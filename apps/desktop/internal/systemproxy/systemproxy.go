package systemproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

var ErrUnsupported = errors.New("Kurlo cannot change the system proxy on this system. Copy the PAC URL into your network or browser settings")

type Runner func(ctx context.Context, name string, args ...string) (string, error)

type MacService struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	Enabled bool   `json:"enabled"`
}

type Backup struct {
	OS          string       `json:"os"`
	PAC         string       `json:"pac"`
	MacServices []MacService `json:"macServices,omitempty"`
	GnomeMode   string       `json:"gnomeMode,omitempty"`
	GnomeURL    string       `json:"gnomeURL,omitempty"`
	WindowsURL  string       `json:"windowsURL,omitempty"`
	WindowsSet  bool         `json:"windowsSet,omitempty"`
}

type Manager struct {
	Path    string
	GOOS    string
	Run     Runner
	Elevate Runner
	Windows windowsSettings
}

func New(path string) *Manager {
	return &Manager{Path: path, GOOS: runtime.GOOS, Run: runCommand, Elevate: runElevated, Windows: windowsRegistry{}}
}

func runCommand(ctx context.Context, name string, args ...string) (string, error) {
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	text := strings.TrimSpace(string(output))
	if err != nil {
		if text == "" {
			text = err.Error()
		}
		return text, errors.New(text)
	}
	return text, nil
}

func runElevated(ctx context.Context, name string, args ...string) (string, error) {
	script := "do shell script " + appleScriptString(shellCommand(name, args...)) + " with administrator privileges"
	return runCommand(ctx, "osascript", "-e", script)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func shellCommand(name string, args ...string) string {
	parts := []string{shellQuote(name)}
	for _, arg := range args {
		parts = append(parts, shellQuote(arg))
	}
	return strings.Join(parts, " ")
}

func appleScriptString(value string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`
}

func (m *Manager) Supported(ctx context.Context) bool {
	switch m.GOOS {
	case "darwin", "windows":
		return true
	case "linux":
		_, err := m.readGnome(ctx)
		return err == nil
	}
	return false
}

func (m *Manager) Active() bool {
	_, err := os.Stat(m.Path)
	return err == nil
}

func (m *Manager) Enable(ctx context.Context, pac string) error {
	if err := m.Recover(ctx); err != nil {
		return err
	}
	var backup Backup
	var err error
	switch m.GOOS {
	case "darwin":
		backup, err = m.readMac(ctx)
	case "windows":
		backup, err = m.readWindows()
	case "linux":
		backup, err = m.readGnome(ctx)
	default:
		err = ErrUnsupported
	}
	if err != nil {
		return err
	}
	backup.OS, backup.PAC = m.GOOS, pac
	if err := m.save(backup); err != nil {
		return err
	}
	switch m.GOOS {
	case "darwin":
		err = m.applyMac(ctx, backup)
	case "windows":
		err = m.Windows.Set(pac, true)
	case "linux":
		err = m.applyGnome(ctx, pac)
	}
	if err != nil {
		restoreErr := m.restore(ctx, backup)
		if restoreErr == nil {
			os.Remove(m.Path)
		}
		return fmt.Errorf("could not set the system proxy: %w", err)
	}
	return nil
}

func (m *Manager) Recover(ctx context.Context) error {
	data, err := os.ReadFile(m.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var backup Backup
	if err := json.Unmarshal(data, &backup); err != nil {
		os.Remove(m.Path)
		return nil
	}
	if err := m.restore(ctx, backup); err != nil {
		return fmt.Errorf("could not restore the system proxy: %w", err)
	}
	return os.Remove(m.Path)
}

func (m *Manager) restore(ctx context.Context, backup Backup) error {
	switch backup.OS {
	case "darwin":
		return m.restoreMac(ctx, backup)
	case "windows":
		current, _, err := m.Windows.Get()
		if err != nil || current != backup.PAC {
			return err
		}
		return m.Windows.Set(backup.WindowsURL, backup.WindowsSet)
	case "linux":
		return m.restoreGnome(ctx, backup)
	}
	return nil
}

func (m *Manager) save(backup Backup) error {
	data, err := json.Marshal(backup)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(m.Path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(m.Path, data, 0o600)
}

func (m *Manager) readMac(ctx context.Context) (Backup, error) {
	list, err := m.Run(ctx, "networksetup", "-listallnetworkservices")
	if err != nil {
		return Backup{}, err
	}
	var backup Backup
	for i, line := range strings.Split(list, "\n") {
		name := strings.TrimSpace(line)
		if i == 0 && strings.Contains(name, "asterisk") || name == "" || strings.HasPrefix(name, "*") {
			continue
		}
		output, err := m.Run(ctx, "networksetup", "-getautoproxyurl", name)
		if err != nil {
			return Backup{}, err
		}
		service := MacService{Name: name}
		for _, field := range strings.Split(output, "\n") {
			key, value, _ := strings.Cut(field, ":")
			value = strings.TrimSpace(value)
			switch strings.TrimSpace(key) {
			case "URL":
				if value != "(null)" {
					service.URL = value
				}
			case "Enabled":
				service.Enabled = strings.EqualFold(value, "yes")
			}
		}
		backup.MacServices = append(backup.MacServices, service)
	}
	if len(backup.MacServices) == 0 {
		return Backup{}, errors.New("no active network services found")
	}
	return backup, nil
}

func (m *Manager) macBatch(ctx context.Context, commands [][]string) error {
	for i, command := range commands {
		if _, err := m.Run(ctx, "networksetup", command...); err != nil {
			if !strings.Contains(strings.ToLower(err.Error()), "admin") {
				return err
			}
			script := make([]string, 0, len(commands)-i)
			for _, rest := range commands[i:] {
				script = append(script, shellCommand("/usr/sbin/networksetup", rest...))
			}
			_, err = m.Elevate(ctx, "/bin/sh", "-c", strings.Join(script, " && "))
			return err
		}
	}
	return nil
}

func (m *Manager) applyMac(ctx context.Context, backup Backup) error {
	commands := [][]string{}
	for _, service := range backup.MacServices {
		commands = append(commands, []string{"-setautoproxyurl", service.Name, backup.PAC}, []string{"-setautoproxystate", service.Name, "on"})
	}
	return m.macBatch(ctx, commands)
}

func (m *Manager) restoreMac(ctx context.Context, backup Backup) error {
	commands := [][]string{}
	for _, service := range backup.MacServices {
		output, err := m.Run(ctx, "networksetup", "-getautoproxyurl", service.Name)
		if err != nil || !strings.Contains(output, backup.PAC) {
			continue
		}
		if service.URL != "" {
			commands = append(commands, []string{"-setautoproxyurl", service.Name, service.URL})
		}
		state := "off"
		if service.Enabled && service.URL != "" {
			state = "on"
		}
		commands = append(commands, []string{"-setautoproxystate", service.Name, state})
	}
	if len(commands) == 0 {
		return nil
	}
	return m.macBatch(ctx, commands)
}

func (m *Manager) gsettings(ctx context.Context, args ...string) (string, error) {
	return m.Run(ctx, "gsettings", args...)
}

func unquoteGVariant(value string) string {
	return strings.Trim(strings.TrimSpace(value), "'")
}

func (m *Manager) readGnome(ctx context.Context) (Backup, error) {
	mode, err := m.gsettings(ctx, "get", "org.gnome.system.proxy", "mode")
	if err != nil {
		return Backup{}, ErrUnsupported
	}
	url, err := m.gsettings(ctx, "get", "org.gnome.system.proxy", "autoconfig-url")
	if err != nil {
		return Backup{}, ErrUnsupported
	}
	return Backup{GnomeMode: unquoteGVariant(mode), GnomeURL: unquoteGVariant(url)}, nil
}

func (m *Manager) applyGnome(ctx context.Context, pac string) error {
	if _, err := m.gsettings(ctx, "set", "org.gnome.system.proxy", "autoconfig-url", pac); err != nil {
		return err
	}
	_, err := m.gsettings(ctx, "set", "org.gnome.system.proxy", "mode", "auto")
	return err
}

func (m *Manager) restoreGnome(ctx context.Context, backup Backup) error {
	url, err := m.gsettings(ctx, "get", "org.gnome.system.proxy", "autoconfig-url")
	if err != nil || unquoteGVariant(url) != backup.PAC {
		return nil
	}
	if _, err := m.gsettings(ctx, "set", "org.gnome.system.proxy", "autoconfig-url", backup.GnomeURL); err != nil {
		return err
	}
	mode := backup.GnomeMode
	if mode == "" {
		mode = "none"
	}
	_, err = m.gsettings(ctx, "set", "org.gnome.system.proxy", "mode", mode)
	return err
}

type windowsSettings interface {
	Get() (string, bool, error)
	Set(url string, present bool) error
}

func (m *Manager) readWindows() (Backup, error) {
	url, present, err := m.Windows.Get()
	if err != nil {
		return Backup{}, err
	}
	return Backup{WindowsURL: url, WindowsSet: present}, nil
}

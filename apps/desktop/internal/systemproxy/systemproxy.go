package systemproxy

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/filelock"
)

var ErrUnsupported = errors.New("Kurlo cannot change the system proxy on this system. Copy the PAC URL into your network or browser settings")

type Runner func(ctx context.Context, name string, args ...string) (string, error)

type MacService struct {
	Restoring bool   `json:"restoring,omitempty"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	Enabled   bool   `json:"enabled"`
}

type Backup struct {
	Owner       string       `json:"owner,omitempty"`
	Applying    bool         `json:"applying,omitempty"`
	Restoring   bool         `json:"restoring,omitempty"`
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
	lease   *routeLease
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

type routeLease struct {
	holder *Manager
	file   *os.File
	id     string
}

var leaseMu sync.RWMutex

func (m *Manager) currentLease() *routeLease {
	leaseMu.RLock()
	defer leaseMu.RUnlock()
	if m.lease != nil && m.lease.holder == m {
		return m.lease
	}
	return nil
}

func (m *Manager) Active() bool {
	lease := m.currentLease()
	if lease == nil {
		return false
	}
	backup, err := m.readBackup()
	return err == nil && backup.Owner == lease.id
}

func (m *Manager) releaseLease() {
	if lease := m.currentLease(); lease != nil {
		lease.file.Close()
		os.Remove(lease.file.Name())
		leaseMu.Lock()
		m.lease = nil
		leaseMu.Unlock()
	}
}

func (m *Manager) lock(ctx context.Context) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(m.Path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(m.Path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = filelock.Acquire(ctx, f); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func (m *Manager) Enable(ctx context.Context, pac string) error {
	lock, err := m.lock(ctx)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := m.recoverLocked(ctx, true); err != nil {
		return err
	}
	var backup Backup
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
	backup.OS, backup.PAC, backup.Applying = m.GOOS, pac, true
	backup.Owner = rand.Text()
	f, err := os.OpenFile(m.Path+".owner-"+backup.Owner, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if err = filelock.Try(f); err != nil {
		f.Close()
		os.Remove(f.Name())
		return err
	}
	leaseMu.Lock()
	m.lease = &routeLease{holder: m, file: f, id: backup.Owner}
	leaseMu.Unlock()
	if err := m.save(backup); err != nil {
		m.releaseLease()
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
	if err == nil {
		backup.Applying = false
		err = m.save(backup)
	}
	if err != nil {
		restoreCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		defer cancel()
		restoreErr := m.recoverLocked(restoreCtx, true)
		return fmt.Errorf("could not set the system proxy: %w", errors.Join(err, restoreErr))
	}
	return nil
}

func (m *Manager) readBackup() (Backup, error) {
	var backup Backup
	data, err := os.ReadFile(m.Path)
	if err == nil {
		err = json.Unmarshal(data, &backup)
	}
	return backup, err
}

func (m *Manager) Recover(ctx context.Context) error {
	if _, err := os.Stat(m.Path); errors.Is(err, os.ErrNotExist) && m.currentLease() == nil {
		return nil
	}
	lock, err := m.lock(ctx)
	if err != nil {
		return err
	}
	defer lock.Close()
	return m.recoverLocked(ctx, false)
}

func (m *Manager) recoverLocked(ctx context.Context, takeover bool) error {
	backup, err := m.readBackup()
	if errors.Is(err, os.ErrNotExist) {
		m.releaseLease()
		return nil
	}
	var invalid *json.SyntaxError
	if errors.As(err, &invalid) {
		m.releaseLease()
		return os.Remove(m.Path)
	}
	if err != nil {
		return err
	}
	lease := m.currentLease()
	if lease != nil && lease.id != backup.Owner {
		m.releaseLease()
		lease = nil
	}
	if backup.Owner != "" && lease == nil {
		if strings.ContainsAny(backup.Owner, `/\`) {
			return errors.New("invalid system proxy owner")
		}
		marker := m.Path + ".owner-" + backup.Owner
		f, err := os.OpenFile(marker, os.O_RDWR, 0600)
		if err == nil {
			err = filelock.Try(f)
			switch {
			case err == nil:
				defer func() { f.Close(); os.Remove(marker) }()
			case errors.Is(err, filelock.ErrBusy):
				f.Close()
				if !takeover {
					return nil
				}
			default:
				f.Close()
				return err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := m.restore(ctx, backup); err != nil {
		return fmt.Errorf("could not restore the system proxy: %w", err)
	}
	if err := os.Remove(m.Path); err != nil {
		return err
	}
	m.releaseLease()
	return nil
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
	f, err := os.CreateTemp(filepath.Dir(m.Path), ".system-proxy-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), m.Path)
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
		service := parseMacService(name, output)
		backup.MacServices = append(backup.MacServices, service)
	}
	if len(backup.MacServices) == 0 {
		return Backup{}, errors.New("no active network services found")
	}
	return backup, nil
}

func parseMacService(name, output string) MacService {
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
	return service
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
	for i, service := range backup.MacServices {
		output, err := m.Run(ctx, "networksetup", "-getautoproxyurl", service.Name)
		if err != nil {
			return err
		}
		current := parseMacService(service.Name, output)
		owned := current.URL == backup.PAC && (current.Enabled || backup.Applying)
		partial := service.Restoring && service.URL != "" && current.URL == service.URL && current.Enabled && !service.Enabled
		if !owned && !partial {
			continue
		}
		backup.MacServices[i].Restoring = true
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
	if err := m.save(backup); err != nil {
		return err
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
		return Backup{}, fmt.Errorf("%w: %w", ErrUnsupported, err)
	}
	url, err := m.gsettings(ctx, "get", "org.gnome.system.proxy", "autoconfig-url")
	if err != nil {
		return Backup{}, fmt.Errorf("%w: %w", ErrUnsupported, err)
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
	current, err := m.readGnome(ctx)
	if err != nil {
		return err
	}
	owned := current.GnomeURL == backup.PAC && (current.GnomeMode == "auto" || backup.Applying)
	partial := backup.Restoring && current.GnomeURL == backup.GnomeURL && current.GnomeMode == "auto"
	if !owned && !partial {
		return nil
	}
	if !backup.Restoring {
		backup.Restoring = true
		if err := m.save(backup); err != nil {
			return err
		}
	}
	if current.GnomeURL != backup.GnomeURL {
		if _, err := m.gsettings(ctx, "set", "org.gnome.system.proxy", "autoconfig-url", backup.GnomeURL); err != nil {
			return err
		}
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

package api

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const appPreferencesFileName = "preferences.json"

type appPreferences struct {
	DefaultWorkspaceLocation string                 `json:"defaultWorkspaceLocation,omitempty"`
	CookieSync               *cookieSyncPreferences `json:"cookieSync,omitempty"`
}

type cookieSyncPreferences struct {
	Enabled        bool     `json:"enabled"`
	Port           int      `json:"port,omitempty"`
	Domains        []string `json:"domains,omitempty"`
	Token          string   `json:"token,omitempty"`
	TokenEncrypted string   `json:"tokenEncrypted,omitempty"`
}

func cookieSyncPreferencesToken(saved cookieSyncPreferences) string {
	if saved.TokenEncrypted != "" {
		if plaintext, err := decryptRequestStorePayload([]byte(saved.TokenEncrypted)); err == nil {
			return strings.TrimSpace(string(plaintext))
		}
	}
	return strings.TrimSpace(saved.Token)
}

func sealCookieSyncPreferencesToken(preferences *cookieSyncPreferences, token string) {
	preferences.Token = ""
	preferences.TokenEncrypted = ""
	if token == "" {
		return
	}
	if sealed, err := encryptRequestStorePayload([]byte(token)); err == nil {
		preferences.TokenEncrypted = string(sealed)
		return
	}
	preferences.Token = token
}

type DefaultWorkspaceLocationResult struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

func appPreferencesPath() string {
	return filepath.Join(requestStoreDir(), appPreferencesFileName)
}

func loadAppPreferences() (appPreferences, error) {
	var preferences appPreferences
	data, err := os.ReadFile(appPreferencesPath())
	if err != nil {
		if os.IsNotExist(err) {
			return preferences, nil
		}
		return preferences, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return preferences, nil
	}
	if err := json.Unmarshal(data, &preferences); err != nil {
		return preferences, err
	}
	return preferences, nil
}

func saveAppPreferences(preferences appPreferences) error {
	dir := requestStoreDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(preferences, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".preferences-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write([]byte("\n")); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := replaceFile(tmpPath, appPreferencesPath()); err != nil {
		return err
	}
	cleanup = false
	return syncDir(dir)
}

func defaultUserWorkspaceLocationPath() string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return filepath.Join(requestStoreDir(), "Documents", "Kurlo")
	}
	return filepath.Join(home, "Documents", "Kurlo")
}

func configuredDefaultWorkspaceLocation() string {
	preferences, err := loadAppPreferences()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(preferences.DefaultWorkspaceLocation)
}

func defaultWorkspaceLocationPath() string {
	if configured := configuredDefaultWorkspaceLocation(); configured != "" {
		return configured
	}
	return defaultUserWorkspaceLocationPath()
}

func ensureDefaultWorkspaceLocation() (string, error) {
	return ensureWorkspaceLocationDir(defaultWorkspaceLocationPath())
}

func ensureWorkspaceLocationDir(path string) (string, error) {
	expanded, err := expandUserPath(path)
	if err != nil {
		return "", err
	}
	expanded = strings.TrimSpace(expanded)
	if expanded == "" {
		expanded = defaultUserWorkspaceLocationPath()
	}
	abs, err := filepath.Abs(expanded)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0755); err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("default location is not a folder")
	}
	return filepath.Clean(abs), nil
}

func expandUserPath(path string) (string, error) {
	value := strings.TrimSpace(path)
	if value != "~" && !strings.HasPrefix(value, "~/") && !strings.HasPrefix(value, `~\`) {
		return value, nil
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return "", fmt.Errorf("could not resolve home directory")
	}
	if value == "~" {
		return home, nil
	}
	return filepath.Join(home, strings.TrimLeft(value[1:], `/\`)), nil
}

func parentDirForNewWorkspace(parentDir string) (string, error) {
	if strings.TrimSpace(parentDir) == "" {
		return ensureDefaultWorkspaceLocation()
	}
	return normalizeExistingDir(parentDir)
}

func (a *App) DefaultWorkspaceLocation() DefaultWorkspaceLocationResult {
	path, err := ensureDefaultWorkspaceLocation()
	if err != nil {
		return DefaultWorkspaceLocationResult{Path: defaultWorkspaceLocationPath(), Error: err.Error()}
	}
	return DefaultWorkspaceLocationResult{Path: path}
}

func (a *App) SetDefaultWorkspaceLocation(path string) DefaultWorkspaceLocationResult {
	normalized, err := ensureWorkspaceLocationDir(path)
	if err != nil {
		return DefaultWorkspaceLocationResult{Path: strings.TrimSpace(path), Error: err.Error()}
	}
	preferences, err := loadAppPreferences()
	if err != nil {
		return DefaultWorkspaceLocationResult{Path: normalized, Error: err.Error()}
	}
	preferences.DefaultWorkspaceLocation = normalized
	if err := saveAppPreferences(preferences); err != nil {
		return DefaultWorkspaceLocationResult{Path: normalized, Error: err.Error()}
	}
	return DefaultWorkspaceLocationResult{Path: normalized}
}

package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/extension"
)

type BrowserExtensionResult struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	Browser string `json:"browser"`
	Error   string `json:"error,omitempty"`
}

var extensionVersionRe = regexp.MustCompile(`^\d+(\.\d+){0,3}`)

func browserExtensionVersion(version string) string {
	clean := strings.TrimPrefix(strings.TrimSpace(version), "v")
	if match := extensionVersionRe.FindString(clean); match != "" {
		return match
	}
	return "0.0.0"
}

func browserExtensionDir(browser string) string {
	return filepath.Join(requestStoreDir(), "browser-extension", browser)
}

func writeBrowserExtension(browser string) (string, error) {
	if browser != "chromium" && browser != "firefox" {
		return "", fmt.Errorf("unknown browser %q", browser)
	}
	dir := browserExtensionDir(browser)
	if err := os.RemoveAll(dir); err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	manifestSource := "manifest.json"
	if browser == "firefox" {
		manifestSource = "manifest.firefox.json"
	}
	err := fs.WalkDir(extension.Files, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || name == "manifest.json" || name == "manifest.firefox.json" {
			return err
		}
		data, err := extension.Files.ReadFile(name)
		if err != nil {
			return err
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0644)
	})
	if err != nil {
		return "", err
	}
	raw, err := extension.Files.ReadFile(path.Clean(manifestSource))
	if err != nil {
		return "", err
	}
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return "", err
	}
	manifest["version"] = browserExtensionVersion(appVersion)
	stamped, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), append(stamped, '\n'), 0644); err != nil {
		return "", err
	}
	return dir, nil
}

func (a *App) InstallBrowserExtension(browser string) BrowserExtensionResult {
	browser = strings.ToLower(strings.TrimSpace(browser))
	result := BrowserExtensionResult{Browser: browser, Version: browserExtensionVersion(appVersion)}
	dir, err := writeBrowserExtension(browser)
	if err != nil {
		result.Error = "Could not prepare the extension: " + err.Error()
		return result
	}
	result.Path = dir
	if err := revealInFileManager(dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		result.Error = "The extension is ready in " + dir + ", but the folder could not be opened: " + err.Error()
	}
	return result
}

func refreshInstalledBrowserExtensions() {
	for _, browser := range []string{"chromium", "firefox"} {
		if _, err := os.Stat(filepath.Join(browserExtensionDir(browser), "manifest.json")); err == nil {
			_, _ = writeBrowserExtension(browser)
		}
	}
}

package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func readExtensionManifest(t *testing.T, dir string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func TestBrowserExtensionVersionFollowsTheApp(t *testing.T) {
	for input, want := range map[string]string{"2.2.5": "2.2.5", "v2.3.0": "2.3.0", "2.3.0-beta.1": "2.3.0", "dev": "0.0.0", "": "0.0.0"} {
		if got := browserExtensionVersion(input); got != want {
			t.Errorf("browserExtensionVersion(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestInstallBrowserExtensionWritesAVersionedCopy(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	restore := stubReveal(t, func(string) error { return nil })
	defer restore()
	previous := appVersion
	appVersion = "2.4.1"
	t.Cleanup(func() { appVersion = previous })

	app := &App{}
	chromium := app.InstallBrowserExtension("chromium")
	if chromium.Error != "" || chromium.Version != "2.4.1" {
		t.Fatalf("chromium setup: %+v", chromium)
	}
	manifest := readExtensionManifest(t, chromium.Path)
	if manifest["version"] != "2.4.1" {
		t.Fatalf("manifest version %v, want the app version", manifest["version"])
	}
	if background, _ := manifest["background"].(map[string]any); background["service_worker"] == nil {
		t.Fatalf("the Chromium copy needs the service worker manifest: %v", manifest["background"])
	}
	for _, name := range []string{"background.js", "popup.html", "popup.js", "icons/icon-128.png"} {
		if _, err := os.Stat(filepath.Join(chromium.Path, filepath.FromSlash(name))); err != nil {
			t.Fatalf("%s is missing: %v", name, err)
		}
	}
	for _, name := range []string{"embed.go", "manifest.firefox.json", "README.md"} {
		if _, err := os.Stat(filepath.Join(chromium.Path, name)); err == nil {
			t.Fatalf("%s should not be in the browser copy", name)
		}
	}

	firefox := app.InstallBrowserExtension("firefox")
	if firefox.Error != "" || firefox.Path == chromium.Path {
		t.Fatalf("firefox setup: %+v", firefox)
	}
	if background, _ := readExtensionManifest(t, firefox.Path)["background"].(map[string]any); background["scripts"] == nil {
		t.Fatalf("the Firefox copy needs the event page manifest: %v", background)
	}

	if result := app.InstallBrowserExtension("safari"); result.Error == "" {
		t.Fatal("an unknown browser must be refused")
	}
}

func TestStartupRefreshesOnlyInstalledExtensionCopies(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	previous := appVersion
	appVersion = "2.4.1"
	t.Cleanup(func() { appVersion = previous })

	dir, err := writeBrowserExtension("chromium")
	if err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, "removed-in-this-version.js")
	if err := os.WriteFile(stale, []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	appVersion = "2.5.0"
	refreshInstalledBrowserExtensions()
	if got := readExtensionManifest(t, dir)["version"]; got != "2.5.0" {
		t.Fatalf("installed copy was not refreshed: version %v", got)
	}
	if _, err := os.Stat(stale); err == nil {
		t.Fatal("files the new version no longer ships must go")
	}
	if _, err := os.Stat(browserExtensionDir("firefox")); err == nil {
		t.Fatal("a browser the user never set up must not get a copy")
	}
}

func TestCookieSyncReportsTheExtensionVersion(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")
	harness.dial(t, harness.token)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if status := harness.server.status(); status.Connected {
			if status.ExtensionVersion != "1.4.0" {
				t.Fatalf("extension version %q, want 1.4.0", status.ExtensionVersion)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the extension never connected")
}

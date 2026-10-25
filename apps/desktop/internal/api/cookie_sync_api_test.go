package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func isolateAppData(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("AppData", filepath.Join(home, "AppData"))
	key := make([]byte, requestStoreKeySize)
	for i := range key {
		key[i] = byte(i + 7)
	}
	previousProvider, previousLoader := requestStoreKeyProvider, requestStoreKeyLoader
	requestStoreKeyProvider = func() ([]byte, error) { return key, nil }
	requestStoreKeyLoader = func() ([]byte, error) { return key, nil }
	t.Cleanup(func() {
		requestStoreKeyProvider, requestStoreKeyLoader = previousProvider, previousLoader
	})
}

func readCookieSyncPreferences(t *testing.T) cookieSyncPreferences {
	t.Helper()
	data, err := os.ReadFile(appPreferencesPath())
	if err != nil {
		t.Fatalf("read preferences: %v", err)
	}
	var preferences appPreferences
	if err := json.Unmarshal(data, &preferences); err != nil {
		t.Fatalf("decode preferences: %v", err)
	}
	if preferences.CookieSync == nil {
		t.Fatal("preferences hold no cookie sync section")
	}
	return *preferences.CookieSync
}

func startAppCookieSync(t *testing.T, app *App, domains []string) model.CookieSyncStatus {
	t.Helper()
	var status model.CookieSyncStatus
	for attempt := 0; attempt < 5; attempt++ {
		status = app.StartCookieSync(model.CookieSyncConfig{
			Enabled: true,
			Port:    freeLoopbackPort(t),
			Domains: domains,
		}, "ws-1")
		if status.Error == "" {
			break
		}
	}
	if status.Error != "" {
		t.Fatalf("start cookie sync: %s", status.Error)
	}
	t.Cleanup(func() { app.cookieSync.stopServer() })
	return status
}

func TestCookieSyncStatusMintsAStableTokenOnFirstUse(t *testing.T) {
	isolateAppData(t)
	app := NewApp()

	first := app.CookieSyncStatus()
	if first.Running || first.Enabled {
		t.Fatalf("a fresh install should leave the bridge off, got %+v", first)
	}
	if first.PairingCode != "" {
		t.Fatal("no pairing code should be shown while the bridge is closed")
	}

	saved := readCookieSyncPreferences(t)
	token := cookieSyncPreferencesToken(saved)
	if len(token) < 16 {
		t.Fatalf("expected a token to be minted and saved, got %q", token)
	}
	if saved.Token != "" || saved.TokenEncrypted == "" {
		t.Fatalf("the token should be saved encrypted, not in plaintext: %+v", saved)
	}
	if app.CookieSyncStatus(); cookieSyncPreferencesToken(readCookieSyncPreferences(t)) != token {
		t.Fatal("the token must not change every time the tab is opened")
	}
}

func TestCookieSyncLegacyPlaintextTokenIsResavedEncrypted(t *testing.T) {
	isolateAppData(t)
	legacy := "legacy-plaintext-bridge-token"
	if err := saveAppPreferences(appPreferences{CookieSync: &cookieSyncPreferences{Token: legacy}}); err != nil {
		t.Fatalf("save preferences: %v", err)
	}

	app := NewApp()
	app.CookieSyncStatus()

	data, err := os.ReadFile(appPreferencesPath())
	if err != nil {
		t.Fatalf("read preferences: %v", err)
	}
	if strings.Contains(string(data), legacy) {
		t.Fatal("the legacy token is still stored in plaintext")
	}
	if got := cookieSyncPreferencesToken(readCookieSyncPreferences(t)); got != legacy {
		t.Fatalf("a paired extension should keep its token, got %q", got)
	}
}

func TestCookieSyncSettingsSurviveARestart(t *testing.T) {
	isolateAppData(t)

	first := NewApp()
	started := startAppCookieSync(t, first, []string{"https://Example.com/orders", "api.example.com"})
	if !started.Running || started.PairingCode == "" {
		t.Fatalf("expected a running bridge with a pairing code, got %+v", started)
	}
	if strings.Join(started.Domains, ",") != "api.example.com,example.com" {
		t.Fatalf("domains were not normalized: %v", started.Domains)
	}

	saved := readCookieSyncPreferences(t)
	if !saved.Enabled || saved.Port != started.Port {
		t.Fatalf("preferences did not record the running bridge: %+v", saved)
	}
	savedToken := cookieSyncPreferencesToken(saved)
	if !strings.HasSuffix(started.PairingCode, savedToken) {
		t.Fatalf("the pairing code %q should carry the saved token %q", started.PairingCode, savedToken)
	}

	first.cookieSync.stopServer()

	second := NewApp()
	restored := second.CookieSyncStatus()
	if !restored.Enabled || restored.Running {
		t.Fatalf("a restart should remember it was on but not be listening yet, got %+v", restored)
	}
	if strings.Join(restored.Domains, ",") != "api.example.com,example.com" {
		t.Fatalf("the allowlist did not survive the restart: %v", restored.Domains)
	}

	resumed := startAppCookieSync(t, second, restored.Domains)
	wantCode := cookieSyncPairingCode(resumed.Port, savedToken)
	if resumed.PairingCode != wantCode {
		t.Fatalf("a paired extension should keep working after a restart: %q, want %q", resumed.PairingCode, wantCode)
	}
}

func TestStopCookieSyncIsRememberedAsOff(t *testing.T) {
	isolateAppData(t)

	app := NewApp()
	startAppCookieSync(t, app, []string{"example.com"})
	stopped := app.StopCookieSync()
	if stopped.Running || stopped.Enabled {
		t.Fatalf("expected the bridge off, got %+v", stopped)
	}
	if saved := readCookieSyncPreferences(t); saved.Enabled {
		t.Fatal("turning sync off must be remembered across restarts")
	}

	next := NewApp().CookieSyncStatus()
	if next.Enabled || next.Running {
		t.Fatalf("a restart should leave the bridge off, got %+v", next)
	}
}

func TestSetCookieSyncDomainsPersistsAndRefusesPublicSuffixes(t *testing.T) {
	isolateAppData(t)
	app := NewApp()

	status := app.SetCookieSyncDomains([]string{"b.example.com", "a.example.com", "b.example.com"})
	if strings.Join(status.Domains, ",") != "a.example.com,b.example.com" {
		t.Fatalf("domains = %v, want them deduped and sorted", status.Domains)
	}
	if saved := readCookieSyncPreferences(t); strings.Join(saved.Domains, ",") != "a.example.com,b.example.com" {
		t.Fatalf("the allowlist was not saved: %v", saved.Domains)
	}

	refused := app.SetCookieSyncDomains([]string{"example.com", "co.uk"})
	if refused.Error == "" || !strings.Contains(refused.Error, "co.uk") {
		t.Fatalf("expected an explanation for the public suffix, got %q", refused.Error)
	}
	if strings.Join(refused.Domains, ",") != "example.com" {
		t.Fatalf("a public suffix must not reach the allowlist: %v", refused.Domains)
	}
}

func TestCookieSyncPushLandsInTheWorkspaceTheAppPointsAt(t *testing.T) {
	isolateAppData(t)
	app := NewApp()
	startAppCookieSync(t, app, []string{"example.com"})
	app.SetCookieSyncWorkspace("ws-2")

	accepted, _ := app.cookieJars.jar("ws-2").SyncCookies([]string{"example.com"}, []model.Cookie{
		{Name: "sid", Domain: "example.com", Path: "/", Session: true},
	})
	if accepted != 1 {
		t.Fatalf("accepted = %d, want 1", accepted)
	}
	if got := app.ListCookies("ws-2"); len(got) != 1 {
		t.Fatalf("the workspace jar holds %d cookies, want 1", len(got))
	}
	if got := app.ListCookies("ws-1"); len(got) != 0 {
		t.Fatalf("cookies leaked into the other workspace: %+v", got)
	}
}

func TestCookieSyncRejectsAPrivilegedPort(t *testing.T) {
	isolateAppData(t)
	app := NewApp()

	status := app.StartCookieSync(model.CookieSyncConfig{Enabled: true, Port: 80, Domains: []string{"example.com"}}, "ws-1")
	if status.Running {
		t.Fatal("the bridge should refuse a privileged port instead of binding it")
	}
	if !strings.Contains(status.Error, "out of range") {
		t.Fatalf("error = %q, want an out-of-range explanation", status.Error)
	}
}

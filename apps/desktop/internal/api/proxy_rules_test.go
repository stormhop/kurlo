package api

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/proxycapture"
)

func TestProxyRulesPersist(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	app := &App{}
	if rules := app.ProxyRules(); len(rules) != 0 {
		t.Fatal(rules)
	}
	rule := proxycapture.Rule{ID: "r1", Name: "Orders", Enabled: true, Kind: proxycapture.RuleLocal, Method: "GET", URL: "https://api.shop.test/orders/*", Local: proxycapture.LocalAnswer{Status: 200, Body: `{"ok":true}`, ContentType: "application/json"}, Hits: 9}
	saved, err := app.SetProxyRules([]proxycapture.Rule{rule})
	if err != nil || len(saved) != 1 || saved[0].Hits != 0 {
		t.Fatal(saved, err)
	}
	info, err := os.Stat(captureRulesPath())
	if err != nil || (goruntime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatal(info, err)
	}
	data, _ := os.ReadFile(captureRulesPath())
	if strings.Contains(string(data), `"hits": 9`) || !strings.Contains(string(data), "api.shop.test/orders/*") {
		t.Fatal(string(data))
	}
	if _, err := app.SetProxyRules([]proxycapture.Rule{{ID: "bad", Kind: proxycapture.RuleLocal, URL: "nope"}}); err == nil {
		t.Fatal("accepted an invalid rule")
	}
	if after, _ := os.ReadFile(captureRulesPath()); !bytes.Equal(after, data) {
		t.Fatal("an invalid rule changed the saved file")
	}
	dir := filepath.Dir(captureRulesPath())
	if err := os.Rename(dir, dir+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	rule.Local.Body = "unsaved"
	after, err := app.SetProxyRules([]proxycapture.Rule{rule})
	if err == nil || len(after) != 1 || after[0].Local.Body != saved[0].Local.Body || app.ProxyRules()[0].Local.Body != saved[0].Local.Body {
		t.Fatal(after, err)
	}
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(dir+".saved", dir); err != nil {
		t.Fatal(err)
	}
	fresh := &App{}
	loaded := fresh.ProxyRules()
	if len(loaded) != 1 || loaded[0].Name != "Orders" || loaded[0].Local.Body != `{"ok":true}` {
		t.Fatal(loaded)
	}
	if status := fresh.ProxyCaptureStatus(); status.Rules != 1 {
		t.Fatal(status)
	}
	if _, err := fresh.SetProxyRules(nil); err != nil || len(fresh.ProxyRules()) != 0 {
		t.Fatal(err)
	}
}

func TestDamagedProxyRulesFileIsIgnored(t *testing.T) {
	dir := t.TempDir()
	useTempConfigDir(t, dir)
	if err := os.MkdirAll(filepath.Dir(captureRulesPath()), 0o700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(captureRulesPath(), []byte("{"), 0o600)
	app := &App{}
	if rules := app.ProxyRules(); len(rules) != 0 {
		t.Fatal(rules)
	}
	if _, err := app.SetProxyRules([]proxycapture.Rule{}); err != nil {
		t.Fatal(err)
	}
}

func TestProxyCLIRulesFile(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	path := filepath.Join(t.TempDir(), "rules.json")
	os.WriteFile(path, []byte(`[{"id":"x","kind":"local","url":"not a url","local":{"status":200}}]`), 0o600)
	var stdout, stderr bytes.Buffer
	if code := runProxyCLI(context.Background(), []string{"--port", "65002", "--rules", path}, &stdout, &stderr); code != 1 || !strings.Contains(stderr.String(), "URL pattern") {
		t.Fatal(code, stderr.String())
	}
	if code := runProxyCLI(context.Background(), []string{"--port", "65002", "--rules", filepath.Join(t.TempDir(), "missing.json")}, &stdout, &stderr); code != 1 {
		t.Fatal(code)
	}
}

func TestOpenProxyCaptureSession(t *testing.T) {
	dir := t.TempDir()
	useTempConfigDir(t, t.TempDir())
	app := &App{}
	defer app.capture.Close()
	path := filepath.Join(dir, "shop.har")
	os.WriteFile(path, []byte(`{"log":{"entries":[{"startedDateTime":"2026-11-22T10:00:00Z","time":5,"request":{"method":"GET","url":"https://shop.test/a"},"response":{"status":204}}]}}`), 0o600)
	status, err := app.OpenProxyCaptureSession(path)
	if err != nil || status.Source != "shop.har" || status.Count != 1 {
		t.Fatal(status, err)
	}
	if entries := app.ProxyCaptureEntries(); len(entries) != 1 || entries[0].Status != 204 {
		t.Fatal(entries)
	}
	if _, err := app.OpenProxyCaptureSession(filepath.Join(dir, "missing.har")); err == nil {
		t.Fatal("opened a missing file")
	}
	if _, err := app.OpenProxyCaptureSession(dir); err == nil || !strings.Contains(err.Error(), "HAR file") {
		t.Fatal(err)
	}
	bad := filepath.Join(dir, "bad.har")
	os.WriteFile(bad, []byte("{}"), 0o600)
	if _, err := app.OpenProxyCaptureSession(bad); err == nil {
		t.Fatal("opened an invalid file")
	}
	if status := app.ProxyCaptureStatus(); status.Source != "shop.har" || status.Count != 1 {
		t.Fatal(status)
	}
}

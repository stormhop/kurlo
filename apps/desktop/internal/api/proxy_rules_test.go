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

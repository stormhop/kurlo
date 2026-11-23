package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/loadtest"
)

const cliLinkedCanary = "kurlo-cli-canary-7c41"

func writeLinkedCLIWorkspace(t *testing.T, baseURL string) string {
	t.Helper()
	return linkCLIWorkspace(t, writeYAMLWorkspace(t, baseURL), baseURL)
}

func linkCLIWorkspace(t *testing.T, root, baseURL string) string {
	t.Helper()
	wsDir := filepath.Join(root, "workspaces", "Demo")
	write := func(path, content string) {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
	write(filepath.Join(wsDir, "workspace.yml"), strings.Join([]string{
		"version: 1",
		"workspace:",
		"  id: ws-demo",
		"  name: Demo",
		"  filesystemName: Demo",
		"  collectionOrder:",
		"    - col-smoke",
		"secretProviders:",
		"  - id: ci-env",
		"    type: env",
		"",
	}, "\n"))
	write(filepath.Join(wsDir, "environments", "Local.yml"), strings.Join([]string{
		"version: 1",
		"environment:",
		"  id: env-local",
		"  workspaceId: ws-demo",
		"  name: Local",
		"  filesystemName: Local",
		"  values:",
		"    - id: 1",
		"      enabled: true",
		"      key: baseUrl",
		"      value: " + baseURL,
		"    - id: 2",
		"      enabled: true",
		"      key: apiToken",
		"      secret: true",
		"      secretRef:",
		"        provider: ci-env",
		"        path: KURLO_TEST_API_TOKEN",
		"    - id: 3",
		"      enabled: true",
		"      key: unusedLink",
		"      secret: true",
		"      secretRef:",
		"        provider: ci-env",
		"        path: KURLO_TEST_NOT_SET",
		"",
	}, "\n"))
	requestPath := filepath.Join(wsDir, "collections", "Smoke", "requests", "GET-1-ok.yml")
	data, err := os.ReadFile(requestPath)
	if err != nil {
		t.Fatal(err)
	}
	write(requestPath, strings.Replace(string(data), `url: "{{baseUrl}}/ok?v={{apiVersion}}"`, `url: "{{baseUrl}}/ok?v={{apiVersion}}&token={{apiToken}}"`, 1))
	return root
}

func linkedCLIServer(t *testing.T) (*httptest.Server, *atomic.Value) {
	t.Helper()
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)
	seen := &atomic.Value{}
	seen.Store("")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token := r.URL.Query().Get("token"); token != "" {
			seen.Store(token)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","echo":"` + r.URL.Query().Get("token") + `"}`))
	}))
	t.Cleanup(server.Close)
	return server, seen
}

func TestRunCLIGetsLinkedSecretsFromProviders(t *testing.T) {
	t.Setenv("KURLO_TEST_API_TOKEN", cliLinkedCanary)
	server, seen := linkedCLIServer(t)
	root := writeLinkedCLIWorkspace(t, server.URL)
	exported := filepath.Join(t.TempDir(), "env.json")
	opts, err := parseCLIArgs([]string{root, "--env", "Local", "--reporter", "json", "--export-environment", exported}, io.Discard, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	opts.stdout, opts.stderr = &out, &errOut
	if code := runCLI(opts); code != 0 {
		t.Fatalf("exit %d\n%s\n%s", code, out.String(), errOut.String())
	}
	if seen.Load() != cliLinkedCanary {
		t.Fatalf("the server got token %q", seen.Load())
	}
	if strings.Contains(out.String(), cliLinkedCanary) || strings.Contains(errOut.String(), cliLinkedCanary) {
		t.Fatalf("the report shows the linked value:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "token=[secret]") {
		t.Fatalf("the report URL is not masked:\n%s", out.String())
	}
	data, err := os.ReadFile(exported)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), cliLinkedCanary) || strings.Contains(string(data), "apiToken") {
		t.Fatalf("--export-environment wrote the linked value:\n%s", data)
	}
}

func TestRunCLIExportsMaskLinkedValuesCopiedByScripts(t *testing.T) {
	t.Setenv("KURLO_TEST_API_TOKEN", cliLinkedCanary)
	server, _ := linkedCLIServer(t)
	root := writeLinkedCLIWorkspace(t, server.URL)
	requestPath := filepath.Join(root, "workspaces", "Demo", "collections", "Smoke", "requests", "GET-1-ok.yml")
	data, err := os.ReadFile(requestPath)
	if err != nil {
		t.Fatal(err)
	}
	script := "    pm.environment.set(\"copied\", pm.response.json().echo)\n" +
		"    pm.environment.set(\"header\", \"Bearer \" + pm.response.json().echo)\n" +
		"    pm.globals.set(\"global\", \"token=\" + pm.response.json().echo)\n" +
		"    pm.environment.set(\"chained\", \"yes\")\n"
	updated := strings.Replace(string(data), "    pm.environment.set(\"chained\", \"yes\")\n", script, 1)
	if updated == string(data) {
		t.Fatal("the request script was not replaced")
	}
	if err := os.WriteFile(requestPath, []byte(updated), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	envFile, globalsFile := filepath.Join(dir, "env.json"), filepath.Join(dir, "globals.json")
	opts, err := parseCLIArgs([]string{root, "--env", "Local", "--export-environment", envFile, "--export-globals", globalsFile}, io.Discard, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	opts.stdout, opts.stderr = &out, &errOut
	if code := runCLI(opts); code != 0 {
		t.Fatalf("exit %d\n%s\n%s", code, out.String(), errOut.String())
	}
	for _, file := range []string{envFile, globalsFile} {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), cliLinkedCanary) {
			t.Fatalf("%s holds the linked value:\n%s", filepath.Base(file), data)
		}
	}
	env, _ := os.ReadFile(envFile)
	for _, want := range []string{`"value": "[secret]"`, `"value": "Bearer [secret]"`, `"key": "chained"`} {
		if !strings.Contains(string(env), want) {
			t.Fatalf("the environment export misses %s:\n%s", want, env)
		}
	}
	globals, _ := os.ReadFile(globalsFile)
	if !strings.Contains(string(globals), `"value": "token=[secret]"`) {
		t.Fatalf("the globals export is not masked:\n%s", globals)
	}
}

func TestRunCLIStopsBeforeTheFirstRequestWhenALinkFails(t *testing.T) {
	t.Setenv("KURLO_TEST_API_TOKEN", "")
	os.Unsetenv("KURLO_TEST_API_TOKEN")
	server, seen := linkedCLIServer(t)
	root := writeLinkedCLIWorkspace(t, server.URL)
	var out, errOut bytes.Buffer
	code := runCLI(cliOptions{workspace: root, env: "Local", reporters: []string{"cli"}, iterations: 1, secretProviders: "on", stdout: &out, stderr: &errOut, vars: map[string]string{}})
	if code != 2 {
		t.Fatalf("exit %d, want 2\n%s%s", code, out.String(), errOut.String())
	}
	message := errOut.String()
	for _, want := range []string{"cannot get linked secrets", "apiToken ← ci-env:KURLO_TEST_API_TOKEN", "environment variable KURLO_TEST_API_TOKEN is not set", "--var apiToken="} {
		if !strings.Contains(message, want) {
			t.Fatalf("stderr is missing %q:\n%s", want, message)
		}
	}
	if strings.Contains(message, "unusedLink") {
		t.Fatalf("a link no request uses was fetched:\n%s", message)
	}
	if seen.Load() != "" {
		t.Fatal("a request was sent before the secrets were ready")
	}
}

func TestRunCLIWithSecretProvidersOff(t *testing.T) {
	t.Setenv("KURLO_TEST_API_TOKEN", cliLinkedCanary)
	server, seen := linkedCLIServer(t)
	root := writeLinkedCLIWorkspace(t, server.URL)
	opts, err := parseCLIArgs([]string{root, "--env", "Local", "--secret-providers=off"}, io.Discard, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	var errOut bytes.Buffer
	opts.stdout, opts.stderr = io.Discard, &errOut
	if code := runCLI(opts); code != 2 || !strings.Contains(errOut.String(), "--secret-providers=off is set") || !strings.Contains(errOut.String(), "--var apiToken=") {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	opts, err = parseCLIArgs([]string{root, "--env", "Local", "--secret-providers", "off", "--var", "apiToken=from-ci"}, io.Discard, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	errOut.Reset()
	opts.stdout, opts.stderr = io.Discard, &errOut
	if code := runCLI(opts); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if seen.Load() != "from-ci" {
		t.Fatalf("--var did not override the link: %q", seen.Load())
	}
}

func TestRunCLIRunsSecretCommandsOnlyWhenAllowed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a shell script")
	}
	server, seen := linkedCLIServer(t)
	root := writeLinkedCLIWorkspace(t, server.URL)
	script := filepath.Join(t.TempDir(), "secret-helper")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf 'cmd-%s' \"$1\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	workspaceFile := filepath.Join(root, "workspaces", "Demo", "workspace.yml")
	data, err := os.ReadFile(workspaceFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(workspaceFile, []byte(strings.Replace(string(data), "    type: env\n", "    type: command\n    command: ["+script+", \"{path}\"]\n", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	var errOut bytes.Buffer
	opts, err := parseCLIArgs([]string{root, "--env", "Local"}, io.Discard, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	opts.stdout, opts.stderr = io.Discard, &errOut
	if code := runCLI(opts); code != 2 || !strings.Contains(errOut.String(), "--allow-secret-commands") {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if seen.Load() != "" {
		t.Fatal("a request was sent without the command value")
	}
	opts, err = parseCLIArgs([]string{root, "--env", "Local", "--allow-secret-commands"}, io.Discard, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	errOut.Reset()
	opts.stdout, opts.stderr = io.Discard, &errOut
	if code := runCLI(opts); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if seen.Load() != "cmd-KURLO_TEST_API_TOKEN" {
		t.Fatalf("the server got %q", seen.Load())
	}
}

func TestParseCLISecretFlags(t *testing.T) {
	if _, err := parseCLIArgs([]string{"--secret-providers", "maybe"}, io.Discard, io.Discard); err == nil || !strings.Contains(err.Error(), "--secret-providers must be on or off") {
		t.Fatalf("err = %v", err)
	}
	opts, err := parseCLIArgs([]string{"--secret-timeout", "3s"}, io.Discard, io.Discard)
	if err != nil || opts.secretTimeout.Seconds() != 3 || opts.secretProviders != "on" {
		t.Fatalf("opts = %+v, err = %v", opts, err)
	}
	source := &cliSecretSource{root: writeLinkedCLIWorkspace(t, "http://127.0.0.1:1"), timeout: opts.secretTimeout}
	configs, err := source.Providers("ws-demo")
	if err != nil || len(configs) != 1 || configs[0].Timeout != opts.secretTimeout {
		t.Fatalf("configs = %+v, err = %v", configs, err)
	}
}

func TestMCPRunUsesTheAppTrustForLinkedSecrets(t *testing.T) {
	f := newLinkedFixture(t)
	server := newMCPServer(mcpServerOptions{workspace: f.root, loadAppSecrets: true}, io.Discard)
	ws, err := server.loadWorkspace()
	if err != nil {
		t.Fatal(err)
	}
	run, err := server.prepareRun(ws, "Prod", nil, cliSavedRequest{URL: "{{baseUrl}}/x?pw={{dbPassword}}"})
	if err != nil {
		t.Fatal(err)
	}
	if run.values["dbPassword"] != linkedCanary {
		t.Fatalf("dbPassword = %q", run.values["dbPassword"])
	}
	found := false
	for _, secret := range run.secrets {
		found = found || secret == linkedCanary
	}
	if !found {
		t.Fatal("the linked value is not masked in MCP results")
	}
	hits := f.vaultHits.Load()
	run, err = server.prepareRun(ws, "Prod", nil, cliSavedRequest{URL: "{{baseUrl}}/public"})
	if err != nil || run.values["dbPassword"] != "" || f.vaultHits.Load() != hits {
		t.Fatalf("a request without the link fetched it: %v %v", run, err)
	}
	if _, err := server.prepareRun(ws, "Prod", map[string]any{"dbPassword": "override"}, cliSavedRequest{URL: "{{dbPassword}}"}); err != nil || f.vaultHits.Load() != hits {
		t.Fatalf("an override still went to the provider: %v", err)
	}

	outside := newMCPServer(mcpServerOptions{workspace: f.root}, io.Discard)
	if _, err := outside.prepareRun(ws, "Prod", nil, cliSavedRequest{URL: "{{dbPassword}}"}); err == nil || !strings.Contains(err.Error(), "only for the workspace open in the Kurlo app") || !strings.Contains(err.Error(), "in variables") {
		t.Fatalf("err = %v", err)
	}
}

func TestMCPShowsLinkedRowsAndRefusesToEditThem(t *testing.T) {
	f := newLinkedFixture(t)
	listed, err := newMCPServer(mcpServerOptions{workspace: f.root, loadAppSecrets: true}, io.Discard).toolListEnvironments(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(listed)
	if !strings.Contains(string(encoded), `"key":"dbPassword","value":"[secret from vault-prod]","secret":true`) || strings.Contains(string(encoded), "must-not-be-saved") {
		t.Fatalf("list_environments = %s", encoded)
	}
	if _, err := mcpEnvironmentValueRows([]any{map[string]any{"key": "pw", "value": "", "secretRef": map[string]any{"provider": "vault-prod", "path": "secret/data/app"}}}); err == nil || !strings.Contains(err.Error(), "links to a secret manager") {
		t.Fatalf("err = %v", err)
	}
	st := &mcpStore{environments: []map[string]any{{"id": "env", "workspaceId": "ws", "name": "Prod", "values": []any{
		map[string]any{"id": 1, "key": "dbPassword", "value": "", "enabled": true, "secretRef": map[string]any{"provider": "vault-prod", "path": "secret/data/app"}},
	}}}}
	server := newMCPServer(mcpServerOptions{}, io.Discard)
	args, _ := json.Marshal(map[string]any{"environment": "Prod", "key": "dbPassword", "value": "https://evil.test"})
	if _, err := server.editSetVariable(st, args); err == nil || !strings.Contains(err.Error(), "linked to a secret manager") {
		t.Fatalf("err = %v", err)
	}
	patch := map[string]any{"values": []any{map[string]any{"key": "x", "value": "1"}}}
	if err := mcpUpdateEnvironment(st, st.environments[0], patch); err == nil || !strings.Contains(err.Error(), "secret rows") {
		t.Fatalf("err = %v", err)
	}
	if err := mcpUpdateEnvironment(st, st.environments[0], map[string]any{"secretSources": []any{}}); err == nil {
		t.Fatal("secretSources was accepted")
	}
}

const linkedLoadPayload = `{
  "loadTest": {"id": "lt", "name": "Linked", "scenarios": [{"id": "sc", "name": "Flow", "executor": {"type": "constant-vus", "vus": 1, "durationMs": 1000}, "steps": [{"id": "st", "requestId": "req"}]}], "settings": {}},
  "collection": {"id": "col", "workspaceId": "workspace-main", "name": "Shop", "defaults": {}},
  "requests": [{"id": "req", "name": "Orders", "requestType": "http", "method": "GET", "url": "https://shop.test/orders?key={{dbPassword}}", "auth": {"type": "none"}, "settings": {}}],
  "environment": {"name": "Prod", "values": [
    {"key": "dbPassword", "value": "", "enabled": true, "secret": true, "secretRef": {"provider": "vault-prod", "path": "secret/data/app", "field": "password"}},
    {"key": "broken", "value": "", "enabled": true, "secret": true, "secretRef": {"provider": "vault-prod", "path": "secret/data/missing", "field": "password"}}
  ]}
}`

func TestK6ExportReadsLinkedVariablesFromEnv(t *testing.T) {
	for _, inline := range []bool{false, true} {
		result := (&App{}).ExportLoadTestK6(linkedLoadPayload, inline)
		if result.Error != "" {
			t.Fatal(result.Error)
		}
		if !strings.Contains(result.Script, `__ENV["dbPassword"]`) && !strings.Contains(result.Script, "__ENV[name]") {
			t.Fatalf("inline=%v: the script does not read dbPassword from __ENV:\n%s", inline, result.Script)
		}
		if strings.Contains(result.Script, `"dbPassword": ""`) {
			t.Fatalf("inline=%v: an empty linked value was written into the script:\n%s", inline, result.Script)
		}
		hint := false
		for _, warning := range result.Warnings {
			hint = hint || strings.Contains(warning.Message, "dbPassword comes from a secret manager")
		}
		if !hint {
			t.Fatalf("inline=%v: no hint about the linked variable: %+v", inline, result.Warnings)
		}
	}
}

func TestLoadRunGetsLinkedValuesFromTheProvider(t *testing.T) {
	f := newLinkedFixture(t)
	plan, err := loadTestPlanFromPayload(linkedLoadPayload, "")
	if err != nil {
		t.Fatal(err)
	}
	var decoded loadTestPayload
	if err := json.Unmarshal([]byte(linkedLoadPayload), &decoded); err != nil {
		t.Fatal(err)
	}
	if err := resolveLoadTestLinkedSecrets(&plan, decoded); err != nil {
		t.Fatal(err)
	}
	var got loadtest.Variable
	for _, variable := range plan.Variables {
		if variable.Name == "dbPassword" {
			got = variable
		}
	}
	if got.Value != linkedCanary || !got.Secret {
		t.Fatalf("dbPassword = %+v", got)
	}
	if f.vaultHits.Load() != 1 {
		t.Fatalf("vault hits = %d, the unused broken link should not be fetched", f.vaultHits.Load())
	}
}

func TestMCPImportWarnsAboutPostmanVault(t *testing.T) {
	content := `{"info":{"name":"Pay","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},"item":[{"name":"Charge","request":{"method":"POST","url":"https://api.test/charge","header":[{"key":"Authorization","value":"Bearer {{vault:stripe-key}}"}]}}]}`
	bundle, err := decodeWorkspaceImport(content, "", "pay.json")
	if err != nil {
		t.Fatal(err)
	}
	warned := false
	for _, warning := range bundle.warnings {
		warned = warned || strings.Contains(warning, "Postman Vault references (stripe-key)")
	}
	if !warned {
		t.Fatalf("warnings = %v", bundle.warnings)
	}
}

func TestLoadCLIRunGetsLinkedValuesAndExportLeavesThemToK6(t *testing.T) {
	t.Setenv("KURLO_TEST_API_TOKEN", cliLinkedCanary)
	fixture, _ := writeCLILoadFixture(t, "http://127.0.0.1:1")
	root := linkCLIWorkspace(t, fixture, "http://127.0.0.1:1")
	workspaces, collections, requests, environments, err := loadCLIWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	entry := loadCLIEntries(root, workspaces, collections, "col-smoke")[0]
	value := func(plan loadtest.Plan, name string) loadtest.Variable {
		for _, variable := range plan.Variables {
			if variable.Name == name {
				return variable
			}
		}
		return loadtest.Variable{}
	}
	exported, err := buildCLILoadPlan(root, loadCLIOptions{command: "export"}, entry, requests, environments)
	if err != nil {
		t.Fatal(err)
	}
	if got := value(exported, "apiToken"); got.Value != "" || !got.Linked {
		t.Fatalf("export fetched the linked value: %+v", got)
	}
	script := loadtest.GenerateK6(exported, loadtest.Options{InlineSecrets: true}).Script
	if strings.Contains(script, cliLinkedCanary) {
		t.Fatal("the export contains the linked value")
	}
	run, err := buildCLILoadPlan(root, loadCLIOptions{command: "run"}, entry, requests, environments)
	if err != nil {
		t.Fatal(err)
	}
	if got := value(run, "apiToken"); got.Value != cliLinkedCanary || !got.Secret {
		t.Fatalf("run did not fetch the linked value: %+v", got)
	}
	if got := value(run, "unusedLink"); got.Value != "" {
		t.Fatalf("an unused link was fetched: %+v", got)
	}
	overridden, err := buildCLILoadPlan(root, loadCLIOptions{command: "run", vars: map[string]string{"apiToken": "from-ci"}}, entry, requests, environments)
	if err != nil || value(overridden, "apiToken").Value != "from-ci" {
		t.Fatalf("--var did not win: %v %+v", err, value(overridden, "apiToken"))
	}
}

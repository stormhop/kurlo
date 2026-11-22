package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	secretmgr "github.com/stormhop/kurlo/apps/desktop/internal/secrets"
)

const linkedCanary = "kurlo-canary-s3cr3t-9f2b"

type linkedFixture struct {
	app        *App
	root       string
	localPath  string
	workspace  string
	vault      *httptest.Server
	vaultHits  *atomic.Int32
	echo       *httptest.Server
	echoAuth   *atomic.Value
	dbPassword string
	ref        secretmgr.Ref
}

func linkedPayload(vaultURL string) string {
	return `{
  "version": 2,
  "activeWorkspaceId": "workspace-main",
  "workspaces": [{"id":"workspace-main","name":"Main","filesystemName":"Main","createdAt":1,"updatedAt":1}],
  "collections": [],
  "requests": [],
  "environments": [{"id":"env-prod","workspaceId":"workspace-main","name":"Prod","filesystemName":"Prod","values":[
    {"id":1,"enabled":true,"key":"dbPassword","value":"must-not-be-saved","description":"","secret":true,"secretRef":{"provider":"vault-prod","path":"secret/data/app","field":"password"}},
    {"id":2,"enabled":true,"key":"broken","value":"","description":"","secret":true,"secretRef":{"provider":"vault-prod","path":"secret/data/missing","field":"password"}},
    {"id":3,"enabled":true,"key":"plainSecret","value":"local-only","description":"","secret":true},
    {"id":4,"enabled":true,"key":"baseUrl","value":"` + vaultURL + `","description":""}
  ]}]
}`
}

func newLinkedFixture(t *testing.T) *linkedFixture {
	t.Helper()
	dir := t.TempDir()
	f := &linkedFixture{
		app:       NewApp(),
		root:      filepath.Join(dir, "workspaces"),
		localPath: filepath.Join(dir, "requests.json"),
		workspace: "workspace-main",
		vaultHits: &atomic.Int32{},
		echoAuth:  &atomic.Value{},
		ref:       secretmgr.Ref{Provider: "vault-prod", Path: "secret/data/app", Field: "password"},
	}
	f.vault = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.vaultHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("X-Vault-Token") != "hvs.test" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"errors":["permission denied"]}`))
			return
		}
		if r.URL.Path != "/v1/secret/data/app" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"errors":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":{"data":{"password":"` + linkedCanary + `"},"metadata":{"version":1}}}`))
	}))
	t.Cleanup(f.vault.Close)
	f.echo = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.echoAuth.Store(r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Echo", r.Header.Get("Authorization"))
		_ = json.NewEncoder(w).Encode(map[string]string{"authorization": r.Header.Get("Authorization"), "body": string(body), "query": r.URL.RawQuery})
	}))
	t.Cleanup(f.echo.Close)

	if err := saveKurloStorePayload(f.localPath, f.root, linkedPayload(f.vault.URL)); err != nil {
		t.Fatalf("save workspace: %v", err)
	}
	previous := linkedSecrets
	linkedSecrets = newLinkedSecretService(func() string { return f.root }, func() string { return filepath.Join(dir, "secret-providers.json") }, secretmgr.Environment{
		Getenv: func(key string) (string, bool) {
			return map[string]string{"VAULT_TOKEN": "hvs.test"}[key], key == "VAULT_TOKEN"
		},
		HomeDir:  func() (string, error) { return dir, nil },
		ReadFile: os.ReadFile,
		Now:      time.Now,
	})
	t.Cleanup(func() { linkedSecrets = previous })
	if result := f.app.SaveSecretProvider(f.workspace, map[string]any{"id": "vault-prod", "type": "vault", "name": "Vault (prod)", "address": f.vault.URL}); !result.Ok {
		t.Fatalf("SaveSecretProvider: %s", result.Error)
	}
	return f
}

func (f *linkedFixture) request(t *testing.T, mutate func(*model.HttpRequest)) model.HttpRequest {
	t.Helper()
	marker := secretmgr.Marker(f.ref)
	req := model.HttpRequest{
		RequestID:        "req-1",
		WorkspaceID:      f.workspace,
		Method:           "POST",
		URL:              f.echo.URL + "/orders?key={{dbPassword}}",
		Headers:          []model.KeyValue{},
		Auth:             model.AuthConfig{Type: "bearer", Token: "{{dbPassword}}"},
		BodyType:         "raw",
		Body:             `{"password":"{{dbPassword}}"}`,
		PreRequestScript: `console.log("pw=" + pm.environment.get("dbPassword"))`,
		TimeoutMs:        5000,
		ResolveTemplates: true,
		TemplateValues:   map[string]string{"dbPassword": marker, "broken": secretmgr.Marker(secretmgr.Ref{Provider: "vault-prod", Path: "secret/data/missing", Field: "password"})},
		ScriptEnvironment: map[string]string{
			"dbPassword": marker,
			"broken":     secretmgr.Marker(secretmgr.Ref{Provider: "vault-prod", Path: "secret/data/missing", Field: "password"}),
		},
		ScriptTimeoutMs: 5000,
	}
	if mutate != nil {
		mutate(&req)
	}
	return req
}

func responseText(t *testing.T, resp any) string {
	t.Helper()
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestLinkedSecretsStayOutOfWorkspaceYAML(t *testing.T) {
	f := newLinkedFixture(t)
	text := readAllText(t, f.root)
	if strings.Contains(text, "must-not-be-saved") {
		t.Fatalf("a linked row kept its value in YAML:\n%s", text)
	}
	if !strings.Contains(text, "secretRef:") || !strings.Contains(text, "provider: vault-prod") || !strings.Contains(text, "secretProviders:") {
		t.Fatalf("YAML lost the link or the provider:\n%s", text)
	}
	local, err := os.ReadFile(f.localPath)
	if err == nil && strings.Contains(string(local), "must-not-be-saved") {
		t.Fatal("a linked row value reached the local store")
	}

	loaded, err := loadKurloStorePayload(f.localPath, f.root)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveKurloStorePayload(f.localPath, f.root, loaded); err != nil {
		t.Fatal(err)
	}
	var doc filesystemWorkspaceFile
	if err := readYAMLFile(filepath.Join(f.root, fileStoreWorkspacesDir, "Main", fileStoreRootFileName), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.SecretProviders) != 1 || doc.SecretProviders[0]["id"] != "vault-prod" {
		t.Fatalf("a save from the app dropped secretProviders: %+v", doc.SecretProviders)
	}
	var decoded struct {
		Environments []struct {
			Values []map[string]any `json:"values"`
		} `json:"environments"`
	}
	if err := json.Unmarshal([]byte(loaded), &decoded); err != nil || len(decoded.Environments) != 1 {
		t.Fatalf("decode loaded payload: %v", err)
	}
	if ref, ok := secretmgr.RefFromMap(decoded.Environments[0].Values[0]["secretRef"]); !ok || ref != f.ref {
		t.Fatalf("loaded payload lost the secretRef: %+v", decoded.Environments[0].Values[0])
	}

	var renamed map[string]any
	if err := json.Unmarshal([]byte(loaded), &renamed); err != nil {
		t.Fatal(err)
	}
	renamed["workspaces"].([]any)[0].(map[string]any)["filesystemName"] = "Renamed"
	payload, _ := json.Marshal(renamed)
	if err := saveKurloStorePayload(f.localPath, f.root, string(payload)); err != nil {
		t.Fatal(err)
	}
	dirs := workspaceDirsByID(filepath.Join(f.root, fileStoreWorkspacesDir))
	if providers := readWorkspaceSecretProviders(dirs[f.workspace]); len(providers) != 1 {
		t.Fatalf("renaming the workspace folder dropped secretProviders: %+v in %v", providers, dirs)
	}
}

func TestPreflightCollectionRunnerReportsLinkedSecretFailuresWithoutReturningValues(t *testing.T) {
	f := newLinkedFixture(t)
	valid := f.request(t, nil)
	broken := f.request(t, func(req *model.HttpRequest) {
		req.URL = f.echo.URL
		req.Auth = model.AuthConfig{}
		req.Headers = []model.KeyValue{{Key: "Authorization", Value: secretmgr.Marker(secretmgr.Ref{Provider: "vault-prod", Path: "secret/data/missing", Field: "password"}), Enabled: true}}
		req.TemplateValues = nil
		req.ScriptEnvironment = nil
		req.Body = ""
	})
	plain := f.request(t, func(req *model.HttpRequest) {
		req.URL = f.echo.URL
		req.Auth = model.AuthConfig{}
		req.TemplateValues = nil
		req.ScriptEnvironment = nil
		req.Headers = nil
		req.Body = "plain"
	})
	results := f.app.PreflightCollectionRunner(f.workspace, []RunnerSecretCheck{
		{RequestID: "plain", HTTP: &plain},
		{RequestID: "valid", HTTP: &valid},
		{RequestID: "broken", HTTP: &broken},
	})
	if len(results) != 3 {
		t.Fatalf("expected one result per request, got %d", len(results))
	}
	if results[0].RequestID != "plain" || len(results[0].Failures) != 0 {
		t.Fatalf("request without links failed preflight: %+v", results[0])
	}
	if results[1].RequestID != "valid" || len(results[1].Failures) != 0 {
		t.Fatalf("valid linked request failed preflight: %+v", results[1])
	}
	if results[2].RequestID != "broken" || len(results[2].Failures) != 1 || results[2].Failures[0].Path != "secret/data/missing" {
		t.Fatalf("broken linked request was not reported: %+v", results[2])
	}
	if strings.Contains(responseText(t, results), linkedCanary) {
		t.Fatal("preflight result returned a resolved secret value")
	}
}

func TestPreflightCollectionRunnerBlocksOnWorkspaceErrors(t *testing.T) {
	f := newLinkedFixture(t)
	req := f.request(t, nil)
	results := f.app.PreflightCollectionRunner("workspace-missing", []RunnerSecretCheck{{RequestID: "linked", HTTP: &req}})
	if len(results) != 1 || len(results[0].Failures) != 1 || results[0].Failures[0].Kind != "preflight-error" {
		t.Fatalf("workspace lookup error was not blocking: %+v", results)
	}
}

func TestLinkedSecretDiagnostics(t *testing.T) {
	envs := []map[string]any{{"name": "Prod", "values": []any{
		map[string]any{"key": "a", "secretRef": map[string]any{"provider": "gone", "path": "x"}},
		map[string]any{"key": "b", "secretRef": map[string]any{"provider": "vault-prod"}},
		map[string]any{"key": "c", "secretRef": map[string]any{"provider": "vault-prod", "path": "ok"}},
	}}}
	diagnostics := secretProviderDiagnostics("/root", "/root/workspaces/Main", "ws", []map[string]any{{"id": "vault-prod", "type": "vault", "address": "https://v"}, {"id": "bad", "type": "nope"}}, envs)
	text := responseText(t, diagnostics)
	for _, want := range []string{`unsupported type \"nope\"`, `links to secret provider \"gone\"`, `\"b\" in environment \"Prod\" has a secretRef without provider or path`} {
		if !strings.Contains(text, want) {
			t.Errorf("diagnostics miss %s: %s", want, text)
		}
	}
	if strings.Contains(text, `\"c\"`) {
		t.Errorf("a valid link produced a diagnostic: %s", text)
	}
	for _, diagnostic := range diagnostics {
		if diagnostic.Blocking {
			t.Errorf("secret diagnostics must not block loading: %+v", diagnostic)
		}
	}
}

func TestUntrustedProviderBlocksTheRequest(t *testing.T) {
	f := newLinkedFixture(t)
	if result := f.app.RevokeSecretProviderTrust(f.workspace, "vault-prod"); !result.Ok {
		t.Fatal(result.Error)
	}
	resp := f.app.SendRequest(f.request(t, nil))
	if !strings.HasPrefix(resp.Error, "Request not sent") || len(resp.LinkedSecretFailures) != 1 || resp.LinkedSecretFailures[0].Kind != "untrusted" {
		t.Fatalf("response = %+v", resp)
	}
	if f.vaultHits.Load() != 0 {
		t.Fatalf("an untrusted provider got %d requests", f.vaultHits.Load())
	}
	if f.echoAuth.Load() != nil {
		t.Fatal("the request was sent although its secret was not resolved")
	}
	list := f.app.ListSecretProviders(f.workspace)
	if len(list.Providers) != 1 || list.Providers[0].Trusted || len(list.Providers[0].UsedBy) != 2 {
		t.Fatalf("ListSecretProviders = %+v", list)
	}
}

func TestLinkedSecretIsSentAndMaskedEverywhere(t *testing.T) {
	f := newLinkedFixture(t)
	resp := f.app.SendRequest(f.request(t, nil))
	if resp.Error != "" {
		t.Fatalf("send: %s", resp.Error)
	}
	if got, _ := f.echoAuth.Load().(string); got != "Bearer "+linkedCanary {
		t.Fatalf("server saw Authorization %q", got)
	}
	text := responseText(t, resp)
	if strings.Contains(text, linkedCanary) {
		t.Fatalf("the linked value leaked into the response: %s", text)
	}
	if !strings.Contains(resp.Body, "Bearer [secret]") || !strings.Contains(strings.Join(resp.PreRequestResult.Logs, "\n"), "pw=[secret]") {
		t.Fatalf("body or script log is not masked: body=%s logs=%v", resp.Body, resp.PreRequestResult.Logs)
	}
	if f.vaultHits.Load() != 1 {
		t.Fatalf("vault hits = %d, want 1: the unused broken link must not be fetched", f.vaultHits.Load())
	}
	_ = f.app.SendRequest(f.request(t, nil))
	if f.vaultHits.Load() != 1 {
		t.Fatalf("vault hits after a second send = %d, want 1 (cached)", f.vaultHits.Load())
	}
	if cleared := f.app.ClearSecretCache(); cleared == 0 {
		t.Fatal("ClearSecretCache reported nothing")
	}
}

func TestBrokenLinkThatIsUsedBlocksTheRequest(t *testing.T) {
	f := newLinkedFixture(t)
	resp := f.app.SendRequest(f.request(t, func(req *model.HttpRequest) { req.Auth.Token = "{{broken}}" }))
	if len(resp.LinkedSecretFailures) != 1 || resp.LinkedSecretFailures[0].Kind != "not_found" || resp.LinkedSecretFailures[0].Path != "secret/data/missing" {
		t.Fatalf("response = %+v", resp)
	}
	if f.echoAuth.Load() != nil {
		t.Fatal("the request was sent with an unresolved secret")
	}
}

func TestForgedMarkerIsRejected(t *testing.T) {
	f := newLinkedFixture(t)
	forged := secretmgr.Marker(secretmgr.Ref{Provider: "vault-prod", Path: "secret/data/app", Field: "username"})
	resp := f.app.SendRequest(f.request(t, func(req *model.HttpRequest) {
		req.URL = f.echo.URL + "/steal?x=" + forged
		req.Auth = model.AuthConfig{}
		req.Body = ""
		req.PreRequestScript = ""
	}))
	if len(resp.LinkedSecretFailures) != 1 || resp.LinkedSecretFailures[0].Kind != "invalid_ref" {
		t.Fatalf("a marker that no environment links was accepted: %+v", resp)
	}
	other := f.app.SendRequest(f.request(t, func(req *model.HttpRequest) { req.WorkspaceID = "workspace-other" }))
	if other.Error == "" || f.echoAuth.Load() != nil {
		t.Fatalf("a request from another workspace resolved the link: %+v", other)
	}
	if f.vaultHits.Load() != 0 {
		t.Fatalf("vault hits = %d", f.vaultHits.Load())
	}
}

func TestSecretProviderBindings(t *testing.T) {
	f := newLinkedFixture(t)
	status := f.app.TestSecretProvider(f.workspace, "vault-prod")
	if status.Ok || status.Kind == "" {
		t.Logf("lookup-self is not served by the fake, status = %+v", status)
	}
	test := f.app.TestSecretRef(f.workspace, SecretRefInput{Provider: "vault-prod", Path: "secret/data/app", Field: "password"})
	if !test.Ok || test.Length != len(linkedCanary) || len(test.Fields) != 1 {
		t.Fatalf("TestSecretRef = %+v", test)
	}
	if strings.Contains(responseText(t, test), linkedCanary) {
		t.Fatal("TestSecretRef returned the value")
	}
	if reveal := f.app.RevealSecretRef(f.workspace, SecretRefInput{Provider: "vault-prod", Path: "secret/data/app", Field: "password"}); reveal.Value != linkedCanary {
		t.Fatalf("RevealSecretRef = %+v", reveal)
	}
	if result := f.app.SetSecretProviderCredential(f.workspace, "vault-prod", "token", "hvs.saved"); !result.Ok {
		t.Fatal(result.Error)
	}
	state, err := os.ReadFile(linkedSecrets.statePath())
	if err != nil || strings.Contains(string(state), "hvs.saved") {
		t.Fatalf("the device state is not encrypted: %v %s", err, state)
	}
	if names := f.app.ListSecretProviders(f.workspace).Providers[0].SavedCredentials; len(names) != 1 || names[0] != "token" {
		t.Fatalf("saved credentials = %v", names)
	}
	if result := f.app.SetSecretProviderCredential(f.workspace, "vault-prod", "apiKey", "x"); result.Ok {
		t.Fatal("an unknown credential name was accepted")
	}
	if result := f.app.SaveSecretProvider(f.workspace, map[string]any{"id": "Bad ID", "type": "vault"}); result.Ok {
		t.Fatal("an invalid provider was saved")
	}
	if result := f.app.SaveSecretProvider(f.workspace, map[string]any{"id": "vault-prod", "type": "vault", "address": "https://moved.example.test"}); !result.Ok {
		t.Fatal(result.Error)
	}
	if !f.app.ListSecretProviders(f.workspace).Providers[0].Trusted {
		t.Fatal("a provider saved in the app must be trusted on this device")
	}
	if result := f.app.DeleteSecretProvider(f.workspace, "vault-prod"); !result.Ok {
		t.Fatal(result.Error)
	}
	if list := f.app.ListSecretProviders(f.workspace); len(list.Providers) != 0 {
		t.Fatalf("providers after delete = %+v", list.Providers)
	}
}

func TestBrowseAndNewProviderBindings(t *testing.T) {
	f := newLinkedFixture(t)
	browse := f.app.BrowseSecretProvider(f.workspace, "vault-prod", "")
	if browse.Ok || browse.Kind != "not_found" || browse.Entries == nil {
		t.Fatalf("browse on a Vault without the mounts endpoint = %+v", browse)
	}
	if result := f.app.SaveSecretProvider(f.workspace, map[string]any{"id": "pass", "type": "command", "command": []any{"pass", "show", "{path}"}}); !result.Ok {
		t.Fatal(result.Error)
	}
	if result := f.app.SaveSecretProvider(f.workspace, map[string]any{"id": "az", "type": "azure-key-vault", "address": "https://team.vault.azure.net", "auth": map[string]any{"method": "client-secret", "tenantId": "11111111-1111-1111-1111-111111111111", "clientId": "22222222-2222-2222-2222-222222222222"}}); !result.Ok {
		t.Fatal(result.Error)
	}
	if browse := f.app.BrowseSecretProvider(f.workspace, "pass", ""); browse.Ok || browse.Kind != "invalid_ref" {
		t.Fatalf("browse on a command provider = %+v", browse)
	}
	if result := f.app.SetSecretProviderCredential(f.workspace, "az", "serviceAccountKey", "value"); result.Ok || !strings.Contains(result.Error, "JSON key file") {
		t.Fatalf("a non-JSON service account key was saved: %+v", result)
	}
	if result := f.app.SetSecretProviderCredential(f.workspace, "az", "clientSecret", "two words"); result.Ok || !strings.Contains(result.Error, "spaces") {
		t.Fatalf("a client secret with a space was saved: %+v", result)
	}
	for name, value := range map[string]string{"clientSecret": "value", "serviceAccountKey": `{"type":"authorized_user","refresh_token":"r"}`} {
		if result := f.app.SetSecretProviderCredential(f.workspace, "az", name, value); !result.Ok {
			t.Fatalf("%s: %s", name, result.Error)
		}
	}
	providers := f.app.ListSecretProviders(f.workspace).Providers
	var command SecretProviderView
	for _, provider := range providers {
		if provider.ID == "pass" {
			command = provider
		}
	}
	if !command.Valid || !command.Trusted || fmt.Sprint(command.Config["command"]) != "[pass show {path}]" {
		t.Fatalf("command provider = %+v", command)
	}
	data, err := os.ReadFile(filepath.Join(f.root, fileStoreWorkspacesDir, "Main", fileStoreRootFileName))
	if err != nil || !strings.Contains(string(data), "- '{path}'") && !strings.Contains(string(data), `- "{path}"`) {
		t.Fatalf("workspace.yml = %s, %v", data, err)
	}
}

func TestTrustFollowsTheProviderSettings(t *testing.T) {
	f := newLinkedFixture(t)
	path := filepath.Join(f.root, fileStoreWorkspacesDir, "Main", fileStoreRootFileName)
	var doc filesystemWorkspaceFile
	if err := readYAMLFile(path, &doc); err != nil {
		t.Fatal(err)
	}
	doc.SecretProviders[0]["address"] = "https://evil.example.test"
	time.Sleep(10 * time.Millisecond)
	if err := writeYAMLFile(path, doc); err != nil {
		t.Fatal(err)
	}
	resp := f.app.SendRequest(f.request(t, nil))
	if len(resp.LinkedSecretFailures) != 1 || resp.LinkedSecretFailures[0].Kind != "untrusted" {
		t.Fatalf("a changed address kept the old trust: %+v", resp)
	}
}

func TestRealtimeMessagesResolveLinkedSecrets(t *testing.T) {
	f := newLinkedFixture(t)
	f.app.realtimeWorkspaces.Store("session-1", f.workspace)
	msg := model.WebSocketSendMessage{Type: "text", Data: "auth " + secretmgr.Marker(f.ref)}
	if err := f.app.linkSecretsIntoRealtime("session-1", &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Data != "auth "+linkedCanary {
		t.Fatalf("message = %q", msg.Data)
	}
	other := model.WebSocketSendMessage{Type: "text", Data: secretmgr.Marker(f.ref)}
	if err := f.app.linkSecretsIntoRealtime("unknown-session", &other); err == nil {
		t.Fatal("a session without a workspace resolved a link")
	}
}

func TestRealtimeEventsHideLinkedValues(t *testing.T) {
	rememberRealtimeSecrets("session-mask", []string{linkedCanary})
	t.Cleanup(func() { linkedRealtimeValues.Delete("session-mask") })
	batch := model.WebSocketBatchPayload{SessionID: "session-mask", Events: []model.WebSocketMessage{{Data: "echo " + linkedCanary}}}
	redacted := redactRealtimePayload("session-mask", batch).(model.WebSocketBatchPayload)
	if redacted.Events[0].Data != "echo [secret]" {
		t.Fatalf("event = %q", redacted.Events[0].Data)
	}
	open := redactRealtimePayload("session-mask", model.SSEOpenEvent{SessionID: "session-mask", URL: "https://api.test/?k=" + linkedCanary}).(model.SSEOpenEvent)
	if strings.Contains(open.URL, linkedCanary) {
		t.Fatalf("open event = %q", open.URL)
	}
	if untouched := redactRealtimePayload("other", model.SSEOpenEvent{URL: linkedCanary}).(model.SSEOpenEvent); untouched.URL != linkedCanary {
		t.Fatal("a session without linked secrets was changed")
	}
}

func TestResponseTimingsReportSecretLookup(t *testing.T) {
	f := newLinkedFixture(t)
	resp := f.app.SendRequest(f.request(t, nil))
	if resp.Error != "" || resp.Timings.Secrets <= 0 {
		t.Fatalf("secrets timing = %v, error = %s", resp.Timings.Secrets, resp.Error)
	}
	plain := f.app.SendRequest(f.request(t, func(req *model.HttpRequest) {
		req.Auth = model.AuthConfig{}
		req.URL = f.echo.URL
		req.Body = ""
		req.PreRequestScript = ""
		req.TemplateValues = nil
		req.ScriptEnvironment = nil
	}))
	if plain.Timings.Secrets != 0 {
		t.Fatalf("a request without links reported %v ms of secret lookup", plain.Timings.Secrets)
	}
}

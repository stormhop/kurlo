package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	secretmgr "github.com/stormhop/kurlo/apps/desktop/internal/secrets"
)

func TestUsedCLISecretVariables(t *testing.T) {
	const key = "token"
	rows := map[string]secretmgr.Ref{key: {Provider: "vault", Path: "db"}}
	for _, test := range []struct {
		name    string
		request cliSavedRequest
		want    bool
	}{
		{"disabled header", cliSavedRequest{Headers: []cliKV{{Key: "X-Test", Value: "{{token}}"}}}, false},
		{"notes", cliSavedRequest{RequestNotes: "example {{token}}"}, false},
		{"quoted JSON key", cliSavedRequest{BodyType: "json", BodyContent: `{"token": 42}`}, false},
		{"unused alias", cliSavedRequest{URL: "/public"}, false},
		{"request override", cliSavedRequest{URL: "/{{token}}", Vars: []cliKV{{Enabled: true, Key: key, Value: "override"}}}, false},
		{"nested alias", cliSavedRequest{URL: "/{{outer}}"}, true},
		{"active header", cliSavedRequest{Headers: []cliKV{{Enabled: true, Key: "X-Test", Value: "{{token}}"}}}, true},
		{"explicit environment script", cliSavedRequest{Vars: []cliKV{{Enabled: true, Key: key, Value: "override"}}, TestScriptJs: `pm.environment.get("token")`}, true},
		{"local script override", cliSavedRequest{Vars: []cliKV{{Enabled: true, Key: key, Value: "override"}}, TestScriptJs: `pm.variables.get("token")`}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			linked := (&cliLinkedSecrets{}).onlyFor(&test.request)
			got := linked.needed(map[string]string{"alias": "{{token}}", "outer": "{{alias}}"}, rows)
			if got[key] != test.want {
				t.Fatalf("needed = %v", got)
			}
		})
	}
}

func TestSecretPreflightSendsNothingForEmptyValues(t *testing.T) {
	server, hits := countingServer(t)
	t.Setenv("KURLO_TEST_API_TOKEN", "")
	root := writeLinkedCLIWorkspace(t, server.URL)
	var stderr bytes.Buffer
	opts, err := parseCLIArgs([]string{root, "--env", "Local"}, io.Discard, &stderr)
	if err != nil {
		t.Fatal(err)
	}
	if code := runCLI(opts); code != 2 || hits.Load() != 0 || !strings.Contains(stderr.String(), "empty value") {
		t.Fatalf("CLI exit %d, received %d: %s", code, hits.Load(), stderr.String())
	}
	f := newLinkedFixture(t)
	vault := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"data":{"data":{"password":""},"metadata":{"version":1}}}`)
	}))
	t.Cleanup(vault.Close)
	if result := f.app.SaveSecretProvider(f.workspace, map[string]any{"id": "vault-prod", "type": "vault", "address": vault.URL}); !result.Ok {
		t.Fatal(result.Error)
	}
	response := f.app.SendRequest(f.request(t, func(request *model.HttpRequest) { request.URL = server.URL }))
	if len(response.LinkedSecretFailures) != 1 || hits.Load() != 0 || response.StatusCode != 0 {
		t.Fatalf("Desktop status %d, received %d, failures %+v", response.StatusCode, hits.Load(), response.LinkedSecretFailures)
	}
}

func writeCLIEnvProvider(t *testing.T, dir string) {
	t.Helper()
	path := filepath.Join(dir, "workspace.yml")
	var document filesystemWorkspaceFile
	if err := readYAMLFile(path, &document); err != nil {
		t.Fatal(err)
	}
	document.SecretProviders = []map[string]any{{"id": "ambient", "type": "env"}}
	if err := writeYAMLFile(path, document); err != nil {
		t.Fatal(err)
	}
}

func TestOpenAPICheckOverridesLinkedHeader(t *testing.T) {
	base := driftSpec(map[string]any{"/pet": map[string]any{"get": getPetOperation("one pet")}})
	var header atomic.Value
	header.Store("")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header.Store(r.Header.Get("Authorization"))
		_ = json.NewEncoder(w).Encode(base)
	}))
	defer srv.Close()
	root := writeDriftWorkspace(t, srv.URL, base)
	dir := workspaceDirsByID(filepath.Join(root, fileStoreWorkspacesDir))["w1"]
	writeCLIEnvProvider(t, dir)
	ed := filepath.Join(dir, "environments")
	if err := os.MkdirAll(ed, 0700); err != nil {
		t.Fatal(err)
	}
	e := map[string]any{"version": 1, "environment": map[string]any{"id": "e", "workspaceId": "w1", "name": "Local", "values": []any{map[string]any{"key": "specToken", "enabled": true, "secret": true, "secretRef": map[string]any{"provider": "ambient", "path": "KURLO_TEST_SPEC_TOKEN"}}}}}
	if err := writeYAMLFile(filepath.Join(ed, "Local.yml"), e); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KURLO_TEST_SPEC_TOKEN", "linked-value")
	check := func(extra ...string) (int, string) {
		var stdout, stderr bytes.Buffer
		code := RunOpenAPICLI(append([]string{"check", "Pets", "--workspace", root, "--env", "Local"}, extra...), &stdout, &stderr)
		return code, stderr.String()
	}
	if code, errText := check(); code != 0 || header.Load() != "Bearer linked-value" {
		t.Fatalf("positive control: code %d header %v err %s", code, header.Load(), errText)
	}
	if err := os.Unsetenv("KURLO_TEST_SPEC_TOKEN"); err != nil {
		t.Fatal(err)
	}
	header.Store("")
	code, msg := check("--var", "specToken=manual")
	if code != 0 || header.Load() != "Bearer manual" {
		t.Errorf("override: code %d header=%q error=%s", code, header.Load(), msg)
	}
	envfile := filepath.Join(t.TempDir(), "local.env")
	if err := os.WriteFile(envfile, []byte("specToken=file\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if code, msg := check("--env-file", envfile); code != 0 || header.Load() != "Bearer file" {
		t.Fatalf("env-file control: code=%d err=%s header=%q", code, msg, header.Load())
	}
}

func TestCLISecretSelectionIsScopedToEachWorkspace(t *testing.T) {
	root, demoID, otherID := twoWorkspaceFolder(t)
	store, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	server, hits := countingServer(t)
	store.requests = nil
	for _, collection := range store.collections {
		url := server.URL
		if collection["workspaceId"] == demoID {
			url += "?token={{token}}"
		}
		store.requests = append(store.requests, map[string]any{"id": "req-" + stringValue(collection, "id"), "name": "Read", "requestType": "http", "method": "GET", "collectionId": collection["id"], "url": url})
	}
	store.environments = []map[string]any{
		{"id": "demo-env", "name": "Local", "workspaceId": demoID, "values": []any{map[string]any{"key": "token", "value": "local", "enabled": true}}},
		{"id": "other-env", "name": "Local", "workspaceId": otherID, "values": []any{map[string]any{"key": "token", "enabled": true, "secretRef": map[string]any{"provider": "ambient", "path": "KURLO_TEST_UNUSED_TOKEN"}}}},
	}
	if err := store.save(); err != nil {
		t.Fatal(err)
	}
	writeCLIEnvProvider(t, workspaceDirsByID(filepath.Join(root, fileStoreWorkspacesDir))[otherID])
	t.Setenv("KURLO_TEST_UNUSED_TOKEN", "")
	var stderr bytes.Buffer
	opts, err := parseCLIArgs([]string{root, "--env", "Local"}, io.Discard, &stderr)
	if err != nil {
		t.Fatal(err)
	}
	if code := runCLI(opts); code != 0 || int(hits.Load()) != len(store.requests) {
		t.Fatalf("exit %d, hits %d: %s", code, hits.Load(), stderr.String())
	}
}

func TestRunCLIDisabledImportStopsBeforePublicRequest(t *testing.T) {
	server, hits := countingServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	store, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	store.environments[0]["secretSources"] = []any{
		map[string]any{"provider": "ambient", "path": "KURLO_TEST_DB", "prefix": "db_"},
	}
	for _, request := range store.requests {
		request["url"] = server.URL
		if request["id"] == "req-fail" {
			request["url"] = server.URL + "/{{db_token}}"
		}
		delete(request, "testScriptJs")
	}
	if err := store.save(); err != nil {
		t.Fatal(err)
	}
	writeCLIEnvProvider(t, workspaceDirsByID(filepath.Join(root, fileStoreWorkspacesDir))["ws-demo"])
	var stderr bytes.Buffer
	opts, err := parseCLIArgs([]string{root, "--env", "Local", "--secret-providers=off"}, io.Discard, &stderr)
	if err != nil {
		t.Fatal(err)
	}
	if code := runCLI(opts); code != 2 || hits.Load() != 0 || !strings.Contains(stderr.String(), "--var db_token=") {
		t.Fatalf("exit %d, hits %d: %s", code, hits.Load(), stderr.String())
	}
	opts.vars["db_token"] = "manual"
	if code := runCLI(opts); code != 0 || hits.Load() != 2 {
		t.Fatalf("override exit %d, hits %d: %s", code, hits.Load(), stderr.String())
	}
}

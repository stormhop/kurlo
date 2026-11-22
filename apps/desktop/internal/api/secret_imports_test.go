package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	secretmgr "github.com/stormhop/kurlo/apps/desktop/internal/secrets"
)

func TestSecretSourcesRoundTripThroughWorkspaceYAML(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "workspaces")
	payload := `{
  "version": 2,
  "activeWorkspaceId": "workspace-main",
  "workspaces": [{"id":"workspace-main","name":"Main","filesystemName":"Main","createdAt":1,"updatedAt":1}],
  "collections": [],
  "requests": [],
  "environments": [{"id":"env-prod","workspaceId":"workspace-main","name":"Prod","filesystemName":"Prod","values":[],
    "secretSources":[{"provider":"vault-prod","path":"secret/data/app","prefix":"db_","keys":["user","password"]}]}]
}`
	if err := saveKurloStorePayload(filepath.Join(dir, "requests.json"), root, payload); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "workspaces", "Main", "environments", "Prod.yml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"secretSources:", "provider: vault-prod", "path: secret/data/app", "prefix: db_", "- user", "- password"} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("environment YAML is missing %q:\n%s", want, data)
		}
	}
	_, _, _, environments, _, _, err := loadFilesystemWorkspaceStoreWithDiagnostics(root, map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if len(environments) != 1 || environments[0]["secretSources"] == nil {
		t.Fatalf("environments = %+v", environments)
	}
}

func (f *linkedFixture) setSecretSources(t *testing.T, sources []any) {
	t.Helper()
	path := filepath.Join(f.root, fileStoreWorkspacesDir, "Main", fileStoreEnvironmentsDir, "Prod.yml")
	var doc filesystemEnvironmentFile
	if err := readYAMLFile(path, &doc); err != nil {
		t.Fatal(err)
	}
	environment := doc.Environment.(map[string]any)
	environment["values"] = []any{map[string]any{"id": 4, "enabled": true, "key": "baseUrl", "value": f.vault.URL, "description": ""}}
	environment["secretSources"] = sources
	time.Sleep(10 * time.Millisecond)
	if err := writeYAMLFile(path, doc); err != nil {
		t.Fatal(err)
	}
}

func TestImportedSecretKeysAreAuthorizedAndSent(t *testing.T) {
	f := newLinkedFixture(t)
	f.setSecretSources(t, []any{map[string]any{"provider": "vault-prod", "path": "secret/data/app", "prefix": "db_"}})
	resp := f.app.SendRequest(f.request(t, nil))
	if resp.Error != "" || f.echoAuth.Load() != "Bearer "+linkedCanary {
		t.Fatalf("an imported key was not sent: %q, auth %v", resp.Error, f.echoAuth.Load())
	}
	if strings.Contains(responseText(t, resp), linkedCanary) {
		t.Fatal("the response shows the imported value")
	}
	other := f.request(t, func(req *model.HttpRequest) {
		req.Auth.Token = secretmgr.Marker(secretmgr.Ref{Provider: "vault-prod", Path: "secret/data/other", Field: "password"})
	})
	if resp := f.app.SendRequest(other); len(resp.LinkedSecretFailures) != 1 || resp.LinkedSecretFailures[0].Kind != "invalid_ref" {
		t.Fatalf("a path outside the source was accepted: %+v", resp)
	}

	f.setSecretSources(t, []any{map[string]any{"provider": "vault-prod", "path": "secret/data/app", "keys": []any{"username"}}})
	if resp := f.app.SendRequest(f.request(t, nil)); len(resp.LinkedSecretFailures) != 1 || resp.LinkedSecretFailures[0].Kind != "invalid_ref" {
		t.Fatalf("a key outside the keys filter was accepted: %+v", resp)
	}
}

func TestSecretImportKeysAreKeptOnThisDevice(t *testing.T) {
	f := newLinkedFixture(t)
	f.setSecretSources(t, []any{map[string]any{"provider": "vault-prod", "path": "secret/data/app"}})
	result := f.app.LoadSecretImportKeys(f.workspace, SecretImportInput{Provider: "vault-prod", Path: "secret/data/app"})
	if !result.Ok || len(result.Keys) != 1 || result.Keys[0] != "password" || result.LoadedAt == 0 {
		t.Fatalf("LoadSecretImportKeys = %+v", result)
	}
	reads := f.vaultHits.Load()
	reloaded := f.app.LoadSecretImportKeys(f.workspace, SecretImportInput{Provider: "vault-prod", Path: "secret/data/app"})
	if !reloaded.Ok || f.vaultHits.Load() != reads+1 {
		t.Fatalf("Load keys reused the value cache: %+v, reads %d", reloaded, f.vaultHits.Load())
	}
	linkedSecrets.resetForTests()
	listed := f.app.ListSecretImportKeys(f.workspace)
	if len(listed) != 1 || listed[0].Provider != "vault-prod" || listed[0].Path != "secret/data/app" || listed[0].Keys[0] != "password" {
		t.Fatalf("ListSecretImportKeys = %+v", listed)
	}
	state, err := os.ReadFile(filepath.Join(filepath.Dir(f.localPath), "secret-providers.json"))
	if err != nil || strings.Contains(string(state), linkedCanary) || strings.Contains(string(state), "password") {
		t.Fatalf("the device file is not encrypted or holds values: %v", err)
	}
	if other := f.app.ListSecretImportKeys("another-workspace"); len(other) != 0 {
		t.Fatalf("keys leaked to another workspace: %+v", other)
	}
	single := f.app.LoadSecretImportKeys(f.workspace, SecretImportInput{Provider: "vault-prod", Path: "secret/data/missing"})
	if single.Ok || single.Kind == "" {
		t.Fatalf("a missing secret loaded keys: %+v", single)
	}
	providers := f.app.ListSecretProviders(f.workspace)
	found := false
	for _, usage := range providers.Providers[0].UsedBy {
		found = found || (usage.Import && usage.Key == "*" && usage.Path == "secret/data/app")
	}
	if !found {
		t.Fatalf("usage misses the source: %+v", providers.Providers[0].UsedBy)
	}
}

func TestOverlappingImportKeyLoadsKeepTheNewerFields(t *testing.T) {
	f := newLinkedFixture(t)
	var reads atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reads.Add(1) == 1 {
			close(started)
			<-release
			io.WriteString(w, `{"data":{"old":"one"}}`)
			return
		}
		io.WriteString(w, `{"data":{"new":"two"}}`)
	}))
	t.Cleanup(server.Close)
	t.Cleanup(unblock)
	if result := f.app.SaveSecretProvider(f.workspace, map[string]any{"id": "vault-prod", "type": "vault", "address": server.URL}); !result.Ok {
		t.Fatal(result.Error)
	}
	input := SecretImportInput{Provider: "vault-prod", Path: "kv/app"}
	first := make(chan SecretImportKeysResult, 1)
	go func() { first <- f.app.LoadSecretImportKeys(f.workspace, input) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("first provider read did not start")
	}
	latest := f.app.LoadSecretImportKeys(f.workspace, input)
	unblock()
	earlier := <-first
	if !latest.Ok || !earlier.Ok || !slices.Equal(latest.Keys, []string{"new"}) || !slices.Equal(earlier.Keys, latest.Keys) {
		t.Fatalf("overlapping results: %+v, %+v", latest, earlier)
	}
	linkedSecrets.resetForTests()
	stored := f.app.ListSecretImportKeys(f.workspace)
	if len(stored) != 1 || !slices.Equal(stored[0].Keys, latest.Keys) || stored[0].LoadedAt != latest.LoadedAt {
		t.Fatalf("persisted keys: %+v", stored)
	}
}

func TestSecretSourceDiagnostics(t *testing.T) {
	envs := []map[string]any{{"name": "Prod", "values": []any{}, "secretSources": []any{
		map[string]any{"provider": "gone", "path": "kv/app"},
		map[string]any{"provider": "vault", "path": "kv/a", "keys": []any{"user"}},
		map[string]any{"provider": "vault", "path": "kv/b", "keys": []any{"user"}},
		map[string]any{"provider": "vault"},
	}}}
	diagnostics := secretProviderDiagnostics("/root", "/root/workspaces/Main", "ws", []map[string]any{{"id": "vault", "type": "vault", "address": "https://vault.test"}}, envs)
	var messages []string
	for _, diagnostic := range diagnostics {
		messages = append(messages, diagnostic.Message)
	}
	joined := strings.Join(messages, "\n")
	for _, want := range []string{`imports kv/app from secret provider "gone"`, "imports user from both vault:kv/a and vault:kv/b", "secretSources[3]"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("diagnostics miss %q:\n%s", want, joined)
		}
	}
}

func TestCLIExpandsSecretSources(t *testing.T) {
	t.Setenv("KURLO_TEST_DB_JSON", `{"user":"svc","pass":"`+cliLinkedCanary+`"}`)
	root := writeLinkedCLIWorkspace(t, "http://127.0.0.1:1")
	envs := []cliEnvironment{{WorkspaceID: "ws-demo", Name: "Local", Values: []cliKV{{Key: "db_user", Value: "explicit", Enabled: true}}, Sources: []any{
		map[string]any{"provider": "ci-env", "path": "KURLO_TEST_DB_JSON", "prefix": "db_"},
	}}}
	target := &cliSavedRequest{URL: "https://api.test/?u={{db_user}}&p={{db_pass}}"}
	values, secrets, err := resolveCLIValuesForWorkspace(cliOptions{env: "Local", linked: newCLILinkedSecrets(root, 0, false).onlyFor(target)}, envs, "ws-demo")
	if err != nil {
		t.Fatal(err)
	}
	if values["db_pass"] != cliLinkedCanary || values["db_user"] != "explicit" {
		t.Fatalf("values = %v", values)
	}
	if len(secrets) != 1 || secrets[0] != cliLinkedCanary {
		t.Fatalf("secrets = %v", secrets)
	}
	t.Setenv("KURLO_TEST_DB_JSON", "")
	os.Unsetenv("KURLO_TEST_DB_JSON")
	values, _, err = resolveCLIValuesForWorkspace(cliOptions{env: "Local", linked: newCLILinkedSecrets(root, 0, false).onlyFor(&cliSavedRequest{URL: "https://api.test/{{other}}"})}, envs, "ws-demo")
	if err != nil || values["db_pass"] != "" {
		t.Fatalf("a source no request uses was read: %v %v", values, err)
	}
	if _, _, err := resolveCLIValuesForWorkspace(cliOptions{env: "Local", linked: newCLILinkedSecrets(root, 0, false).onlyFor(target)}, envs, "ws-demo"); err == nil || !strings.Contains(err.Error(), "cannot list the keys of ci-env:KURLO_TEST_DB_JSON") {
		t.Fatalf("err = %v", err)
	}
	filtered := []cliEnvironment{{WorkspaceID: "ws-demo", Name: "Local", Sources: []any{
		map[string]any{"provider": "ci-env", "path": "KURLO_TEST_DB_JSON", "prefix": "db_", "keys": []any{"pass"}},
	}}}
	if _, _, err := resolveCLIValuesForWorkspace(cliOptions{env: "Local", vars: map[string]string{"db_pass": "from-ci"}, linked: newCLILinkedSecrets(root, 0, false).onlyFor(target)}, filtered, "ws-demo"); err != nil {
		t.Fatalf("--var did not override an imported key: %v", err)
	}
}

func TestCLIWholeSourceInScript(t *testing.T) {
	t.Setenv("KURLO_TEST_DB_JSON", `{"token":"value"}`)
	root := writeLinkedCLIWorkspace(t, "http://127.0.0.1:1")
	envs := []cliEnvironment{{WorkspaceID: "ws-demo", Name: "Local", Sources: []any{
		map[string]any{"provider": "ci-env", "path": "KURLO_TEST_DB_JSON", "prefix": "db_"},
	}}}
	target := &cliSavedRequest{TestScriptJs: `pm.environment.get('db_token')`}
	opts := cliOptions{env: "Local", linked: newCLILinkedSecrets(root, 0, false).onlyFor(target)}
	values, _, err := resolveCLIValuesForWorkspace(opts, envs, "ws-demo")
	if err != nil || values["db_token"] != "value" {
		t.Fatalf("script variables = %v, %v", values, err)
	}
	opts.linked = disabledLinkedSecrets("--secret-providers=off is set", "--var").onlyFor(target)
	if _, _, err = resolveCLIValuesForWorkspace(opts, envs, "ws-demo"); err == nil || !strings.Contains(err.Error(), "--var db_token=") {
		t.Fatalf("preflight error = %v", err)
	}
	opts.vars = map[string]string{"db_token": "override"}
	values, _, err = resolveCLIValuesForWorkspace(opts, envs, "ws-demo")
	if err != nil || values["db_token"] != "override" {
		t.Fatalf("override = %v, %v", values, err)
	}
}

func TestFlattenedEnvironmentsInheritSecretSources(t *testing.T) {
	flat := flattenCLIEnvironments([]cliEnvironment{
		{ID: "base", Name: "Base", Sources: []any{map[string]any{"provider": "vault", "path": "kv/base"}}},
		{ID: "prod", Name: "Prod", ParentID: "base", Sources: []any{map[string]any{"provider": "vault", "path": "kv/prod"}}},
	})
	imports, _ := secretmgr.ImportsFromAny(flat[1].Sources)
	if len(imports) != 2 || imports[0].Path != "kv/base" || imports[1].Path != "kv/prod" {
		t.Fatalf("imports = %+v", imports)
	}
}

func TestMCPListsSecretSources(t *testing.T) {
	f := newLinkedFixture(t)
	f.setSecretSources(t, []any{map[string]any{"provider": "vault-prod", "path": "secret/data/app", "prefix": "db_", "keys": []any{"user"}}})
	listed, err := newMCPServer(mcpServerOptions{workspace: f.root, loadAppSecrets: true}, io.Discard).toolListEnvironments(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(listed)
	if !strings.Contains(string(encoded), `"importedFrom":["keys user of vault-prod:secret/data/app as secret variables named db_\u003ckey\u003e"]`) {
		t.Fatalf("list_environments = %s", encoded)
	}
}

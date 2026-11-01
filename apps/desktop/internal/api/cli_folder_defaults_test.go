package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func folderDefaultsCollection() *cliCollection {
	return &cliCollection{
		ID: "col",
		Defaults: cliCollectionDefaults{
			Headers:            []cliKV{{Key: "X-Team", Value: "core", Enabled: true}, {Key: "Accept", Value: "*/*", Enabled: true}},
			Auth:               cliAuth{Type: "bearer", BearerToken: "collection-token"},
			PreRequestScriptJs: "collection-pre",
			TestScriptJs:       "collection-test",
		},
		FolderDefaults: []cliFolderDefaults{
			{ID: "f-orders", Path: []string{"Orders"}, Headers: []cliKV{{Key: "Accept", Value: "application/json", Enabled: true}}, Auth: cliAuth{Type: "bearer", BearerToken: "orders-token"}, PreRequestScriptJs: "orders-pre", TestScriptJs: "orders-test"},
			{ID: "f-write", Path: []string{"Orders", "Write"}, Headers: []cliKV{{Key: "X-Write", Value: "1", Enabled: true}}, Auth: cliAuth{Type: "inherit"}, PreRequestScriptJs: "write-pre", TestScriptJs: "write-test"},
			{ID: "f-public", Path: []string{"Public"}, Auth: cliAuth{Type: "none"}},
		},
	}
}

func folderHeaderValues(rows []cliKV) map[string]string {
	values := map[string]string{}
	for _, row := range rows {
		values[row.Key] = row.Value
	}
	return values
}

func TestApplyCollectionDefaultsLayersFoldersBetweenCollectionAndRequest(t *testing.T) {
	req := cliSavedRequest{
		FolderPath:         []string{"Orders", "Write"},
		Auth:               cliAuth{Type: "inherit"},
		Headers:            []cliKV{{Key: "X-Write", Value: "request", Enabled: true}},
		PreRequestScriptJs: "request-pre",
		TestScriptJs:       "request-test",
	}
	got := applyCollectionDefaults(req, folderDefaultsCollection())
	headers := folderHeaderValues(got.Headers)
	if headers["X-Team"] != "core" || headers["Accept"] != "application/json" || headers["X-Write"] != "request" || len(got.Headers) != 3 {
		t.Fatalf("headers = %+v", got.Headers)
	}
	if got.Auth.Type != "bearer" || got.Auth.BearerToken != "orders-token" {
		t.Fatalf("auth should come from the nearest folder that sets one: %+v", got.Auth)
	}
	if got.PreRequestScriptJs != "collection-pre\n\norders-pre\n\nwrite-pre\n\nrequest-pre" {
		t.Fatalf("pre-request order = %q", got.PreRequestScriptJs)
	}
	if got.TestScriptJs != "request-test\n\nwrite-test\n\norders-test\n\ncollection-test" {
		t.Fatalf("test order = %q", got.TestScriptJs)
	}
}

func TestApplyCollectionDefaultsHonoursAFolderWithoutAuth(t *testing.T) {
	got := applyCollectionDefaults(cliSavedRequest{FolderPath: []string{"Public"}, Auth: cliAuth{Type: "inherit"}}, folderDefaultsCollection())
	if got.Auth.Type != "none" {
		t.Fatalf("a folder set to no auth should stop the collection token: %+v", got.Auth)
	}
	own := applyCollectionDefaults(cliSavedRequest{FolderPath: []string{"Orders"}, Auth: cliAuth{Type: "basic", BasicUser: "me"}}, folderDefaultsCollection())
	if own.Auth.Type != "basic" {
		t.Fatalf("a request with its own auth keeps it: %+v", own.Auth)
	}
	outside := applyCollectionDefaults(cliSavedRequest{FolderPath: []string{"Other"}, Auth: cliAuth{Type: "inherit"}}, folderDefaultsCollection())
	if outside.Auth.BearerToken != "collection-token" {
		t.Fatalf("a folder without defaults falls back to the collection: %+v", outside.Auth)
	}
}

func TestKurloStoreKeepsFolderDefaultSecretsOutOfWorkspaceYAML(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	payload := `{
  "version": 2,
  "activeWorkspaceId": "workspace-main",
  "workspaces": [{"id":"workspace-main","name":"Main","filesystemName":"Main","createdAt":1,"updatedAt":1}],
  "collections": [{
    "id":"collection-main",
    "workspaceId":"workspace-main",
    "name":"Core",
    "filesystemName":"Core",
    "folderPaths":[["Orders"],["Public"]],
    "defaults":{},
    "folderDefaults":[
      {"id":"folder-orders","path":["Orders"],"headers":[{"id":7,"key":"X-Api-Key","value":"folder-header-secret","enabled":true,"secret":true},{"id":8,"key":"Accept","value":"application/json","enabled":true}],"auth":{"type":"bearer","bearerToken":"folder-bearer-secret"},"preRequestScriptJs":"pm.variables.set('a', 1)"},
      {"id":"folder-public","path":["Public"],"headers":[],"auth":{"type":"none","bearerToken":""}},
      {"id":"folder-empty","path":["Empty"],"headers":[],"auth":{"type":"inherit"}}
    ],
    "createdAt":1,
    "updatedAt":1
  }],
  "requests": [],
  "environments": []
}`
	if err := saveKurloStorePayload(localPath, workspaceRoot, payload); err != nil {
		t.Fatalf("save kurlo store: %v", err)
	}
	collectionText, err := os.ReadFile(filepath.Join(workspaceRoot, "workspaces", "Main", "collections", "Core", "collection.yml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(collectionText)
	for _, leaked := range []string{"folder-bearer-secret", "folder-header-secret", "folder-empty"} {
		if strings.Contains(text, leaked) {
			t.Fatalf("collection.yml should not contain %q:\n%s", leaked, text)
		}
	}
	for _, expected := range []string{
		"{{kurloSecret:collection.collection-main.folder.folder-orders.auth.bearerToken}}",
		"{{kurloSecret:collection.collection-main.folder.folder-orders.headers.row.7.value}}",
		"folderDefaults:",
		"type: none",
		"application/json",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("collection.yml is missing %q:\n%s", expected, text)
		}
	}

	loaded, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load kurlo store: %v", err)
	}
	var store struct {
		Collections []struct {
			FolderDefaults []cliFolderDefaults `json:"folderDefaults"`
		} `json:"collections"`
	}
	if err := json.Unmarshal([]byte(loaded), &store); err != nil {
		t.Fatal(err)
	}
	if len(store.Collections) != 1 || len(store.Collections[0].FolderDefaults) != 2 {
		t.Fatalf("loaded folder defaults = %+v", store.Collections)
	}
	orders, public := store.Collections[0].FolderDefaults[0], store.Collections[0].FolderDefaults[1]
	if orders.Auth.BearerToken != "folder-bearer-secret" || folderHeaderValues(orders.Headers)["X-Api-Key"] != "folder-header-secret" {
		t.Fatalf("secrets were not restored on load: %+v", orders)
	}
	if public.Auth.Type != "none" {
		t.Fatalf("a folder without auth must stay without auth, not become inherit: %+v", public.Auth)
	}
}

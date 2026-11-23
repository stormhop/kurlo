package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRequestFileYAMLRoundTripSurvivesFullStoreSave(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "workspace")
	if err := saveKurloStorePayload(requestStorePath(), root, kurloSaveFlowPayload("https://saved.example.test", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	loaded := app.LoadWorkspace()
	if loaded.Payload == "" {
		t.Fatal("workspace payload is empty")
	}
	pathHint := "workspaces/Main/collections/Core/requests/Main-request.yml"
	requestPath := filepath.Join(root, filepath.FromSlash(pathHint))
	if err := os.Chmod(requestPath, 0600); err != nil {
		t.Fatal(err)
	}
	file := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	content := strings.ReplaceAll(file.Content, "\n", "\r\n")
	content = strings.Replace(content, "url: https://saved.example.test\r\n", "url: https://edited.example.test # preserved\r\n", 1)
	content = strings.Replace(content, "request:\r\n", "request:\r\n    requestTab: headers\r\n    headers: [{key: X-On, value: one, enabled: true, description: ''}, {key: X-Off, value: two, enabled: false}]\r\n", 1)
	formatted := app.FormatRequestFileYAML(content)
	if !formatted.Ok || formatted.Content == content || !strings.Contains(formatted.Content, "# preserved\r\n") || strings.Contains(formatted.Content, "requestTab:") || strings.Contains(formatted.Content, "enabled: true") || !strings.Contains(formatted.Content, "enabled: false") {
		t.Fatalf("unexpected Beautify result: %#v", formatted)
	}
	saved := app.SaveRequestFileYAML(root, "req-main", content, file.Revision, pathHint)
	if !saved.Ok {
		t.Fatalf("save request YAML: %s", saved.Error)
	}
	if saved.Content != formatted.Content || saved.Revision != requestFileYAMLRevision(formatted.Content) {
		t.Fatalf("save and Beautify differ\nwant: %q\n got: %q", formatted.Content, saved.Content)
	}
	path := filepath.Join(root, filepath.FromSlash(saved.Path))
	disk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(disk) != formatted.Content {
		t.Fatalf("unexpected request file on disk\nwant: %q\n got: %q", formatted.Content, string(disk))
	}
	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && fileInfo.Mode().Perm() != 0600 {
		t.Fatalf("request file permissions changed: %o", fileInfo.Mode().Perm())
	}
	var request map[string]any
	if err := json.Unmarshal([]byte(saved.RequestJSON), &request); err != nil {
		t.Fatal(err)
	}
	if request["url"] != "https://edited.example.test" {
		t.Fatalf("request JSON did not include the edit: %#v", request["url"])
	}
	reopened := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !reopened.Ok || reopened.Content != saved.Content || reopened.Revision != saved.Revision {
		t.Fatalf("reopened YAML or revision differs from save: %#v", reopened)
	}
	for _, result := range []RequestFileYAMLResult{saved, reopened} {
		var hydrated map[string]any
		if err := json.Unmarshal([]byte(result.RequestJSON), &hydrated); err != nil {
			t.Fatal(err)
		}
		if _, exists := hydrated["requestTab"]; exists {
			t.Fatal("file returned a removed legacy requestTab")
		}
		rows := mapSlice(hydrated["headers"])
		if len(rows) != 2 || rows[0]["enabled"] != true || rows[0]["description"] != "" || rows[1]["enabled"] != false {
			t.Fatalf("incorrect row state returned to the form: %#v", rows)
		}
	}
	auth, ok := request["auth"].(map[string]any)
	if !ok || auth["bearerToken"] != "token-a" {
		t.Fatalf("request JSON did not resolve the existing token: %#v", request["auth"])
	}
	if strings.Contains(string(disk), "token-a") {
		t.Fatal("workspace YAML contains the plaintext token")
	}
	var store map[string]any
	if err := json.Unmarshal([]byte(loaded.Payload), &store); err != nil {
		t.Fatal(err)
	}
	requests := mapSlice(store["requests"])
	if len(requests) != 1 {
		t.Fatalf("unexpected request count: %d", len(requests))
	}
	var savedRequest map[string]any
	if err := json.Unmarshal([]byte(saved.RequestJSON), &savedRequest); err != nil {
		t.Fatal(err)
	}
	settings, ok := savedRequest["settings"].(map[string]any)
	if !ok {
		settings = map[string]any{}
		savedRequest["settings"] = settings
	}
	settings["allowSendRequest"] = false
	settings["scriptTimeoutMs"] = float64(0)
	store["requests"] = []any{savedRequest}
	collections := mapSlice(store["collections"])
	collections[0]["description"] = "Changed in an unrelated editor"
	payload, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	resetWorkspaceYAMLMemo()
	if result := app.SaveRequestStoreWithError(string(payload)); !result.Ok {
		t.Fatalf("full store save after YAML edit: %s", result.Error)
	}
	disk, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(disk) != formatted.Content {
		t.Fatalf("full store save rewrote the YAML text\nwant: %q\n got: %q", formatted.Content, string(disk))
	}
	collectionYAML, err := os.ReadFile(filepath.Join(root, "workspaces", "Main", "collections", "Core", "collection.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(collectionYAML), "Changed in an unrelated editor") {
		t.Fatal("unrelated full-store edit was not saved")
	}
}

func TestRequestFileYAMLFormatOnlySaveDoesNotRewriteCanonicalFile(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	const pathHint = "workspaces/Main/collections/Core/requests/Main-request.yml"
	file := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	if formatted := app.FormatRequestFileYAML(file.Content); !formatted.Ok || formatted.Content != file.Content {
		t.Fatalf("Beautify changed a freshly generated request: %#v", formatted)
	}
	path := filepath.Join(root, filepath.FromSlash(pathHint))
	modTime := time.Unix(1700000000, 0)
	if err := os.Chtimes(path, modTime, modTime); err != nil {
		t.Fatal(err)
	}
	draft := strings.Replace(file.Content, "url: https://api.example.test", "url: 'https://api.example.test'", 1)
	if draft == file.Content {
		t.Fatal("test did not change the URL's quote style")
	}
	saved := app.SaveRequestFileYAML(root, "req-main", draft, file.Revision, pathHint)
	if !saved.Ok || saved.Content != file.Content || saved.Revision != file.Revision {
		t.Fatalf("format-only save diverged from the saved file: %#v", saved)
	}
	stat, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !stat.ModTime().Equal(modTime) {
		t.Fatal("format-only save touched the canonical file")
	}
}

func TestRequestFileYAMLPreservesMissingLocalSecretReference(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "workspace")
	if err := saveKurloStorePayload(requestStorePath(), root, kurloSaveFlowPayload("https://saved.example.test", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	localStore, _, err := loadLocalRequestStore(requestStorePath())
	if err != nil {
		t.Fatal(err)
	}
	localStore["secrets"] = map[string]string{}
	if err := saveLocalKurloStore(requestStorePath(), localStore); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	pathHint := "workspaces/Main/collections/Core/requests/Main-request.yml"
	file := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	secretRef := "{{kurloSecret:request.req-main.auth.bearerToken}}"
	if !strings.Contains(file.Content, secretRef) || strings.Contains(file.Content, "token-a") {
		t.Fatalf("request YAML did not preserve the missing secret reference safely: %s", file.Content)
	}
	var request map[string]any
	if err := json.Unmarshal([]byte(file.RequestJSON), &request); err != nil {
		t.Fatal(err)
	}
	auth := nestedMap(request, "auth")
	if auth["bearerToken"] != secretRef {
		t.Fatalf("the request model did not preserve the missing secret reference: %#v", auth["bearerToken"])
	}
	content := strings.Replace(file.Content, "url: https://saved.example.test", "url: https://edited.example.test", 1)
	saved := app.SaveRequestFileYAML(root, "req-main", content, file.Revision, pathHint)
	if !saved.Ok {
		t.Fatalf("save request YAML with missing local secret: %s", saved.Error)
	}
	if !strings.Contains(saved.Content, secretRef) || strings.Contains(saved.Content, "token-a") {
		t.Fatalf("saved YAML changed or exposed the missing secret: %s", saved.Content)
	}
	reopened := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !reopened.Ok || !strings.Contains(reopened.Content, secretRef) || strings.Contains(reopened.Content, "token-a") {
		t.Fatalf("reopened YAML did not preserve the missing secret reference: %#v", reopened)
	}
	localStore, _, err = loadLocalRequestStore(requestStorePath())
	if err != nil {
		t.Fatal(err)
	}
	if len(stringMap(localStore["secrets"])) != 0 {
		t.Fatal("saving the request file unexpectedly changed the local secret store")
	}
}

func TestRequestFileYAMLDoesNotWriteWhenLocalStoreIsUnreadable(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "workspace")
	if err := saveKurloStorePayload(requestStorePath(), root, kurloSaveFlowPayload("https://saved.example.test", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	pathHint := "workspaces/Main/collections/Core/requests/Main-request.yml"
	file := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	path := filepath.Join(root, filepath.FromSlash(file.Path))
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(requestStorePath(), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	changed := strings.Replace(file.Content, "url: https://saved.example.test", "url: https://edited.example.test", 1)
	saved := app.SaveRequestFileYAML(root, "req-main", changed, file.Revision, pathHint)
	if saved.Ok || saved.Error == "" {
		t.Fatalf("expected an error when the local store is unreadable, got %#v", saved)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatalf("request YAML changed despite the unreadable local store\nbefore: %s\nafter: %s", before, after)
	}
}

func TestRequestFileYAMLConflictAndInvalidContentDoNotOverwrite(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "workspace")
	if err := saveKurloStorePayload(requestStorePath(), root, kurloSaveFlowPayload("https://saved.example.test", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	pathHint := "workspaces/Main/collections/Core/requests/Main-request.yml"
	file := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	path := filepath.Join(root, filepath.FromSlash(file.Path))
	changed := strings.Replace(file.Content, "https://saved.example.test", "https://outside.example.test", 1)
	if err := os.WriteFile(path, []byte(changed), 0644); err != nil {
		t.Fatal(err)
	}
	conflict := app.SaveRequestFileYAML(root, "req-main", file.Content, file.Revision, pathHint)
	if conflict.Ok || !conflict.Conflict || conflict.Content != changed || conflict.Revision != requestFileYAMLRevision(changed) {
		t.Fatalf("expected current content on conflict, got %#v", conflict)
	}
	invalid := app.SaveRequestFileYAML(root, "req-main", "version: 1\nrequest: [broken\n", conflict.Revision, pathHint)
	if invalid.Ok || invalid.Line == 0 {
		t.Fatalf("expected line diagnostic for invalid YAML, got %#v", invalid)
	}
	disk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(disk) != changed {
		t.Fatalf("invalid YAML changed the request file: %q", string(disk))
	}
	invalidExternal := "version: 1\nrequest: [broken\n"
	if err := os.WriteFile(path, []byte(invalidExternal), 0644); err != nil {
		t.Fatal(err)
	}
	invalidConflict := app.SaveRequestFileYAML(root, "req-main", file.Content, file.Revision, pathHint)
	if invalidConflict.Ok || !invalidConflict.Conflict || invalidConflict.Content != invalidExternal || invalidConflict.Revision != requestFileYAMLRevision(invalidExternal) {
		t.Fatalf("invalid disk edit did not return a conflict before YAML parsing: %#v", invalidConflict)
	}
	changedID := strings.Replace(file.Content, "id: req-main", "id: req-other", 1)
	if changedID == file.Content {
		t.Fatal("test request ID was not found in the saved YAML")
	}
	if result := app.SaveRequestFileYAML(root, "req-main", changedID, invalidConflict.Revision, pathHint); result.Ok || !strings.Contains(result.Error, `request field "id" is managed`) {
		t.Fatalf("Keep my edits accepted another request ID: %#v", result)
	}
	keepInvalid := app.SaveRequestFileYAML(root, "req-main", file.Content, invalidConflict.Revision, pathHint)
	if !keepInvalid.Ok {
		t.Fatalf("expected Keep my edits to restore the request: %#v", keepInvalid)
	}
	if keepInvalid.Content != file.Content {
		t.Fatalf("Keep my edits returned different content: %q", keepInvalid.Content)
	}
	restored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != file.Content {
		t.Fatalf("Keep my edits did not restore the request: %q", string(restored))
	}
}

func TestRequestFileYAMLRoundTripsLegacyNestedRequestPath(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "workspace")
	if err := saveKurloStorePayload(requestStorePath(), root, kurloSaveFlowPayload("https://saved.example.test", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	flatPath := filepath.Join(root, "workspaces", "Main", "collections", "Core", "requests", "Main-request.yml")
	nestedPath := filepath.Join(root, "workspaces", "Main", "collections", "Core", "requests", "legacy", "Auth", "Main-request.yml")
	if err := os.MkdirAll(filepath.Dir(nestedPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(flatPath, nestedPath); err != nil {
		t.Fatal(err)
	}
	flatHint := "workspaces/Main/collections/Core/requests/Main-request.yml"
	file := app.GetRequestFileYAML(root, "req-main", flatHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	if file.Path != "workspaces/Main/collections/Core/requests/legacy/Auth/Main-request.yml" {
		t.Fatalf("unexpected nested request path: %s", file.Path)
	}
	content := strings.Replace(file.Content, "https://saved.example.test", "https://edited.example.test", 1)
	saved := app.SaveRequestFileYAML(root, "req-main", content, file.Revision, file.Path)
	if !saved.Ok {
		t.Fatal(saved.Error)
	}
	disk, err := os.ReadFile(nestedPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(disk) != content {
		t.Fatalf("nested request did not retain the edit: %s", string(disk))
	}
	if _, err := os.Stat(flatPath); !os.IsNotExist(err) {
		t.Fatalf("legacy nested path unexpectedly created a flat file: %v", err)
	}
}

func TestRequestFileYAMLReturnsExamplesAndRejectsProtectedChanges(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "workspace")
	store, err := decodeJSONMap(kurloSaveFlowPayload("https://saved.example.test", "token-a", []string{"req-main"}, ""))
	if err != nil {
		t.Fatal(err)
	}
	request := mapSlice(store["requests"])[0]
	request["examples"] = []any{map[string]any{
		"id":        "example-one",
		"requestId": "req-main",
		"name":      "OK",
		"source":    "manual",
		"snapshot":  map[string]any{"method": "GET", "url": "https://saved.example.test"},
		"response":  map[string]any{"statusCode": 200, "status": "200 OK", "headers": []any{}, "body": "ok", "bodyMediaType": "text/plain"},
		"match":     map[string]any{"pathTemplate": "/"},
	}}
	payload, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveKurloStorePayload(requestStorePath(), root, string(payload)); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	pathHint := "workspaces/Main/collections/Core/requests/Main-request.yml"
	file := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	var hydrated map[string]any
	if err := json.Unmarshal([]byte(file.RequestJSON), &hydrated); err != nil {
		t.Fatal(err)
	}
	if len(mapSlice(hydrated["examples"])) != 1 {
		t.Fatalf("request examples were not returned: %#v", hydrated["examples"])
	}
	examplePath := filepath.Join(root, "workspaces", "Main", "collections", "Core", "examples", "Main-request", "OK.yml")
	exampleBefore, err := os.ReadFile(examplePath)
	if err != nil {
		t.Fatal(err)
	}
	protectedEdits := []struct {
		name          string
		content       string
		errorContains string
	}{
		{name: "request id", content: strings.Replace(file.Content, "id: req-main", "id: req-other", 1), errorContains: `request field "id" is managed`},
		{name: "boolean field", content: strings.Replace(file.Content, "request:\n", "request:\n    isPinned: \"false\"\n", 1), errorContains: "request.isPinned: Use true or false"},
		{name: "new secret literal", content: strings.Replace(file.Content, "{{kurloSecret:request.req-main.auth.bearerToken}}", "literal-secret", 1), errorContains: "edit new secret values in Auth or Vars"},
		{name: "draft request", content: strings.Replace(file.Content, "request:\n", "request:\n    isDraft: true\n", 1), errorContains: "draft requests cannot be saved"},
		{name: "file examples", content: strings.Replace(file.Content, "request:\n", "request:\n    examples: []\n", 1), errorContains: "request examples are stored separately"},
		{name: "yaml alias", content: strings.Replace(file.Content, "request:\n", "request: &request\n", 1), errorContains: "YAML aliases and anchors are not supported"},
	}
	for _, test := range protectedEdits {
		if test.content == file.Content {
			t.Fatalf("test content for %s did not change", test.name)
		}
		if result := app.SaveRequestFileYAML(root, "req-main", test.content, file.Revision, pathHint); result.Ok || !strings.Contains(result.Error, test.errorContains) {
			t.Fatalf("expected %s to fail with %q, got %#v", test.name, test.errorContains, result)
		}
	}
	updatedContent := strings.Replace(file.Content, "https://saved.example.test", "https://edited.example.test", 1)
	saved := app.SaveRequestFileYAML(root, "req-main", updatedContent, file.Revision, pathHint)
	if !saved.Ok {
		t.Fatal(saved.Error)
	}
	var after map[string]any
	if err := json.Unmarshal([]byte(saved.RequestJSON), &after); err != nil {
		t.Fatal(err)
	}
	if len(mapSlice(after["examples"])) != 1 {
		t.Fatalf("saving the request changed its examples: %#v", after["examples"])
	}
	exampleAfter, err := os.ReadFile(examplePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(exampleBefore) != string(exampleAfter) {
		t.Fatal("saving the request changed its separate example file")
	}
}

func TestRequestFileYAMLProtectsStructureAndSupportsSparseRequests(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "workspace")
	if err := saveKurloStorePayload(requestStorePath(), root, kurloSaveFlowPayload("https://saved.example.test", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	pathHint := "workspaces/Main/collections/Core/requests/Main-request.yml"
	path := filepath.Join(root, filepath.FromSlash(pathHint))
	disk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content := strings.Replace(string(disk), "version: 1\n", "version: 1\norder: 0\n", 1)
	content = strings.Replace(content, "request:\n", "request:\n    filesystemName: Main-request\n", 1)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	file := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	protectedEdits := []struct {
		name          string
		content       string
		errorContains string
	}{
		{name: "version change", content: strings.Replace(file.Content, "version: 1", "version: 2", 1), errorContains: "request file version cannot be changed"},
		{name: "version null", content: strings.Replace(file.Content, "version: 1", "version: null", 1), errorContains: "request file version cannot be changed"},
		{name: "version removal", content: strings.Replace(file.Content, "version: 1\n", "", 1), errorContains: "request file version cannot be changed"},
		{name: "order change", content: strings.Replace(file.Content, "order: 0", "order: 1", 1), errorContains: "order is managed by the collection"},
		{name: "order null", content: strings.Replace(file.Content, "order: 0", "order: null", 1), errorContains: "order is managed by the collection"},
		{name: "order removal", content: strings.Replace(file.Content, "order: 0\n", "", 1), errorContains: "order is managed by the collection"},
		{name: "request id removal", content: strings.Replace(file.Content, "    id: req-main\n", "", 1), errorContains: `request field "id" is managed`},
		{name: "request id empty", content: strings.Replace(file.Content, "    id: req-main", "    id: ''", 1), errorContains: `request field "id" is managed`},
		{name: "request id null", content: strings.Replace(file.Content, "    id: req-main", "    id: null", 1), errorContains: `request field "id" is managed`},
		{name: "collection removal", content: strings.Replace(file.Content, "    collectionId: collection-main\n", "", 1), errorContains: `request field "collectionId" is managed`},
		{name: "collection null", content: strings.Replace(file.Content, "    collectionId: collection-main", "    collectionId: null", 1), errorContains: `request field "collectionId" is managed`},
		{name: "filesystem name removal", content: strings.Replace(file.Content, "    filesystemName: Main-request\n", "", 1), errorContains: `request field "filesystemName" is managed`},
		{name: "filesystem name change", content: strings.Replace(file.Content, "    filesystemName: Main-request", "    filesystemName: Elsewhere", 1), errorContains: `request field "filesystemName" is managed`},
		{name: "filesystem name null", content: strings.Replace(file.Content, "    filesystemName: Main-request", "    filesystemName: null", 1), errorContains: `request field "filesystemName" is managed`},
	}
	for _, test := range protectedEdits {
		if test.content == file.Content {
			t.Fatalf("test content for %s did not change", test.name)
		}
		result := app.SaveRequestFileYAML(root, "req-main", test.content, file.Revision, pathHint)
		if result.Ok || !strings.Contains(result.Error, test.errorContains) {
			t.Fatalf("expected %s to fail with %q, got %#v", test.name, test.errorContains, result)
		}
		if test.name != "new secret literal" && result.Line == 0 {
			t.Fatalf("expected a source line for %s, got %#v", test.name, result)
		}
		expectedLine := 0
		switch test.name {
		case "version removal", "order removal":
			expectedLine = 1
		case "request id removal", "collection removal", "filesystem name removal":
			expectedLine = strings.Count(file.Content[:strings.Index(file.Content, "request:\n")], "\n") + 1
		}
		if expectedLine > 0 && result.Line != expectedLine {
			t.Fatalf("expected %s diagnostic on line %d, got %#v", test.name, expectedLine, result)
		}
	}
}

func TestRequestFileYAMLInlineStructuralErrorReturnsLine(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "workspace")
	if err := saveKurloStorePayload(requestStorePath(), root, kurloSaveFlowPayload("https://saved.example.test", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	pathHint := "workspaces/Main/collections/Core/requests/Main-request.yml"
	path := filepath.Join(root, filepath.FromSlash(pathHint))
	compact := "version: 1\nrequest: {id: req-main, collectionId: collection-main, filesystemName: Main-request, auth: {type: none}, bodyType: none, folderPath: [Auth], name: Main request, requestType: http, url: https://saved.example.test}\n"
	if err := os.WriteFile(path, []byte(compact), 0644); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	file := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	changed := strings.Replace(file.Content, "id: req-main", "id: req-other", 1)
	result := app.SaveRequestFileYAML(root, "req-main", changed, file.Revision, pathHint)
	if result.Ok || !strings.Contains(result.Error, `request field "id" is managed`) || result.Line != 2 {
		t.Fatalf("inline structural edit returned a wrong diagnostic: %#v", result)
	}
}

func TestRequestFileYAMLReadRejectsNegativeOrder(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "workspace")
	if err := saveKurloStorePayload(requestStorePath(), root, kurloSaveFlowPayload("https://saved.example.test", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	pathHint := "workspaces/Main/collections/Core/requests/Main-request.yml"
	path := filepath.Join(root, filepath.FromSlash(pathHint))
	disk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content := strings.Replace(string(disk), "version: 1\n", "version: 1\norder: -1\n", 1)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	result := app.GetRequestFileYAML(root, "req-main", pathHint)
	if result.Ok || !strings.Contains(result.Error, "request file order cannot be negative") {
		t.Fatalf("negative request order was not rejected on read: %#v", result)
	}
}

func TestRequestFileYAMLAllowsSparseStructureAndURLProtocolChanges(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "workspace")
	if err := saveKurloStorePayload(requestStorePath(), root, kurloSaveFlowPayload("https://saved.example.test", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	pathHint := "workspaces/Main/collections/Core/requests/Main-request.yml"
	path := filepath.Join(root, filepath.FromSlash(pathHint))
	disk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content := strings.Replace(string(disk), "    collectionId: collection-main\n", "", 1)
	content = strings.Replace(content, "    requestType: http\n", "", 1)
	content = strings.Replace(content, "    url: https://saved.example.test\n", "    settings: {allowSendRequest: false, scriptTimeoutMs: 0}\n    url: https://saved.example.test\n", 1)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	file := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	structureAdditions := []struct {
		name    string
		content string
	}{
		{name: "order", content: strings.Replace(file.Content, "version: 1\n", "version: 1\norder: 0\n", 1)},
		{name: "collectionId", content: strings.Replace(file.Content, "    id: req-main\n", "    collectionId: collection-main\n    id: req-main\n", 1)},
		{name: "filesystemName", content: strings.Replace(file.Content, "    id: req-main\n", "    filesystemName: Main-request\n    id: req-main\n", 1)},
	}
	for _, addition := range structureAdditions {
		result := app.SaveRequestFileYAML(root, "req-main", addition.content, file.Revision, pathHint)
		expected := "managed by the file editor"
		if addition.name == "order" {
			expected = "managed by the collection"
		}
		if result.Ok || !strings.Contains(result.Error, expected) {
			t.Fatalf("sparse request accepted added structural field %s: %#v", addition.name, result)
		}
	}
	updated := strings.Replace(file.Content, "https://saved.example.test", "https://edited.example.test", 1)
	if saved := app.SaveRequestFileYAML(root, "req-main", updated, file.Revision, pathHint); !saved.Ok {
		t.Fatalf("sparse request could not be saved: %s", saved.Error)
	}
	file = app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	protocolChange := strings.Replace(file.Content, "https://edited.example.test", "wss://edited.example.test", 1)
	changed := app.SaveRequestFileYAML(root, "req-main", protocolChange, file.Revision, pathHint)
	if !changed.Ok {
		t.Fatalf("sparse request could not change protocol with its URL: %s", changed.Error)
	}
	var changedRequest map[string]any
	if err := json.Unmarshal([]byte(changed.RequestJSON), &changedRequest); err != nil {
		t.Fatal(err)
	}
	if changedRequest["id"] != "req-main" || changedRequest["url"] != "wss://edited.example.test" || changed.Path != pathHint {
		t.Fatalf("protocol URL change altered request identity or failed to update protocol: %#v", changedRequest)
	}
	file = app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	typedProtocol := strings.Replace(file.Content, "    url: wss://edited.example.test", "    requestType: ws\n    url: wss://edited.example.test", 1)
	changed = app.SaveRequestFileYAML(root, "req-main", typedProtocol, file.Revision, pathHint)
	if !changed.Ok {
		t.Fatalf("explicit request type could not be changed: %s", changed.Error)
	}
	var explicitlyTypedRequest map[string]any
	if err := json.Unmarshal([]byte(changed.RequestJSON), &explicitlyTypedRequest); err != nil {
		t.Fatal(err)
	}
	if explicitlyTypedRequest["requestType"] != "ws" {
		t.Fatalf("explicit request type was not saved: %#v", explicitlyTypedRequest["requestType"])
	}
	file = app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	explicitHTTP := strings.Replace(file.Content, "    requestType: ws\n", "    requestType: http\n", 1)
	changed = app.SaveRequestFileYAML(root, "req-main", explicitHTTP, file.Revision, pathHint)
	if !changed.Ok {
		t.Fatalf("explicit HTTP type could not be saved with a WebSocket URL: %s", changed.Error)
	}
	var explicitlyHTTPRequest map[string]any
	if err := json.Unmarshal([]byte(changed.RequestJSON), &explicitlyHTTPRequest); err != nil {
		t.Fatal(err)
	}
	if explicitlyHTTPRequest["requestType"] != "http" {
		t.Fatalf("explicit HTTP type was inferred from URL: %#v", explicitlyHTTPRequest["requestType"])
	}
	invalidExternal := "version: 1\nrequest: [broken\n"
	if err := os.WriteFile(path, []byte(invalidExternal), 0644); err != nil {
		t.Fatal(err)
	}
	conflict := app.SaveRequestFileYAML(root, "req-main", changed.Content, changed.Revision, pathHint)
	if conflict.Ok || !conflict.Conflict || conflict.Content != invalidExternal {
		t.Fatalf("sparse request did not surface invalid external content as a conflict: %#v", conflict)
	}
	kept := app.SaveRequestFileYAML(root, "req-main", changed.Content, conflict.Revision, pathHint)
	if !kept.Ok {
		t.Fatalf("Keep my edits failed for sparse request structure: %s", kept.Error)
	}
}

func TestRequestFileYAMLLargeCompactContentRoundTrip(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "workspace")
	if err := saveKurloStorePayload(requestStorePath(), root, kurloSaveFlowPayload("https://saved.example.test", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	pathHint := "workspaces/Main/collections/Core/requests/Main-request.yml"
	path := filepath.Join(root, filepath.FromSlash(pathHint))
	disk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	largeValue := strings.Repeat("x", 1024*1024)
	content := strings.Replace(string(disk), "    url: https://saved.example.test\n", "    settings: {allowSendRequest: false, scriptTimeoutMs: 0}\n    bodyContent: "+largeValue+"\n    url: https://saved.example.test # keep this comment\n", 1)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	file := app.GetRequestFileYAML(root, "req-main", pathHint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	if file.Content != content {
		t.Fatal("File tab changed compact YAML formatting while loading the large request")
	}
	updated := strings.Replace(file.Content, "https://saved.example.test", "https://edited.example.test", 1)
	saved := app.SaveRequestFileYAML(root, "req-main", updated, file.Revision, pathHint)
	if !saved.Ok {
		t.Fatal(saved.Error)
	}
	if !strings.Contains(saved.Content, "bodyContent: "+largeValue+"\n") || !strings.Contains(saved.Content, "allowSendRequest: false") || !strings.Contains(saved.Content, "scriptTimeoutMs: 0") || !strings.Contains(saved.Content, "https://edited.example.test # keep this comment") {
		t.Fatal("large YAML save lost the body, settings or URL comment")
	}
	if formatted := app.FormatRequestFileYAML(saved.Content); !formatted.Ok || formatted.Content != saved.Content {
		t.Fatal("Beautify changed the saved large request")
	}
}

func TestRequestFileYAMLKeepsLegacyCollection(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := writeYAMLWorkspace(t, "https://orders.test")
	const hint = "workspaces/Demo/collections/Smoke/requests/GET-1-ok.yml"
	app := NewApp()
	if opened := app.openWorkspaceRoot(root); !opened.Ok {
		t.Fatal(opened.Error)
	}
	file := app.GetRequestFileYAML(root, "req-ok", hint)
	if !file.Ok {
		t.Fatal(file.Error)
	}
	content := strings.Replace(file.Content, "/ok?", "/updated?", 1)
	saved := app.SaveRequestFileYAML(root, "req-ok", content, file.Revision, hint)
	if !saved.Ok {
		t.Fatal(saved.Error)
	}
	reopened := app.GetRequestFileYAML(root, "req-ok", hint)
	if !reopened.Ok || !strings.Contains(reopened.Content, "/updated?") || !strings.Contains(reopened.Content, "collection: Smoke") {
		t.Fatalf("reopen after save: %+v", reopened)
	}
	changed := strings.Replace(reopened.Content, "collection: Smoke", "collection: Other", 1)
	if edited := app.SaveRequestFileYAML(root, "req-ok", changed, reopened.Revision, hint); edited.Ok || !strings.Contains(edited.Error, `field "collection" is managed`) {
		t.Fatalf("accepted a change of collection: %+v", edited)
	}
}

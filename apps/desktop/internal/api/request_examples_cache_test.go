package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func examplesTestPayload(name, filesystemName string, examples string) string {
	request := `{"id":"req","name":"` + name + `","filesystemName":"` + filesystemName + `","collectionId":"col","method":"GET","url":"https://example.test/orders"`
	if examples != "" {
		request += `,"examples":` + examples
	}
	request += `}`
	return `{"workspaces":[{"id":"ws","name":"Main"}],"activeWorkspaceId":"ws","collections":[{"id":"col","workspaceId":"ws","name":"API"}],"requests":[` + request + `]}`
}

const twoExamples = `[` +
	`{"id":"ex-ok","requestId":"req","name":"OK","source":"manual","snapshot":{"method":"GET","url":"https://example.test/orders"},"response":{"statusCode":200,"status":"200 OK","headers":[],"body":"{\"ok\":true}","bodyMediaType":"application/json"},"match":{"pathTemplate":"/orders"}},` +
	`{"id":"ex-missing","requestId":"req","name":"Missing","source":"manual","snapshot":{"method":"GET","url":"https://example.test/orders"},"response":{"statusCode":404,"status":"404 Not Found","headers":[],"body":"none","bodyMediaType":"text/plain"},"match":{"pathTemplate":"/orders"}}` +
	`]`

func setUpExamplesWorkspace(t *testing.T) (*App, string) {
	t.Helper()
	withRequestStoreTestKey(t)
	useTempConfigDir(t, t.TempDir())
	root := fileWorkspaceStorePath()
	t.Cleanup(func() { loadedRequestExamples.forget(root) })
	app := NewApp()
	if result := app.SaveRequestStoreWithError(examplesTestPayload("Orders", "Orders", twoExamples)); !result.Ok {
		t.Fatalf("initial save: %s", result.Error)
	}
	return app, root
}

func exampleFiles(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{}
	paths, _ := filepath.Glob(filepath.Join(root, "workspaces", "*", "collections", "*", "examples", "*", "*.yml"))
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		rel, _ := filepath.Rel(root, path)
		files[rel] = string(data)
	}
	return files
}

func exampleFilePaths(files map[string]string) []string {
	keys := make([]string, 0, len(files))
	for key := range files {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func loadedRequest(t *testing.T, payload string) map[string]any {
	t.Helper()
	store, err := decodeJSONMap(payload)
	if err != nil {
		t.Fatal(err)
	}
	requests := mapSlice(store["requests"])
	if len(requests) != 1 {
		t.Fatalf("expected one request, got %d", len(requests))
	}
	return requests[0]
}

func TestLoadWorkspaceSendsExampleCountsInsteadOfExamples(t *testing.T) {
	app, _ := setUpExamplesWorkspace(t)
	request := loadedRequest(t, app.LoadWorkspace().Payload)
	if _, ok := request["examples"]; ok {
		t.Fatalf("examples should stay in Go until asked for: %v", request["examples"])
	}
	if count, _ := request[exampleCountField].(float64); count != 2 {
		t.Fatalf("exampleCount = %v, want 2", request[exampleCountField])
	}
	examples := app.LoadRequestExamples([]string{"req", "unknown"})
	if len(examples["req"]) != 2 {
		t.Fatalf("LoadRequestExamples returned %d examples", len(examples["req"]))
	}
	if first, _ := examples["req"][0].(map[string]any); stringValue(first, "id") != "ex-ok" {
		t.Fatalf("examples lost their order: %v", examples["req"])
	}
	if got, ok := examples["unknown"]; !ok || len(got) != 0 {
		t.Fatalf("unknown request should map to an empty list, got %v", got)
	}
}

func TestSavingARequestWithoutLoadedExamplesKeepsItsExampleFiles(t *testing.T) {
	app, root := setUpExamplesWorkspace(t)
	before := exampleFiles(t, root)
	if len(before) != 2 {
		t.Fatalf("expected two example files, got %v", exampleFilePaths(before))
	}
	app.LoadWorkspace()
	payload := examplesTestPayload("Orders", "Orders", "")
	payload = strings.Replace(payload, `"url":"https://example.test/orders"`, `"url":"https://example.test/orders?page=2","exampleCount":2`, 1)
	if result := app.SaveRequestStoreWithError(payload); !result.Ok {
		t.Fatalf("save: %s", result.Error)
	}
	after := exampleFiles(t, root)
	if strings.Join(exampleFilePaths(after), ",") != strings.Join(exampleFilePaths(before), ",") {
		t.Fatalf("example files changed: before %v after %v", exampleFilePaths(before), exampleFilePaths(after))
	}
	for path, content := range before {
		if after[path] != content {
			t.Fatalf("%s changed:\n%s\n---\n%s", path, content, after[path])
		}
	}
	requestFiles, _ := filepath.Glob(filepath.Join(root, "workspaces", "*", "collections", "*", "requests", "*.yml"))
	for _, path := range requestFiles {
		data, _ := os.ReadFile(path)
		if strings.Contains(string(data), exampleCountField) {
			t.Fatalf("%s stores the exampleCount field:\n%s", path, data)
		}
	}
}

func TestSavingAnEmptyExampleListDeletesTheExamples(t *testing.T) {
	app, root := setUpExamplesWorkspace(t)
	app.LoadWorkspace()
	if result := app.SaveRequestStoreWithError(examplesTestPayload("Orders", "Orders", `[]`)); !result.Ok {
		t.Fatalf("save: %s", result.Error)
	}
	if files := exampleFiles(t, root); len(files) != 0 {
		t.Fatalf("examples should be deleted, still have %v", exampleFilePaths(files))
	}
	if request := loadedRequest(t, app.LoadWorkspace().Payload); request[exampleCountField] != nil {
		t.Fatalf("deleted examples still counted: %v", request[exampleCountField])
	}
	if result := app.SaveRequestStoreWithError(examplesTestPayload("Orders", "Orders", "")); !result.Ok {
		t.Fatalf("second save: %s", result.Error)
	}
	if files := exampleFiles(t, root); len(files) != 0 {
		t.Fatalf("deleted examples came back: %v", exampleFilePaths(files))
	}
}

func TestSavingEditedExamplesWritesThem(t *testing.T) {
	app, root := setUpExamplesWorkspace(t)
	app.LoadWorkspace()
	edited := strings.Replace(twoExamples, `"name":"Missing"`, `"name":"Gone"`, 1)
	if result := app.SaveRequestStoreWithError(examplesTestPayload("Orders", "Orders", edited)); !result.Ok {
		t.Fatalf("save: %s", result.Error)
	}
	examples := app.LoadRequestExamples([]string{"req"})["req"]
	if len(examples) != 2 {
		t.Fatalf("expected two examples, got %v", examples)
	}
	if second, _ := examples[1].(map[string]any); stringValue(second, "name") != "Gone" {
		t.Fatalf("edit not kept: %v", examples[1])
	}
	found := false
	for _, content := range exampleFiles(t, root) {
		if strings.Contains(content, "Gone") {
			found = true
		}
	}
	if !found {
		t.Fatalf("edit not written to disk")
	}
}

func TestRenamingARequestMovesItsUnloadedExamples(t *testing.T) {
	app, root := setUpExamplesWorkspace(t)
	app.LoadWorkspace()
	if result := app.SaveRequestStoreWithError(examplesTestPayload("Orders list", "Orders-list", "")); !result.Ok {
		t.Fatalf("save: %s", result.Error)
	}
	files := exampleFiles(t, root)
	if len(files) != 2 {
		t.Fatalf("expected two example files after rename, got %v", exampleFilePaths(files))
	}
	for path := range files {
		if !strings.Contains(path, filepath.Join("examples", "Orders-list")) {
			t.Fatalf("example left under the old name: %s", path)
		}
	}
	result := app.LoadWorkspace()
	if len(result.Diagnostics) != 0 {
		t.Fatalf("rename left diagnostics: %+v", result.Diagnostics)
	}
	if count, _ := loadedRequest(t, result.Payload)[exampleCountField].(float64); count != 2 {
		t.Fatalf("exampleCount after rename = %v", count)
	}
}

func TestSavingWithoutALoadedCacheReadsExamplesFromDisk(t *testing.T) {
	app, root := setUpExamplesWorkspace(t)
	app.LoadWorkspace()
	loadedRequestExamples.forget(root)
	before := exampleFiles(t, root)
	if result := NewApp().SaveRequestStoreWithError(examplesTestPayload("Orders", "Orders", "")); !result.Ok {
		t.Fatalf("save: %s", result.Error)
	}
	if after := exampleFiles(t, root); strings.Join(exampleFilePaths(after), ",") != strings.Join(exampleFilePaths(before), ",") {
		t.Fatalf("examples lost without a cache: before %v after %v", exampleFilePaths(before), exampleFilePaths(after))
	}
}

func TestReplacingTheWholeStoreDoesNotBringBackOldExamples(t *testing.T) {
	app, root := setUpExamplesWorkspace(t)
	app.LoadWorkspace()
	if result := app.ReplaceRequestStoreWithError(examplesTestPayload("Orders", "Orders", "")); !result.Ok {
		t.Fatalf("replace: %s", result.Error)
	}
	if files := exampleFiles(t, root); len(files) != 0 {
		t.Fatalf("a backup without examples should not keep the old ones: %v", exampleFilePaths(files))
	}
}

func TestLoadRequestExamplesReturnsJSONTheFrontendCanUse(t *testing.T) {
	app, _ := setUpExamplesWorkspace(t)
	app.LoadWorkspace()
	encoded, err := json.Marshal(app.LoadRequestExamples([]string{"req"}))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"statusCode":404`) {
		t.Fatalf("unexpected JSON: %s", encoded)
	}
}

func TestRestoringADeletedRequestBringsBackItsUnloadedExamples(t *testing.T) {
	app, root := setUpExamplesWorkspace(t)
	app.LoadWorkspace()
	before := exampleFiles(t, root)
	empty := `{"workspaces":[{"id":"ws","name":"Main"}],"activeWorkspaceId":"ws","collections":[{"id":"col","workspaceId":"ws","name":"API"}],"requests":[]}`
	if result := app.SaveRequestStoreWithError(empty); !result.Ok {
		t.Fatalf("delete: %s", result.Error)
	}
	if files := exampleFiles(t, root); len(files) != 0 {
		t.Fatalf("deleting the request should delete its examples, still have %v", exampleFilePaths(files))
	}
	if result := app.SaveRequestStoreWithError(examplesTestPayload("Orders", "Orders", "")); !result.Ok {
		t.Fatalf("restore: %s", result.Error)
	}
	if after := exampleFiles(t, root); strings.Join(exampleFilePaths(after), ",") != strings.Join(exampleFilePaths(before), ",") {
		t.Fatalf("undo lost the examples: before %v after %v", exampleFilePaths(before), exampleFilePaths(after))
	}
}

func TestASymlinkedExampleFileIsRefusedWithADiagnostic(t *testing.T) {
	app, root := setUpExamplesWorkspace(t)
	files, _ := filepath.Glob(filepath.Join(root, "workspaces", "*", "collections", "*", "examples", "*", "*.yml"))
	if len(files) == 0 {
		t.Fatal("no example files")
	}
	outside := filepath.Join(t.TempDir(), "outside.yml")
	data, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(files[0]); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, files[0]); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	result := app.LoadWorkspace()
	found := false
	for _, diagnostic := range result.Diagnostics {
		if strings.Contains(diagnostic.Message, "refusing to read symlink") || strings.Contains(diagnostic.Path, filepath.Base(files[0])) {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a diagnostic for the symlinked example, got %+v", result.Diagnostics)
	}
}

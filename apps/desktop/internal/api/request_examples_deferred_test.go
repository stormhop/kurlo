package api

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func deferredExamplesPayload() string {
	example := func(id, request string, status int) string {
		return `{"id":"` + id + `","requestId":"` + request + `","name":"` + id + `","source":"manual","snapshot":{"method":"GET","url":"https://example.test/` + request + `"},"response":{"statusCode":` + jsonNumber(status) + `,"status":"","headers":[{"key":"Content-Type","value":"application/json"}],"body":"{\"id\":\"` + id + `\"}","bodyMediaType":"application/json"},"match":{"pathTemplate":"/` + request + `"}}`
	}
	requests := `{"id":"req-a","name":"List orders","collectionId":"col","method":"GET","url":"https://example.test/a","examples":[` + example("ex-a1", "req-a", 200) + `,` + example("ex-a2", "req-a", 404) + `]},` +
		`{"id":"req-b","name":"Get order","collectionId":"col","folderPath":["Orders","Nested"],"method":"GET","url":"https://example.test/b","examples":[` + example("ex-b1", "req-b", 200) + `]},` +
		`{"id":"req-c","name":"No examples","collectionId":"col","method":"POST","url":"https://example.test/c"},` +
		`{"id":"req-d","name":"Other collection","collectionId":"col-2","method":"GET","url":"https://example.test/d","examples":[` + example("ex-d1", "req-d", 201) + `]}`
	return `{"workspaces":[{"id":"ws","name":"Main"}],"activeWorkspaceId":"ws","collections":[{"id":"col","workspaceId":"ws","name":"API"},{"id":"col-2","workspaceId":"ws","name":"Second"}],"requests":[` + requests + `]}`
}

func jsonNumber(value int) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func setUpDeferredExamplesWorkspace(t *testing.T) (*App, string) {
	t.Helper()
	useTempConfigDir(t, t.TempDir())
	root := fileWorkspaceStorePath()
	t.Cleanup(func() {
		loadedRequestExamples.forget(root)
		loadedRequestExamples.healthy(root)
	})
	app := NewApp()
	if result := app.SaveRequestStoreWithError(deferredExamplesPayload()); !result.Ok {
		t.Fatalf("initial save: %s", result.Error)
	}
	loadedRequestExamples.forget(root)
	return app, root
}

func TestDeferredExamplesMatchTheFullLoad(t *testing.T) {
	_, root := setUpDeferredExamplesWorkspace(t)

	eager, eagerDiagnostics, err := loadKurloStoreWithDiagnostics(requestStorePath(), root)
	if err != nil || len(eagerDiagnostics) != 0 {
		t.Fatalf("eager load: %v %v", err, eagerDiagnostics)
	}
	wantExamples := moveRequestExamplesOut(eager)

	deferred := &deferredRequestExamples{}
	lazy, lazyDiagnostics, err := loadKurloStoreDeferring(requestStorePath(), root, deferred)
	if err != nil || len(lazyDiagnostics) != 0 {
		t.Fatalf("deferred load: %v %v", err, lazyDiagnostics)
	}
	wantPayload, _ := json.Marshal(eager)
	gotPayload, _ := json.Marshal(lazy)
	if string(gotPayload) != string(wantPayload) {
		t.Fatalf("deferred payload differs\n got: %s\nwant: %s", gotPayload, wantPayload)
	}
	if len(deferred.sources) != 3 {
		t.Fatalf("deferred sources = %d, want 3", len(deferred.sources))
	}
	gotExamples, healthy := deferred.load(root)
	if !healthy {
		t.Fatal("a healthy workspace was reported broken")
	}
	if !reflect.DeepEqual(gotExamples, wantExamples) {
		t.Fatalf("deferred examples differ\n got: %v\nwant: %v", gotExamples, wantExamples)
	}
}

func TestStartupLeavesExamplesForLaterAndSavesWaitForThem(t *testing.T) {
	app, root := setUpDeferredExamplesWorkspace(t)

	payload := app.LoadWorkspace().Payload
	if payload == "" {
		t.Fatal("load failed")
	}
	store, _ := decodeJSONMap(payload)
	counts := map[string]any{}
	for _, request := range mapSlice(store["requests"]) {
		counts[stringValue(request, "id")] = request[exampleCountField]
		if _, ok := request["examples"]; ok {
			t.Fatalf("examples sent at startup for %s", stringValue(request, "id"))
		}
	}
	if !reflect.DeepEqual(counts, map[string]any{"req-a": float64(2), "req-b": float64(1), "req-c": nil, "req-d": float64(1)}) {
		t.Fatalf("example counts = %v", counts)
	}

	loaded := app.LoadRequestExamples([]string{"req-a", "req-c"})
	if len(loaded["req-a"]) != 2 || len(loaded["req-c"]) != 0 {
		t.Fatalf("loaded examples = %v", loaded)
	}
	before := exampleFiles(t, root)
	if result := app.SaveRequestStoreWithError(payload); !result.Ok {
		t.Fatalf("save after deferred load: %s", result.Error)
	}
	if after := exampleFiles(t, root); !reflect.DeepEqual(after, before) || len(after) != 4 {
		t.Fatalf("example files changed by a save that did not touch them: %v", exampleFilePaths(after))
	}
}

func TestBrokenExampleFoundLaterBlocksSavesUntilAFullReload(t *testing.T) {
	app, root := setUpDeferredExamplesWorkspace(t)
	paths, _ := filepath.Glob(filepath.Join(root, "workspaces", "*", "collections", "*", "examples", "*", "*.yml"))
	if len(paths) != 4 {
		t.Fatalf("example files = %d", len(paths))
	}
	broken := paths[0]
	original, err := os.ReadFile(broken)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(broken, []byte("version: [\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reported := make(chan struct{}, 1)
	payload, diagnostics, err := loadKurloStorePayloadRemembering(requestStorePath(), root, func() { reported <- struct{}{} })
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("startup should not read example files: %v %v", err, diagnostics)
	}
	select {
	case <-reported:
	case <-time.After(5 * time.Second):
		t.Fatal("the broken example was not reported")
	}
	if _, err := requestExamplesForRoot(root); !errors.Is(err, errRequestExamplesNeedReload) {
		t.Fatalf("examples for a broken workspace: %v", err)
	}
	if result := app.SaveRequestStoreWithError(payload); result.Ok {
		t.Fatal("a save must not go through while an example file is broken")
	}
	if _, err := os.Stat(broken); err != nil {
		t.Fatalf("the broken example file is gone: %v", err)
	}

	_, diagnostics, err = loadKurloStorePayloadRemembering(requestStorePath(), root, nil)
	if err != nil || len(diagnostics) == 0 {
		t.Fatalf("the reload should read examples and report the broken file: %v %v", err, diagnostics)
	}
	if !loadedRequestExamples.needsEagerLoad(root) {
		t.Fatal("a reload with a broken example should keep reading examples up front")
	}

	if err := os.WriteFile(broken, original, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, diagnostics, err = loadKurloStorePayloadRemembering(requestStorePath(), root, nil); err != nil || len(diagnostics) != 0 {
		t.Fatalf("reload after the fix: %v %v", err, diagnostics)
	}
	if loadedRequestExamples.needsEagerLoad(root) {
		t.Fatal("a healthy reload should go back to deferred examples")
	}
}

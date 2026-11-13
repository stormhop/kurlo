package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadWorkspaceReturnsStoreAndDiagnosticsFromOneRead(t *testing.T) {
	withRequestStoreTestKey(t)
	useTempConfigDir(t, t.TempDir())
	root := fileWorkspaceStorePath()
	app := NewApp()
	if result := app.SaveRequestStoreWithError(`{"workspaces":[{"id":"ws","name":"Main"}],"activeWorkspaceId":"ws","collections":[{"id":"col","workspaceId":"ws","name":"API"}],"requests":[{"id":"req","name":"Ping","collectionId":"col","method":"GET","url":"https://example.test"}]}`); !result.Ok {
		t.Fatalf("save failed: %s", result.Error)
	}
	requestFiles, _ := filepath.Glob(filepath.Join(root, "workspaces", "*", "collections", "*", "requests", "*.yml"))
	if len(requestFiles) != 1 {
		t.Fatalf("expected one saved request file, got %v", requestFiles)
	}
	broken := filepath.Join(filepath.Dir(requestFiles[0]), "Broken.yml")
	if err := os.WriteFile(broken, []byte("name: [unclosed\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := app.LoadWorkspace()
	var store map[string]any
	if err := json.Unmarshal([]byte(result.Payload), &store); err != nil {
		t.Fatalf("payload is not JSON: %v", err)
	}
	if strings.Contains(result.Payload, "\n  ") {
		t.Fatalf("payload should be compact JSON")
	}
	if !strings.Contains(result.Payload, `"Ping"`) {
		t.Fatalf("payload misses the saved request: %s", result.Payload)
	}
	if len(result.Diagnostics) == 0 {
		t.Fatalf("expected a diagnostic for the broken file")
	}
	if separate := app.LoadWorkspaceDiagnostics(); len(separate) != len(result.Diagnostics) {
		t.Fatalf("diagnostics differ: one read %d, separate call %d", len(result.Diagnostics), len(separate))
	}
	if app.LoadRequestStore() != result.Payload {
		t.Fatalf("LoadRequestStore should return the same payload")
	}
}

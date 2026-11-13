package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openAPISyncCollections(name string) []map[string]any {
	return []map[string]any{{
		"id":          "c1",
		"workspaceId": "w1",
		"name":        name,
		"openapi":     map[string]any{"source": "https://api.example.test/openapi.json", "intervalMinutes": 15},
	}}
}

func openAPISyncWorkspaces() []map[string]any {
	return []map[string]any{{"id": "w1", "name": "Team"}}
}

func openAPISyncRequests() []map[string]any {
	return []map[string]any{{"id": "r1", "collectionId": "c1", "name": "Get pet", "method": "GET", "url": "{{baseUrl}}/pets/:id", "openapi": "GET /pets/{id}"}}
}

func TestOpenAPIBaseSpecIsWrittenNextToTheCollection(t *testing.T) {
	root := t.TempDir()
	if err := writeYAMLWorkspaceStore(root, openAPISyncWorkspaces(), openAPISyncCollections("Pets"), openAPISyncRequests(), nil, nil, nil); err != nil {
		t.Fatalf("write store: %v", err)
	}
	if err := writeOpenAPIBaseSpec(root, "c1", `{"openapi":"3.0.0"}`); err != nil {
		t.Fatalf("write spec: %v", err)
	}
	path := filepath.Join(root, fileStoreWorkspacesDir, "Team", fileStoreCollectionsDir, "Pets", openAPISpecDir, openAPISpecFile)
	if data, err := os.ReadFile(path); err != nil || string(data) != `{"openapi":"3.0.0"}` {
		t.Fatalf("spec.json = %q, %v", data, err)
	}
	got := readOpenAPIBaseSpec(root, "c1")
	if !got.Exists || got.Content != `{"openapi":"3.0.0"}` || got.Path != "workspaces/Team/collections/Pets/openapi/spec.json" {
		t.Fatalf("read = %+v", got)
	}

	if err := writeYAMLWorkspaceStore(root, openAPISyncWorkspaces(), openAPISyncCollections("Pets"), openAPISyncRequests(), nil, nil, nil); err != nil {
		t.Fatalf("second write: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("a normal save removed spec.json: %v", err)
	}
	_, collections, requests, _, _, _, err := loadYAMLWorkspaceStoreWithDiagnostics(root, map[string]string{})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	source, _ := collections[0]["openapi"].(map[string]any)
	if source["source"] != "https://api.example.test/openapi.json" {
		t.Fatalf("collection openapi = %#v", collections[0]["openapi"])
	}
	if requests[0]["openapi"] != "GET /pets/{id}" {
		t.Fatalf("request openapi = %#v", requests[0]["openapi"])
	}
}

func TestRenamingASyncedCollectionMovesItsBaseSpec(t *testing.T) {
	root := t.TempDir()
	if err := writeYAMLWorkspaceStore(root, openAPISyncWorkspaces(), openAPISyncCollections("Pets"), openAPISyncRequests(), nil, nil, nil); err != nil {
		t.Fatalf("write store: %v", err)
	}
	if err := writeOpenAPIBaseSpec(root, "c1", "{}"); err != nil {
		t.Fatalf("write spec: %v", err)
	}
	if err := writeYAMLWorkspaceStore(root, openAPISyncWorkspaces(), openAPISyncCollections("Animals"), openAPISyncRequests(), nil, nil, nil); err != nil {
		t.Fatalf("rename: %v", err)
	}
	collections := filepath.Join(root, fileStoreWorkspacesDir, "Team", fileStoreCollectionsDir)
	if data, err := os.ReadFile(filepath.Join(collections, "Animals", openAPISpecDir, openAPISpecFile)); err != nil || string(data) != "{}" {
		t.Fatalf("spec.json in renamed folder = %q, %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(collections, "Pets")); !os.IsNotExist(err) {
		t.Fatalf("old collection folder was left behind: %v", err)
	}
}

func TestDeletingASyncedCollectionRemovesItsBaseSpec(t *testing.T) {
	root := t.TempDir()
	if err := writeYAMLWorkspaceStore(root, openAPISyncWorkspaces(), openAPISyncCollections("Pets"), openAPISyncRequests(), nil, nil, nil); err != nil {
		t.Fatalf("write store: %v", err)
	}
	if err := writeOpenAPIBaseSpec(root, "c1", "{}"); err != nil {
		t.Fatalf("write spec: %v", err)
	}
	if err := writeYAMLWorkspaceStore(root, openAPISyncWorkspaces(), nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, fileStoreWorkspacesDir, "Team", fileStoreCollectionsDir, "Pets")); !os.IsNotExist(err) {
		t.Fatalf("deleted collection folder still exists: %v", err)
	}
}

func TestDeleteOpenAPIBaseSpecRemovesTheFolder(t *testing.T) {
	root := t.TempDir()
	if err := writeYAMLWorkspaceStore(root, openAPISyncWorkspaces(), openAPISyncCollections("Pets"), nil, nil, nil, nil); err != nil {
		t.Fatalf("write store: %v", err)
	}
	if err := writeOpenAPIBaseSpec(root, "c1", "{}"); err != nil {
		t.Fatalf("write spec: %v", err)
	}
	if err := deleteOpenAPIBaseSpec(root, "c1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, fileStoreWorkspacesDir, "Team", fileStoreCollectionsDir, "Pets", openAPISpecDir)); !os.IsNotExist(err) {
		t.Fatalf("openapi folder still exists: %v", err)
	}
	if got := readOpenAPIBaseSpec(root, "c1"); got.Exists || got.Error != "" {
		t.Fatalf("read after delete = %+v", got)
	}
}

func TestOpenAPIBaseSpecNeedsASavedCollection(t *testing.T) {
	root := t.TempDir()
	if err := writeOpenAPIBaseSpec(root, "missing", "{}"); err == nil {
		t.Fatal("writing a spec for an unknown collection succeeded")
	}
}

func TestReadOpenAPISourceFileResolvesAgainstTheWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Dir(root)
	specDir := filepath.Join(repo, "api-spec")
	if err := os.MkdirAll(specDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(specDir, "openapi.yaml"), []byte("openapi: 3.0.0\n"), 0644); err != nil {
		t.Fatal(err)
	}
	got := readOpenAPISourceFile(root, "../api-spec/openapi.yaml")
	if got.Error != "" || got.Content != "openapi: 3.0.0\n" {
		t.Fatalf("relative read = %+v", got)
	}
	absolute := readOpenAPISourceFile(root, "file://"+filepath.Join(specDir, "openapi.yaml"))
	if absolute.Error != "" || !absolute.Exists {
		t.Fatalf("file:// read = %+v", absolute)
	}
	missing := readOpenAPISourceFile(root, "nope.yaml")
	if !strings.Contains(missing.Error, "does not exist") {
		t.Fatalf("missing file error = %q", missing.Error)
	}
	folder := readOpenAPISourceFile(root, "../api-spec")
	if !strings.Contains(folder.Error, "folder") {
		t.Fatalf("folder error = %q", folder.Error)
	}
}

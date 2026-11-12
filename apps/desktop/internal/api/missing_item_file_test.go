package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func twoWorkspaceStoreForTest(t *testing.T) map[string]any {
	t.Helper()
	store := guardStoreWithRequests(t, 3)
	store["workspaces"] = append(storeItems(store, "workspaces"), map[string]any{"id": "workspace-second", "name": "Second", "filesystemName": "Second"})
	store["collections"] = append(storeItems(store, "collections"), map[string]any{"id": "collection-second", "workspaceId": "workspace-second", "name": "Other", "filesystemName": "Other"})
	store["requests"] = append(storeItems(store, "requests"), newRoundtripRequest("req-second", "collection-second", "Other", "Second-request", []any{}))
	return store
}

func diagnosticsWithMessage(diagnostics []WorkspaceDiagnostic, file string) []WorkspaceDiagnostic {
	var found []WorkspaceDiagnostic
	for _, diagnostic := range diagnostics {
		if filepath.Base(filepath.FromSlash(diagnostic.Path)) == file && diagnostic.Message != "" {
			found = append(found, diagnostic)
		}
	}
	return found
}

func TestMissingCollectionFileOnlyAffectsItsCollection(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	store := twoWorkspaceStoreForTest(t)
	saveAppStoreForTest(t, app, store, "seed")
	collectionDir := filepath.Join(root, fileStoreWorkspacesDir, "Main", fileStoreCollectionsDir, "Big")
	if err := os.Remove(filepath.Join(collectionDir, fileStoreCollection)); err != nil {
		t.Fatal(err)
	}
	forgetWorkspaceDiskState()
	missing := diagnosticsWithMessage(app.LoadWorkspaceDiagnostics(), fileStoreCollection)
	if len(missing) != 1 {
		t.Fatalf("diagnostics = %+v", app.LoadWorkspaceDiagnostics())
	}
	if missing[0].Scope != "collection" || missing[0].WorkspaceID != "workspace-main" || missing[0].Blocking {
		t.Fatalf("missing collection.yml should flag only its collection in its workspace: %+v", missing[0])
	}
	var loaded map[string]any
	if err := json.Unmarshal([]byte(app.LoadRequestStore()), &loaded); err != nil {
		t.Fatal(err)
	}
	storeItem(loaded, "requests", "req-second")["url"] = "https://second.example.test/edited"
	saveAppStoreForTest(t, app, loaded, "save other workspace")
	requests, err := os.ReadDir(filepath.Join(collectionDir, fileStoreRequestsDir))
	if err != nil || len(requests) != 3 {
		t.Fatalf("requests of the collection without collection.yml must stay: %d, %v", len(requests), err)
	}
}

func TestMissingWorkspaceFileOnlyBlocksItsWorkspace(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	store := twoWorkspaceStoreForTest(t)
	saveAppStoreForTest(t, app, store, "seed")
	secondDir := filepath.Join(root, fileStoreWorkspacesDir, "Second")
	if err := os.Remove(filepath.Join(secondDir, fileStoreRootFileName)); err != nil {
		t.Fatal(err)
	}
	forgetWorkspaceDiskState()
	missing := diagnosticsWithMessage(app.LoadWorkspaceDiagnostics(), fileStoreRootFileName)
	if len(missing) != 1 {
		t.Fatalf("diagnostics = %+v", app.LoadWorkspaceDiagnostics())
	}
	if missing[0].Scope != "workspace" || missing[0].WorkspaceID == "" || !missing[0].Blocking {
		t.Fatalf("missing workspace.yml should block only its own workspace: %+v", missing[0])
	}
	var loaded map[string]any
	if err := json.Unmarshal([]byte(app.LoadRequestStore()), &loaded); err != nil {
		t.Fatal(err)
	}
	storeItem(loaded, "requests", "req-main")["url"] = "https://main.example.test/edited"
	saveAppStoreForTest(t, app, loaded, "save main workspace")
	if _, err := os.Stat(filepath.Join(secondDir, fileStoreCollectionsDir, "Other", fileStoreRequestsDir, "Second-request.yml")); err != nil {
		t.Fatalf("files of the workspace without workspace.yml must stay: %v", err)
	}
}

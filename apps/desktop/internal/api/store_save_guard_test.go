package api

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func guardStoreWithRequests(t *testing.T, count int) map[string]any {
	t.Helper()
	store := saveFlowStoreForTest(t)
	store["collections"] = append(storeItems(store, "collections"), map[string]any{"id": "collection-big", "workspaceId": "workspace-main", "name": "Big", "filesystemName": "Big"})
	for i := 0; i < count; i++ {
		store["requests"] = append(storeItems(store, "requests"), newRoundtripRequest(fmt.Sprintf("req-big-%d", i), "collection-big", "Big", fmt.Sprintf("Big-%d", i), []any{}))
	}
	return store
}

func workspaceYAMLCount(t *testing.T, root string) int {
	t.Helper()
	count := 0
	for path := range workspaceTreeForTest(t, root) {
		if strings.HasSuffix(path, fileStoreYAMLExt) {
			count++
		}
	}
	return count
}

func freshDefaultStorePayload(t *testing.T) string {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"version":      2,
		"workspaces":   []any{map[string]any{"id": "workspace-default", "name": "My Workspace"}},
		"collections":  []any{map[string]any{"id": "collection-default", "workspaceId": "workspace-default", "name": "Requests"}},
		"requests":     []any{},
		"environments": []any{},
		"history":      []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(payload)
}

func TestSaveRefusesAStoreThatDropsEveryWorkspaceOnDisk(t *testing.T) {
	for _, cached := range []bool{true, false} {
		t.Run(fmt.Sprintf("cached=%v", cached), func(t *testing.T) {
			app, root := appWorkspaceForTest(t)
			saveAppStoreForTest(t, app, guardStoreWithRequests(t, 20), "seed")
			before := workspaceTreeForTest(t, root)
			if !cached {
				forgetWorkspaceDiskState()
			}
			result := app.SaveRequestStoreWithError(freshDefaultStorePayload(t))
			if result.Ok || !strings.Contains(result.Error, "would remove every workspace") {
				t.Fatalf("save of a fresh default store must be refused, got %+v", result)
			}
			after := workspaceTreeForTest(t, root)
			if len(after) != len(before) {
				t.Fatalf("files changed after a refused save: %d -> %d", len(before), len(after))
			}
		})
	}
}

func TestSaveStillDeletesOneOfSeveralWorkspaces(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	store := guardStoreWithRequests(t, 2)
	store["workspaces"] = append(storeItems(store, "workspaces"), map[string]any{"id": "workspace-second", "name": "Second", "filesystemName": "Second"})
	saveAppStoreForTest(t, app, store, "two workspaces")
	if _, err := os.Stat(filepath.Join(root, fileStoreWorkspacesDir, "Second", fileStoreRootFileName)); err != nil {
		t.Fatal(err)
	}
	store["workspaces"] = storeItems(store, "workspaces")[:1]
	saveAppStoreForTest(t, app, store, "delete second workspace")
	if _, err := os.Stat(filepath.Join(root, fileStoreWorkspacesDir, "Second")); !os.IsNotExist(err) {
		t.Fatalf("deleted workspace should be gone: %v", err)
	}
}

func TestBackupImportReplacesAllWorkspaces(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	saveAppStoreForTest(t, app, guardStoreWithRequests(t, 3), "seed")
	if result := app.ReplaceRequestStoreWithError(freshDefaultStorePayload(t)); !result.Ok {
		t.Fatalf("backup import must be able to replace everything: %s", result.Error)
	}
	if ids := diskWorkspaceIDs(root); len(ids) != 1 || ids[0] != "workspace-default" {
		t.Fatalf("workspaces after replace: %v", ids)
	}
}

func TestSaveIsRefusedAfterTheWorkspaceFailedToLoad(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	saveAppStoreForTest(t, app, guardStoreWithRequests(t, 5), "seed")
	before := workspaceYAMLCount(t, root)
	rootIndex := filepath.Join(root, fileStoreRootIndex)
	original, err := os.ReadFile(rootIndex)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rootIndex, []byte("version: 1\nworkspaceOrder: [\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	forgetWorkspaceDiskState()
	if payload := app.LoadRequestStore(); payload != "" {
		t.Fatalf("load of a broken workspace should fail, got %d bytes", len(payload))
	}
	if err := os.WriteFile(rootIndex, original, 0o644); err != nil {
		t.Fatal(err)
	}
	store := guardStoreWithRequests(t, 0)
	payload, _ := json.Marshal(store)
	result := app.SaveRequestStoreWithError(string(payload))
	if result.Ok || !strings.Contains(result.Error, "could not read this workspace") {
		t.Fatalf("save after a failed load must be refused, got %+v", result)
	}
	if got := workspaceYAMLCount(t, root); got != before {
		t.Fatalf("files changed: %d -> %d", before, got)
	}
	if app.LoadRequestStore() == "" {
		t.Fatal("reload after the fix should work")
	}
	saveAppStoreForTest(t, app, guardStoreWithRequests(t, 5), "save after reload")
}

func diskWorkspaceIDs(root string) []string {
	ids := make([]string, 0)
	for id := range diskWorkspaces(root) {
		ids = append(ids, id)
	}
	return ids
}

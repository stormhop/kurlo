package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func workspaceYAMLMemoPaths() map[string]bool {
	workspaceYAMLMemo.Lock()
	defer workspaceYAMLMemo.Unlock()
	paths := map[string]bool{}
	for path := range workspaceYAMLMemo.entries {
		paths[path] = true
	}
	return paths
}

func TestTheYAMLMemoForgetsRemovedFilesAndOtherWorkspaces(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	store := saveFlowStoreForTest(t)
	store["requests"] = append(storeItems(store, "requests"), newRoundtripRequest("req-extra", "collection-main", "Core", "Extra request", []any{}))
	saveAppStoreForTest(t, app, store, "with extra")
	saveAppStoreForTest(t, app, store, "again")

	var extra string
	for path := range workspaceYAMLMemoPaths() {
		if !strings.HasPrefix(path, root) {
			t.Fatalf("memo holds a path outside the workspace: %s", path)
		}
		if strings.Contains(filepath.Base(path), "Extra") {
			extra = path
		}
	}
	if extra == "" {
		t.Fatal("the extra request should be in the memo after it was written")
	}

	removeStoreItems(store, "requests", func(r map[string]any) bool { return r["id"] == "req-extra" })
	saveAppStoreForTest(t, app, store, "without extra")
	if _, err := os.Stat(extra); !os.IsNotExist(err) {
		t.Fatalf("the removed request file is still there: %v", err)
	}
	if workspaceYAMLMemoPaths()[extra] {
		t.Fatal("the memo kept a removed file")
	}
	for path := range workspaceYAMLMemoPaths() {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("memo entry without a file: %s", path)
		}
	}

	other := t.TempDir()
	workspaceDisk.remember(other)
	if len(workspaceYAMLMemoPaths()) != 0 {
		t.Fatal("opening another workspace should clear the memo")
	}
}

func TestTheYAMLMemoSkipsOnlyWhatMatchesTheDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request.yml")
	value := map[string]any{"name": "One"}
	journal := &saveJournal{known: map[string]string{}}
	data, unchanged, err := workspaceYAMLForWrite(path, value, journal)
	if err != nil || unchanged || len(data) == 0 {
		t.Fatalf("first write: %v %v %q", err, unchanged, data)
	}
	journal.known[path] = contentHash(data)
	if data, unchanged, _ := workspaceYAMLForWrite(path, value, journal); !unchanged || data != nil {
		t.Fatal("a value whose YAML matches the disk should be skipped without building it")
	}
	journal.known[path] = contentHash([]byte("edited outside\n"))
	if data, unchanged, _ := workspaceYAMLForWrite(path, value, journal); unchanged || len(data) == 0 {
		t.Fatal("a file that differs on disk must be written")
	}
	journal.known[path] = contentHash(data)
	if data, unchanged, _ := workspaceYAMLForWrite(path, map[string]any{"name": "Two"}, journal); unchanged || len(data) == 0 {
		t.Fatal("a changed value must be written")
	}
}

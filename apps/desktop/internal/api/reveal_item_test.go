package api

import (
	"errors"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
)

func revealFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	workspaces := []map[string]any{{"id": "ws", "name": "Demo"}}
	collections := []map[string]any{{"id": "col", "workspaceId": "ws", "name": "Orders API"}}
	requests := []map[string]any{{"id": "req", "collectionId": "col", "name": "List orders", "method": "GET", "url": "https://example.test/orders", "requestType": "http", "auth": map[string]any{"type": "none"}}}
	ensureStoreFilesystemNames(workspaces, collections, requests, nil, nil, false)
	if err := writeFilesystemWorkspaceStore(root, workspaces, collections, requests, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestWorkspaceItemPathFindsTheRequestFile(t *testing.T) {
	root := revealFixture(t)
	target, err := workspaceItemPath(root, "request", "req")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Ext(target) != fileStoreYAMLExt || filepath.Base(filepath.Dir(target)) != fileStoreRequestsDir {
		t.Fatalf("expected a request YAML file, got %q", target)
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "List orders") {
		t.Fatalf("expected the file of the request, got:\n%s", body)
	}
}

func TestWorkspaceItemPathFindsTheCollectionFolder(t *testing.T) {
	root := revealFixture(t)
	target, err := workspaceItemPath(root, "collection", "col")
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(target); err != nil || !info.IsDir() {
		t.Fatalf("expected the collection folder, got %q (%v)", target, err)
	}
	if filepath.Base(filepath.Dir(target)) != fileStoreCollectionsDir {
		t.Fatalf("expected a folder under %s, got %q", fileStoreCollectionsDir, target)
	}
}

func TestWorkspaceItemPathExplainsAnUnsavedRequest(t *testing.T) {
	root := revealFixture(t)
	if _, err := workspaceItemPath(root, "request", "draft"); err == nil || !strings.Contains(err.Error(), "not saved") {
		t.Fatalf("expected a not-saved error, got %v", err)
	}
	if _, err := workspaceItemPath(root, "folder", "x"); err == nil {
		t.Fatal("expected an unknown kind to be refused")
	}
}

func TestRevealWorkspaceItemSelectsTheFileAndReportsFailures(t *testing.T) {
	root := revealFixture(t)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "config"))
	if err := persistActiveWorkspaceRootMode(root, workspaceStorageModeGit); err != nil {
		t.Fatal(err)
	}

	var selected string
	previous := selectInFileManager
	selectInFileManager = func(target string) error { selected = target; return nil }
	defer func() { selectInFileManager = previous }()

	if msg := (&App{}).RevealWorkspaceItem("request", "req"); msg != "" {
		t.Fatalf("expected no error, got %q", msg)
	}
	want, _ := workspaceItemPath(root, "request", "req")
	if selected != want {
		t.Fatalf("expected %q to be selected, got %q", want, selected)
	}

	selectInFileManager = func(string) error { return errors.New("no file manager") }
	if msg := (&App{}).RevealWorkspaceItem("request", "req"); !strings.Contains(msg, "no file manager") {
		t.Fatalf("expected the failure to reach the UI, got %q", msg)
	}
}

func TestFileManagerSelectCommandHighlightsTheItem(t *testing.T) {
	target := filepath.Join(t.TempDir(), "Orders API", "list orders.yml")
	cmd := fileManagerSelectCommand(target)
	switch goruntime.GOOS {
	case "darwin":
		if strings.Join(cmd.Args, " ") != "open -R "+target {
			t.Fatalf("expected open -R, got %v", cmd.Args)
		}
	case "windows":
	default:
		if cmd.Args[len(cmd.Args)-1] != filepath.Dir(target) {
			t.Fatalf("expected the parent folder to open, got %v", cmd.Args)
		}
	}
	if args := explorerSelectCommand(target).Args; goruntime.GOOS != "windows" && args[1] != "/select,"+target {
		t.Fatalf("expected explorer to select the item, got %v", args)
	}
}

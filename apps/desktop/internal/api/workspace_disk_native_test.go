package api

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWorkspaceWatchRelevantPaths(t *testing.T) {
	for rel, want := range map[string]bool{
		"":                                  true,
		".":                                 true,
		"kurlo.yml":                         true,
		"workspaces":                        true,
		"workspaces/api/collection.yml":     true,
		"Workspaces/API/Get user.yml":       true,
		"workspaces/api/.kurlo-write.tmp":   false,
		".git/index":                        false,
		".kurlo-save-journal.tmp":           false,
		"README.md":                         false,
		"workspaces-old/api/collection.yml": false,
	} {
		if got := workspaceWatchRelevant(rel); got != want {
			t.Errorf("workspaceWatchRelevant(%q) = %v, want %v", rel, got, want)
		}
	}
}

type fakeWorkspaceWatch struct {
	ch     chan struct{}
	closed bool
}

func (w *fakeWorkspaceWatch) changes() <-chan struct{} { return w.ch }
func (w *fakeWorkspaceWatch) close()                   { w.closed = true }

func TestWorkspaceDiskLoopScansOnEventsAndFallsBackToPolling(t *testing.T) {
	var started []string
	var watches []*fakeWorkspaceWatch
	fail := map[string]bool{"/broken": true}
	loop := &workspaceDiskLoop{dirty: true, start: func(root string) (workspaceNativeWatch, error) {
		started = append(started, root)
		if fail[root] {
			return nil, errors.New("unsupported")
		}
		watch := &fakeWorkspaceWatch{ch: make(chan struct{}, 1)}
		watches = append(watches, watch)
		return watch, nil
	}}
	now := time.Unix(1000, 0)

	loop.follow("")
	if loop.watch != nil || !loop.due(now) || len(started) != 0 {
		t.Fatal("no workspace should mean no watch and plain polling")
	}
	loop.follow("/ws")
	if loop.watch == nil || !loop.due(now) {
		t.Fatal("a new root should start a watch and scan once")
	}
	loop.scanned(now)
	if loop.due(now.Add(time.Second)) {
		t.Fatal("a quiet watched workspace should not be scanned every second")
	}
	loop.changed(true)
	if !loop.due(now.Add(time.Second)) {
		t.Fatal("a file event should trigger a scan")
	}
	loop.scanned(now.Add(time.Second))
	if !loop.due(now.Add(time.Second + workspaceDiskSafetyPoll)) {
		t.Fatal("a watched workspace should still be scanned now and then")
	}
	loop.follow("/ws")
	if len(started) != 1 {
		t.Fatal("the same root should keep its watch")
	}

	loop.changed(false)
	if loop.watch != nil || !watches[0].closed || !loop.due(now.Add(2*time.Second)) {
		t.Fatal("a lost watch should fall back to polling")
	}
	loop.follow("/ws")
	if len(started) != 1 {
		t.Fatal("a lost watch should not be restarted every second")
	}

	loop.follow("/broken")
	loop.scanned(now)
	if loop.watch != nil || !loop.due(now) {
		t.Fatal("a root without native watching should be polled")
	}
	loop.follow("/broken")
	if len(started) != 2 {
		t.Fatal("a failed root should not be retried every second")
	}
	loop.follow("/other")
	if loop.watch == nil || len(started) != 3 {
		t.Fatal("switching workspaces should start a new watch")
	}
	loop.stop()
	if !watches[1].closed || loop.watch != nil {
		t.Fatal("stop should close the watch")
	}
}

func waitWorkspaceWatch(t *testing.T, watch workspaceNativeWatch, want bool, wait time.Duration) {
	t.Helper()
	select {
	case _, open := <-watch.changes():
		if !open {
			t.Fatal("the watch stopped")
		}
		if !want {
			t.Fatal("an unrelated change woke the watch")
		}
	case <-time.After(wait):
		if want {
			t.Fatal("the watch did not report the change")
		}
	}
}

func drainWorkspaceWatch(watch workspaceNativeWatch) {
	deadline := time.After(700 * time.Millisecond)
	for {
		select {
		case <-watch.changes():
		case <-deadline:
			return
		}
	}
}

func TestNativeWorkspaceWatchReportsWorkspaceFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, fileStoreRootIndex), []byte("version: 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	collection := filepath.Join(root, fileStoreWorkspacesDir, "api", "collections", "users")
	if err := os.MkdirAll(collection, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	watch, err := startWorkspaceNativeWatch(root)
	if err != nil {
		t.Skipf("native watching unavailable: %v", err)
	}
	defer watch.close()
	drainWorkspaceWatch(watch)

	if err := os.WriteFile(filepath.Join(collection, "Get user.yml"), []byte("name: Get user\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitWorkspaceWatch(t, watch, true, 5*time.Second)
	drainWorkspaceWatch(watch)

	nested := filepath.Join(root, fileStoreWorkspacesDir, "api", "examples", "get-user")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	waitWorkspaceWatch(t, watch, true, 5*time.Second)
	drainWorkspaceWatch(watch)
	if err := os.WriteFile(filepath.Join(nested, "ok.yml"), []byte("status: 200\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitWorkspaceWatch(t, watch, true, 5*time.Second)
	drainWorkspaceWatch(watch)

	if err := os.WriteFile(filepath.Join(root, ".git", "index"), []byte("index"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitWorkspaceWatch(t, watch, false, time.Second)

	if err := os.Remove(filepath.Join(collection, "Get user.yml")); err != nil {
		t.Fatal(err)
	}
	waitWorkspaceWatch(t, watch, true, 5*time.Second)
	if err := os.WriteFile(filepath.Join(root, fileStoreRootIndex), []byte("version: 2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitWorkspaceWatch(t, watch, true, 5*time.Second)
}

func TestDarwinWorkspaceWatchDoesNotWatchParentFolders(t *testing.T) {
	source, err := os.ReadFile("workspace_disk_native_darwin.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(source), "WatchRoot") {
		t.Fatal("kFSEventStreamCreateFlagWatchRoot watches every parent folder, so macOS asks for Documents access when the workspace lives there")
	}
}

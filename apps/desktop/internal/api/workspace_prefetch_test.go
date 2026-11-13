package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setUpPrefetchWorkspace(t *testing.T) (*App, string) {
	t.Helper()
	withRequestStoreTestKey(t)
	useTempConfigDir(t, t.TempDir())
	app := NewApp()
	if result := app.SaveRequestStoreWithError(examplesTestPayload("Orders", "Orders", "")); !result.Ok {
		t.Fatalf("initial save: %s", result.Error)
	}
	files, _ := filepath.Glob(filepath.Join(fileWorkspaceStorePath(), "workspaces", "*", "collections", "*", "requests", "*.yml"))
	if len(files) != 1 {
		t.Fatalf("expected one request file, got %v", files)
	}
	return app, files[0]
}

func renameRequestOnDisk(t *testing.T, path, from, to string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), from) {
		t.Fatalf("%s does not contain %q:\n%s", path, from, data)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(string(data), from, to, 1)), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadWorkspaceUsesTheWorkspaceReadAtStartup(t *testing.T) {
	app, requestFile := setUpPrefetchWorkspace(t)
	app.prefetchWorkspace()
	<-app.workspacePrefetch.pending.done
	renameRequestOnDisk(t, requestFile, "name: Orders", "name: Changed later")
	if payload := app.LoadWorkspace().Payload; !strings.Contains(payload, `"Orders"`) {
		t.Fatalf("expected the startup read, got %s", payload)
	}
	if payload := app.LoadWorkspace().Payload; !strings.Contains(payload, `"Changed later"`) {
		t.Fatalf("the startup read must be used only once, got %s", payload)
	}
}

func TestASaveAfterTheStartupReadForcesAFreshLoad(t *testing.T) {
	app, _ := setUpPrefetchWorkspace(t)
	app.prefetchWorkspace()
	<-app.workspacePrefetch.pending.done
	if result := app.SaveRequestStoreWithError(examplesTestPayload("Saved since", "Orders", "")); !result.Ok {
		t.Fatalf("save: %s", result.Error)
	}
	if payload := app.LoadWorkspace().Payload; !strings.Contains(payload, `"Saved since"`) {
		t.Fatalf("a stale startup read was returned after a save: %s", payload)
	}
}

func TestLoadWorkspaceWaitsForAStartupReadStillInProgress(t *testing.T) {
	app, _ := setUpPrefetchWorkspace(t)
	app.prefetchWorkspace()
	result := app.LoadWorkspace()
	if !strings.Contains(result.Payload, `"Orders"`) || len(result.Diagnostics) != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if app.workspacePrefetch.pending != nil {
		t.Fatalf("the startup read should be consumed")
	}
}

func TestTheStartupReadIsIgnoredForAnotherWorkspaceFolder(t *testing.T) {
	app, _ := setUpPrefetchWorkspace(t)
	app.prefetchWorkspace()
	<-app.workspacePrefetch.pending.done
	if _, ok := app.takePrefetchedWorkspace(filepath.Join(t.TempDir(), "elsewhere")); ok {
		t.Fatalf("a read of one folder must not answer for another")
	}
}

package api

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitPullWorkspaceReportsChangeSummary(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir, peer := setupGitPullRemoteForTest(t)
	if err := os.WriteFile(filepath.Join(peer, "kurlo.yml"), []byte("version: 1\nremoteUpdate: true\n"), 0644); err != nil {
		t.Fatalf("write peer kurlo index: %v", err)
	}
	addedPath := filepath.Join(peer, "remote-note.yml")
	if err := os.WriteFile(addedPath, []byte("created: true\n"), 0644); err != nil {
		t.Fatalf("write peer added file: %v", err)
	}
	runGitForTest(t, peer, "add", "kurlo.yml", "remote-note.yml")
	runGitForTest(t, peer, "commit", "-m", "Remote Kurlo update")
	runGitForTest(t, peer, "push")

	result := gitPullWorkspaceForRoot(dir, "ff")
	if !result.Ok {
		t.Fatalf("pull failed: %s\n%s", result.Error, result.Output)
	}
	if result.PullSummary.Changed != 2 || result.PullSummary.Added != 1 || result.PullSummary.Updated != 1 {
		t.Fatalf("unexpected pull summary: %#v", result.PullSummary)
	}
}

func TestGitPullWorkspaceReturnsDiagnosticsForInvalidRemoteRequest(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)

	dir, peer := setupGitPullRemoteForTest(t)
	app := NewApp()
	opened := app.openWorkspaceRoot(dir)
	if !opened.Ok {
		t.Fatalf("open workspace failed: %s\n%s", opened.Error, opened.Output)
	}
	requestDir := filepath.Join(peer, "workspaces", "Main", "collections", "Default", "requests")
	if err := os.MkdirAll(requestDir, 0755); err != nil {
		t.Fatalf("create peer request dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(requestDir, "Broken.yml"), []byte("version: 1\nrequest:\n  id: req-broken\n  name: \"Broken\n"), 0644); err != nil {
		t.Fatalf("write broken peer request: %v", err)
	}
	runGitForTest(t, peer, "add", "workspaces/Main/collections/Default/requests/Broken.yml")
	runGitForTest(t, peer, "commit", "-m", "Add invalid request YAML")
	runGitForTest(t, peer, "push")

	result := app.gitPullWorkspace("ff")
	if !result.Ok {
		t.Fatalf("pull with invalid request YAML should keep workspace open: %s\n%s", result.Error, result.Output)
	}
	if len(result.Diagnostics) != 1 {
		t.Fatalf("expected one diagnostic, got %#v", result.Diagnostics)
	}
	got := result.Diagnostics[0]
	if got.Scope != "request" || got.CollectionID != "collection-main" || got.Blocking || !strings.Contains(got.Path, "Broken.yml") {
		t.Fatalf("unexpected pull diagnostic: %#v", got)
	}
	if result.PullSummary.Added != 1 {
		t.Fatalf("expected pull summary to include invalid file addition, got %#v", result.PullSummary)
	}
}

func TestGitPullWorkspaceKeepsRepoOpenForInvalidRemoteWorkspace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)

	dir, peer := setupGitPullRemoteForTest(t)
	app := NewApp()
	opened := app.openWorkspaceRoot(dir)
	if !opened.Ok {
		t.Fatalf("open workspace failed: %s\n%s", opened.Error, opened.Output)
	}
	workspacePath := filepath.Join(peer, "workspaces", "Main", "workspace.yml")
	if err := os.WriteFile(workspacePath, []byte("version: 1\nworkspace:\n  id: workspace-main\n  name \"Broken\"\n"), 0644); err != nil {
		t.Fatalf("write broken peer workspace: %v", err)
	}
	runGitForTest(t, peer, "add", "workspaces/Main/workspace.yml")
	runGitForTest(t, peer, "commit", "-m", "Break workspace YAML")
	runGitForTest(t, peer, "push")

	result := app.gitPullWorkspace("ff")
	if !result.Ok {
		t.Fatalf("pull with invalid workspace YAML should keep repo open: %s\n%s", result.Error, result.Output)
	}
	if len(result.Diagnostics) != 1 {
		t.Fatalf("expected one diagnostic, got %#v", result.Diagnostics)
	}
	got := result.Diagnostics[0]
	if got.Scope != "workspace" || !got.Blocking || got.WorkspaceID == "" || !strings.Contains(got.Path, "workspace.yml") {
		t.Fatalf("unexpected blocking diagnostic: %#v", got)
	}
	if result.PullSummary.Updated != 1 {
		t.Fatalf("expected pull summary to include workspace update, got %#v", result.PullSummary)
	}
}

func TestGitPullWorkspaceAllowsDirtyNonOverlappingChanges(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir, peer := setupGitPullRemoteForTest(t)
	localWorkspace := filepath.Join(dir, "workspaces", "Main", "workspace.yml")
	if err := os.WriteFile(localWorkspace, []byte(`version: 1
workspace:
  id: workspace-main
  name: Local Dirty
  filesystemName: Main
collectionOrder:
  - collection-main
`), 0644); err != nil {
		t.Fatalf("write dirty local workspace: %v", err)
	}
	if err := os.WriteFile(filepath.Join(peer, "kurlo.yml"), []byte("version: 1\nremoteUpdate: true\n"), 0644); err != nil {
		t.Fatalf("write peer kurlo index: %v", err)
	}
	runGitForTest(t, peer, "add", "kurlo.yml")
	runGitForTest(t, peer, "commit", "-m", "Remote Kurlo update")
	runGitForTest(t, peer, "push")

	result := gitPullWorkspaceForRoot(dir, "ff")
	if !result.Ok {
		t.Fatalf("dirty pull should succeed for non-overlapping changes: %s\n%s", result.Error, result.Output)
	}
	if result.Git.Clean {
		t.Fatalf("expected local dirty edit to remain after pull, got clean status")
	}
	if !strings.Contains(readFileForTest(t, filepath.Join(dir, "kurlo.yml")), "remoteUpdate: true") {
		t.Fatalf("expected remote update to be pulled")
	}
	if !strings.Contains(readFileForTest(t, localWorkspace), "Local Dirty") {
		t.Fatalf("expected local dirty edit to be re-applied")
	}
	if result.PullSummary.Changed != 1 || result.PullSummary.Updated != 1 {
		t.Fatalf("unexpected dirty pull summary: %#v", result.PullSummary)
	}
}

func TestGitPullWorkspaceMergeAllowsDirtyNonOverlappingChanges(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir, peer := setupGitPullRemoteForTest(t)
	workspacePath := filepath.Join(dir, "workspaces", "Main", "workspace.yml")
	if err := os.WriteFile(workspacePath, []byte(`version: 1
workspace:
  id: workspace-main
  name: Local Commit
  filesystemName: Main
collectionOrder:
  - collection-main
`), 0644); err != nil {
		t.Fatalf("write local committed workspace: %v", err)
	}
	runGitForTest(t, dir, "add", "workspaces/Main/workspace.yml")
	runGitForTest(t, dir, "commit", "-m", "Local workspace update")

	collectionPath := filepath.Join(dir, "workspaces", "Main", "collections", "Default", "collection.yml")
	if err := os.WriteFile(collectionPath, []byte(`version: 1
collection:
  id: collection-main
  workspaceId: workspace-main
  name: Dirty Collection
  filesystemName: Default
requestOrder: []
`), 0644); err != nil {
		t.Fatalf("write dirty local collection: %v", err)
	}
	if err := os.WriteFile(filepath.Join(peer, "kurlo.yml"), []byte("version: 1\nremote: true\n"), 0644); err != nil {
		t.Fatalf("write peer kurlo index: %v", err)
	}
	runGitForTest(t, peer, "add", "kurlo.yml")
	runGitForTest(t, peer, "commit", "-m", "Remote Kurlo update")
	runGitForTest(t, peer, "push")

	result := gitPullWorkspaceForRoot(dir, "merge")
	if !result.Ok {
		t.Fatalf("dirty merge pull should succeed for non-overlapping changes: %s\n%s", result.Error, result.Output)
	}
	if result.Git.Operation != "" {
		t.Fatalf("expected merge pull to finish, got %#v", result.Git)
	}
	if result.Git.Clean {
		t.Fatalf("expected dirty collection edit to remain after merge pull")
	}
	if !strings.Contains(readFileForTest(t, filepath.Join(dir, "kurlo.yml")), "remote: true") {
		t.Fatalf("expected remote update to be merged")
	}
	if !strings.Contains(readFileForTest(t, collectionPath), "Dirty Collection") {
		t.Fatalf("expected dirty local edit to be re-applied")
	}
}

func TestParseGitPullSummary(t *testing.T) {
	t.Parallel()

	summary := parseGitPullSummary("A\tnew.yml\nM\tupdated.yml\nD\tdeleted.yml\nR100\told.yml\trenamed.yml\n")
	if summary.Changed != 4 || summary.Added != 1 || summary.Updated != 1 || summary.Deleted != 1 || summary.Renamed != 1 {
		t.Fatalf("unexpected parsed summary: %#v", summary)
	}
}

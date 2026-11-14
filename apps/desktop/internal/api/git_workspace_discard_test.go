package api

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitDiscardWorkspaceFileRestoresTrackedKurloFile(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	configureGitUserForTest(t, dir)
	if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\ndirty: true\n"), 0644); err != nil {
		t.Fatalf("write dirty kurlo index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "history.json"), []byte(`{"history":["keep"]}`+"\n"), 0644); err != nil {
		t.Fatalf("write non-kurlo file: %v", err)
	}

	result := gitDiscardWorkspaceFileForRoot(dir, "kurlo.yml")
	if !result.Ok {
		t.Fatalf("discard file failed: %s\n%s", result.Error, result.Output)
	}
	kurloData, err := os.ReadFile(filepath.Join(dir, "kurlo.yml"))
	if err != nil {
		t.Fatalf("read kurlo index: %v", err)
	}
	if strings.Contains(string(kurloData), "dirty") {
		t.Fatalf("kurlo file was not restored:\n%s", kurloData)
	}
	if _, err := os.Stat(filepath.Join(dir, "history.json")); err != nil {
		t.Fatalf("non-kurlo file should not be touched: %v", err)
	}
}

func TestGitDiscardWorkspaceFileClearsStaleManagedGitignore(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)

	root := t.TempDir()
	writeKurloWorkspaceFiles(t, root)
	runGitForTest(t, root, "init", "-b", "main")
	configureGitUserForTest(t, root)

	staleGitignore := ".kurlo-local/\n.env\n.env.*\n*-????-??-??T??-??-??.html\n.DS_Store\nThumbs.db\n"
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte(staleGitignore), 0644); err != nil {
		t.Fatalf("write stale .gitignore: %v", err)
	}
	runGitForTest(t, root, "add", ".")
	runGitForTest(t, root, "commit", "-m", "Initial Kurlo workspace")

	app := NewApp()
	opened := app.OpenWorkspaceRoot(root)
	if !opened.Ok {
		t.Fatalf("open workspace failed: %s", opened.Error)
	}
	if !gitChangedPathExists(opened.Git.Files, ".gitignore") {
		t.Fatalf("expected .gitignore to be dirtied by managed-entry refresh, got %#v", opened.Git.Files)
	}

	result := app.GitDiscardWorkspaceFile(".gitignore")
	if !result.Ok {
		t.Fatalf("discard .gitignore failed: %s\n%s", result.Error, result.Output)
	}
	if gitChangedPathExists(result.Git.Files, ".gitignore") {
		t.Fatalf("discard should clear the .gitignore change, still present: %#v", result.Git.Files)
	}
	data, err := os.ReadFile(filepath.Join(root, ".gitignore"))
	if err != nil {
		t.Fatalf("read .gitignore: %v", err)
	}
	if normalizeNewlines(string(data)) != normalizeNewlines(staleGitignore) {
		t.Fatalf("discard should restore the committed .gitignore, got:\n%s", data)
	}
}

func TestGitDiscardWorkspaceFileRemovesRunnerReportArtifact(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	runGitForTest(t, dir, "init", "-b", "main")
	configureGitUserForTest(t, dir)
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(".kurlo-local/\n.env\n"), 0644); err != nil {
		t.Fatalf("write stale .gitignore: %v", err)
	}
	runGitForTest(t, dir, "add", ".")
	runGitForTest(t, dir, "commit", "-m", "Initial Kurlo workspace")

	reportName := "collection-1-2026-05-17T19-25-24.html"
	if err := os.WriteFile(filepath.Join(dir, reportName), []byte("<!doctype html><title>report</title>"), 0644); err != nil {
		t.Fatalf("write runner report: %v", err)
	}
	foreignName := "my-notes.txt"
	if err := os.WriteFile(filepath.Join(dir, foreignName), []byte("keep me"), 0644); err != nil {
		t.Fatalf("write foreign file: %v", err)
	}

	result := gitDiscardWorkspaceFileForRoot(dir, reportName)
	if !result.Ok {
		t.Fatalf("discard runner report failed: %s\n%s", result.Error, result.Output)
	}
	if _, err := os.Stat(filepath.Join(dir, reportName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("runner report should be removed, err=%v", err)
	}

	foreign := gitDiscardWorkspaceFileForRoot(dir, foreignName)
	if foreign.Ok {
		t.Fatalf("discard of foreign file should be refused, got ok=%v", foreign.Ok)
	}
	if _, err := os.Stat(filepath.Join(dir, foreignName)); err != nil {
		t.Fatalf("foreign file must be left untouched: %v", err)
	}
}

func TestGitDiscardWorkspaceFileRemovesUntrackedKurloFile(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	configureGitUserForTest(t, dir)
	if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	requestPath := filepath.Join(dir, "workspaces", "Main", "collections", "Default", "requests", "New.yml")
	if err := os.MkdirAll(filepath.Dir(requestPath), 0755); err != nil {
		t.Fatalf("create request dir: %v", err)
	}
	if err := os.WriteFile(requestPath, []byte("version: 1\nrequest:\n  id: req-new\n  name: New\n"), 0644); err != nil {
		t.Fatalf("write untracked request: %v", err)
	}

	result := gitDiscardWorkspaceFileForRoot(dir, "workspaces/Main/collections/Default/requests/New.yml")
	if !result.Ok {
		t.Fatalf("discard untracked file failed: %s\n%s", result.Error, result.Output)
	}
	if _, err := os.Stat(requestPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("untracked request should be removed, err=%v", err)
	}
}

func TestGitDiscardWorkspaceFileRestoresCollectionOrderForNewRequest(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	configureGitUserForTest(t, dir)
	if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	requestRel := "workspaces/Main/collections/Default/requests/New.yml"
	collectionRel := "workspaces/Main/collections/Default/collection.yml"
	requestPath := filepath.Join(dir, filepath.FromSlash(requestRel))
	collectionPath := filepath.Join(dir, filepath.FromSlash(collectionRel))
	if err := os.MkdirAll(filepath.Dir(requestPath), 0755); err != nil {
		t.Fatalf("create request dir: %v", err)
	}
	if err := os.WriteFile(requestPath, []byte("version: 1\nrequest:\n  id: req-new\n  name: New\n"), 0644); err != nil {
		t.Fatalf("write untracked request: %v", err)
	}
	if err := os.WriteFile(collectionPath, []byte(`version: 1
collection:
  id: collection-main
  workspaceId: workspace-main
  name: Default
  filesystemName: Default
requestOrder:
  - req-new
`), 0644); err != nil {
		t.Fatalf("write dirty collection: %v", err)
	}

	result := gitDiscardWorkspaceFileForRoot(dir, requestRel)
	if !result.Ok {
		t.Fatalf("discard new request failed: %s\n%s", result.Error, result.Output)
	}
	if !containsGitPath(result.Files, requestRel) || !containsGitPath(result.Files, collectionRel) {
		t.Fatalf("discard should include request and collection index, got %#v", result.Files)
	}
	if _, err := os.Stat(requestPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("untracked request should be removed, err=%v", err)
	}
	collectionData := readFileForTest(t, collectionPath)
	if strings.Contains(collectionData, "req-new") {
		t.Fatalf("collection requestOrder was not restored:\n%s", collectionData)
	}
	status := gitStatusForWorkspace(dir)
	if gitChangedPathExists(status.Files, collectionRel) {
		t.Fatalf("collection index should be clean after discard, status=%#v", status.Files)
	}
}

func TestGitDiscardWorkspaceFilesRestoresCollectionOrderForSelectedNewRequest(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	configureGitUserForTest(t, dir)
	if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	requestRel := "workspaces/Main/collections/Default/requests/New.yml"
	collectionRel := "workspaces/Main/collections/Default/collection.yml"
	requestPath := filepath.Join(dir, filepath.FromSlash(requestRel))
	collectionPath := filepath.Join(dir, filepath.FromSlash(collectionRel))
	if err := os.MkdirAll(filepath.Dir(requestPath), 0755); err != nil {
		t.Fatalf("create request dir: %v", err)
	}
	if err := os.WriteFile(requestPath, []byte("version: 1\nrequest:\n  id: req-new\n  name: New\n"), 0644); err != nil {
		t.Fatalf("write untracked request: %v", err)
	}
	if err := os.WriteFile(collectionPath, []byte(`version: 1
collection:
  id: collection-main
  workspaceId: workspace-main
  name: Default
  filesystemName: Default
requestOrder:
  - req-new
`), 0644); err != nil {
		t.Fatalf("write dirty collection: %v", err)
	}

	result := gitDiscardWorkspaceFilesForRoot(dir, []string{requestRel})
	if !result.Ok {
		t.Fatalf("discard selected new request failed: %s\n%s", result.Error, result.Output)
	}
	if !containsGitPath(result.Files, requestRel) || !containsGitPath(result.Files, collectionRel) {
		t.Fatalf("discard selected should include request and collection index, got %#v", result.Files)
	}
	if _, err := os.Stat(requestPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("untracked request should be removed, err=%v", err)
	}
	if collectionData := readFileForTest(t, collectionPath); strings.Contains(collectionData, "req-new") {
		t.Fatalf("collection requestOrder was not restored:\n%s", collectionData)
	}
}

func TestGitDiscardWorkspaceFileRemovesUntrackedKurloFileBeforeInitialCommit(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	runGitForTest(t, dir, "init")
	requestPath := filepath.Join(dir, "workspaces", "Main", "collections", "Default", "requests", "New.yml")
	if err := os.MkdirAll(filepath.Dir(requestPath), 0755); err != nil {
		t.Fatalf("create request dir: %v", err)
	}
	if err := os.WriteFile(requestPath, []byte("version: 1\nrequest:\n  id: req-new\n  name: New\n  filesystemName: New\n"), 0644); err != nil {
		t.Fatalf("write untracked request: %v", err)
	}

	result := gitDiscardWorkspaceFileForRoot(dir, "workspaces/Main/collections/Default/requests/New.yml")
	if !result.Ok {
		t.Fatalf("discard untracked file before initial commit failed: %s\n%s", result.Error, result.Output)
	}
	if _, err := os.Stat(requestPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("untracked request should be removed before initial commit, err=%v", err)
	}
}

func TestGitDiscardWorkspaceFilesBeforeInitialCommitRejectsKurloIndex(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	runGitForTest(t, dir, "init")

	result := gitDiscardWorkspaceFilesForRoot(dir, []string{"kurlo.yml"})
	if result.Ok {
		t.Fatalf("expected discarding root index before initial commit to fail")
	}
	if !strings.Contains(result.Error, "No committed baseline") {
		t.Fatalf("expected baseline error, got %q", result.Error)
	}
}

func TestGitDiscardWorkspaceChangesOnlyTouchesKurloFiles(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	configureGitUserForTest(t, dir)
	if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\ndirty: true\n"), 0644); err != nil {
		t.Fatalf("write dirty kurlo index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("keep\n"), 0644); err != nil {
		t.Fatalf("write non-kurlo file: %v", err)
	}

	result := gitDiscardWorkspaceChangesForRoot(dir)
	if !result.Ok {
		t.Fatalf("discard all failed: %s\n%s", result.Error, result.Output)
	}
	status := gitStatusForWorkspace(dir)
	if len(managedChangedGitPaths(dir, status)) != 0 {
		t.Fatalf("expected managed Kurlo changes to be clean, got %#v", status.Files)
	}
	if _, err := os.Stat(filepath.Join(dir, "notes.txt")); err != nil {
		t.Fatalf("non-kurlo file should not be touched: %v", err)
	}
}

func TestGitDiscardWorkspaceFilesOnlyTouchesSelectedKurloFiles(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	configureGitUserForTest(t, dir)
	if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	workspaceRel := "workspaces/Main/workspace.yml"
	requestRel := "workspaces/Main/collections/Default/requests/New.yml"
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\ndirty: true\n"), 0644); err != nil {
		t.Fatalf("write dirty kurlo index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(workspaceRel)), []byte("version: 1\nworkspace:\n  id: workspace-main\n  name: Keep Dirty\n  filesystemName: Main\n"), 0644); err != nil {
		t.Fatalf("write dirty workspace: %v", err)
	}
	requestPath := filepath.Join(dir, filepath.FromSlash(requestRel))
	if err := os.MkdirAll(filepath.Dir(requestPath), 0755); err != nil {
		t.Fatalf("create request dir: %v", err)
	}
	if err := os.WriteFile(requestPath, []byte("version: 1\nrequest:\n  id: req-new\n  name: New\n"), 0644); err != nil {
		t.Fatalf("write untracked request: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("keep\n"), 0644); err != nil {
		t.Fatalf("write non-kurlo file: %v", err)
	}

	result := gitDiscardWorkspaceFilesForRoot(dir, []string{"kurlo.yml", requestRel})
	if !result.Ok {
		t.Fatalf("discard selected failed: %s\n%s", result.Error, result.Output)
	}
	kurloData, err := os.ReadFile(filepath.Join(dir, "kurlo.yml"))
	if err != nil {
		t.Fatalf("read kurlo index: %v", err)
	}
	if strings.Contains(string(kurloData), "dirty") {
		t.Fatalf("selected kurlo file was not restored:\n%s", kurloData)
	}
	if _, err := os.Stat(requestPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("selected untracked request should be removed, err=%v", err)
	}
	workspaceData, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(workspaceRel)))
	if err != nil {
		t.Fatalf("read workspace: %v", err)
	}
	if !strings.Contains(string(workspaceData), "Keep Dirty") {
		t.Fatalf("unselected workspace file should remain dirty:\n%s", workspaceData)
	}
	if _, err := os.Stat(filepath.Join(dir, "notes.txt")); err != nil {
		t.Fatalf("non-kurlo file should not be touched: %v", err)
	}
}

func TestGitDiscardWorkspaceFileRejectsNonKurloPath(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	configureGitUserForTest(t, dir)
	if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("keep\n"), 0644); err != nil {
		t.Fatalf("write non-kurlo file: %v", err)
	}

	result := gitDiscardWorkspaceFileForRoot(dir, "notes.txt")
	if result.Ok {
		t.Fatalf("expected discard to reject non-kurlo path")
	}
	if !strings.Contains(result.Error, "Kurlo workspace files") {
		t.Fatalf("expected managed path error, got %q", result.Error)
	}
}

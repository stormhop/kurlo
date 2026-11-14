package api

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitStatusDetectsRepositoryAndChangedFiles(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	runGitForTest(t, dir, "init")
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\n"), 0644); err != nil {
		t.Fatalf("write workspace file: %v", err)
	}

	status := gitStatusForWorkspace(dir)
	if !status.IsRepo {
		t.Fatalf("expected git repository status, got %#v", status)
	}
	expectedRoot, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("resolve temp dir: %v", err)
	}
	if status.Root != expectedRoot {
		t.Fatalf("expected repo root %q, got %q", expectedRoot, status.Root)
	}
	if status.Clean {
		t.Fatalf("expected dirty status for untracked file")
	}
	if len(status.Files) != 1 || status.Files[0].Path != "kurlo.yml" || status.Files[0].Status != "untracked" {
		t.Fatalf("unexpected files: %#v", status.Files)
	}
}

func TestGitDiffShowsUntrackedWorkspaceFile(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	runGitForTest(t, dir, "init")
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\n"), 0644); err != nil {
		t.Fatalf("write workspace file: %v", err)
	}

	diff := gitDiffForWorkspace(dir, "kurlo.yml")
	if diff.Error != "" {
		t.Fatalf("unexpected diff error: %s", diff.Error)
	}
	if !strings.Contains(diff.Diff, "version: 1") {
		t.Fatalf("expected untracked file content in diff, got:\n%s", diff.Diff)
	}
}

func TestGitDiffSeparatesStagedAndUnstagedChanges(t *testing.T) {
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
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nstate: staged\n"), 0644); err != nil {
		t.Fatalf("write staged kurlo index: %v", err)
	}
	runGitForTest(t, dir, "add", "kurlo.yml")
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nstate: unstaged\n"), 0644); err != nil {
		t.Fatalf("write unstaged kurlo index: %v", err)
	}

	diff := gitDiffForWorkspace(dir, "kurlo.yml")
	if diff.Error != "" {
		t.Fatalf("unexpected diff error: %s", diff.Error)
	}
	if !strings.Contains(diff.StagedDiff, "state: staged") {
		t.Fatalf("expected staged diff to show indexed content, got:\n%s", diff.StagedDiff)
	}
	if !strings.Contains(diff.UnstagedDiff, "state: unstaged") {
		t.Fatalf("expected unstaged diff to show worktree content, got:\n%s", diff.UnstagedDiff)
	}
	if !strings.Contains(diff.Diff, "state: staged") || !strings.Contains(diff.Diff, "state: unstaged") {
		t.Fatalf("combined diff should remain backward compatible, got:\n%s", diff.Diff)
	}
}

func TestGitStatusMarshalsEmptyFilesAsArray(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	runGitForTest(t, dir, "init")

	status := gitStatusForWorkspace(dir)
	data, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("marshal status: %v", err)
	}
	if strings.Contains(string(data), `"files":null`) {
		t.Fatalf("expected files to marshal as an array, got %s", data)
	}
	if !strings.Contains(string(data), `"files":[]`) {
		t.Fatalf("expected empty files array, got %s", data)
	}
}

func TestGitStatusMarksMissingWorkspaceRoot(t *testing.T) {
	t.Parallel()

	missingRoot := filepath.Join(t.TempDir(), "deleted-workspace")

	status := gitStatusForWorkspace(missingRoot)
	if !status.MissingRoot {
		t.Fatalf("expected missing root status, got %#v", status)
	}
	if status.IsRepo {
		t.Fatalf("missing folder should not be reported as a repository")
	}
	if status.Error == "" || strings.Contains(status.Error, "stat ") || strings.Contains(status.Error, "no such file") {
		t.Fatalf("expected friendly missing folder error, got %q", status.Error)
	}
}

func TestGitInitWorkspaceMissingRootReturnsFriendlyError(t *testing.T) {
	t.Parallel()

	missingRoot := filepath.Join(t.TempDir(), "deleted-workspace")

	result := gitInitWorkspaceForRoot(missingRoot)
	if result.Ok {
		t.Fatalf("init should fail for missing workspace root")
	}
	if !result.Git.MissingRoot {
		t.Fatalf("expected missing root status, got %#v", result.Git)
	}
	if result.Error == "" || strings.Contains(result.Error, "stat ") || strings.Contains(result.Error, "no such file") {
		t.Fatalf("expected friendly missing folder error, got %q", result.Error)
	}
}

func TestFriendlyGitErrorAddsPrivateRepositoryHints(t *testing.T) {
	t.Parallel()

	message := friendlyGitError("clone", "git@gitlab.com: Permission denied (publickey).", nil)
	if !strings.Contains(message, "ssh-agent") || !strings.Contains(message, "GitHub/GitLab/Bitbucket") {
		t.Fatalf("expected SSH auth hint, got %q", message)
	}
	message = friendlyGitError("clone", "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled", nil)
	if !strings.Contains(message, "credential helper") || !strings.Contains(message, "personal access token") || strings.Contains(message, "does not store") {
		t.Fatalf("expected HTTPS auth hint, got %q", message)
	}
}

func TestNormalizeGitDiffPathsKeepsSidePrefixes(t *testing.T) {
	t.Parallel()

	diff := "diff --git a/Users/me/repo/workspaces/x.txt b/Users/me/repo/workspaces/x.txt\n--- /dev/null\n+++ b/Users/me/repo/workspaces/x.txt\n@@ -0,0 +1 @@\n+a/Users/me/repo/kept"
	got := normalizeGitDiffPaths("/Users/me/repo", diff)
	want := "diff --git a/workspaces/x.txt b/workspaces/x.txt\n--- /dev/null\n+++ b/workspaces/x.txt\n@@ -0,0 +1 @@\n+a/Users/me/repo/kept"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestGitStatusMarksWhichChangesKurloCanHandle(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	repo := t.TempDir()
	root := filepath.Join(repo, "api")
	writeKurloWorkspaceFiles(t, root)
	runGitForTest(t, repo, "init")
	for _, path := range []string{"README.md", "api/workspaces/Main/notes.txt", "api/kurlo-agent.md", "kurlo-agent.md", "api/workspaces/Main/kurlo-agent.md", "api/workspaces/Main/README.md"} {
		if err := os.WriteFile(filepath.Join(repo, filepath.FromSlash(path)), []byte("x\n"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	managed := map[string]bool{}
	for _, file := range gitStatusForWorkspace(root).Files {
		managed[file.Path] = file.Managed
	}
	if !managed["api/kurlo.yml"] || !managed["api/workspaces/Main/workspace.yml"] || !managed["api/kurlo-agent.md"] || !managed["api/workspaces/Main/README.md"] {
		t.Fatalf("Kurlo files must be managed: %#v", managed)
	}
	for _, path := range []string{"README.md", "api/workspaces/Main/notes.txt", "kurlo-agent.md", "api/workspaces/Main/kurlo-agent.md"} {
		if value, listed := managed[path]; !listed || value {
			t.Fatalf("%s must be listed as not managed: %#v", path, managed)
		}
	}
}

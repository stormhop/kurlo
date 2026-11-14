package api

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitCommitStagesAndCommitsOnlyKurloFiles(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	if err := os.MkdirAll(filepath.Join(dir, ".kurlo-local"), 0755); err != nil {
		t.Fatalf("create local dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".kurlo-local", "secrets.json"), []byte(`{"token":"secret"}`+"\n"), 0600); err != nil {
		t.Fatalf("write local secret file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "history.json"), []byte(`{"history":[]}`+"\n"), 0644); err != nil {
		t.Fatalf("write history file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "workspaces", "Main", "notes.txt"), []byte("draft notes\n"), 0644); err != nil {
		t.Fatalf("write workspace notes: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "workspaces", "Main", "Readme.md"), []byte("# Main\n"), 0644); err != nil {
		t.Fatalf("write workspace README: %v", err)
	}

	initResult := gitInitWorkspaceForRoot(dir)
	if !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	runGitForTest(t, dir, "config", "user.email", "kurlo@example.test")
	runGitForTest(t, dir, "config", "user.name", "Kurlo Test")

	commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace")
	if !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	committed := strings.Join(commitResult.Files, "\n")
	if !strings.Contains(committed, "kurlo.yml") || !strings.Contains(committed, "workspaces/Main/workspace.yml") {
		t.Fatalf("expected Kurlo files to be committed, got %#v", commitResult.Files)
	}
	if strings.Contains(committed, "history.json") || strings.Contains(committed, ".kurlo-local") || strings.Contains(committed, "workspaces/Main/notes.txt") {
		t.Fatalf("non-Kurlo files were committed: %#v", commitResult.Files)
	}
	tree := runGitOutputForTest(t, dir, "ls-tree", "-r", "--name-only", "HEAD")
	if strings.Contains(tree, "history.json") || strings.Contains(tree, ".kurlo-local") || strings.Contains(tree, "workspaces/Main/notes.txt") {
		t.Fatalf("committed non-Kurlo files:\n%s", tree)
	}
	if !strings.Contains(tree, "kurlo.yml") || !strings.Contains(tree, "workspaces/Main/workspace.yml") || !strings.Contains(tree, "workspaces/Main/Readme.md") {
		t.Fatalf("committed tree is missing Kurlo files:\n%s", tree)
	}
}

func TestGitHistoryIgnoresNonYAMLFilesUnderWorkspaces(t *testing.T) {
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

	notesRel := "workspaces/Main/notes.txt"
	if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(notesRel)), []byte("draft notes\n"), 0644); err != nil {
		t.Fatalf("write workspace notes: %v", err)
	}
	runGitForTest(t, dir, "add", notesRel)
	runGitForTest(t, dir, "commit", "-m", "Workspace notes")

	logResult := gitCommitLogForRoot(dir, 10)
	if !logResult.Ok {
		t.Fatalf("git log failed: %s\n%s", logResult.Error, logResult.Output)
	}
	for _, commit := range logResult.Commits {
		if commit.Message == "Workspace notes" {
			t.Fatalf("non-YAML workspace note commit leaked into Kurlo history: %#v", logResult.Commits)
		}
	}

	head := strings.TrimSpace(runGitOutputForTest(t, dir, "rev-parse", "HEAD"))
	diff := gitCommitDiffForRoot(dir, head)
	if diff.Error != "" {
		t.Fatalf("commit diff failed: %s", diff.Error)
	}
	if !strings.Contains(diff.Diff, "No Kurlo workspace changes") {
		t.Fatalf("expected non-YAML commit diff to be ignored, got:\n%s", diff.Diff)
	}
}

func TestGitManagedPathspecsRespectWorkspaceSubdirectory(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	repo := t.TempDir()
	workspace := filepath.Join(repo, "apps", "kurlo-workspace")
	if err := os.MkdirAll(workspace, 0755); err != nil {
		t.Fatalf("create workspace dir: %v", err)
	}
	writeKurloWorkspaceFiles(t, workspace)
	runGitForTest(t, repo, "init")
	configureGitUserForTest(t, repo)

	if commitResult := gitCommitWorkspaceForRoot(workspace, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	tree := runGitOutputForTest(t, repo, "ls-tree", "-r", "--name-only", "HEAD")
	if !strings.Contains(tree, "apps/kurlo-workspace/kurlo.yml") || !strings.Contains(tree, "apps/kurlo-workspace/workspaces/Main/workspace.yml") {
		t.Fatalf("workspace subdirectory files were not committed:\n%s", tree)
	}

	notesRel := "apps/kurlo-workspace/workspaces/Main/notes.txt"
	if err := os.WriteFile(filepath.Join(repo, filepath.FromSlash(notesRel)), []byte("draft notes\n"), 0644); err != nil {
		t.Fatalf("write workspace notes: %v", err)
	}
	runGitForTest(t, repo, "add", notesRel)
	runGitForTest(t, repo, "commit", "-m", "Workspace notes")

	logResult := gitCommitLogForRoot(workspace, 10)
	if !logResult.Ok {
		t.Fatalf("git log failed: %s\n%s", logResult.Error, logResult.Output)
	}
	for _, commit := range logResult.Commits {
		if commit.Message == "Workspace notes" {
			t.Fatalf("non-YAML subdirectory note commit leaked into Kurlo history: %#v", logResult.Commits)
		}
	}
}

func TestGitCommitRejectsNonKurloStagedFiles(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	runGitForTest(t, dir, "init")
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("draft\n"), 0644); err != nil {
		t.Fatalf("write notes: %v", err)
	}
	runGitForTest(t, dir, "add", "notes.txt")

	result := gitCommitWorkspaceForRoot(dir, "Should not commit")
	if result.Ok {
		t.Fatalf("expected commit to be rejected")
	}
	if !strings.Contains(result.Error, "non-Kurlo files") {
		t.Fatalf("expected non-Kurlo error, got %q", result.Error)
	}

	if err := os.MkdirAll(filepath.Join(dir, "workspaces", "Main"), 0755); err != nil {
		t.Fatalf("create workspace dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "workspaces", "Main", "notes.txt"), []byte("keep\n"), 0644); err != nil {
		t.Fatalf("write workspace notes: %v", err)
	}
	result = gitCommitWorkspaceFilesForRoot(dir, []string{"workspaces/Main/notes.txt"}, "Should not commit")
	if result.Ok {
		t.Fatalf("expected partial commit to reject non-YAML workspace path")
	}
	if !strings.Contains(result.Error, "Kurlo workspace files") {
		t.Fatalf("expected managed path error, got %q", result.Error)
	}
}

func TestGitCommitWorkspaceFilesCommitsOnlySelectedKurloFiles(t *testing.T) {
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
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nselected: true\n"), 0644); err != nil {
		t.Fatalf("write selected kurlo index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(workspaceRel)), []byte("version: 1\nworkspace:\n  id: workspace-main\n  name: Dirty\n  filesystemName: Main\n"), 0644); err != nil {
		t.Fatalf("write unselected workspace: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("do not commit\n"), 0644); err != nil {
		t.Fatalf("write non-kurlo file: %v", err)
	}
	runGitForTest(t, dir, "add", "notes.txt")

	result := gitCommitWorkspaceFilesForRoot(dir, []string{"kurlo.yml"}, "Commit selected Kurlo file")
	if !result.Ok {
		t.Fatalf("partial commit failed: %s\n%s", result.Error, result.Output)
	}
	if len(result.Files) != 1 || result.Files[0] != "kurlo.yml" {
		t.Fatalf("expected only kurlo.yml to be committed, got %#v", result.Files)
	}
	headKurlo := runGitOutputForTest(t, dir, "show", "HEAD:kurlo.yml")
	if !strings.Contains(headKurlo, "selected: true") {
		t.Fatalf("selected file was not committed:\n%s", headKurlo)
	}
	headWorkspace := runGitOutputForTest(t, dir, "show", "HEAD:"+workspaceRel)
	if strings.Contains(headWorkspace, "Dirty") {
		t.Fatalf("unselected workspace file was committed:\n%s", headWorkspace)
	}
	tree := runGitOutputForTest(t, dir, "ls-tree", "-r", "--name-only", "HEAD")
	if strings.Contains(tree, "notes.txt") {
		t.Fatalf("non-Kurlo staged file was committed:\n%s", tree)
	}
	status := gitStatusForWorkspace(dir)
	if !gitChangedPathExists(status.Files, workspaceRel) {
		t.Fatalf("expected unselected workspace file to remain changed, got %#v", status.Files)
	}
}

func TestGitCommitWorkspaceFilesRejectsNonKurloPath(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	runGitForTest(t, dir, "init")
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("keep\n"), 0644); err != nil {
		t.Fatalf("write notes: %v", err)
	}

	result := gitCommitWorkspaceFilesForRoot(dir, []string{"notes.txt"}, "Should not commit")
	if result.Ok {
		t.Fatalf("expected partial commit to reject non-Kurlo path")
	}
	if !strings.Contains(result.Error, "Kurlo workspace files") {
		t.Fatalf("expected managed path error, got %q", result.Error)
	}
}

func TestGitStashWorkspaceStashesOnlyKurloManagedFiles(t *testing.T) {
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
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nstashed: true\n"), 0644); err != nil {
		t.Fatalf("write kurlo change: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("keep local\n"), 0644); err != nil {
		t.Fatalf("write non-kurlo note: %v", err)
	}

	stashResult := gitStashWorkspaceForRoot(dir, "Save Kurlo change")
	if !stashResult.Ok {
		t.Fatalf("stash failed: %s\n%s", stashResult.Error, stashResult.Output)
	}
	if len(stashResult.Git.Stashes) != 1 || !strings.Contains(stashResult.Git.Stashes[0].Message, "Save Kurlo change") {
		t.Fatalf("expected stash entry, got %#v", stashResult.Git.Stashes)
	}
	kurlo := readFileForTest(t, filepath.Join(dir, "kurlo.yml"))
	if strings.Contains(kurlo, "stashed: true") {
		t.Fatalf("kurlo change was not stashed:\n%s", kurlo)
	}
	if note := readFileForTest(t, filepath.Join(dir, "notes.txt")); note != "keep local\n" {
		t.Fatalf("non-kurlo note should remain in the worktree, got %q", note)
	}

	popResult := gitStashPopWorkspaceForRoot(dir, "")
	if !popResult.Ok {
		t.Fatalf("stash pop failed: %s\n%s", popResult.Error, popResult.Output)
	}
	kurlo = readFileForTest(t, filepath.Join(dir, "kurlo.yml"))
	if !strings.Contains(kurlo, "stashed: true") {
		t.Fatalf("kurlo change was not restored:\n%s", kurlo)
	}
	if len(popResult.Git.Stashes) != 0 {
		t.Fatalf("expected stash to be dropped after pop, got %#v", popResult.Git.Stashes)
	}
}

func TestGitCommitLogAndCommitDiffShowKurloHistory(t *testing.T) {
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
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nhistory: true\n"), 0644); err != nil {
		t.Fatalf("write changed kurlo index: %v", err)
	}
	if commitResult := gitCommitWorkspaceForRoot(dir, "Update Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}

	logResult := gitCommitLogForRoot(dir, 10)
	if !logResult.Ok {
		t.Fatalf("log failed: %s\n%s", logResult.Error, logResult.Output)
	}
	if len(logResult.Commits) < 2 || logResult.Commits[0].Message != "Update Kurlo workspace" {
		t.Fatalf("unexpected commit log: %#v", logResult.Commits)
	}
	diff := gitCommitDiffForRoot(dir, logResult.Commits[0].Hash)
	if diff.Error != "" {
		t.Fatalf("commit diff failed: %s", diff.Error)
	}
	if !strings.Contains(diff.Diff, "history: true") || strings.Contains(diff.Diff, "history.json") {
		t.Fatalf("unexpected commit diff:\n%s", diff.Diff)
	}
}

func TestGitCommitLogPagePaginatesKurloHistory(t *testing.T) {
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
	for i := 1; i <= 5; i++ {
		if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte(fmt.Sprintf("version: 1\npage: %d\n", i)), 0644); err != nil {
			t.Fatalf("write kurlo index %d: %v", i, err)
		}
		if commitResult := gitCommitWorkspaceForRoot(dir, fmt.Sprintf("Kurlo page %d", i)); !commitResult.Ok {
			t.Fatalf("commit %d failed: %s\n%s", i, commitResult.Error, commitResult.Output)
		}
	}

	first := gitCommitLogPageForRoot(dir, 2, 0)
	if !first.Ok {
		t.Fatalf("first page failed: %s\n%s", first.Error, first.Output)
	}
	if first.Limit != 2 || first.Offset != 0 || !first.HasMore || len(first.Commits) != 2 {
		t.Fatalf("unexpected first page metadata: %#v", first)
	}
	if first.Commits[0].Message != "Kurlo page 5" || first.Commits[1].Message != "Kurlo page 4" {
		t.Fatalf("unexpected first page commits: %#v", first.Commits)
	}

	second := gitCommitLogPageForRoot(dir, 2, 2)
	if !second.Ok {
		t.Fatalf("second page failed: %s\n%s", second.Error, second.Output)
	}
	if second.Limit != 2 || second.Offset != 2 || !second.HasMore || len(second.Commits) != 2 {
		t.Fatalf("unexpected second page metadata: %#v", second)
	}
	if second.Commits[0].Message != "Kurlo page 3" || second.Commits[1].Message != "Kurlo page 2" {
		t.Fatalf("unexpected second page commits: %#v", second.Commits)
	}

	last := gitCommitLogPageForRoot(dir, 2, 4)
	if !last.Ok {
		t.Fatalf("last page failed: %s\n%s", last.Error, last.Output)
	}
	if last.HasMore || len(last.Commits) != 1 || last.Commits[0].Message != "Kurlo page 1" {
		t.Fatalf("unexpected last page: %#v", last)
	}
}

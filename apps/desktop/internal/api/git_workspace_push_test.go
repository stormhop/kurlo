package api

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitPushWorkspaceFriendlyErrorAfterLocalRename(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir, _ := setupGitPullRemoteForTest(t)

	runGitForTest(t, dir, "config", "push.default", "simple")

	status := gitStatusForWorkspace(dir)
	oldBranch := status.Branch
	if oldBranch == "" {
		t.Fatalf("could not determine current branch: %#v", status)
	}
	const newBranch = "renamed-locally"
	if r := gitRenameBranchForRoot(dir, oldBranch, newBranch, false); !r.Ok {
		t.Fatalf("local rename failed: %s\n%s", r.Error, r.Output)
	}

	collectionPath := filepath.Join(dir, "workspaces", "Main", "collections", "Default", "collection.yml")
	body, err := os.ReadFile(collectionPath)
	if err != nil {
		t.Fatalf("read collection.yml: %v", err)
	}
	if err := os.WriteFile(collectionPath, append(body, []byte("\n# local rename change\n")...), 0644); err != nil {
		t.Fatalf("modify collection.yml: %v", err)
	}
	if c := gitCommitWorkspaceForRoot(dir, "Change after local rename"); !c.Ok {
		t.Fatalf("commit failed: %s\n%s", c.Error, c.Output)
	}

	result := gitPushWorkspaceForRoot(dir, "origin")
	if result.Ok {
		t.Fatalf("expected push to fail due to upstream name mismatch, got Ok\n%s", result.Output)
	}
	if !strings.Contains(result.Error, "was renamed locally but still tracks") || !strings.Contains(result.Error, "Rename (remote)") {
		t.Fatalf("expected friendly rename-mismatch error, got: %q", result.Error)
	}
	if strings.Contains(result.Error, "push.default") {
		t.Fatalf("friendly error must not leak the raw git push.default advice, got: %q", result.Error)
	}
	normalizedOutput := strings.Join(strings.Fields(strings.ToLower(result.Output)), " ")
	if !strings.Contains(normalizedOutput, "does not match the name of your current branch") {
		t.Fatalf("raw git output should be preserved in Output for the Git output panel, got: %q", result.Output)
	}
}

func TestGitPushWorkspaceUsesLocalRemote(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	remote := filepath.Join(t.TempDir(), "origin.git")
	if err := os.MkdirAll(remote, 0755); err != nil {
		t.Fatalf("create bare remote dir: %v", err)
	}
	initBareRemoteForTest(t, remote)
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	runGitForTest(t, dir, "config", "user.email", "kurlo@example.test")
	runGitForTest(t, dir, "config", "user.name", "Kurlo Test")
	if remoteResult := gitAddRemoteForRoot(dir, "origin", remote); !remoteResult.Ok {
		t.Fatalf("add remote failed: %s\n%s", remoteResult.Error, remoteResult.Output)
	}
	if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}

	pushResult := gitPushWorkspaceForRoot(dir, "origin")
	if !pushResult.Ok {
		t.Fatalf("push failed: %s\n%s", pushResult.Error, pushResult.Output)
	}
}

func TestGitPushNewBranchAfterCommitSetsUpstream(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	remote := filepath.Join(t.TempDir(), "origin.git")
	if err := os.MkdirAll(remote, 0755); err != nil {
		t.Fatalf("create bare remote dir: %v", err)
	}
	initBareRemoteForTest(t, remote)
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	configureGitUserForTest(t, dir)
	if remoteResult := gitAddRemoteForRoot(dir, "origin", remote); !remoteResult.Ok {
		t.Fatalf("add remote failed: %s\n%s", remoteResult.Error, remoteResult.Output)
	}
	if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	if pushResult := gitPushWorkspaceForRoot(dir, "origin"); !pushResult.Ok {
		t.Fatalf("push failed: %s\n%s", pushResult.Error, pushResult.Output)
	}
	if branchResult := gitCreateBranchForRoot(dir, "feature/new-branch", "main"); !branchResult.Ok {
		t.Fatalf("branch failed: %s\n%s", branchResult.Error, branchResult.Output)
	}
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nformat: kurlo.workspace.yaml.v1\nscenario: new-branch\n"), 0644); err != nil {
		t.Fatalf("write kurlo index: %v", err)
	}
	commitResult := gitCommitWorkspaceForRoot(dir, "Update new branch")
	if !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	if commitResult.Git.Upstream != "" {
		t.Fatalf("new branch upstream = %q, want none before first push", commitResult.Git.Upstream)
	}
	if commitResult.Git.Ahead != 0 {
		t.Fatalf("new branch ahead = %d, want 0 without upstream", commitResult.Git.Ahead)
	}
	if commitResult.Git.PushRemote != "origin" {
		t.Fatalf("push remote = %q, want origin", commitResult.Git.PushRemote)
	}
	if commitResult.Git.PushCommitCount != 1 {
		t.Fatalf("push commit count before first push = %d, want 1", commitResult.Git.PushCommitCount)
	}

	pushResult := gitPushWorkspaceForRoot(dir, "origin")
	if !pushResult.Ok {
		t.Fatalf("push failed: %s\n%s", pushResult.Error, pushResult.Output)
	}
	if pushResult.CommitCount != 1 {
		t.Fatalf("pushed commit count = %d, want 1", pushResult.CommitCount)
	}
	if pushResult.PullSummary.Changed == 0 {
		t.Fatalf("expected pushed file summary, got %#v", pushResult.PullSummary)
	}
	if pushResult.Git.Upstream != "origin/feature/new-branch" {
		t.Fatalf("upstream = %q, want origin/feature/new-branch", pushResult.Git.Upstream)
	}
	remoteHead := strings.TrimSpace(runGitOutputForTest(t, dir, "ls-remote", "origin", "refs/heads/feature/new-branch"))
	localHead := strings.TrimSpace(runGitOutputForTest(t, dir, "rev-parse", "HEAD"))
	if !strings.HasPrefix(remoteHead, localHead) {
		t.Fatalf("expected remote feature branch to point at %s, got %s", localHead, remoteHead)
	}
}

func TestGitForcePushWorkspaceUsesForceWithLease(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	remote := filepath.Join(t.TempDir(), "origin.git")
	if err := os.MkdirAll(remote, 0755); err != nil {
		t.Fatalf("create bare remote dir: %v", err)
	}
	initBareRemoteForTest(t, remote)
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	configureGitUserForTest(t, dir)
	if remoteResult := gitAddRemoteForRoot(dir, "origin", remote); !remoteResult.Ok {
		t.Fatalf("add remote failed: %s\n%s", remoteResult.Error, remoteResult.Output)
	}
	if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	if pushResult := gitPushWorkspaceForRoot(dir, "origin"); !pushResult.Ok {
		t.Fatalf("push failed: %s\n%s", pushResult.Error, pushResult.Output)
	}
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nrewritten: true\n"), 0644); err != nil {
		t.Fatalf("rewrite kurlo index: %v", err)
	}
	runGitForTest(t, dir, "add", "kurlo.yml")
	runGitForTest(t, dir, "commit", "--amend", "-m", "Rewrite Kurlo workspace")

	result := gitForcePushWorkspaceForRoot(dir, "origin")
	if !result.Ok {
		t.Fatalf("force push failed: %s\n%s", result.Error, result.Output)
	}
	remoteHead := strings.TrimSpace(runGitOutputForTest(t, dir, "ls-remote", "origin", "refs/heads/main"))
	localHead := strings.TrimSpace(runGitOutputForTest(t, dir, "rev-parse", "HEAD"))
	if !strings.HasPrefix(remoteHead, localHead) {
		t.Fatalf("expected remote to point at rewritten head %s, got %s", localHead, remoteHead)
	}
}

func TestGitForcePushRefusesToDropFetchedTeammateCommits(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir, peer := setupGitPullRemoteForTest(t)
	if err := os.WriteFile(filepath.Join(peer, "teammate.txt"), []byte("work\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitForTest(t, peer, "add", "teammate.txt")
	runGitForTest(t, peer, "commit", "-m", "Teammate work")
	runGitForTest(t, peer, "push", "origin", "main")
	teammateHead := strings.TrimSpace(runGitOutputForTest(t, peer, "rev-parse", "HEAD"))

	if _, err := gitFetchWorkspaceOnOpen(dir); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nrewritten: true\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitForTest(t, dir, "add", "kurlo.yml")
	runGitForTest(t, dir, "commit", "--amend", "-m", "Rewrite Kurlo workspace")

	result := gitForcePushWorkspaceForRoot(dir, "origin")
	if result.Ok {
		t.Fatal("expected force push to refuse overwriting a fetched commit that was never integrated")
	}
	remoteHead := strings.TrimSpace(runGitOutputForTest(t, dir, "ls-remote", "origin", "refs/heads/main"))
	if !strings.HasPrefix(remoteHead, teammateHead) {
		t.Fatalf("expected the teammate's commit to survive, remote is at %s", remoteHead)
	}
}

func TestGitOutgoingChangesShowsOnlyCommittedKurloFiles(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	remote := filepath.Join(t.TempDir(), "origin.git")
	if err := os.MkdirAll(remote, 0755); err != nil {
		t.Fatalf("create bare remote dir: %v", err)
	}
	initBareRemoteForTest(t, remote)
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	configureGitUserForTest(t, dir)
	if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
		t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	if remoteResult := gitAddRemoteForRoot(dir, "origin", remote); !remoteResult.Ok {
		t.Fatalf("add remote failed: %s\n%s", remoteResult.Error, remoteResult.Output)
	}
	runGitForTest(t, dir, "push", "-u", "origin", "main")
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nformat: kurlo.workspace.yaml.v1\nchanged: true\n"), 0644); err != nil {
		t.Fatalf("write changed kurlo index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "history.json"), []byte(`{"history":["local-only"]}`+"\n"), 0644); err != nil {
		t.Fatalf("write history file: %v", err)
	}
	runGitForTest(t, dir, "add", "kurlo.yml", "history.json")
	runGitForTest(t, dir, "commit", "-m", "Update Kurlo workspace")

	diff := gitOutgoingChangesForWorkspace(dir)
	if diff.Error != "" {
		t.Fatalf("unexpected outgoing diff error: %s", diff.Error)
	}
	if !strings.Contains(diff.Diff, "changed: true") {
		t.Fatalf("expected Kurlo file diff, got:\n%s", diff.Diff)
	}
	if strings.Contains(diff.Diff, "Outgoing Kurlo workspace changes") || strings.Contains(diff.Diff, "Commits") || strings.Contains(diff.Diff, "Stat") {
		t.Fatalf("outgoing diff should only contain the patch:\n%s", diff.Diff)
	}
	if strings.Contains(diff.Diff, "history.json") || strings.Contains(diff.Diff, "local-only") {
		t.Fatalf("outgoing diff included non-Kurlo files:\n%s", diff.Diff)
	}
}

func TestGitOutgoingChangesWithoutUpstreamShowsInitialPublishDiff(t *testing.T) {
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

	diff := gitOutgoingChangesForWorkspace(dir)
	if diff.Error != "" {
		t.Fatalf("unexpected outgoing diff error: %s", diff.Error)
	}
	if !strings.Contains(diff.Diff, "kurlo.yml") {
		t.Fatalf("expected first-publish outgoing diff, got:\n%s", diff.Diff)
	}
	if strings.Contains(diff.Diff, "No upstream branch is set") {
		t.Fatalf("outgoing diff should only contain the patch:\n%s", diff.Diff)
	}
}

func TestGitTestRemoteUsesConfiguredRemote(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	remote := filepath.Join(t.TempDir(), "origin.git")
	if err := os.MkdirAll(remote, 0755); err != nil {
		t.Fatalf("create bare remote dir: %v", err)
	}
	initBareRemoteForTest(t, remote)
	writeKurloWorkspaceFiles(t, dir)
	if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	if remoteResult := gitAddRemoteForRoot(dir, "origin", remote); !remoteResult.Ok {
		t.Fatalf("add remote failed: %s\n%s", remoteResult.Error, remoteResult.Output)
	}

	result := gitTestRemoteForRoot(dir, "origin")
	if !result.Ok {
		t.Fatalf("test remote failed: %s\n%s", result.Error, result.Output)
	}
}

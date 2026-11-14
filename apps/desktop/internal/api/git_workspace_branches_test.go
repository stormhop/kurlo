package api

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitCreateBranchFromRemoteBaseDoesNotTrackDifferentBranchName(t *testing.T) {
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
	if checkoutResult := gitCheckoutBranchForRoot(dir, "main"); !checkoutResult.Ok {
		t.Fatalf("checkout failed: %s\n%s", checkoutResult.Error, checkoutResult.Output)
	}

	result := gitCreateBranchForRoot(dir, "feature/from-main", "origin/main")
	if !result.Ok {
		t.Fatalf("branch failed: %s\n%s", result.Error, result.Output)
	}
	if result.Git.Upstream != "" {
		t.Fatalf("upstream = %q, want no upstream for a differently named branch from origin/main", result.Git.Upstream)
	}
}

func TestParseGitBranchLineTracksGoneUpstreamSeparately(t *testing.T) {
	t.Parallel()

	status := GitWorkspaceStatus{}
	parseGitBranchLine("No commits yet on main...origin/main [gone]", &status)
	if status.Branch != "main" {
		t.Fatalf("branch = %q, want main", status.Branch)
	}
	if status.Upstream != "origin/main" {
		t.Fatalf("upstream = %q, want origin/main", status.Upstream)
	}
	if !status.UpstreamGone {
		t.Fatal("expected upstream gone flag")
	}
	if status.Ahead != 0 || status.Behind != 0 {
		t.Fatalf("ahead/behind = %d/%d, want 0/0", status.Ahead, status.Behind)
	}

	status = GitWorkspaceStatus{}
	parseGitBranchLine("main...origin/main [gone]", &status)
	if status.Branch != "main" || status.Upstream != "origin/main" || !status.UpstreamGone {
		t.Fatalf("unexpected gone branch parse: %#v", status)
	}

	status = GitWorkspaceStatus{}
	parseGitBranchLine("feature/api...origin/feature/api [ahead 2, behind 1]", &status)
	if status.Branch != "feature/api" || status.Upstream != "origin/feature/api" {
		t.Fatalf("unexpected branch tracking parse: %#v", status)
	}
	if status.UpstreamGone {
		t.Fatal("did not expect upstream gone flag")
	}
	if status.Ahead != 2 || status.Behind != 1 {
		t.Fatalf("ahead/behind = %d/%d, want 2/1", status.Ahead, status.Behind)
	}
}

func TestGitBranchesListLocalAndRemoteBranches(t *testing.T) {
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
	runGitForTest(t, dir, "checkout", "-b", "feature/local")
	runGitForTest(t, dir, "push", "-u", "origin", "feature/local")
	runGitForTest(t, dir, "checkout", "main")
	runGitForTest(t, dir, "branch", "-D", "feature/local")
	runGitForTest(t, dir, "fetch", "origin")

	result := gitBranchesForRoot(dir)
	if !result.Ok {
		t.Fatalf("branches failed: %s\n%s", result.Error, result.Output)
	}
	if !branchListContains(result.LocalBranches, "main") {
		t.Fatalf("expected local main branch, got %#v", result.LocalBranches)
	}
	if !branchListContainsFullName(result.RemoteBranches, "origin/feature/local") {
		t.Fatalf("expected remote feature branch, got %#v", result.RemoteBranches)
	}
}

func TestGitBranchesKeepStableAlphabeticalLocalOrder(t *testing.T) {
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
	runGitForTest(t, dir, "checkout", "-b", "test")

	result := gitBranchesForRoot(dir)
	if !result.Ok {
		t.Fatalf("branches failed: %s\n%s", result.Error, result.Output)
	}
	if len(result.LocalBranches) < 2 {
		t.Fatalf("expected at least two local branches, got %#v", result.LocalBranches)
	}
	if result.LocalBranches[0].Name != "main" || result.LocalBranches[1].Name != "test" {
		t.Fatalf("expected stable alphabetical order, got %#v", result.LocalBranches)
	}
	if !result.LocalBranches[1].Current {
		t.Fatalf("expected test to remain marked current, got %#v", result.LocalBranches)
	}
}

func TestGitCheckoutBranchRequiresCleanWorkspace(t *testing.T) {
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
	if createResult := gitCreateBranchForRoot(dir, "feature/clean", ""); !createResult.Ok {
		t.Fatalf("create branch failed: %s\n%s", createResult.Error, createResult.Output)
	}
	if checkoutResult := gitCheckoutBranchForRoot(dir, "main"); !checkoutResult.Ok {
		t.Fatalf("checkout main failed: %s\n%s", checkoutResult.Error, checkoutResult.Output)
	}
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\ndirty: true\n"), 0644); err != nil {
		t.Fatalf("dirty kurlo index: %v", err)
	}

	result := gitCheckoutBranchForRoot(dir, "feature/clean")
	if result.Ok {
		t.Fatalf("expected checkout to be blocked by dirty workspace")
	}
	if !strings.Contains(result.Error, "Commit or discard") {
		t.Fatalf("expected clean workspace error, got %q", result.Error)
	}
	current := strings.TrimSpace(runGitOutputForTest(t, dir, "branch", "--show-current"))
	if current != "main" {
		t.Fatalf("expected to remain on main, got %q", current)
	}
}

func TestGitCreateBranchFromRemoteTracksUpstream(t *testing.T) {
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
	runGitForTest(t, dir, "checkout", "-b", "team/api")
	runGitForTest(t, dir, "push", "-u", "origin", "team/api")
	runGitForTest(t, dir, "checkout", "main")
	runGitForTest(t, dir, "branch", "-D", "team/api")
	runGitForTest(t, dir, "fetch", "origin")

	result := gitCreateTrackingBranchForRoot(dir, "local/api", "origin/team/api")
	if !result.Ok {
		t.Fatalf("create from remote failed: %s\n%s", result.Error, result.Output)
	}
	status := gitStatusForWorkspace(dir)
	if status.Branch != "local/api" {
		t.Fatalf("expected local/api branch, got %#v", status)
	}
	if status.Upstream != "origin/team/api" {
		t.Fatalf("expected upstream origin/team/api, got %#v", status)
	}
}

func TestGitCreateBranchFromLocalBranchDoesNotSetUpstream(t *testing.T) {
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

	result := gitCreateBranchForRoot(dir, "feature/from-main", "main")
	if !result.Ok {
		t.Fatalf("create from local branch failed: %s\n%s", result.Error, result.Output)
	}
	status := gitStatusForWorkspace(dir)
	if status.Branch != "feature/from-main" {
		t.Fatalf("expected feature/from-main branch, got %#v", status)
	}
	if status.Upstream != "" {
		t.Fatalf("expected no upstream for branch created from local branch, got %#v", status)
	}
}

func TestGitCreateBranchRejectsExistingLocalBranch(t *testing.T) {
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

	result := gitCreateBranchForRoot(dir, "main", "")
	if result.Ok {
		t.Fatalf("expected existing branch to be rejected")
	}
	if !strings.Contains(result.Error, "already exists") {
		t.Fatalf("expected already exists error, got %q", result.Error)
	}
}

func TestGitDeleteBranchDeletesLocalAndRemoteBranches(t *testing.T) {
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
	if branchResult := gitCreateBranchForRoot(dir, "local/delete-me", "main"); !branchResult.Ok {
		t.Fatalf("local branch create failed: %s\n%s", branchResult.Error, branchResult.Output)
	}
	if checkoutResult := gitCheckoutBranchForRoot(dir, "main"); !checkoutResult.Ok {
		t.Fatalf("checkout main failed: %s\n%s", checkoutResult.Error, checkoutResult.Output)
	}
	if deleteResult := gitDeleteBranchForRoot(dir, "local/delete-me", false, false); !deleteResult.Ok {
		t.Fatalf("local branch delete failed: %s\n%s", deleteResult.Error, deleteResult.Output)
	}
	if localGitBranchExists(dir, "local/delete-me") {
		t.Fatalf("expected local branch to be deleted")
	}
	if branchResult := gitCreateBranchForRoot(dir, "remote/delete-me", "main"); !branchResult.Ok {
		t.Fatalf("remote branch create failed: %s\n%s", branchResult.Error, branchResult.Output)
	}
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nformat: kurlo.workspace.yaml.v1\nscenario: delete-remote\n"), 0644); err != nil {
		t.Fatalf("write kurlo index: %v", err)
	}
	if commitResult := gitCommitWorkspaceForRoot(dir, "Remote branch update"); !commitResult.Ok {
		t.Fatalf("remote branch commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}
	if pushResult := gitPushWorkspaceForRoot(dir, "origin"); !pushResult.Ok {
		t.Fatalf("remote branch push failed: %s\n%s", pushResult.Error, pushResult.Output)
	}
	if checkoutResult := gitCheckoutBranchForRoot(dir, "main"); !checkoutResult.Ok {
		t.Fatalf("checkout main failed: %s\n%s", checkoutResult.Error, checkoutResult.Output)
	}
	if deleteResult := gitDeleteBranchForRoot(dir, "origin/remote/delete-me", true, false); !deleteResult.Ok {
		t.Fatalf("remote branch delete failed: %s\n%s", deleteResult.Error, deleteResult.Output)
	}
	remoteHead := strings.TrimSpace(runGitOutputForTest(t, dir, "ls-remote", "origin", "refs/heads/remote/delete-me"))
	if remoteHead != "" {
		t.Fatalf("expected remote branch to be deleted, got %q", remoteHead)
	}
	if remoteTrackingBranchExists(dir, "origin/remote/delete-me") {
		t.Fatalf("expected remote-tracking branch to be pruned")
	}
	if deleteResult := gitDeleteBranchForRoot(dir, "origin/remote/delete-me", true, false); !deleteResult.Ok {
		t.Fatalf("second remote branch delete should refresh stale state, got: %s\n%s", deleteResult.Error, deleteResult.Output)
	}
}

func TestGitPullBranchFastForwardsNonCurrentTrackingBranch(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir, peer := setupGitPullRemoteForTest(t)
	runGitForTest(t, peer, "checkout", "-b", "feature/api")
	if err := os.WriteFile(filepath.Join(peer, "kurlo.yml"), []byte("version: 1\nformat: kurlo.workspace.yaml.v1\nbranch: api\n"), 0644); err != nil {
		t.Fatalf("write peer kurlo index: %v", err)
	}
	runGitForTest(t, peer, "add", "kurlo.yml")
	runGitForTest(t, peer, "commit", "-m", "Create API branch")
	runGitForTest(t, peer, "push", "-u", "origin", "feature/api")
	runGitForTest(t, dir, "fetch", "origin")
	if createResult := gitCreateTrackingBranchForRoot(dir, "feature/api", "origin/feature/api"); !createResult.Ok {
		t.Fatalf("create tracking branch failed: %s\n%s", createResult.Error, createResult.Output)
	}
	if checkoutResult := gitCheckoutBranchForRoot(dir, "main"); !checkoutResult.Ok {
		t.Fatalf("checkout main failed: %s\n%s", checkoutResult.Error, checkoutResult.Output)
	}
	beforeHead := strings.TrimSpace(runGitOutputForTest(t, dir, "rev-parse", "feature/api"))
	if err := os.WriteFile(filepath.Join(peer, "kurlo.yml"), []byte("version: 1\nformat: kurlo.workspace.yaml.v1\nbranch: api\nupdated: true\n"), 0644); err != nil {
		t.Fatalf("write peer kurlo update: %v", err)
	}
	runGitForTest(t, peer, "add", "kurlo.yml")
	runGitForTest(t, peer, "commit", "-m", "Update API branch")
	runGitForTest(t, peer, "push", "origin", "feature/api")

	result := gitPullBranchForRoot(dir, "feature/api")
	if !result.Ok {
		t.Fatalf("branch pull failed: %s\n%s", result.Error, result.Output)
	}
	current := strings.TrimSpace(runGitOutputForTest(t, dir, "branch", "--show-current"))
	if current != "main" {
		t.Fatalf("branch pull should not checkout feature/api, current=%q", current)
	}
	afterHead := strings.TrimSpace(runGitOutputForTest(t, dir, "rev-parse", "feature/api"))
	remoteHead := strings.TrimSpace(runGitOutputForTest(t, dir, "rev-parse", "origin/feature/api"))
	if afterHead == beforeHead || afterHead != remoteHead {
		t.Fatalf("feature/api was not fast-forwarded from %s to remote %s, got %s", beforeHead, remoteHead, afterHead)
	}
	if result.PullSummary.Changed == 0 {
		t.Fatalf("expected pull summary for branch update, got %#v", result.PullSummary)
	}
}

func TestGitRenameBranchLocallyAndOnTheRemote(t *testing.T) {
	t.Parallel()

	dir := setupBranchRepoForTest(t)
	if result := gitCreateBranchForRoot(dir, "feature", "main"); !result.Ok {
		t.Fatalf("create failed: %s", result.Error)
	}
	if result := gitPushWorkspaceForRoot(dir, "origin"); !result.Ok {
		t.Fatalf("push failed: %s", result.Error)
	}
	if result := gitRenameBranchForRoot(dir, "feature", "feature-renamed", false); !result.Ok {
		t.Fatalf("local rename failed: %s", result.Error)
	}
	if localGitBranchExists(dir, "feature") || !localGitBranchExists(dir, "feature-renamed") {
		t.Fatal("local branch was not renamed")
	}
	if result := gitRenameBranchForRoot(dir, "main", "feature-renamed", false); result.Ok {
		t.Fatal("renaming onto an existing branch must fail")
	}
	if result := gitRenameBranchForRoot(dir, "origin/feature", "feature-renamed", true); !result.Ok {
		t.Fatalf("remote rename failed: %s\n%s", result.Error, result.Output)
	}
	if strings.TrimSpace(runGitOutputForTest(t, dir, "ls-remote", "origin", "refs/heads/feature")) != "" {
		t.Fatal("old remote branch still exists")
	}
	if strings.TrimSpace(runGitOutputForTest(t, dir, "ls-remote", "origin", "refs/heads/feature-renamed")) == "" {
		t.Fatal("new remote branch is missing")
	}
	upstream := strings.TrimSpace(runGitOutputForTest(t, dir, "rev-parse", "--abbrev-ref", "feature-renamed@{upstream}"))
	if upstream != "origin/feature-renamed" {
		t.Fatalf("local branch must follow the renamed remote, got %q", upstream)
	}
	if result := gitRenameBranchForRoot(dir, "origin/missing", "x", true); result.Ok {
		t.Fatal("renaming an unknown remote branch must fail")
	}
}

func TestGitCheckoutLoadsTheOtherBranchesWorkspace(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	dir := setupBranchRepoForTest(t)
	app := NewApp()
	if result := app.openWorkspaceRoot(dir); !result.Ok {
		t.Fatalf("open failed: %s", result.Error)
	}
	if result := gitCreateBranchForRoot(dir, "renamed-workspace", "main"); !result.Ok {
		t.Fatalf("create failed: %s", result.Error)
	}
	replaceWorkspaceTextForTest(t, dir, "workspaces/Main/workspace.yml", "name: Main", "name: Renamed on branch")
	if result := gitCommitWorkspaceForRoot(dir, "Rename workspace"); !result.Ok {
		t.Fatalf("commit failed: %s", result.Error)
	}
	for _, step := range []struct{ branch, want string }{{"main", "Main"}, {"renamed-workspace", "Renamed on branch"}, {"main", "Main"}} {
		branch := step.branch
		result := app.GitCheckoutBranch(branch)
		if !result.Ok {
			t.Fatalf("checkout %s failed: %s", branch, result.Error)
		}
		store, err := decodeJSONMap(result.Payload)
		if err != nil {
			t.Fatal(err)
		}
		if got := stringValue(mapSlice(store["workspaces"])[0], "name"); got != step.want {
			t.Fatalf("checkout %s loaded workspace %q, want %q", branch, got, step.want)
		}
		if status := gitStatusForWorkspace(dir); !status.Clean {
			t.Fatalf("checkout %s left changes: %#v", branch, status.Files)
		}
	}
}

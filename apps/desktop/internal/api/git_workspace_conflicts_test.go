package api

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitPullWorkspaceDirtyOverlapLeavesResolvableConflict(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir, peer := setupGitPullRemoteForTest(t)
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nlocal: true\n"), 0644); err != nil {
		t.Fatalf("write dirty local kurlo index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(peer, "kurlo.yml"), []byte("version: 1\nremote: true\n"), 0644); err != nil {
		t.Fatalf("write peer kurlo index: %v", err)
	}
	runGitForTest(t, peer, "add", "kurlo.yml")
	runGitForTest(t, peer, "commit", "-m", "Remote Kurlo update")
	runGitForTest(t, peer, "push")

	result := gitPullWorkspaceForRoot(dir, "ff")
	if result.Ok {
		t.Fatalf("expected overlapping dirty pull to stop for conflicts")
	}
	if !hasConflictedFiles(result.Git) {
		t.Fatalf("expected conflicted status, got %#v\n%s", result.Git, result.Output)
	}
	if result.Git.Operation != "" {
		t.Fatalf("autostash conflict should not require merge/rebase continue, got %#v", result.Git)
	}
	if !strings.Contains(result.Error, "uncommitted edits conflicted") {
		t.Fatalf("expected dirty conflict message, got %q", result.Error)
	}

	conflict := gitConflictFileForRoot(dir, "kurlo.yml")
	if !conflict.Ok {
		t.Fatalf("read conflict failed: %s", conflict.Error)
	}
	if !strings.Contains(conflict.Content, "<<<<<<<") || !strings.Contains(conflict.Content, ">>>>>>>") {
		t.Fatalf("expected conflict markers, got:\n%s", conflict.Content)
	}
	if !strings.Contains(conflict.OursContent, "local: true") {
		t.Fatalf("expected ours side to contain dirty local change, got:\n%s", conflict.OursContent)
	}
	if !strings.Contains(conflict.TheirsContent, "remote: true") {
		t.Fatalf("expected theirs side to contain pulled remote change, got:\n%s", conflict.TheirsContent)
	}
	markerOurs, markerTheirs := gitConflictMarkerSidesForTest(t, conflict.Content)
	if !strings.Contains(markerOurs, "local: true") {
		t.Fatalf("expected visual ours marker side to contain dirty local change, got:\n%s", markerOurs)
	}
	if !strings.Contains(markerTheirs, "remote: true") {
		t.Fatalf("expected visual theirs marker side to contain pulled remote change, got:\n%s", markerTheirs)
	}
	resolveResult := gitResolveConflictFileForRoot(dir, "kurlo.yml", "ours", "")
	if !resolveResult.Ok {
		t.Fatalf("resolve dirty pull conflict failed: %s\n%s", resolveResult.Error, resolveResult.Output)
	}
	if hasConflictedFiles(resolveResult.Git) {
		t.Fatalf("expected conflicts to be resolved, got %#v", resolveResult.Git.Files)
	}
	if resolveResult.Git.Clean {
		t.Fatalf("expected local resolution to remain as an uncommitted change")
	}
	if status := gitStatusForPath(resolveResult.Git.Files, "kurlo.yml"); status != "modified" {
		t.Fatalf("expected kurlo.yml to stay modified after resolving with local side, got %q in %#v", status, resolveResult.Git.Files)
	}
	content := readFileForTest(t, filepath.Join(dir, "kurlo.yml"))
	if !strings.Contains(content, "local: true") || strings.Contains(content, "remote: true") {
		t.Fatalf("expected local side to remain after resolution, got:\n%s", content)
	}
}

func TestGitPullMergeConflictCanResolveAndContinue(t *testing.T) {
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
	if pushResult := gitPushWorkspaceForRoot(dir, "origin"); !pushResult.Ok {
		t.Fatalf("push failed: %s\n%s", pushResult.Error, pushResult.Output)
	}

	peer := filepath.Join(t.TempDir(), "peer")
	cloneGitForTest(t, remote, peer)
	configureGitUserForTest(t, peer)
	if err := os.WriteFile(filepath.Join(peer, "kurlo.yml"), []byte("version: 1\nremote: true\n"), 0644); err != nil {
		t.Fatalf("write peer kurlo index: %v", err)
	}
	runGitForTest(t, peer, "add", "kurlo.yml")
	runGitForTest(t, peer, "commit", "-m", "Remote Kurlo change")
	runGitForTest(t, peer, "push")

	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nlocal: true\n"), 0644); err != nil {
		t.Fatalf("write local kurlo index: %v", err)
	}
	if commitResult := gitCommitWorkspaceForRoot(dir, "Local Kurlo change"); !commitResult.Ok {
		t.Fatalf("local commit failed: %s\n%s", commitResult.Error, commitResult.Output)
	}

	ffResult := gitPullWorkspaceForRoot(dir, "ff")
	if ffResult.Ok {
		t.Fatalf("expected fast-forward pull to fail on diverged history")
	}
	mergeResult := gitPullWorkspaceForRoot(dir, "merge")
	if mergeResult.Ok {
		t.Fatalf("expected merge pull to stop for conflict")
	}
	if mergeResult.Git.Operation != "merge" || !hasConflictedFiles(mergeResult.Git) {
		t.Fatalf("expected merge conflict status, got %#v\n%s", mergeResult.Git, mergeResult.Output)
	}

	commitDuringMerge := gitCommitWorkspaceForRoot(dir, "Commit conflict markers")
	if commitDuringMerge.Ok {
		t.Fatalf("normal commit should be rejected during merge")
	}
	if !strings.Contains(commitDuringMerge.Error, "current Git merge") {
		t.Fatalf("expected merge guard error, got %q", commitDuringMerge.Error)
	}

	conflict := gitConflictFileForRoot(dir, "kurlo.yml")
	if !conflict.Ok {
		t.Fatalf("read conflict failed: %s", conflict.Error)
	}
	if !strings.Contains(conflict.Content, "<<<<<<<") || !strings.Contains(conflict.Content, ">>>>>>>") {
		t.Fatalf("expected conflict markers, got:\n%s", conflict.Content)
	}
	if !strings.Contains(conflict.OursContent, "local: true") {
		t.Fatalf("expected ours side to contain local change, got:\n%s", conflict.OursContent)
	}
	if !strings.Contains(conflict.TheirsContent, "remote: true") {
		t.Fatalf("expected theirs side to contain remote change, got:\n%s", conflict.TheirsContent)
	}

	markerResult := gitResolveConflictFileForRoot(dir, "kurlo.yml", "manual", conflict.Content)
	if markerResult.Ok || !strings.Contains(markerResult.Error, "conflict markers") {
		t.Fatalf("manual resolution with markers should be rejected, got %#v", markerResult)
	}
	invalidYAMLResult := gitResolveConflictFileForRoot(dir, "kurlo.yml", "manual", "version: [\n")
	if invalidYAMLResult.Ok || !strings.Contains(invalidYAMLResult.Error, "Resolved YAML is invalid") {
		t.Fatalf("manual resolution with invalid YAML should be rejected, got %#v", invalidYAMLResult)
	}

	resolveResult := gitResolveConflictFileForRoot(dir, "kurlo.yml", "ours", "")
	if !resolveResult.Ok {
		t.Fatalf("resolve failed: %s\n%s", resolveResult.Error, resolveResult.Output)
	}
	if hasConflictedFiles(resolveResult.Git) {
		t.Fatalf("expected conflicts to be resolved, got %#v", resolveResult.Git.Files)
	}
	if resolved, err := os.ReadFile(filepath.Join(dir, "kurlo.yml")); err != nil || string(resolved) != "version: 1\nlocal: true\n" {
		t.Fatalf("taking our side should keep the file byte for byte, got %q (%v)", resolved, err)
	}
	continueResult := gitContinueOperationForRoot(dir, "Merge Kurlo workspace")
	if !continueResult.Ok {
		t.Fatalf("continue failed: %s\n%s", continueResult.Error, continueResult.Output)
	}
	if continueResult.Git.Operation != "" || !continueResult.Git.Clean {
		t.Fatalf("expected clean completed merge, got %#v", continueResult.Git)
	}
}

func TestGitPullWorkspaceRebaseConflictMapsOursToLocalCommit(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir, peer := setupGitPullRemoteForTest(t)
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nlocal: true\n"), 0644); err != nil {
		t.Fatalf("write local kurlo index: %v", err)
	}
	runGitForTest(t, dir, "add", "kurlo.yml")
	runGitForTest(t, dir, "commit", "-m", "Local Kurlo update")

	if err := os.WriteFile(filepath.Join(peer, "kurlo.yml"), []byte("version: 1\nremote: true\n"), 0644); err != nil {
		t.Fatalf("write peer kurlo index: %v", err)
	}
	runGitForTest(t, peer, "add", "kurlo.yml")
	runGitForTest(t, peer, "commit", "-m", "Remote Kurlo update")
	runGitForTest(t, peer, "push")

	result := gitPullWorkspaceForRoot(dir, "rebase")
	if result.Ok {
		t.Fatalf("expected rebase pull to stop for conflict")
	}
	if result.Git.Operation != "rebase" || !hasConflictedFiles(result.Git) {
		t.Fatalf("expected rebase conflict status, got %#v\n%s", result.Git, result.Output)
	}

	conflict := gitConflictFileForRoot(dir, "kurlo.yml")
	if !conflict.Ok {
		t.Fatalf("read conflict failed: %s", conflict.Error)
	}
	if !strings.Contains(conflict.OursContent, "local: true") {
		t.Fatalf("expected ours side to contain local commit, got:\n%s", conflict.OursContent)
	}
	if !strings.Contains(conflict.TheirsContent, "remote: true") {
		t.Fatalf("expected theirs side to contain remote commit, got:\n%s", conflict.TheirsContent)
	}
	markerOurs, markerTheirs := gitConflictMarkerSidesForTest(t, conflict.Content)
	if !strings.Contains(markerOurs, "local: true") {
		t.Fatalf("expected visual ours marker side to contain local commit, got:\n%s", markerOurs)
	}
	if !strings.Contains(markerTheirs, "remote: true") {
		t.Fatalf("expected visual theirs marker side to contain remote commit, got:\n%s", markerTheirs)
	}

	resolveResult := gitResolveConflictFileForRoot(dir, "kurlo.yml", "ours", "")
	if !resolveResult.Ok {
		t.Fatalf("resolve rebase conflict failed: %s\n%s", resolveResult.Error, resolveResult.Output)
	}
	if hasConflictedFiles(resolveResult.Git) {
		t.Fatalf("expected conflicts to be resolved, got %#v", resolveResult.Git.Files)
	}
	continueResult := gitContinueOperationForRoot(dir, "")
	if !continueResult.Ok {
		t.Fatalf("continue failed: %s\n%s", continueResult.Error, continueResult.Output)
	}
	if continueResult.Git.Operation != "" || !continueResult.Git.Clean {
		t.Fatalf("expected clean completed rebase, got %#v\n%s", continueResult.Git, continueResult.Output)
	}
	content := readFileForTest(t, filepath.Join(dir, "kurlo.yml"))
	if !strings.Contains(content, "local: true") || strings.Contains(content, "remote: true") {
		t.Fatalf("expected local commit side after rebase resolution, got:\n%s", content)
	}
}

func TestGitResolveMarkerlessModifyDeleteConflict(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	setup := func(t *testing.T) (string, string) {
		t.Helper()
		dir := t.TempDir()
		writeKurloWorkspaceFiles(t, dir)
		if initResult := gitInitWorkspaceForRoot(dir); !initResult.Ok {
			t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
		}
		configureGitUserForTest(t, dir)
		if commitResult := gitCommitWorkspaceForRoot(dir, "Initial Kurlo workspace"); !commitResult.Ok {
			t.Fatalf("commit failed: %s\n%s", commitResult.Error, commitResult.Output)
		}
		relPath := filepath.ToSlash(filepath.Join("workspaces", "Main", "collections", "Default", "collection.yml"))
		runGitForTest(t, dir, "checkout", "-b", "incoming-change")
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(relPath)), []byte(`version: 1
collection:
  id: collection-main
  workspaceId: workspace-main
  name: Incoming
  filesystemName: Default
requestOrder: []
`), 0644); err != nil {
			t.Fatalf("write incoming collection: %v", err)
		}
		if commitResult := gitCommitWorkspaceForRoot(dir, "Incoming collection change"); !commitResult.Ok {
			t.Fatalf("incoming commit failed: %s\n%s", commitResult.Error, commitResult.Output)
		}
		runGitForTest(t, dir, "checkout", "main")
		if err := os.Remove(filepath.Join(dir, filepath.FromSlash(relPath))); err != nil {
			t.Fatalf("delete local collection: %v", err)
		}
		runGitForTest(t, dir, "add", "-A", "--", relPath)
		runGitForTest(t, dir, "commit", "-m", "Delete collection locally")
		output, err := runGit(dir, "merge", "incoming-change")
		if err == nil {
			t.Fatalf("expected modify/delete conflict, got clean merge:\n%s", output)
		}
		return dir, relPath
	}

	dir, relPath := setup(t)
	conflict := gitConflictFileForRoot(dir, relPath)
	if !conflict.Ok {
		t.Fatalf("read conflict failed: %s", conflict.Error)
	}
	if conflict.OursAvailable {
		t.Fatalf("expected absent ours stage for local deletion")
	}
	if !conflict.TheirsAvailable || !strings.Contains(conflict.TheirsContent, "name: Incoming") {
		t.Fatalf("expected incoming stage, got %#v\n%s", conflict, conflict.TheirsContent)
	}
	if strings.Contains(conflict.Content, "<<<<<<<") {
		t.Fatalf("modify/delete conflict should not have inline markers, got:\n%s", conflict.Content)
	}
	theirsResult := gitResolveConflictFileForRoot(dir, relPath, "theirs", "")
	if !theirsResult.Ok {
		t.Fatalf("resolve theirs failed: %s\n%s", theirsResult.Error, theirsResult.Output)
	}
	if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(relPath))); err != nil {
		t.Fatalf("expected theirs resolution to keep file: %v", err)
	}

	dir, relPath = setup(t)
	oursResult := gitResolveConflictFileForRoot(dir, relPath, "ours", "")
	if !oursResult.Ok {
		t.Fatalf("resolve ours deletion failed: %s\n%s", oursResult.Error, oursResult.Output)
	}
	if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(relPath))); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected ours resolution to delete file, stat err=%v", err)
	}
}

func TestSwapGitConflictMarkerSidesKeepsDiff3BaseOutOfSides(t *testing.T) {
	t.Parallel()

	content := strings.Join([]string{
		"version: 1",
		"<<<<<<< HEAD",
		"description: upstream",
		"||||||| merged common ancestors",
		"description: base",
		"=======",
		"description: local",
		">>>>>>> abc1234 (local commit)",
		"name: Workspace",
	}, "\n")

	swapped := swapGitConflictMarkerSides(content)
	if strings.Contains(swapped, "|||||||") {
		t.Fatalf("swapped content kept the diff3 base marker:\n%s", swapped)
	}
	lines := strings.Split(swapped, "\n")
	if !strings.HasPrefix(lines[1], "<<<<<<< local") {
		t.Fatalf("first side should be semantic ours after swap, got %q", lines[1])
	}
	ours := swapped[strings.Index(swapped, "<<<<<<< local"):strings.Index(swapped, "=======")]
	if !strings.Contains(ours, "description: local") {
		t.Fatalf("semantic ours content missing after swap:\n%s", swapped)
	}
	if strings.Contains(ours, "description: base") {
		t.Fatalf("base content leaked into the ours side:\n%s", swapped)
	}
	if !strings.Contains(swapped, "description: upstream") {
		t.Fatalf("semantic theirs content missing after swap:\n%s", swapped)
	}
	if !strings.HasSuffix(strings.TrimSpace(swapped), "name: Workspace") {
		t.Fatalf("text after the conflict hunk was lost:\n%s", swapped)
	}

	plain := "<<<<<<< HEAD\none\n=======\ntwo\n>>>>>>> branch\n"
	swappedPlain := swapGitConflictMarkerSides(plain)
	if swappedPlain != "<<<<<<< local\ntwo\n=======\none\n>>>>>>> remote\n" {
		t.Fatalf("plain conflict swap changed shape: %q", swappedPlain)
	}
}

func TestContainsGitConflictMarkersDetectsDiff3Base(t *testing.T) {
	t.Parallel()

	if !containsGitConflictMarkers("ok\n<<<<<<< HEAD\nx\n||||||| base\ny\n=======\nz\n>>>>>>> other\n") {
		t.Fatal("diff3 conflict markers were not detected")
	}
	if containsGitConflictMarkers("ok:\n  - a\n  - b\n") {
		t.Fatal("plain YAML was flagged as containing conflict markers")
	}
}

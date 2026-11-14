package api

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func writeKurloWorkspaceFiles(t *testing.T, dir string) {
	t.Helper()
	workspaceDir := filepath.Join(dir, "workspaces", "Main")
	collectionDir := filepath.Join(workspaceDir, "collections", "Default")
	if err := os.MkdirAll(collectionDir, 0755); err != nil {
		t.Fatalf("create Kurlo workspace dirs: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte(`version: 1
format: kurlo.workspace.yaml.v1
workspaceOrder:
  - workspace-main
`), 0644); err != nil {
		t.Fatalf("write kurlo index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspaceDir, "workspace.yml"), []byte(`version: 1
workspace:
  id: workspace-main
  name: Main
  filesystemName: Main
collectionOrder:
  - collection-main
`), 0644); err != nil {
		t.Fatalf("write workspace: %v", err)
	}
	if err := os.WriteFile(filepath.Join(collectionDir, "collection.yml"), []byte(`version: 1
collection:
  id: collection-main
  workspaceId: workspace-main
  name: Default
  filesystemName: Default
requestOrder: []
`), 0644); err != nil {
		t.Fatalf("write collection: %v", err)
	}
}

func runGitForTest(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, output)
	}
}

func setupGitPullRemoteForTest(t *testing.T) (string, string) {
	t.Helper()
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
	return dir, peer
}

func initBareRemoteForTest(t *testing.T, dir string) {
	t.Helper()
	runGitForTest(t, dir, "init", "--bare")
	runGitForTest(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
}

func configureGitUserForTest(t *testing.T, dir string) {
	t.Helper()
	runGitForTest(t, dir, "config", "user.email", "kurlo@example.test")
	runGitForTest(t, dir, "config", "user.name", "Kurlo Test")
}

func cloneGitForTest(t *testing.T, remote, target string) {
	t.Helper()
	cmd := exec.Command("git", "clone", remote, target)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git clone failed: %v\n%s", err, output)
	}
}

func branchListContains(branches []GitBranchEntry, name string) bool {
	for _, branch := range branches {
		if branch.Name == name {
			return true
		}
	}
	return false
}

func branchListContainsFullName(branches []GitBranchEntry, fullName string) bool {
	for _, branch := range branches {
		if branch.FullName == fullName {
			return true
		}
	}
	return false
}

func gitConflictMarkerSidesForTest(t *testing.T, content string) (string, string) {
	t.Helper()
	start := strings.Index(content, "<<<<<<<")
	if start < 0 {
		t.Fatalf("conflict content has no start marker:\n%s", content)
	}
	separatorOffset := strings.Index(content[start:], "\n=======")
	if separatorOffset < 0 {
		t.Fatalf("conflict content has no separator marker:\n%s", content)
	}
	separator := start + separatorOffset
	endOffset := strings.Index(content[separator+1:], "\n>>>>>>>")
	if endOffset < 0 {
		t.Fatalf("conflict content has no end marker:\n%s", content)
	}
	end := separator + 1 + endOffset
	return content[start:separator], content[separator:end]
}

func runGitOutputForTest(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, output)
	}
	return string(output)
}

func readFileForTest(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func setupBranchRepoForTest(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	remote := filepath.Join(t.TempDir(), "origin.git")
	if err := os.MkdirAll(remote, 0755); err != nil {
		t.Fatal(err)
	}
	initBareRemoteForTest(t, remote)
	writeKurloWorkspaceFiles(t, dir)
	if result := gitInitWorkspaceForRoot(dir); !result.Ok {
		t.Fatalf("init failed: %s", result.Error)
	}
	configureGitUserForTest(t, dir)
	if result := gitAddRemoteForRoot(dir, "origin", remote); !result.Ok {
		t.Fatalf("add remote failed: %s", result.Error)
	}
	if result := gitCommitWorkspaceForRoot(dir, "Initial"); !result.Ok {
		t.Fatalf("commit failed: %s", result.Error)
	}
	if result := gitPushWorkspaceForRoot(dir, "origin"); !result.Ok {
		t.Fatalf("push failed: %s", result.Error)
	}
	return dir
}

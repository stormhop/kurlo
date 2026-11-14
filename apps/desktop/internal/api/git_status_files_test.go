package api

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

func TestGitStatusFilesScopesToSavedPaths(t *testing.T) {
	repo := t.TempDir()
	workspace := filepath.Join(repo, "team", "api workspace")
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(rel, content string) {
		t.Helper()
		path := filepath.Join(workspace, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run("init", "-q")
	write("collections/Users/Get user.yml", "name: Get user\n")
	write("collections/Users/Delete user.yml", "name: Delete user\n")
	write("environments/Local.yml", "name: Local\n")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("root\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "init")

	write("collections/Users/Get user.yml", "name: Get user\nurl: /users/1\n")
	write("collections/Users/New user.yml", "name: New user\n")
	write("environments/Local.yml", "name: Local\nvalues: []\n")
	if err := os.Remove(filepath.Join(workspace, "collections", "Users", "Delete user.yml")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	paths := func(result GitFileStatusResult) []string {
		out := []string{}
		for _, file := range result.Files {
			out = append(out, file.Index+file.Worktree+" "+file.Path)
		}
		sort.Strings(out)
		return out
	}

	scoped := gitStatusFilesForWorkspace(workspace, []string{"collections/Users/Get user.yml", "collections/Users/New user.yml", "collections/Users/Delete user.yml", "collections/Users/Get user.yml"})
	if !scoped.Ok || !scoped.Scoped {
		t.Fatalf("scoped status = %+v", scoped)
	}
	wantPaths := []string{"team/api workspace/collections/Users/Get user.yml", "team/api workspace/collections/Users/New user.yml", "team/api workspace/collections/Users/Delete user.yml"}
	if !reflect.DeepEqual(scoped.Paths, wantPaths) {
		t.Fatalf("scoped paths = %q, want %q", scoped.Paths, wantPaths)
	}
	want := []string{
		" D team/api workspace/collections/Users/Delete user.yml",
		" M team/api workspace/collections/Users/Get user.yml",
		"?? team/api workspace/collections/Users/New user.yml",
	}
	if got := paths(scoped); !reflect.DeepEqual(got, want) {
		t.Fatalf("scoped files = %q, want %q", got, want)
	}

	full := gitStatusFilesForWorkspace(workspace, nil)
	if !full.Ok || full.Scoped {
		t.Fatalf("full status = %+v", full)
	}
	fullStatus := gitStatusForWorkspace(workspace)
	wantFull := []string{}
	for _, file := range fullStatus.Files {
		wantFull = append(wantFull, file.Index+file.Worktree+" "+file.Path)
	}
	sort.Strings(wantFull)
	if got := paths(full); !reflect.DeepEqual(got, wantFull) || len(got) != 5 {
		t.Fatalf("full files = %q, want %q", got, wantFull)
	}
	for index, file := range full.Files {
		if file != fullStatus.Files[index] {
			t.Fatalf("file %d = %+v, GitStatus has %+v", index, file, fullStatus.Files[index])
		}
	}

	empty := gitStatusFilesForWorkspace(workspace, []string{})
	if !empty.Ok || !empty.Scoped || len(empty.Files) != 0 || len(empty.Paths) != 0 {
		t.Fatalf("empty scoped status = %+v", empty)
	}
	for _, unsafe := range [][]string{{"../outside.yml"}, {"/etc/passwd"}} {
		if result := gitStatusFilesForWorkspace(workspace, unsafe); !result.Ok || result.Scoped {
			t.Fatalf("status for %q = %+v, want unscoped", unsafe, result)
		}
	}
	many := make([]string, gitScopedStatusPathLimit+1)
	for index := range many {
		many[index] = "collections/file.yml"
	}
	if result := gitStatusFilesForWorkspace(workspace, many); result.Scoped {
		t.Fatalf("status for %d paths stayed scoped", len(many))
	}
	if result := gitStatusFilesForWorkspace(t.TempDir(), []string{"a.yml"}); result.Ok {
		t.Fatalf("status outside a repository = %+v", result)
	}
}

package api

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type gitFlow struct {
	home   string
	t      *testing.T
	app    *App
	root   string
	remote string
	peer   string
}

func gitOutputForTest(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func (f *gitFlow) dirtyFiles() []string {
	var files []string
	for _, file := range f.app.GitStatus().Files {
		files = append(files, file.Status+" "+file.Path)
	}
	return files
}

func (f *gitFlow) reloadAndAutosave(label string) string {
	f.t.Helper()
	payload := f.app.LoadRequestStore()
	if payload == "" {
		f.t.Fatalf("%s: workspace did not load", label)
	}
	if frontend := os.Getenv("KURLO_ROUNDTRIP_FRONTEND"); frontend != "" {
		payload = f.throughAppStore(frontend, payload, label)
	}
	if result := f.app.SaveRequestStoreWithError(payload); !result.Ok {
		f.t.Fatalf("%s: autosave after reload failed: %s", label, result.Error)
	}
	if diagnostics := f.app.LoadWorkspaceDiagnostics(); len(diagnostics) > 0 {
		f.t.Fatalf("%s: workspace diagnostics: %#v", label, diagnostics[0])
	}
	return payload
}

func (f *gitFlow) throughAppStore(frontend, payload, label string) string {
	f.t.Helper()
	dir := f.t.TempDir()
	in, out := filepath.Join(dir, "in.json"), filepath.Join(dir, "out.json")
	if err := os.WriteFile(in, []byte(payload), 0600); err != nil {
		f.t.Fatal(err)
	}
	cmd := exec.Command("npx", "playwright", "test", "e2e/full-app.spec.ts", "-g", "real workspace round trip", "--project=chromium", "--workers=1")
	cmd.Dir = frontend
	cmd.Env = append(os.Environ(), "HOME="+f.home, "KURLO_ROUNDTRIP_IN="+in, "KURLO_ROUNDTRIP_OUT="+out)
	if output, err := cmd.CombinedOutput(); err != nil {
		f.t.Fatalf("%s: app store round trip failed: %v\n%s", label, err, output)
	}
	saved, err := os.ReadFile(out)
	if err != nil {
		f.t.Fatalf("%s: app store wrote nothing: %v", label, err)
	}
	return string(saved)
}

func (f *gitFlow) expectClean(label string) {
	f.t.Helper()
	f.reloadAndAutosave(label)
	if files := f.dirtyFiles(); len(files) > 0 {
		diff, _ := exec.Command("git", "-C", f.root, "diff").CombinedOutput()
		f.t.Fatalf("%s: reload + autosave left changes the user did not make: %v\n%s", label, files, diff)
	}
}

func (f *gitFlow) okOp(label string, ok bool, errText, output string) {
	f.t.Helper()
	if !ok {
		f.t.Fatalf("%s failed: %s\n%s", label, errText, output)
	}
}

func (f *gitFlow) editFirstRequestURL(url string) string {
	f.t.Helper()
	var store map[string]any
	if err := json.Unmarshal([]byte(f.app.LoadRequestStore()), &store); err != nil {
		f.t.Fatal(err)
	}
	requests, _ := store["requests"].([]any)
	for _, raw := range requests {
		request := raw.(map[string]any)
		if request["requestType"] == "http" || request["requestType"] == nil || request["requestType"] == "" {
			request["url"] = url
			payload, _ := json.Marshal(store)
			if result := f.app.SaveRequestStoreWithError(string(payload)); !result.Ok {
				f.t.Fatalf("save edit: %s", result.Error)
			}
			return request["id"].(string)
		}
	}
	f.t.Fatal("no HTTP request in the workspace")
	return ""
}

func (f *gitFlow) otherHTTPRequestID(except string) string {
	f.t.Helper()
	var store struct {
		Requests []map[string]any `json:"requests"`
	}
	if err := json.Unmarshal([]byte(f.app.LoadRequestStore()), &store); err != nil {
		f.t.Fatal(err)
	}
	for _, request := range store.Requests {
		kind, _ := request["requestType"].(string)
		if id, _ := request["id"].(string); id != except && (kind == "" || kind == "http") {
			return id
		}
	}
	f.t.Fatal("the workspace needs two HTTP requests")
	return ""
}

func (f *gitFlow) requestURL(id string) string {
	f.t.Helper()
	var store struct {
		Requests []map[string]any `json:"requests"`
	}
	if err := json.Unmarshal([]byte(f.app.LoadRequestStore()), &store); err != nil {
		f.t.Fatal(err)
	}
	for _, request := range store.Requests {
		if request["id"] == id {
			url, _ := request["url"].(string)
			return url
		}
	}
	f.t.Fatalf("request %s missing", id)
	return ""
}

func (f *gitFlow) peerEditsRequestURL(id, url, message string) {
	f.t.Helper()
	runGitForTest(f.t, f.peer, "pull", "--ff-only")
	path := ""
	filepath.WalkDir(f.peer, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".yml") && path == "" {
			if data, readErr := os.ReadFile(p); readErr == nil && strings.Contains(string(data), "id: "+id+"\n") && strings.Contains(string(data), "request:") {
				path = p
			}
		}
		return nil
	})
	if path == "" {
		f.t.Fatalf("peer cannot find request %s", id)
	}
	data, _ := os.ReadFile(path)
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "url: ") {
			indent := line[:len(line)-len(strings.TrimLeft(line, " "))]
			lines[i] = indent + "url: " + url
		}
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0644); err != nil {
		f.t.Fatal(err)
	}
	runGitForTest(f.t, f.peer, "commit", "-am", message)
	runGitForTest(f.t, f.peer, "push")
}

func TestGitFlowOnARealWorkspace(t *testing.T) {
	source := os.Getenv("KURLO_GIT_E2E_SOURCE")
	if source == "" {
		t.Skip("set KURLO_GIT_E2E_SOURCE to a Kurlo Git workspace to run the full flow on a copy of it")
	}
	realHome := os.Getenv("HOME")
	useTempConfigDir(t, t.TempDir())
	withRequestStoreTestKey(t)
	for key, value := range map[string]string{"GIT_AUTHOR_NAME": "Kurlo E2E", "GIT_AUTHOR_EMAIL": "e2e@kurlo.test", "GIT_COMMITTER_NAME": "Kurlo E2E", "GIT_COMMITTER_EMAIL": "e2e@kurlo.test"} {
		t.Setenv(key, value)
	}

	base := t.TempDir()
	remote := filepath.Join(base, "origin.git")
	runGitForTest(t, base, "clone", "--bare", "--no-local", source, remote)
	branch := gitOutputForTest(t, source, "rev-parse", "--abbrev-ref", "HEAD")
	runGitForTest(t, remote, "symbolic-ref", "HEAD", "refs/heads/"+branch)

	f := &gitFlow{home: realHome, t: t, app: NewApp(), remote: remote, peer: filepath.Join(base, "peer")}
	cloneGitForTest(t, remote, f.peer)

	opened := f.app.GitCloneWorkspaceWithMode(remote, base, "mine", "")
	f.okOp("clone", opened.Ok, opened.Error, opened.Output)
	f.root = opened.Root
	if len(opened.Diagnostics) > 0 {
		t.Fatalf("cloned workspace has diagnostics: %#v", opened.Diagnostics[0])
	}
	f.expectClean("after clone")

	id := f.editFirstRequestURL("https://e2e.kurlo.test/first")
	if files := f.dirtyFiles(); len(files) != 1 {
		t.Fatalf("one URL edit should change one file, got %v", files)
	}
	commit := f.app.GitCommitWorkspace("E2E: edit a request")
	f.okOp("commit", commit.Ok, commit.Error, commit.Output)
	f.expectClean("after commit")
	if status := f.app.GitStatus(); status.Ahead != 1 {
		t.Fatalf("ahead %d after commit, want 1", status.Ahead)
	}
	push := f.app.GitPushWorkspace("origin")
	f.okOp("push", push.Ok, push.Error, push.Output)
	if status := f.app.GitStatus(); status.Ahead != 0 || status.Behind != 0 {
		t.Fatalf("after push ahead %d behind %d", status.Ahead, status.Behind)
	}

	created := f.app.GitCreateBranch("e2e-feature", branch)
	f.okOp("create branch", created.Ok, created.Error, created.Output)
	f.expectClean("after creating a branch")
	if status := f.app.GitStatus(); status.Branch != "e2e-feature" || status.Upstream != "" {
		t.Fatalf("new branch %q upstream %q", status.Branch, status.Upstream)
	}
	f.editFirstRequestURL("https://e2e.kurlo.test/feature")
	f.okOp("commit on branch", f.app.GitCommitWorkspace("E2E: feature change").Ok, "", "")
	publish := f.app.GitPushWorkspace("origin")
	f.okOp("publish branch", publish.Ok, publish.Error, publish.Output)
	if status := f.app.GitStatus(); status.Upstream != "origin/e2e-feature" || status.Ahead != 0 {
		t.Fatalf("published branch upstream %q ahead %d", status.Upstream, status.Ahead)
	}
	f.expectClean("after publishing the branch")

	back := f.app.GitCheckoutBranch(branch)
	f.okOp("checkout base", back.Ok, back.Error, back.Output)
	f.expectClean("after checkout")
	if url := f.requestURL(id); url != "https://e2e.kurlo.test/first" {
		t.Fatalf("checkout did not load the base branch: url %q", url)
	}

	f.peerEditsRequestURL(id, "https://e2e.kurlo.test/teammate", "E2E: teammate change")
	fetched := f.app.GitFetchWorkspace()
	if fetched.Behind != 1 {
		t.Fatalf("behind %d after fetch, want 1", fetched.Behind)
	}
	pulled := f.app.GitPullWorkspace()
	f.okOp("pull", pulled.Ok, pulled.Error, pulled.Output)
	f.expectClean("after pull")
	if url := f.requestURL(id); url != "https://e2e.kurlo.test/teammate" {
		t.Fatalf("pull did not bring the teammate change: %q", url)
	}

	f.peerEditsRequestURL(id, "https://e2e.kurlo.test/theirs", "E2E: conflicting teammate change")
	f.editFirstRequestURL("https://e2e.kurlo.test/ours")
	f.okOp("commit ours", f.app.GitCommitWorkspace("E2E: conflicting change").Ok, "", "")
	if diverged := f.app.GitPullWorkspace(); diverged.Ok || !strings.Contains(diverged.Error, "fast-forward") {
		t.Fatalf("a plain pull on diverged branches should stop and offer merge or rebase: ok=%v err=%s", diverged.Ok, diverged.Error)
	}
	conflicted := f.app.GitPullWorkspaceWithStrategy("merge")
	status := f.app.GitStatus()
	if status.Operation == "" {
		t.Fatalf("expected a merge in progress after a conflicting pull: ok=%v err=%s", conflicted.Ok, conflicted.Error)
	}
	var conflictPath string
	for _, file := range status.Files {
		if strings.Contains(file.Status, "conflict") || file.Index == "U" || file.Worktree == "U" {
			conflictPath = file.Path
		}
	}
	if conflictPath == "" {
		t.Fatalf("no conflicted file in %#v", status.Files)
	}
	conflict := f.app.GitConflictFile(conflictPath)
	f.okOp("read conflict", conflict.Ok, conflict.Error, conflict.Output)
	if !strings.Contains(conflict.OursContent, "/ours") || !strings.Contains(conflict.TheirsContent, "/theirs") {
		t.Fatalf("conflict sides are wrong:\nours %q\ntheirs %q", conflict.OursContent, conflict.TheirsContent)
	}
	resolved := f.app.GitResolveConflictFile(conflictPath, "ours", "")
	f.okOp("resolve", resolved.Ok, resolved.Error, resolved.Output)
	continued := f.app.GitContinueOperation("")
	f.okOp("continue merge", continued.Ok, continued.Error, continued.Output)
	f.expectClean("after resolving the conflict")
	if url := f.requestURL(id); url != "https://e2e.kurlo.test/ours" {
		t.Fatalf("resolution with ours kept %q", url)
	}
	f.okOp("push merge", f.app.GitPushWorkspace("origin").Ok, "", "")

	other := f.otherHTTPRequestID(id)
	f.peerEditsRequestURL(other, "https://e2e.kurlo.test/teammate-other", "E2E: teammate edits another request")
	f.editFirstRequestURL("https://e2e.kurlo.test/rebased")
	f.okOp("commit before rebase", f.app.GitCommitWorkspace("E2E: local change before rebase").Ok, "", "")
	rebased := f.app.GitPullWorkspaceWithStrategy("rebase")
	f.okOp("pull --rebase", rebased.Ok, rebased.Error, rebased.Output)
	f.expectClean("after rebase")
	if url := f.requestURL(id); url != "https://e2e.kurlo.test/rebased" {
		t.Fatalf("rebase lost the local change: %q", url)
	}
	if url := f.requestURL(other); url != "https://e2e.kurlo.test/teammate-other" {
		t.Fatalf("rebase lost the teammate change: %q", url)
	}
	if status := f.app.GitStatus(); status.Ahead != 1 || status.Behind != 0 {
		t.Fatalf("after rebase ahead %d behind %d, want 1/0", status.Ahead, status.Behind)
	}
	f.okOp("push rebased", f.app.GitPushWorkspace("origin").Ok, "", "")

	f.editFirstRequestURL("https://e2e.kurlo.test/stashed")
	stashed := f.app.GitStashWorkspace("E2E stash")
	f.okOp("stash", stashed.Ok, stashed.Error, stashed.Output)
	f.expectClean("after stash")
	popped := f.app.GitStashPopWorkspace("")
	f.okOp("stash pop", popped.Ok, popped.Error, popped.Output)
	if url := f.requestURL(id); url != "https://e2e.kurlo.test/stashed" {
		t.Fatalf("stash pop restored %q", url)
	}
	discarded := f.app.GitDiscardWorkspaceChanges()
	f.okOp("discard", discarded.Ok, discarded.Error, discarded.Output)
	f.expectClean("after discard")
	if url := f.requestURL(id); url != "https://e2e.kurlo.test/rebased" {
		t.Fatalf("discard left %q", url)
	}

	renamed := f.app.GitRenameBranch("e2e-feature", "e2e-renamed", false)
	f.okOp("rename local branch", renamed.Ok, renamed.Error, renamed.Output)
	renamedRemote := f.app.GitRenameBranch("origin/e2e-feature", "e2e-renamed", true)
	f.okOp("rename remote branch", renamedRemote.Ok, renamedRemote.Error, renamedRemote.Output)
	if upstream := gitOutputForTest(t, f.root, "rev-parse", "--abbrev-ref", "e2e-renamed@{upstream}"); upstream != "origin/e2e-renamed" {
		t.Fatalf("renamed branch tracks %q", upstream)
	}
	deleted := f.app.GitDeleteBranch("e2e-renamed", false, true)
	f.okOp("delete local branch", deleted.Ok, deleted.Error, deleted.Output)
	deletedRemote := f.app.GitDeleteBranch("origin/e2e-renamed", true, true)
	f.okOp("delete remote branch", deletedRemote.Ok, deletedRemote.Error, deletedRemote.Output)
	if refs := gitOutputForTest(t, remote, "branch", "--list", "e2e-*"); refs != "" {
		t.Fatalf("remote still has %s", refs)
	}

	log := f.app.GitCommitLog(20)
	messages := ""
	for _, entry := range log.Commits {
		messages += entry.Message + "\n"
	}
	for _, want := range []string{"E2E: edit a request", "E2E: conflicting change", "E2E: teammate change"} {
		if !strings.Contains(messages, want) {
			t.Fatalf("history is missing %q:\n%s", want, messages)
		}
	}
	if diff := f.app.GitCommitDiff(log.Commits[0].Hash); diff.Error != "" || diff.Diff == "" {
		t.Fatalf("commit diff failed: %s", diff.Error)
	}
	f.expectClean("at the end")
}

func TestGitFlowAgainstARealRemote(t *testing.T) {
	remoteURL := os.Getenv("KURLO_GIT_E2E_REMOTE")
	if remoteURL == "" {
		t.Skip("set KURLO_GIT_E2E_REMOTE to push a temporary branch to a real remote and delete it again")
	}
	realHome := os.Getenv("HOME")
	sandbox := t.TempDir()
	if err := os.MkdirAll(filepath.Join(sandbox, "Library"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(realHome, "Library", "Keychains"), filepath.Join(sandbox, "Library", "Keychains")); err != nil {
		t.Fatal(err)
	}
	useTempConfigDir(t, sandbox)
	withRequestStoreTestKey(t)
	t.Setenv("GIT_TERMINAL_PROMPT", "0")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(realHome, ".gitconfig"))
	t.Setenv("GH_CONFIG_DIR", filepath.Join(realHome, ".config", "gh"))
	for key, value := range map[string]string{"GIT_AUTHOR_NAME": "Kurlo E2E", "GIT_AUTHOR_EMAIL": "e2e@kurlo.test", "GIT_COMMITTER_NAME": "Kurlo E2E", "GIT_COMMITTER_EMAIL": "e2e@kurlo.test"} {
		t.Setenv(key, value)
	}
	base := t.TempDir()
	f := &gitFlow{t: t, app: NewApp()}
	opened := f.app.GitCloneWorkspaceWithMode(remoteURL, base, "real", "")
	f.okOp("clone from the real remote", opened.Ok, opened.Error, opened.Output)
	f.root = opened.Root
	f.expectClean("after cloning the real remote")

	branch := "e2e-check-" + strings.ReplaceAll(strings.ReplaceAll(t.Name(), "/", "-"), "_", "-")
	branch = strings.ToLower(branch) + "-" + gitOutputForTest(t, f.root, "rev-parse", "--short", "HEAD")
	defer func() {
		_ = exec.Command("git", "-C", f.root, "push", "origin", "--delete", branch).Run()
	}()
	base0 := f.app.GitStatus().Branch
	f.okOp("create branch", f.app.GitCreateBranch(branch, base0).Ok, "", "")
	f.editFirstRequestURL("https://e2e.kurlo.test/real-remote")
	f.okOp("commit", f.app.GitCommitWorkspace("E2E: temporary check, deleted right after").Ok, "", "")
	published := f.app.GitPushWorkspace("origin")
	f.okOp("publish to the real remote", published.Ok, published.Error, published.Output)
	if status := f.app.GitStatus(); status.Upstream != "origin/"+branch || status.Ahead != 0 {
		t.Fatalf("after publish upstream %q ahead %d", status.Upstream, status.Ahead)
	}
	if refs := gitOutputForTest(t, f.root, "ls-remote", "origin", "refs/heads/"+branch); refs == "" {
		t.Fatal("the branch is not on the remote")
	}
	f.expectClean("after publishing to the real remote")
	f.okOp("back to base", f.app.GitCheckoutBranch(base0).Ok, "", "")
	deleted := f.app.GitDeleteBranch("origin/"+branch, true, true)
	f.okOp("delete the remote branch", deleted.Ok, deleted.Error, deleted.Output)
	if refs := gitOutputForTest(t, f.root, "ls-remote", "origin", "refs/heads/"+branch); refs != "" {
		t.Fatalf("the remote still has %s", refs)
	}
	f.okOp("delete the local branch", f.app.GitDeleteBranch(branch, false, true).Ok, "", "")
	fetched := f.app.GitFetchWorkspace()
	if fetched.Ahead != 0 || fetched.Behind != 0 {
		t.Fatalf("base branch moved: ahead %d behind %d", fetched.Ahead, fetched.Behind)
	}
}

package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitStatusDetectsRepositoryAndChangedFiles(t *testing.T) {
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

func TestSaveKurloStorePayloadDoesNotRecreateMissingCustomRoot(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "deleted-workspace")
	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/initial", "token", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save initial workspace: %v", err)
	}
	if err := os.RemoveAll(workspaceRoot); err != nil {
		t.Fatalf("remove workspace root: %v", err)
	}

	err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/missing", "token", []string{"req-main"}, ""))
	if err == nil {
		t.Fatalf("expected save to fail for missing custom workspace root")
	}
	if !strings.Contains(err.Error(), "no longer exists") {
		t.Fatalf("expected friendly missing folder error, got %q", err.Error())
	}
	if _, statErr := os.Stat(workspaceRoot); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("save should not recreate missing workspace root, stat error: %v", statErr)
	}
}

func TestUseLocalWorkspaceStoreSuppressesGitRepoInDefaultStorage(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)
	root := defaultFileWorkspaceStorePath()
	writeKurloWorkspaceFiles(t, root)
	runGitForTest(t, root, "init")

	app := NewApp()
	localResult := app.UseLocalWorkspaceStore()
	if !localResult.Ok {
		t.Fatalf("use local failed: %s", localResult.Error)
	}
	if localResult.Git.IsRepo {
		t.Fatalf("local storage should ignore git metadata in default storage, got %#v", localResult.Git)
	}

	initResult := app.GitInitWorkspace()
	if !initResult.Ok {
		t.Fatalf("init failed: %s\n%s", initResult.Error, initResult.Output)
	}
	if !initResult.Git.IsRepo {
		t.Fatalf("expected init to switch default storage into git mode, got %#v", initResult.Git)
	}

	localResult = app.UseLocalWorkspaceStore()
	if !localResult.Ok {
		t.Fatalf("use local after init failed: %s", localResult.Error)
	}
	if localResult.Git.IsRepo {
		t.Fatalf("switching back to local storage should suppress git mode, got %#v", localResult.Git)
	}
}

func TestDefaultWorkspaceRootFollowsMovedAppData(t *testing.T) {
	firstConfigDir := t.TempDir()
	useTempConfigDir(t, firstConfigDir)
	writeKurloWorkspaceFiles(t, defaultFileWorkspaceStorePath())
	app := NewApp()
	if result := app.UseLocalWorkspaceStore(); !result.Ok {
		t.Fatalf("use local failed: %s", result.Error)
	}
	store, _, err := loadLocalRequestStore(requestStorePath())
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	if stored := stringValue(localStoreStorage(store), "root"); stored != "" {
		t.Fatalf("default workspace root should not be stored as an absolute path, got %q", stored)
	}

	oldAppDir := requestStoreDir()
	secondConfigDir := t.TempDir()
	useTempConfigDir(t, secondConfigDir)
	newAppDir := requestStoreDir()
	if err := os.MkdirAll(filepath.Dir(newAppDir), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(oldAppDir, newAppDir); err != nil {
		t.Fatal(err)
	}

	root := fileWorkspaceStorePath()
	if root != defaultFileWorkspaceStorePath() || !strings.HasPrefix(root, secondConfigDir) {
		t.Fatalf("workspace root should follow the moved app data, got %q", root)
	}
	if workspaceRootMissing(root) {
		t.Fatalf("moved default workspace root reported missing: %q", root)
	}
}

func TestFreshInstallDoesNotReportDefaultWorkspaceMissing(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	if _, err := os.Stat(defaultFileWorkspaceStorePath()); !os.IsNotExist(err) {
		t.Fatalf("expected no default workspace folder before first save, got %v", err)
	}
	status := NewApp().GitStatus()
	if status.MissingRoot {
		t.Fatalf("a not yet created default workspace folder must not be reported missing: %#v", status)
	}
	if status.GitMissing {
		t.Fatalf("a not yet created default workspace folder must not look like missing Git: %#v", status)
	}
	if status.Error != "" {
		t.Fatalf("fresh install status should carry no error, got %q", status.Error)
	}
}

func TestCustomWorkspaceRootIsStoredAsAbsolutePath(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	custom := filepath.Join(t.TempDir(), "team-workspace")
	writeKurloWorkspaceFiles(t, custom)
	app := NewApp()
	if result := app.OpenWorkspaceRoot(custom); !result.Ok {
		t.Fatalf("open custom root failed: %s", result.Error)
	}
	store, _, err := loadLocalRequestStore(requestStorePath())
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	if stored := stringValue(localStoreStorage(store), "root"); !sameWorkspaceRoot(stored, custom) {
		t.Fatalf("custom workspace root should be stored as given, got %q", stored)
	}
}

func TestCreateLocalWorkspaceRootCreatesFolderWorkspace(t *testing.T) {
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)

	parent := t.TempDir()
	app := NewApp()
	result := app.CreateLocalWorkspaceRoot(parent, "Kurlo API", "empty")
	if !result.Ok {
		t.Fatalf("create local workspace failed: %s", result.Error)
	}
	expectedRoot := filepath.Join(parent, "Kurlo-API")
	if result.Root != expectedRoot {
		t.Fatalf("expected root %q, got %q", expectedRoot, result.Root)
	}
	if result.Git.IsRepo {
		t.Fatalf("folder workspace should stay in local mode before init, got %#v", result.Git)
	}
	if !hasYAMLWorkspaceStore(expectedRoot) {
		t.Fatalf("expected Kurlo YAML workspace files in %s", expectedRoot)
	}
	store, _, err := loadLocalRequestStore(requestStorePath())
	if err != nil {
		t.Fatalf("load local store: %v", err)
	}
	storage := localStoreStorage(store)
	if stringValue(storage, "root") != expectedRoot {
		t.Fatalf("expected persisted root %q, got %#v", expectedRoot, storage)
	}
	if stringValue(storage, "mode") != workspaceStorageModeLocal {
		t.Fatalf("expected local storage mode, got %#v", storage)
	}

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	initResult := app.GitInitWorkspace()
	if !initResult.Ok {
		t.Fatalf("init folder workspace failed: %s\n%s", initResult.Error, initResult.Output)
	}
	if !initResult.Git.IsRepo {
		t.Fatalf("expected folder workspace to switch to git mode after init, got %#v", initResult.Git)
	}
}

func TestDefaultWorkspaceLocationUsesDocumentsKurlo(t *testing.T) {
	configDir := t.TempDir()
	homeDir := t.TempDir()
	useTempConfigDir(t, configDir)
	useTempHomeDir(t, homeDir)

	app := NewApp()
	result := app.DefaultWorkspaceLocation()
	if result.Error != "" {
		t.Fatalf("default workspace location failed: %s", result.Error)
	}
	expected := filepath.Join(homeDir, "Documents", "Kurlo")
	if result.Path != expected {
		t.Fatalf("expected default location %q, got %q", expected, result.Path)
	}
	if info, err := os.Stat(expected); err != nil || !info.IsDir() {
		t.Fatalf("expected default location directory to exist, info=%#v err=%v", info, err)
	}
}

func TestCreateLocalWorkspaceRootUsesConfiguredDefaultLocation(t *testing.T) {
	withRequestStoreTestKey(t)
	configDir := t.TempDir()
	homeDir := t.TempDir()
	useTempConfigDir(t, configDir)
	useTempHomeDir(t, homeDir)

	defaultParent := filepath.Join(t.TempDir(), "Kurlo Workspaces")
	app := NewApp()
	location := app.SetDefaultWorkspaceLocation(defaultParent)
	if location.Error != "" {
		t.Fatalf("set default workspace location failed: %s", location.Error)
	}
	result := app.CreateLocalWorkspaceRoot("", "Kurlo API", "empty")
	if !result.Ok {
		t.Fatalf("create local workspace failed: %s", result.Error)
	}
	expectedRoot := filepath.Join(defaultParent, "Kurlo-API")
	if result.Root != expectedRoot {
		t.Fatalf("expected root %q, got %q", expectedRoot, result.Root)
	}
	if !hasYAMLWorkspaceStore(expectedRoot) {
		t.Fatalf("expected Kurlo YAML workspace files in %s", expectedRoot)
	}
}

func TestOpenWorkspaceRootEnsuresGitignore(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)

	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	runGitForTest(t, dir, "init")
	configureGitUserForTest(t, dir)
	runGitForTest(t, dir, "add", "kurlo.yml", "workspaces")
	runGitForTest(t, dir, "commit", "-m", "Initial Kurlo workspace")

	app := NewApp()
	result := app.openWorkspaceRoot(dir)
	if !result.Ok {
		t.Fatalf("open workspace failed: %s", result.Error)
	}
	gitignore, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
	if err != nil {
		t.Fatalf("expected .gitignore to be created on open: %v", err)
	}
	for _, entry := range kurloGitignoreEntries {
		if !strings.Contains(string(gitignore), entry) {
			t.Fatalf("expected .gitignore to include %q, got:\n%s", entry, gitignore)
		}
	}
}

func TestWorkspaceGitignoreIgnoresGeneratedRunnerReports(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	writeKurloWorkspaceFiles(t, dir)
	runGitForTest(t, dir, "init")
	configureGitUserForTest(t, dir)
	if err := ensureWorkspaceGitignore(dir); err != nil {
		t.Fatalf("ensure gitignore: %v", err)
	}
	runGitForTest(t, dir, "add", "kurlo.yml", ".gitignore", "workspaces")
	runGitForTest(t, dir, "commit", "-m", "Initial Kurlo workspace")

	reportPath := filepath.Join(dir, "collection-1-2026-05-17T19-25-24.html")
	if err := os.WriteFile(reportPath, []byte("<!doctype html>\n"), 0644); err != nil {
		t.Fatalf("write runner report: %v", err)
	}
	status := gitStatusForWorkspace(dir)
	if !status.Clean || len(status.Files) != 0 {
		t.Fatalf("expected generated runner report to be ignored, got %#v", status.Files)
	}
}

func TestOpenWorkspaceRootFetchesRemoteStatus(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)

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
	if err := os.WriteFile(filepath.Join(peer, "kurlo.yml"), []byte("version: 1\nremoteUpdate: true\n"), 0644); err != nil {
		t.Fatalf("write peer kurlo index: %v", err)
	}
	runGitForTest(t, peer, "add", "kurlo.yml")
	runGitForTest(t, peer, "commit", "-m", "Remote Kurlo update")
	runGitForTest(t, peer, "push")

	beforeOpen := gitStatusForWorkspace(dir)
	if beforeOpen.Behind != 0 {
		t.Fatalf("test setup expected stale remote tracking before open, got %#v", beforeOpen)
	}
	app := NewApp()
	result := app.openWorkspaceRoot(dir)
	if !result.Ok {
		t.Fatalf("open workspace failed: %s\n%s", result.Error, result.Output)
	}
	if result.Git.Behind != 1 {
		t.Fatalf("expected open to fetch remote status and show 1 behind, got %#v\n%s", result.Git, result.Output)
	}
}

func TestGitPullWorkspaceReportsChangeSummary(t *testing.T) {
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

func TestGitPushWorkspaceFriendlyErrorAfterLocalRename(t *testing.T) {
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

func TestGitPullWorkspaceReturnsDiagnosticsForInvalidRemoteRequest(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	withRequestStoreTestKey(t)
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
	withRequestStoreTestKey(t)
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

func TestGitPullWorkspaceDirtyOverlapLeavesResolvableConflict(t *testing.T) {
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

func TestGitPullWorkspaceMergeAllowsDirtyNonOverlappingChanges(t *testing.T) {
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
	summary := parseGitPullSummary("A\tnew.yml\nM\tupdated.yml\nD\tdeleted.yml\nR100\told.yml\trenamed.yml\n")
	if summary.Changed != 4 || summary.Added != 1 || summary.Updated != 1 || summary.Deleted != 1 || summary.Renamed != 1 {
		t.Fatalf("unexpected parsed summary: %#v", summary)
	}
}

func TestCustomLocalWorkspaceRootReceivesSubsequentSaves(t *testing.T) {
	withRequestStoreTestKey(t)
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)

	parent := t.TempDir()
	app := NewApp()
	result := app.CreateLocalWorkspaceRoot(parent, "Kurlo API", "empty")
	if !result.Ok {
		t.Fatalf("create local workspace failed: %s", result.Error)
	}
	if ok := app.SaveRequestStore(kurloSaveFlowPayload("/custom-folder", "token-a", []string{"req-main"}, "")); !ok {
		t.Fatalf("save request store failed")
	}

	customText := readAllText(t, result.Root)
	if !strings.Contains(customText, "/custom-folder") || !strings.Contains(customText, "name: Core") {
		t.Fatalf("custom folder workspace did not receive saved YAML:\n%s", customText)
	}
	if _, err := os.Stat(defaultFileWorkspaceStorePath()); err == nil {
		defaultText := readAllText(t, defaultFileWorkspaceStorePath())
		if strings.Contains(defaultText, "/custom-folder") {
			t.Fatalf("save leaked into default local storage:\n%s", defaultText)
		}
	}
}

func TestMissingWorkspaceSecretsFindsPlaceholdersWithoutLocalValues(t *testing.T) {
	dir := t.TempDir()
	requestDir := filepath.Join(dir, "workspaces", "Main", "collections", "Default", "requests")
	if err := os.MkdirAll(requestDir, 0755); err != nil {
		t.Fatalf("create request dir: %v", err)
	}
	payload := `request:
  id: req-main
  auth:
    bearerToken: "{{kurloSecret:request.req-main.auth.bearerToken}}"
  headers:
    - id: 7
      secret: true
      value: "{{kurloSecret:request.req-main.headers.row.7.value}}"
`
	if err := os.WriteFile(filepath.Join(requestDir, "req-main.yml"), []byte(payload), 0644); err != nil {
		t.Fatalf("write request file: %v", err)
	}

	missing := missingWorkspaceSecrets(dir, map[string]string{
		"request.req-main.auth.bearerToken": "token",
	})
	if len(missing) != 1 {
		t.Fatalf("expected one missing secret, got %#v", missing)
	}
	if missing[0].Key != "request.req-main.headers.row.7.value" || missing[0].Scope != "request" {
		t.Fatalf("unexpected missing secret: %#v", missing[0])
	}
}

func TestDeriveCloneDirectoryName(t *testing.T) {
	cases := map[string]string{
		"https://github.com/acme/api-workspace.git": "api-workspace",
		"git@github.com:acme/kurlo-demo.git":        "kurlo-demo",
	}
	for input, expected := range cases {
		if got := deriveCloneDirectoryName(input); got != expected {
			t.Fatalf("deriveCloneDirectoryName(%q) = %q, want %q", input, got, expected)
		}
	}
}

func TestEmptyKurloWorkspacePayloadUsesRepoName(t *testing.T) {
	payload, err := emptyKurloWorkspacePayload("avia-api")
	if err != nil {
		t.Fatalf("empty payload: %v", err)
	}
	var store map[string]any
	if err := json.Unmarshal([]byte(payload), &store); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	workspaces := mapSlice(store["workspaces"])
	collections := mapSlice(store["collections"])
	if len(workspaces) != 1 || stringValue(workspaces[0], "name") != "avia-api" {
		t.Fatalf("expected workspace named from repo, got %#v", workspaces)
	}
	if len(collections) != 1 || stringValue(collections[0], "name") != "Default Collection" {
		t.Fatalf("expected one default collection, got %#v", collections)
	}
	if requests := mapSlice(store["requests"]); len(requests) != 0 {
		t.Fatalf("expected empty request list, got %#v", requests)
	}
}

func TestGitCommitStagesAndCommitsOnlyKurloFiles(t *testing.T) {
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
	if !strings.Contains(tree, "kurlo.yml") || !strings.Contains(tree, "workspaces/Main/workspace.yml") {
		t.Fatalf("committed tree is missing Kurlo files:\n%s", tree)
	}
}

func TestGitHistoryIgnoresNonYAMLFilesUnderWorkspaces(t *testing.T) {
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

func TestGitDiscardWorkspaceFileRestoresTrackedKurloFile(t *testing.T) {
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

func TestGitPushWorkspaceUsesLocalRemote(t *testing.T) {
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

func TestGitCreateBranchFromRemoteBaseDoesNotTrackDifferentBranchName(t *testing.T) {
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

func TestGitForcePushWorkspaceUsesForceWithLease(t *testing.T) {
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

func TestGitPullMergeConflictCanResolveAndContinue(t *testing.T) {
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
	continueResult := gitContinueOperationForRoot(dir, "Merge Kurlo workspace")
	if !continueResult.Ok {
		t.Fatalf("continue failed: %s\n%s", continueResult.Error, continueResult.Output)
	}
	if continueResult.Git.Operation != "" || !continueResult.Git.Clean {
		t.Fatalf("expected clean completed merge, got %#v", continueResult.Git)
	}
}

func TestGitPullWorkspaceRebaseConflictMapsOursToLocalCommit(t *testing.T) {
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

func TestGitCommitLogAndCommitDiffShowKurloHistory(t *testing.T) {
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

func TestGitOutgoingChangesShowsOnlyCommittedKurloFiles(t *testing.T) {
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

func TestParseGitBranchLineTracksGoneUpstreamSeparately(t *testing.T) {
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

func TestFriendlyGitErrorAddsPrivateRepositoryHints(t *testing.T) {
	message := friendlyGitError("clone", "git@gitlab.com: Permission denied (publickey).", nil)
	if !strings.Contains(message, "ssh-agent") || !strings.Contains(message, "GitHub/GitLab/Bitbucket") {
		t.Fatalf("expected SSH auth hint, got %q", message)
	}
	message = friendlyGitError("clone", "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled", nil)
	if !strings.Contains(message, "credential helper") || !strings.Contains(message, "personal access token") || strings.Contains(message, "does not store") {
		t.Fatalf("expected HTTPS auth hint, got %q", message)
	}
}

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

func TestNormalizeGitDiffPathsKeepsSidePrefixes(t *testing.T) {
	diff := "diff --git a/Users/me/repo/workspaces/x.txt b/Users/me/repo/workspaces/x.txt\n--- /dev/null\n+++ b/Users/me/repo/workspaces/x.txt\n@@ -0,0 +1 @@\n+a/Users/me/repo/kept"
	got := normalizeGitDiffPaths("/Users/me/repo", diff)
	want := "diff --git a/workspaces/x.txt b/workspaces/x.txt\n--- /dev/null\n+++ b/workspaces/x.txt\n@@ -0,0 +1 @@\n+a/Users/me/repo/kept"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestGitStatusMarksWhichChangesKurloCanHandle(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	repo := t.TempDir()
	root := filepath.Join(repo, "api")
	writeKurloWorkspaceFiles(t, root)
	runGitForTest(t, repo, "init")
	for _, path := range []string{"README.md", "api/workspaces/Main/notes.txt"} {
		if err := os.WriteFile(filepath.Join(repo, filepath.FromSlash(path)), []byte("x\n"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	managed := map[string]bool{}
	for _, file := range gitStatusForWorkspace(root).Files {
		managed[file.Path] = file.Managed
	}
	if !managed["api/kurlo.yml"] || !managed["api/workspaces/Main/workspace.yml"] {
		t.Fatalf("Kurlo files must be managed: %#v", managed)
	}
	for _, path := range []string{"README.md", "api/workspaces/Main/notes.txt"} {
		if value, listed := managed[path]; !listed || value {
			t.Fatalf("%s must be listed as not managed: %#v", path, managed)
		}
	}
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

func TestGitRenameBranchLocallyAndOnTheRemote(t *testing.T) {
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
	withRequestStoreTestKey(t)
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

func TestSwapGitConflictMarkerSidesKeepsDiff3BaseOutOfSides(t *testing.T) {
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
	if !containsGitConflictMarkers("ok\n<<<<<<< HEAD\nx\n||||||| base\ny\n=======\nz\n>>>>>>> other\n") {
		t.Fatal("diff3 conflict markers were not detected")
	}
	if containsGitConflictMarkers("ok:\n  - a\n  - b\n") {
		t.Fatal("plain YAML was flagged as containing conflict markers")
	}
}

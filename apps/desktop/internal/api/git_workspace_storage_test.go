package api

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveKurloStorePayloadDoesNotRecreateMissingCustomRoot(t *testing.T) {
	t.Parallel()
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
	t.Parallel()

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

func TestCustomLocalWorkspaceRootReceivesSubsequentSaves(t *testing.T) {
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
	t.Parallel()

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
      key: Authorization
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
	if missing[0].RowKey != "Authorization" {
		t.Fatalf("missing secret should name its row, got %#v", missing[0])
	}
}

func TestDeriveCloneDirectoryName(t *testing.T) {
	t.Parallel()

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
	t.Parallel()

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

package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"gopkg.in/yaml.v3"
)

const (
	gitCommandTimeout    = 2 * time.Minute
	maxGitDiffBytes      = 768 * 1024
	defaultGitLogPageLen = 60
	maxGitLogPageLen     = 200
)

var kurloSecretRefPattern = regexp.MustCompile(`\{\{kurloSecret:([^}]+)\}\}`)
var gitRemoteNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
var gitCommitHashPattern = regexp.MustCompile(`^[0-9A-Fa-f]{4,64}$`)
var gitStashRefPattern = regexp.MustCompile(`^stash@\{\d+\}$`)
var gitCredentialURLPattern = regexp.MustCompile(`(https?://)[^/\s:@]+:[^/\s@]+@`)

var kurloRunnerReportArtifactPattern = regexp.MustCompile(`-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.html$`)

var gitOperationMu sync.RWMutex
var workspaceGitignoreMu sync.Mutex

type GitFileStatus struct {
	Path     string `json:"path"`
	Index    string `json:"index"`
	Worktree string `json:"worktree"`
	Status   string `json:"status"`
	Managed  bool   `json:"managed"`
}

type GitWorkspaceStatus struct {
	IsRepo          bool            `json:"isRepo"`
	WorkspaceRoot   string          `json:"workspaceRoot"`
	Root            string          `json:"root"`
	MissingRoot     bool            `json:"missingRoot"`
	Branch          string          `json:"branch"`
	Head            string          `json:"head"`
	Upstream        string          `json:"upstream"`
	UpstreamGone    bool            `json:"upstreamGone"`
	Ahead           int             `json:"ahead"`
	Behind          int             `json:"behind"`
	PushCommitCount int             `json:"pushCommitCount"`
	PushRemote      string          `json:"pushRemote"`
	Operation       string          `json:"operation"`
	Clean           bool            `json:"clean"`
	Files           []GitFileStatus `json:"files"`
	Remotes         []string        `json:"remotes"`
	Stashes         []GitStashEntry `json:"stashes"`
	Error           string          `json:"error"`
	GitMissing      bool            `json:"gitMissing"`

	AuthRequired  bool   `json:"authRequired"`
	AuthScheme    string `json:"authScheme"`
	AuthHost      string `json:"authHost"`
	TokenRejected bool   `json:"tokenRejected"`
}

type GitDiffResult struct {
	Path         string `json:"path"`
	Diff         string `json:"diff"`
	StagedDiff   string `json:"stagedDiff"`
	UnstagedDiff string `json:"unstagedDiff"`
	Binary       bool   `json:"binary"`
	Truncated    bool   `json:"truncated"`
	Error        string `json:"error"`
}

type GitOperationResult struct {
	Ok          bool               `json:"ok"`
	Git         GitWorkspaceStatus `json:"git"`
	Error       string             `json:"error"`
	Output      string             `json:"output"`
	Files       []string           `json:"files"`
	PullSummary GitPullSummary     `json:"pullSummary"`
	CommitCount int                `json:"commitCount"`
}

type GitPullSummary struct {
	Changed int `json:"changed"`
	Added   int `json:"added"`
	Updated int `json:"updated"`
	Deleted int `json:"deleted"`
	Renamed int `json:"renamed"`
}

type GitConflictFileResult struct {
	Ok              bool               `json:"ok"`
	Git             GitWorkspaceStatus `json:"git"`
	Path            string             `json:"path"`
	Content         string             `json:"content"`
	OursContent     string             `json:"oursContent"`
	TheirsContent   string             `json:"theirsContent"`
	OursAvailable   bool               `json:"oursAvailable"`
	TheirsAvailable bool               `json:"theirsAvailable"`
	Binary          bool               `json:"binary"`
	Truncated       bool               `json:"truncated"`
	OursTruncated   bool               `json:"oursTruncated"`
	TheirsTruncated bool               `json:"theirsTruncated"`
	Error           string             `json:"error"`
	Output          string             `json:"output"`
}

type GitStashEntry struct {
	Ref     string `json:"ref"`
	Index   int    `json:"index"`
	Message string `json:"message"`
}

type GitCommitEntry struct {
	Hash      string `json:"hash"`
	ShortHash string `json:"shortHash"`
	Author    string `json:"author"`
	Date      string `json:"date"`
	Message   string `json:"message"`
}

type GitLogResult struct {
	Ok      bool               `json:"ok"`
	Git     GitWorkspaceStatus `json:"git"`
	Commits []GitCommitEntry   `json:"commits"`
	Limit   int                `json:"limit"`
	Offset  int                `json:"offset"`
	HasMore bool               `json:"hasMore"`
	Error   string             `json:"error"`
	Output  string             `json:"output"`
}

type GitBranchEntry struct {
	Name     string `json:"name"`
	FullName string `json:"fullName"`
	Remote   string `json:"remote"`
	Current  bool   `json:"current"`
	Upstream string `json:"upstream"`
}

type GitBranchListResult struct {
	Ok             bool               `json:"ok"`
	Git            GitWorkspaceStatus `json:"git"`
	Current        string             `json:"current"`
	LocalBranches  []GitBranchEntry   `json:"localBranches"`
	RemoteBranches []GitBranchEntry   `json:"remoteBranches"`
	Error          string             `json:"error"`
	Output         string             `json:"output"`
}

type WorkspaceSecretRef struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Scope string `json:"scope"`
}

type WorkspaceOpenResult struct {
	Ok             bool                  `json:"ok"`
	Root           string                `json:"root"`
	Payload        string                `json:"payload"`
	Git            GitWorkspaceStatus    `json:"git"`
	MissingSecrets []WorkspaceSecretRef  `json:"missingSecrets"`
	Diagnostics    []WorkspaceDiagnostic `json:"diagnostics"`
	Error          string                `json:"error"`
	Output         string                `json:"output"`
	PullSummary    GitPullSummary        `json:"pullSummary"`
	TargetExists   bool                  `json:"targetExists"`
}

func (a *App) OpenDirectoryDialog(title string) string {
	return a.openDirectoryDialog(title, "")
}

func (a *App) OpenDirectoryDialogWithDefault(title, defaultDirectory string) string {
	return a.openDirectoryDialog(title, defaultDirectory)
}

func (a *App) openDirectoryDialog(title, defaultDirectory string) string {
	if a.ctx == nil {
		return ""
	}
	defaultDirectory = strings.TrimSpace(defaultDirectory)
	if defaultDirectory != "" {
		if normalized, err := ensureWorkspaceLocationDir(defaultDirectory); err == nil {
			defaultDirectory = normalized
		} else {
			defaultDirectory = ""
		}
	}
	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                title,
		DefaultDirectory:     defaultDirectory,
		CanCreateDirectories: true,
	})
	if err != nil {
		return ""
	}
	return path
}

func (a *App) GitStatus() GitWorkspaceStatus {
	root := fileWorkspaceStorePath()
	if fileWorkspaceStorageMode() == workspaceStorageModeLocal {
		return localWorkspaceGitStatus(root)
	}
	return gitStatusForWorkspace(root)
}

func (a *App) GitDiff(path string) GitDiffResult {
	return gitDiffForWorkspace(fileWorkspaceStorePath(), path)
}

func (a *App) GitOutgoingChanges() GitDiffResult {
	return gitOutgoingChangesForWorkspace(fileWorkspaceStorePath())
}

func (a *App) GitCommitLog(limit int) GitLogResult {
	return gitCommitLogForRoot(fileWorkspaceStorePath(), limit)
}

func (a *App) GitCommitLogPage(limit, offset int) GitLogResult {
	return gitCommitLogPageForRoot(fileWorkspaceStorePath(), limit, offset)
}

func (a *App) GitCommitDiff(commit string) GitDiffResult {
	return gitCommitDiffForRoot(fileWorkspaceStorePath(), commit)
}

func (a *App) GitConflictFile(path string) GitConflictFileResult {
	return gitConflictFileForRoot(fileWorkspaceStorePath(), path)
}

func (a *App) GitResolveConflictFile(path, resolution, content string) GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return gitResolveConflictFileForRoot(fileWorkspaceStorePath(), path, resolution, content)
}

func (a *App) GitContinueOperation(message string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitContinueOperationForRoot(root, message)
	if !result.Ok {
		return WorkspaceOpenResult{Ok: false, Root: root, Git: result.Git, Error: result.Error, Output: result.Output}
	}
	opened := a.openWorkspaceRoot(root)
	opened.Output = result.Output
	if opened.Error == "" {
		opened.Ok = true
		a.emitWorkspaceChanged("git:continue")
	}
	return opened
}

func (a *App) GitAbortOperation() WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitAbortOperationForRoot(root)
	if !result.Ok {
		return WorkspaceOpenResult{Ok: false, Root: root, Git: result.Git, Error: result.Error, Output: result.Output}
	}
	opened := a.openWorkspaceRoot(root)
	opened.Output = result.Output
	if opened.Error == "" {
		opened.Ok = true
		a.emitWorkspaceChanged("git:abort")
	}
	return opened
}

func (a *App) GitStashWorkspace(message string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitStashWorkspaceForRoot(root, message)
	if !result.Ok {
		return WorkspaceOpenResult{Ok: false, Root: root, Git: result.Git, Error: result.Error, Output: result.Output}
	}
	opened := a.openWorkspaceRoot(root)
	opened.Output = result.Output
	if opened.Error == "" {
		opened.Ok = true
		a.emitWorkspaceChanged("git:stash")
	}
	return opened
}

func (a *App) GitStashPopWorkspace(ref string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitStashPopWorkspaceForRoot(root, ref)
	if !result.Ok {
		return WorkspaceOpenResult{Ok: false, Root: root, Git: result.Git, Error: result.Error, Output: result.Output}
	}
	opened := a.openWorkspaceRoot(root)
	opened.Output = result.Output
	if opened.Error == "" {
		opened.Ok = true
		a.emitWorkspaceChanged("git:stash-pop")
	}
	return opened
}

func (a *App) GitFetchWorkspace() GitWorkspaceStatus {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	status := gitStatusForWorkspace(root)
	if !status.IsRepo || status.Root == "" {
		return status
	}
	if output, err := runGit(status.Root, "fetch", "--prune"); err != nil {
		status.Error = friendlyGitError("fetch", output, err)
		annotateGitAuthFailure(&status, output+" "+status.Error, gitRemoteURLForRoot(status.Root, ""))
		return status
	}
	return gitStatusForWorkspace(root)
}

func gitFetchWorkspaceOnOpen(repoRoot string) (string, error) {
	if strings.TrimSpace(repoRoot) == "" || gitOperationState(repoRoot) != "" || !gitRepositoryHasRemote(repoRoot) {
		return "", nil
	}
	return runGit(repoRoot, "fetch", "--prune")
}

func (a *App) GitInitWorkspace() GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitInitWorkspaceForRoot(root)
	if result.Ok {
		if err := persistActiveWorkspaceRootMode(root, workspaceStorageModeGit); err != nil {
			return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: err.Error(), Output: result.Output, Files: result.Files}
		}
		result.Git = gitStatusForWorkspace(root)
	}
	return result
}

func (a *App) GitAddRemote(remoteName, remoteURL string) GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return gitAddRemoteForRoot(fileWorkspaceStorePath(), remoteName, remoteURL)
}

func (a *App) GitTestRemote(remoteNameOrURL string) GitOperationResult {
	return gitTestRemoteForRoot(fileWorkspaceStorePath(), remoteNameOrURL)
}

func (a *App) GitBranches() GitBranchListResult {
	return gitBranchesForRoot(fileWorkspaceStorePath())
}

func (a *App) GitCheckoutBranch(branchName string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitCheckoutBranchForRoot(root, branchName)
	if !result.Ok {
		return WorkspaceOpenResult{Ok: false, Root: root, Git: result.Git, Error: result.Error, Output: result.Output}
	}
	opened := a.openWorkspaceRoot(root)
	opened.Output = result.Output
	if opened.Error == "" {
		opened.Ok = true
		a.emitWorkspaceChanged("git:checkout")
	}
	return opened
}

func (a *App) GitCreateBranch(branchName, startPoint string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitCreateBranchForRoot(root, branchName, startPoint)
	if !result.Ok {
		return WorkspaceOpenResult{Ok: false, Root: root, Git: result.Git, Error: result.Error, Output: result.Output}
	}
	opened := a.openWorkspaceRoot(root)
	opened.Output = result.Output
	if opened.Error == "" {
		opened.Ok = true
	}
	return opened
}

func (a *App) GitCreateTrackingBranch(branchName, startPoint string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitCreateTrackingBranchForRoot(root, branchName, startPoint)
	if !result.Ok {
		return WorkspaceOpenResult{Ok: false, Root: root, Git: result.Git, Error: result.Error, Output: result.Output}
	}
	opened := a.openWorkspaceRoot(root)
	opened.Output = result.Output
	if opened.Error == "" {
		opened.Ok = true
	}
	return opened
}

func (a *App) GitDeleteBranch(branchName string, remote bool, force bool) GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return gitDeleteBranchForRoot(fileWorkspaceStorePath(), branchName, remote, force)
}

func (a *App) GitRenameBranch(branchName, newName string, remote bool) GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return gitRenameBranchForRoot(fileWorkspaceStorePath(), branchName, newName, remote)
}

func (a *App) GitStageWorkspaceFiles() GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return gitStageWorkspaceFilesForRoot(fileWorkspaceStorePath())
}

func (a *App) GitCommitWorkspace(message string) GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return gitCommitWorkspaceForRoot(fileWorkspaceStorePath(), message)
}

func (a *App) GitCommitWorkspaceFiles(paths []string, message string) GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return gitCommitWorkspaceFilesForRoot(fileWorkspaceStorePath(), paths, message)
}

func (a *App) GitPushWorkspace(remoteName string) GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return gitPushWorkspaceForRoot(fileWorkspaceStorePath(), remoteName)
}

func (a *App) GitForcePushWorkspace(remoteName string) GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return gitForcePushWorkspaceForRoot(fileWorkspaceStorePath(), remoteName)
}

func (a *App) GitDiscardWorkspaceFile(path string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitDiscardWorkspaceFileForRoot(root, path)
	if !result.Ok {
		return WorkspaceOpenResult{Ok: false, Root: root, Git: result.Git, Error: result.Error, Output: result.Output}
	}
	opened := a.openWorkspaceRootOpts(root, false)
	opened.Output = result.Output
	if opened.Error == "" {
		opened.Ok = true
	}
	return opened
}

func (a *App) GitDiscardWorkspaceChanges() WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitDiscardWorkspaceChangesForRoot(root)
	if !result.Ok {
		return WorkspaceOpenResult{Ok: false, Root: root, Git: result.Git, Error: result.Error, Output: result.Output}
	}
	opened := a.openWorkspaceRootOpts(root, false)
	opened.Output = result.Output
	if opened.Error == "" {
		opened.Ok = true
	}
	return opened
}

func (a *App) GitDiscardWorkspaceFiles(paths []string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitDiscardWorkspaceFilesForRoot(root, paths)
	if !result.Ok {
		return WorkspaceOpenResult{Ok: false, Root: root, Git: result.Git, Error: result.Error, Output: result.Output}
	}
	opened := a.openWorkspaceRootOpts(root, false)
	opened.Output = result.Output
	if opened.Error == "" {
		opened.Ok = true
	}
	return opened
}

func (a *App) GitPullWorkspace() WorkspaceOpenResult {
	return a.gitPullWorkspace("ff")
}

func (a *App) GitPullWorkspaceWithStrategy(strategy string) WorkspaceOpenResult {
	return a.gitPullWorkspace(strategy)
}

func (a *App) GitPullBranch(branchName string) GitOperationResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return gitPullBranchForRoot(fileWorkspaceStorePath(), branchName)
}

func (a *App) gitPullWorkspace(strategy string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	result := gitPullWorkspaceForRoot(root, strategy)
	if !result.Ok {
		return WorkspaceOpenResult{Ok: false, Root: root, Git: result.Git, Error: result.Error, Output: result.Output, PullSummary: result.PullSummary}
	}
	opened := a.openWorkspaceRoot(root)
	opened.Output = result.Output
	opened.PullSummary = result.PullSummary
	if opened.Error == "" {
		opened.Ok = true
		a.emitWorkspaceChanged("git:pull")
	}
	return opened
}

func gitPullWorkspaceForRoot(root, strategy string) GitOperationResult {
	status := gitStatusForWorkspace(root)
	if !status.IsRepo || status.Root == "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Current workspace is not inside a Git repository."}
	}
	if status.Operation != "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Finish or abort the current Git " + status.Operation + " before pulling."}
	}
	var args []string
	action := "pull"
	autostash := !status.Clean
	switch strings.TrimSpace(strings.ToLower(strategy)) {
	case "", "ff", "fast-forward", "fast-forward-only":
		args = []string{"pull", "--ff-only"}
		action = "pull --ff-only"
	case "merge":
		args = []string{"pull", "--no-rebase"}
		action = "pull --merge"
	case "rebase":
		args = []string{"pull", "--rebase"}
		action = "pull --rebase"
	case "autostash", "rebase-autostash":
		args = []string{"pull", "--rebase", "--autostash"}
		action = "pull --rebase --autostash"
		autostash = false
	default:
		return GitOperationResult{Ok: false, Git: status, Error: "Unknown pull strategy."}
	}
	if autostash {
		args = append(args, "--autostash")
		action += " --autostash"
	}
	beforeHead := gitCurrentHead(status.Root)
	output, err := runGit(status.Root, args...)
	afterHead := gitCurrentHead(status.Root)
	summary := gitPullSummaryForRange(status.Root, beforeHead, afterHead)
	if err != nil {
		next := gitStatusForWorkspace(root)
		message := friendlyGitError(action, output, err)
		if hasConflictedFiles(next) {
			message = gitPullConflictMessage(next)
		} else {
			annotateGitAuthFailure(&next, output+" "+message, gitRemoteURLForRoot(status.Root, ""))
		}
		return GitOperationResult{Ok: false, Git: next, Error: message, Output: output, PullSummary: summary}
	}
	next := gitStatusForWorkspace(root)
	if hasConflictedFiles(next) {
		return GitOperationResult{Ok: false, Git: next, Error: gitPullConflictMessage(next), Output: output, PullSummary: summary}
	}
	return GitOperationResult{Ok: true, Git: next, Output: output, PullSummary: summary}
}

func gitPullBranchForRoot(root, branchName string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	if status.Operation != "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Finish or abort the current Git " + status.Operation + " before pulling branches."}
	}
	branch, err := cleanGitBranchName(branchName)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	current := currentGitBranch(status.Root, status.Branch)
	if branch == current {
		return gitPullWorkspaceForRoot(root, "ff")
	}
	if gitBranchCheckedOutInAnotherWorktree(status.Root, branch) {
		return GitOperationResult{Ok: false, Git: status, Error: "Branch " + branch + " is checked out in another worktree. Pull it from that worktree or check out a different branch there first."}
	}
	localBranches, output, err := localGitBranches(status.Root)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: friendlyGitError("branch list", output, err), Output: output}
	}
	var selected GitBranchEntry
	for _, local := range localBranches {
		if local.Name == branch {
			selected = local
			break
		}
	}
	if selected.Name == "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Local branch " + branch + " does not exist."}
	}
	if selected.Upstream == "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Branch " + branch + " has no upstream to pull from."}
	}
	remoteName, remoteBranch, err := splitRemoteBranchName(selected.Upstream)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	beforeHead := gitRefHash(status.Root, "refs/heads/"+branch)
	if beforeHead == "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Local branch " + branch + " does not exist."}
	}
	remoteRef := "refs/remotes/" + remoteName + "/" + remoteBranch
	fetchOutput, err := runGit(status.Root, "fetch", "--prune", remoteName, "+refs/heads/"+remoteBranch+":"+remoteRef)
	if err != nil {
		next := gitStatusForWorkspace(root)
		return GitOperationResult{Ok: false, Git: next, Error: friendlyGitError("branch pull fetch", fetchOutput, err), Output: fetchOutput}
	}
	afterHead := gitRefHash(status.Root, remoteRef)
	if afterHead == "" {
		next := gitStatusForWorkspace(root)
		return GitOperationResult{Ok: false, Git: next, Error: selected.Upstream + " no longer exists on the remote.", Output: fetchOutput}
	}
	_, err = runGit(status.Root, "merge-base", "--is-ancestor", "refs/heads/"+branch, remoteRef)
	if err != nil {
		next := gitStatusForWorkspace(root)
		return GitOperationResult{
			Ok:     false,
			Git:    next,
			Error:  "Cannot fast-forward " + branch + " from " + selected.Upstream + ". Check out the branch and pull with merge or rebase.",
			Output: fetchOutput,
		}
	}
	if beforeHead == afterHead {
		return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: fetchOutput, PullSummary: GitPullSummary{}}
	}
	updateOutput, err := runGit(status.Root, "update-ref", "refs/heads/"+branch, afterHead, beforeHead)
	output = appendGitOutput(fetchOutput, updateOutput)
	summary := gitPullSummaryForRange(status.Root, beforeHead, afterHead)
	if err != nil {
		next := gitStatusForWorkspace(root)
		return GitOperationResult{Ok: false, Git: next, Error: friendlyGitError("branch fast-forward", output, err), Output: output, PullSummary: summary}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output, PullSummary: summary}
}

func (a *App) OpenWorkspaceRoot(path string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	return a.openWorkspaceRoot(path)
}

func (a *App) UseLocalWorkspaceStore() WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := defaultFileWorkspaceStorePath()
	if err := os.MkdirAll(root, 0755); err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: localWorkspaceGitStatus(root)}
	}
	if err := persistActiveWorkspaceRootMode(root, workspaceStorageModeLocal); err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: localWorkspaceGitStatus(root)}
	}
	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(requestStorePath(), root)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: localWorkspaceGitStatus(root), Diagnostics: diagnostics}
	}
	secrets := map[string]string{}
	if localStore, _, err := loadLocalRequestStore(requestStorePath()); err == nil {
		secrets = stringMap(localStore["secrets"])
	}
	return WorkspaceOpenResult{
		Ok:             true,
		Root:           root,
		Payload:        payload,
		Git:            localWorkspaceGitStatus(root),
		MissingSecrets: missingWorkspaceSecrets(root, secrets),
		Diagnostics:    diagnostics,
	}
}

func (a *App) CreateLocalWorkspaceRoot(parentDir, directoryName, initMode string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	parent, err := parentDirForNewWorkspace(parentDir)
	if err != nil {
		return WorkspaceOpenResult{Ok: false, Error: err.Error()}
	}
	name := safeCloneDirectoryName(directoryName)
	if name == "" {
		return WorkspaceOpenResult{Ok: false, Error: "Workspace folder name is required."}
	}
	target := filepath.Join(parent, name)
	if _, err := os.Stat(target); err == nil {
		return WorkspaceOpenResult{Ok: false, Root: target, Error: "Destination folder already exists."}
	} else if !errors.Is(err, os.ErrNotExist) {
		return WorkspaceOpenResult{Ok: false, Root: target, Error: err.Error()}
	}

	payload, initMessage, err := localWorkspaceInitializationPayload(initMode, name)
	if err != nil {
		return WorkspaceOpenResult{Ok: false, Root: target, Error: err.Error()}
	}
	if err := os.MkdirAll(target, 0755); err != nil {
		return WorkspaceOpenResult{Ok: false, Root: target, Error: err.Error()}
	}
	if err := persistActiveWorkspaceRootMode(target, workspaceStorageModeLocal); err != nil {
		return WorkspaceOpenResult{Ok: false, Root: target, Error: err.Error(), Git: localWorkspaceGitStatus(target)}
	}
	if err := saveKurloStorePayload(requestStorePath(), target, payload); err != nil {
		return WorkspaceOpenResult{Ok: false, Root: target, Error: err.Error(), Git: localWorkspaceGitStatus(target)}
	}
	result := a.openLocalWorkspaceRoot(target)
	result.Output = initMessage
	return result
}

func (a *App) GitCloneWorkspace(remoteURL, parentDir, directoryName string) WorkspaceOpenResult {
	return a.gitCloneWorkspace(remoteURL, parentDir, directoryName, "empty", "", false)
}

func (a *App) GitCloneWorkspaceWithMode(remoteURL, parentDir, directoryName, initMode string) WorkspaceOpenResult {
	return a.gitCloneWorkspace(remoteURL, parentDir, directoryName, initMode, "", false)
}

func (a *App) GitCloneWorkspaceWithAuth(remoteURL, parentDir, directoryName, initMode, sshKeyPath string, overwrite bool) WorkspaceOpenResult {
	return a.gitCloneWorkspace(remoteURL, parentDir, directoryName, initMode, sshKeyPath, overwrite)
}

func (a *App) gitCloneWorkspace(remoteURL, parentDir, directoryName, initMode, sshKeyPath string, overwrite bool) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	remoteURL = strings.TrimSpace(remoteURL)
	if remoteURL == "" {
		return WorkspaceOpenResult{Error: "Repository URL is required."}
	}
	parent, err := parentDirForNewWorkspace(parentDir)
	if err != nil {
		return WorkspaceOpenResult{Error: err.Error()}
	}
	name := safeCloneDirectoryName(directoryName)
	if name == "" {
		name = deriveCloneDirectoryName(remoteURL)
	}
	if name == "" {
		return WorkspaceOpenResult{Error: "Could not infer a destination folder name."}
	}
	target := filepath.Join(parent, name)
	targetExists := false
	if _, statErr := os.Stat(target); statErr == nil {
		targetExists = true
		if !overwrite {

			return WorkspaceOpenResult{Root: target, Error: "A folder named \"" + name + "\" already exists here.", TargetExists: true}
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return WorkspaceOpenResult{Root: target, Error: statErr.Error()}
	}
	cleanedRemoteURL, err := cleanGitRemoteURL(remoteURL)
	if err != nil {
		return WorkspaceOpenResult{Root: target, Error: err.Error()}
	}
	cloneEnv := gitSSHCommandEnv(sshKeyPath)

	cloneDest := target
	if targetExists && overwrite {
		cloneDest = filepath.Join(parent, fmt.Sprintf(".kurlo-clone-%d", time.Now().UnixNano()))
	}
	output, err := gitOutputEnv(parent, cloneEnv, "clone", "--", cleanedRemoteURL, cloneDest)
	if err != nil {
		if cloneDest != target {
			_ = os.RemoveAll(cloneDest)
		}
		message := friendlyGitError("clone", output, err)
		var st GitWorkspaceStatus
		annotateGitAuthFailure(&st, output+" "+message, cleanedRemoteURL)
		return WorkspaceOpenResult{Root: target, Error: message, Output: output, Git: st}
	}

	backupDir := ""
	if cloneDest != target {
		backupDir = filepath.Join(parent, fmt.Sprintf(".kurlo-backup-%d", time.Now().UnixNano()))
		if mvErr := os.Rename(target, backupDir); mvErr != nil {
			_ = os.RemoveAll(cloneDest)
			return WorkspaceOpenResult{Root: target, Error: "Could not replace the existing folder: " + mvErr.Error(), Output: output}
		}
		if mvErr := os.Rename(cloneDest, target); mvErr != nil {
			_ = os.Rename(backupDir, target)
			_ = os.RemoveAll(cloneDest)
			return WorkspaceOpenResult{Root: target, Error: "Cloned but could not move into place: " + mvErr.Error(), Output: output}
		}
	}

	rollback := func() {
		_ = os.RemoveAll(target)
		if backupDir != "" {
			_ = os.Rename(backupDir, target)
			backupDir = ""
		}
	}
	commit := func() {
		if backupDir != "" {
			_ = os.RemoveAll(backupDir)
			backupDir = ""
		}
	}

	if strings.TrimSpace(sshKeyPath) != "" {
		_ = saveWorkspaceAuth(target, gitWorkspaceAuth{Method: "ssh-key", SSHKeyPath: strings.TrimSpace(sshKeyPath)})
	}
	if !hasYAMLWorkspaceStore(target) {
		initPayload, initMessage, err := cloneInitializationPayload(initMode, name)
		if err != nil {
			rollback()
			return WorkspaceOpenResult{Output: output, Error: err.Error()}
		}
		if err := persistActiveWorkspaceRootMode(target, workspaceStorageModeGit); err != nil {
			rollback()
			return WorkspaceOpenResult{Output: output, Error: err.Error()}
		}
		if err := saveKurloStorePayload(requestStorePath(), target, initPayload); err != nil {
			rollback()
			return WorkspaceOpenResult{Output: output, Error: err.Error()}
		}
		commit()
		result := a.openWorkspaceRoot(target)
		result.Output = appendGitOutput(output, initMessage)
		if result.Ok {
			a.emitWorkspaceChanged("git:clone")
		}
		return result
	}
	commit()
	result := a.openWorkspaceRoot(target)
	result.Output = output
	if result.Ok {
		a.emitWorkspaceChanged("git:clone")
	}
	return result
}

func (a *App) SaveWorkspaceSecrets(values map[string]string) WorkspaceOpenResult {
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	root := fileWorkspaceStorePath()
	store, _, err := loadLocalRequestStore(requestStorePath())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: gitStatusForWorkspace(root)}
		}
		store = map[string]any{}
	}
	secrets := stringMap(store["secrets"])
	for key, value := range values {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		secrets[key] = value
	}
	store["version"] = localStoreVersion
	store["secrets"] = secrets
	storage := cloneMap(localStoreStorage(store))
	storage["kind"] = workspaceStoreKind
	storage["format"] = workspaceStoreFormat
	storage["root"] = persistedWorkspaceRoot(root)
	storage["mode"] = fileWorkspaceStorageMode()
	store["storage"] = storage
	if err := saveLocalKurloStore(requestStorePath(), store); err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: gitStatusForWorkspace(root)}
	}
	return a.openWorkspaceRoot(root)
}

func (a *App) openWorkspaceRoot(path string) WorkspaceOpenResult {
	return a.openWorkspaceRootOpts(path, true)
}

func (a *App) openWorkspaceRootOpts(path string, ensureGitignore bool) WorkspaceOpenResult {
	root, err := normalizeExistingDir(path)
	if err != nil {
		return WorkspaceOpenResult{Ok: false, Root: path, Error: friendlyWorkspaceRootError(err), Git: gitStatusForWorkspace(path)}
	}
	if !hasYAMLWorkspaceStore(root) {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: "Selected folder does not contain a Kurlo YAML workspace.", Git: gitStatusForWorkspace(root)}
	}
	if err := persistActiveWorkspaceRootMode(root, workspaceStorageModeGit); err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: gitStatusForWorkspace(root)}
	}
	openOutput := ""
	if status := gitStatusForWorkspace(root); status.IsRepo && ensureGitignore {
		if err := ensureWorkspaceGitignore(root); err != nil {
			status.Error = err.Error()
			return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: status}
		}
	}
	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(requestStorePath(), root)
	if err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: gitStatusForWorkspace(root), Diagnostics: diagnostics}
	}
	gitStatus := gitStatusForWorkspace(root)
	if gitStatus.IsRepo && gitStatus.Root != "" {
		if output, fetchErr := gitFetchWorkspaceOnOpen(gitStatus.Root); fetchErr != nil {
			openOutput = output
			gitStatus = gitStatusForWorkspace(root)
			gitStatus.Error = friendlyGitError("fetch", output, fetchErr)
		} else {
			openOutput = output
			gitStatus = gitStatusForWorkspace(root)
		}
	}
	secrets := map[string]string{}
	if localStore, _, err := loadLocalRequestStore(requestStorePath()); err == nil {
		secrets = stringMap(localStore["secrets"])
	}
	return WorkspaceOpenResult{
		Ok:             true,
		Root:           root,
		Payload:        payload,
		Git:            gitStatus,
		MissingSecrets: missingWorkspaceSecrets(root, secrets),
		Diagnostics:    diagnostics,
		Output:         openOutput,
	}
}

func (a *App) openLocalWorkspaceRoot(path string) WorkspaceOpenResult {
	root, err := normalizeExistingDir(path)
	if err != nil {
		return WorkspaceOpenResult{Ok: false, Root: path, Error: friendlyWorkspaceRootError(err), Git: localWorkspaceGitStatus(path)}
	}
	if !hasYAMLWorkspaceStore(root) {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: "Selected folder does not contain a Kurlo YAML workspace.", Git: localWorkspaceGitStatus(root)}
	}
	if err := persistActiveWorkspaceRootMode(root, workspaceStorageModeLocal); err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: localWorkspaceGitStatus(root)}
	}
	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(requestStorePath(), root)
	if err != nil {
		return WorkspaceOpenResult{Ok: false, Root: root, Error: err.Error(), Git: localWorkspaceGitStatus(root), Diagnostics: diagnostics}
	}
	secrets := map[string]string{}
	if localStore, _, err := loadLocalRequestStore(requestStorePath()); err == nil {
		secrets = stringMap(localStore["secrets"])
	}
	return WorkspaceOpenResult{
		Ok:             true,
		Root:           root,
		Payload:        payload,
		Git:            localWorkspaceGitStatus(root),
		MissingSecrets: missingWorkspaceSecrets(root, secrets),
		Diagnostics:    diagnostics,
	}
}

func persistActiveWorkspaceRootMode(root, mode string) error {
	store, _, err := loadLocalRequestStore(requestStorePath())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		store = map[string]any{}
	}
	storage := cloneMap(localStoreStorage(store))
	if !sameWorkspaceRoot(resolvedStoredWorkspaceRoot(stringFromAny(storage["root"])), root) {
		delete(storage, "sharedHash")
	}
	storage["kind"] = workspaceStoreKind
	storage["format"] = workspaceStoreFormat
	storage["root"] = persistedWorkspaceRoot(root)
	if mode != workspaceStorageModeGit && mode != workspaceStorageModeLocal {
		mode = inferWorkspaceStorageMode(root)
	}
	storage["mode"] = mode
	store["version"] = localStoreVersion
	store["storage"] = storage
	if _, ok := store["secrets"]; !ok {
		store["secrets"] = map[string]string{}
	}
	return saveLocalKurloStore(requestStorePath(), store)
}

func localWorkspaceGitStatus(root string) GitWorkspaceStatus {
	status := GitWorkspaceStatus{
		IsRepo:        false,
		WorkspaceRoot: root,
		Root:          "",
		Clean:         true,
		Files:         []GitFileStatus{},
		Stashes:       []GitStashEntry{},
	}
	if workspaceRootUnavailable(root) {
		status.MissingRoot = true
		status.Error = missingWorkspaceRootMessage()
	}
	return status
}

func gitStatusForWorkspace(workspaceRoot string) GitWorkspaceStatus {
	status := GitWorkspaceStatus{WorkspaceRoot: workspaceRoot, Clean: true, Files: []GitFileStatus{}, Stashes: []GitStashEntry{}}
	if workspaceRootMissing(workspaceRoot) {
		if isDefaultWorkspaceRoot(workspaceRoot) {
			return status
		}
		status.MissingRoot = true
		status.Error = missingWorkspaceRootMessage()
		return status
	}
	root, err := gitOutput(workspaceRoot, "rev-parse", "--show-toplevel")
	if err != nil {
		status.Error = gitUnavailableMessage(root, err)
		status.GitMissing = status.Error != ""
		return status
	}
	status.Root = strings.TrimSpace(root)
	if status.Root != "" {
		status.Root = filepath.Clean(status.Root)
	}
	status.IsRepo = status.Root != ""
	if !status.IsRepo {
		return status
	}
	status.Operation = gitOperationState(status.Root)
	if head, err := gitOutput(status.Root, "rev-parse", "--short", "HEAD"); err == nil {
		status.Head = strings.TrimSpace(head)
	}
	output, err := gitOutput(status.Root, "status", "--porcelain=v1", "-b", "--untracked-files=all")
	if err != nil {
		status.Error = friendlyGitError("status", output, err)
		return status
	}
	lines := strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if strings.HasPrefix(line, "## ") {
			parseGitBranchLine(strings.TrimPrefix(line, "## "), &status)
			continue
		}
		if len(line) < 3 {
			continue
		}
		index, worktree := string(line[0]), string(line[1])
		path := strings.TrimSpace(line[3:])
		if arrow := strings.LastIndex(path, " -> "); arrow >= 0 {
			path = strings.TrimSpace(path[arrow+4:])
		}
		status.Files = append(status.Files, GitFileStatus{
			Path:     path,
			Index:    index,
			Worktree: worktree,
			Status:   gitStatusLabel(index, worktree),
			Managed:  isDiscardableKurloGitPath(workspaceRoot, status.Root, path),
		})
	}
	status.Clean = len(status.Files) == 0
	if status.Branch == "" {
		if branch, err := gitOutput(status.Root, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
			status.Branch = strings.TrimSpace(branch)
		}
	}
	status.Remotes = gitRemoteNamesForRoot(status.Root)
	status.PushRemote = defaultPushRemoteName(status.Upstream, status.Remotes)
	status.PushCommitCount = gitStatusPushCommitCount(status)
	status.Stashes = gitStashesForRoot(status.Root)
	return status
}

func gitInitWorkspaceForRoot(root string) GitOperationResult {
	workspaceRoot, err := normalizeExistingDir(root)
	if err != nil {
		return GitOperationResult{Ok: false, Error: friendlyWorkspaceRootError(err), Git: gitStatusForWorkspace(root)}
	}
	if !hasYAMLWorkspaceStore(workspaceRoot) {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(workspaceRoot), Error: "Current folder does not contain a Kurlo YAML workspace."}
	}
	status := gitStatusForWorkspace(workspaceRoot)
	if status.IsRepo {
		if err := ensureWorkspaceGitignore(workspaceRoot); err != nil {
			return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(workspaceRoot), Error: err.Error()}
		}
		return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(workspaceRoot), Output: "Already a Git repository."}
	}
	output, err := runGit(workspaceRoot, "init", "-b", "main")
	if err != nil {
		fallbackOutput, fallbackErr := runGit(workspaceRoot, "init")
		if fallbackErr == nil {
			output = fallbackOutput
			if currentBranch, berr := gitOutput(workspaceRoot, "branch", "--show-current"); berr == nil {
				if branch := strings.TrimSpace(currentBranch); branch != "" && branch != "main" {
					if renameOut, renameErr := runGit(workspaceRoot, "branch", "-m", "main"); renameErr == nil {
						output = appendGitOutput(output, renameOut)
					}
				}
			}
		} else {
			output = appendGitOutput(output, fallbackOutput)
		}
		err = fallbackErr
	}
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(workspaceRoot), Error: friendlyGitError("init", output, err), Output: output}
	}
	if err := ensureWorkspaceGitignore(workspaceRoot); err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(workspaceRoot), Error: err.Error(), Output: output}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(workspaceRoot), Output: output}
}

func gitAddRemoteForRoot(root, remoteName, remoteURL string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	name, err := cleanGitRemoteName(remoteName)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	url, err := cleanGitRemoteURL(remoteURL)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	_, getErr := gitOutput(status.Root, "remote", "get-url", name)
	args := []string{"remote", "add", name, url}
	action := "remote add"
	if getErr == nil {
		args = []string{"remote", "set-url", name, url}
		action = "remote set-url"
	}
	output, err := runGit(status.Root, args...)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError(action, output, err), Output: output}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
}

func gitTestRemoteForRoot(root, remoteNameOrURL string) GitOperationResult {
	status := gitStatusForWorkspace(root)
	dir := gitCommandDir(root)
	target := strings.TrimSpace(remoteNameOrURL)
	if target == "" && status.Upstream != "" {
		target = remoteNameFromUpstream(status.Upstream)
	}
	if target == "" {
		target = "origin"
	}
	if status.IsRepo && looksLikeGitRemoteName(target) {
		name, err := cleanGitRemoteName(target)
		if err != nil {
			return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
		}
		output, err := gitOutput(status.Root, "remote", "get-url", name)
		if err != nil {
			return GitOperationResult{Ok: false, Git: status, Error: friendlyGitError("remote get-url", output, err), Output: output}
		}
		target = strings.TrimSpace(output)
		dir = status.Root
	}
	url, err := cleanGitRemoteURL(target)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	output, err := runGit(dir, "ls-remote", "--heads", "--", url)
	if err != nil {
		failed := gitStatusForWorkspace(root)
		message := friendlyGitError("ls-remote", output, err)
		annotateGitAuthFailure(&failed, output+" "+message, url)
		return GitOperationResult{Ok: false, Git: failed, Error: message, Output: output}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: truncateRemoteTestOutput(output)}
}

func gitBranchesForRoot(root string) GitBranchListResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return GitBranchListResult{Ok: false, Git: status, Error: result.Error, Output: result.Output, LocalBranches: []GitBranchEntry{}, RemoteBranches: []GitBranchEntry{}}
	}
	local, output, err := localGitBranches(status.Root)
	if err != nil {
		return GitBranchListResult{Ok: false, Git: status, Error: friendlyGitError("branch list", output, err), Output: output, LocalBranches: []GitBranchEntry{}, RemoteBranches: []GitBranchEntry{}}
	}
	remote, remoteOutput, err := remoteGitBranches(status.Root)
	if err != nil {
		return GitBranchListResult{Ok: true, Git: status, Error: friendlyGitError("remote branch list", remoteOutput, err), Output: remoteOutput, Current: status.Branch, LocalBranches: local, RemoteBranches: []GitBranchEntry{}}
	}
	return GitBranchListResult{
		Ok:             true,
		Git:            status,
		Current:        status.Branch,
		LocalBranches:  local,
		RemoteBranches: remote,
	}
}

func gitCheckoutBranchForRoot(root, branchName string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	if !status.Clean {
		return GitOperationResult{Ok: false, Git: status, Error: "Commit or discard local Git changes before switching branches."}
	}
	branch, err := cleanGitBranchName(branchName)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	output, err := runGit(status.Root, "checkout", branch)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("checkout", output, err), Output: output}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
}

func gitCreateBranchForRoot(root, branchName, startPoint string) GitOperationResult {
	return gitCreateBranchForRootMode(root, branchName, startPoint, false)
}

func gitCreateTrackingBranchForRoot(root, branchName, startPoint string) GitOperationResult {
	return gitCreateBranchForRootMode(root, branchName, startPoint, true)
}

func gitCreateBranchForRootMode(root, branchName, startPoint string, trackRemote bool) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	branch, err := cleanGitBranchName(branchName)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	if localGitBranchExists(status.Root, branch) {
		return GitOperationResult{Ok: false, Git: status, Error: "Local branch " + branch + " already exists. Checkout it instead or choose another branch name."}
	}
	start := strings.TrimSpace(startPoint)
	var args []string
	if start == "" {
		args = []string{"checkout", "-b", branch}
	} else {
		if !status.Clean {
			return GitOperationResult{Ok: false, Git: status, Error: "Commit or discard local Git changes before creating a branch from another start point."}
		}
		cleanStart, err := cleanGitBranchName(start)
		if err != nil {
			return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
		}
		if remoteTrackingBranchExists(status.Root, cleanStart) {
			if trackRemote {
				args = []string{"checkout", "-b", branch, "--track", cleanStart}
			} else {
				args = []string{"checkout", "-b", branch, "--no-track", cleanStart}
			}
		} else {
			args = []string{"checkout", "-b", branch, cleanStart}
		}
	}
	output, err := runGit(status.Root, args...)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("branch create", output, err), Output: output}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
}

func gitDeleteBranchForRoot(root, branchName string, remote bool, force bool) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	if status.Operation != "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Finish or abort the current Git " + status.Operation + " before deleting branches."}
	}
	if remote {
		remoteName, branch, err := splitRemoteBranchName(branchName)
		if err != nil {
			return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
		}
		output, err := runGit(status.Root, "push", remoteName, "--delete", branch)
		if err != nil {
			if remoteBranchDeleteMissing(output) {
				if pruneOutput, pruneErr := runGit(status.Root, "branch", "-dr", remoteName+"/"+branch); pruneErr == nil {
					output = appendGitOutput(output, pruneOutput)
				}
				return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
			}
			return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("remote branch delete", output, err), Output: output}
		}
		if pruneOutput, pruneErr := runGit(status.Root, "branch", "-dr", remoteName+"/"+branch); pruneErr == nil {
			output = appendGitOutput(output, pruneOutput)
		}
		return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
	}
	branch, err := cleanGitBranchName(branchName)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	if branch == currentGitBranch(status.Root, status.Branch) {
		return GitOperationResult{Ok: false, Git: status, Error: "Cannot delete the current branch. Check out another branch first."}
	}
	deleteFlag := "-d"
	if force {
		deleteFlag = "-D"
	}
	output, err := runGit(status.Root, "branch", deleteFlag, branch)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("branch delete", output, err), Output: output}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
}

func gitRenameBranchForRoot(root, branchName, newName string, remote bool) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	if status.Operation != "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Finish or abort the current Git " + status.Operation + " before renaming branches."}
	}
	newBranch, err := cleanGitBranchName(newName)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	if remote {
		remoteName, oldBranch, err := splitRemoteBranchName(branchName)
		if err != nil {
			return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
		}
		if oldBranch == newBranch {
			return GitOperationResult{Ok: true, Git: status, Output: "Remote branch already uses that name."}
		}
		remoteRef := "refs/remotes/" + remoteName + "/" + oldBranch
		if gitRefHash(status.Root, remoteRef) == "" {
			return GitOperationResult{Ok: false, Git: status, Error: remoteName + "/" + oldBranch + " is not known locally. Fetch first, then try again."}
		}
		if gitRefHash(status.Root, "refs/remotes/"+remoteName+"/"+newBranch) != "" {
			return GitOperationResult{Ok: false, Git: status, Error: remoteName + "/" + newBranch + " already exists on the remote. Choose another name."}
		}
		pushOutput, err := runGit(status.Root, "push", remoteName, remoteRef+":refs/heads/"+newBranch)
		if err != nil {
			return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("remote branch rename push", pushOutput, err), Output: pushOutput}
		}
		deleteOutput, err := runGit(status.Root, "push", remoteName, "--delete", oldBranch)
		output := appendGitOutput(pushOutput, deleteOutput)
		if err != nil && !remoteBranchDeleteMissing(deleteOutput) {
			return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("remote branch rename cleanup", deleteOutput, err), Output: output}
		}
		if fetchOutput, fetchErr := runGit(status.Root, "fetch", "--prune", remoteName); fetchErr == nil {
			output = appendGitOutput(output, fetchOutput)
		}
		oldUpstream := remoteName + "/" + oldBranch
		newUpstream := remoteName + "/" + newBranch
		if locals, _, listErr := localGitBranches(status.Root); listErr == nil {
			for _, local := range locals {
				if local.Upstream != oldUpstream {
					continue
				}
				if setOutput, setErr := runGit(status.Root, "branch", "--set-upstream-to="+newUpstream, local.Name); setErr == nil {
					output = appendGitOutput(output, setOutput)
				}
			}
		}
		return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
	}
	oldBranch, err := cleanGitBranchName(branchName)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	if oldBranch == newBranch {
		return GitOperationResult{Ok: true, Git: status, Output: "Branch already uses that name."}
	}
	if !localGitBranchExists(status.Root, oldBranch) {
		return GitOperationResult{Ok: false, Git: status, Error: "Local branch " + oldBranch + " does not exist."}
	}
	if localGitBranchExists(status.Root, newBranch) {
		return GitOperationResult{Ok: false, Git: status, Error: "Local branch " + newBranch + " already exists. Choose another name."}
	}

	if oldBranch != currentGitBranch(status.Root, status.Branch) && gitBranchCheckedOutInAnotherWorktree(status.Root, oldBranch) {
		return GitOperationResult{Ok: false, Git: status, Error: "Branch " + oldBranch + " is checked out in another worktree. Rename it from that worktree instead."}
	}
	output, err := runGit(status.Root, "branch", "-m", oldBranch, newBranch)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("branch rename", output, err), Output: output}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
}

func remoteBranchDeleteMissing(output string) bool {
	value := strings.ToLower(output)
	return strings.Contains(value, "remote ref does not exist") ||
		strings.Contains(value, "not found") ||
		(strings.Contains(value, "unable to delete") && strings.Contains(value, "does not exist"))
}

func gitStageWorkspaceFilesForRoot(root string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	files := managedChangedGitPaths(root, status)
	if len(files) == 0 {
		return GitOperationResult{Ok: true, Git: status, Files: []string{}, Output: "No Kurlo workspace file changes to stage."}
	}
	args := append([]string{"add", "--"}, files...)
	output, err := runGit(status.Root, args...)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("add", output, err), Output: output, Files: files}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output, Files: files}
}

func gitCommitWorkspaceForRoot(root, message string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	if status.Operation != "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Finish, continue, or abort the current Git " + status.Operation + " before creating a normal commit."}
	}
	if err := validateWorkspaceStoreOnDisk(root); err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Commit message is required."}
	}
	staged, err := stagedGitFiles(status.Root)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	kurloFiles, otherFiles := partitionManagedGitPaths(root, status.Root, staged)
	if len(otherFiles) > 0 {
		return GitOperationResult{Ok: false, Git: status, Error: "Unstage non-Kurlo files before committing from Kurlo: " + strings.Join(otherFiles, ", "), Files: kurloFiles}
	}
	filesToStage := managedChangedGitPaths(root, status)
	if len(filesToStage) > 0 {
		addArgs := append([]string{"add", "--"}, filesToStage...)
		addOutput, addErr := runGit(status.Root, addArgs...)
		if addErr != nil {
			return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("add", addOutput, addErr), Output: addOutput, Files: filesToStage}
		}
	}
	staged, err = stagedGitFiles(status.Root)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: err.Error(), Files: filesToStage}
	}
	kurloFiles, otherFiles = partitionManagedGitPaths(root, status.Root, staged)
	if len(otherFiles) > 0 {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: "Unstage non-Kurlo files before committing from Kurlo: " + strings.Join(otherFiles, ", "), Files: kurloFiles}
	}
	if len(kurloFiles) == 0 {
		return GitOperationResult{Ok: false, Git: status, Error: "No Kurlo workspace changes to commit.", Files: []string{}}
	}
	output, err := runGit(status.Root, "commit", "-m", message)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("commit", output, err), Output: output, Files: kurloFiles}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output, Files: kurloFiles}
}

func gitCommitWorkspaceFilesForRoot(root string, paths []string, message string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	if status.Operation != "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Finish, continue, or abort the current Git " + status.Operation + " before creating a normal commit."}
	}
	if err := validateWorkspaceStoreOnDisk(root); err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Commit message is required."}
	}
	files, err := selectedManagedChangedGitPaths(root, status, paths)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	if len(files) == 0 {
		return GitOperationResult{Ok: false, Git: status, Error: "No selected Kurlo workspace changes to commit.", Files: []string{}}
	}
	addArgs := append([]string{"add", "--"}, files...)
	addOutput, addErr := runGit(status.Root, addArgs...)
	if addErr != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("add", addOutput, addErr), Output: addOutput, Files: files}
	}
	commitArgs := append([]string{"commit", "-m", message, "--"}, files...)
	output, err := runGit(status.Root, commitArgs...)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("commit", appendGitOutput(addOutput, output), err), Output: appendGitOutput(addOutput, output), Files: files}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: appendGitOutput(addOutput, output), Files: files}
}

func gitStashWorkspaceForRoot(root, message string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	if status.Operation != "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Finish or abort the current Git " + status.Operation + " before stashing."}
	}
	files := managedChangedGitPaths(root, status)
	if len(files) == 0 {
		return GitOperationResult{Ok: false, Git: status, Error: "No Kurlo workspace changes to stash.", Files: []string{}}
	}
	message = strings.TrimSpace(message)
	if message == "" {
		message = "Kurlo workspace changes"
	}
	args := append([]string{"stash", "push", "-u", "-m", message, "--"}, files...)
	output, err := runGit(status.Root, args...)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("stash", output, err), Output: output, Files: files}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output, Files: files}
}

func gitStashPopWorkspaceForRoot(root, ref string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	if status.Operation != "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Finish or abort the current Git " + status.Operation + " before applying a stash."}
	}
	ref = strings.TrimSpace(ref)
	if ref == "" {
		ref = "stash@{0}"
	}
	if !gitStashRefPattern.MatchString(ref) {
		return GitOperationResult{Ok: false, Git: status, Error: "Invalid Git stash reference."}
	}
	if len(status.Stashes) == 0 {
		return GitOperationResult{Ok: false, Git: status, Error: "No Git stashes to apply."}
	}
	output, err := runGit(status.Root, "stash", "pop", ref)
	if err != nil {
		next := gitStatusForWorkspace(root)
		message := friendlyGitError("stash pop", output, err)
		if hasConflictedFiles(next) {
			message = "Applying the stash stopped with conflicts. Resolve the conflicted Kurlo files, then continue or abort the Git operation."
		}
		return GitOperationResult{Ok: false, Git: next, Error: message, Output: output}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
}

func gitPushWorkspaceForRoot(root, remoteName string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	if status.Operation != "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Finish or abort the current Git " + status.Operation + " before pushing."}
	}
	name, err := cleanGitRemoteName(remoteName)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	branch := currentGitBranch(status.Root, status.Branch)
	if branch == "" || branch == "HEAD" {
		return GitOperationResult{Ok: false, Git: status, Error: "Current Git branch could not be determined."}
	}

	var fetchOutput string
	if status.Upstream != "" && !status.UpstreamGone {
		if out, fetchErr := runGit(status.Root, "fetch", name); fetchErr != nil {
			return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("fetch", out, fetchErr), Output: out}
		} else {
			fetchOutput = out
		}
		status = gitStatusForWorkspace(root)
		if status.Behind > 0 {
			return GitOperationResult{
				Ok:     false,
				Git:    status,
				Error:  fmt.Sprintf("Remote has %d new commit(s). Pull (or rebase) before pushing, or use Force push if you intentionally want to overwrite the remote.", status.Behind),
				Output: fetchOutput,
			}
		}
		if status.Ahead == 0 {
			return GitOperationResult{Ok: true, Git: status, Output: appendGitOutput(fetchOutput, "Nothing to push: local branch is already up to date with "+status.Upstream+".")}
		}
	}

	pushBase := status.Upstream
	if pushBase == "" || status.UpstreamGone {
		pushBase = bestRemoteBaseForPush(status.Root, name, branch)
	}
	pushSummary := gitPullSummaryForRange(status.Root, pushBase, "HEAD")
	pushCommitCount := gitPushCommitCount(status.Root, pushBase, name)

	var output string
	if status.Upstream != "" && !status.UpstreamGone {
		output, err = runGit(status.Root, "push")
	} else {
		output, err = runGit(status.Root, "push", "-u", name, branch)
	}
	if err != nil {
		combined := appendGitOutput(fetchOutput, output)
		if pushUpstreamNameMismatch(combined) {
			return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: pushUpstreamNameMismatchMessage(branch, status.Upstream), Output: combined, PullSummary: pushSummary, CommitCount: pushCommitCount}
		}
		failed := gitStatusForWorkspace(root)
		message := friendlyGitError("push", combined, err)
		annotateGitAuthFailure(&failed, combined+" "+message, gitRemoteURLForRoot(status.Root, name))
		return GitOperationResult{Ok: false, Git: failed, Error: message, Output: combined, PullSummary: pushSummary, CommitCount: pushCommitCount}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: appendGitOutput(fetchOutput, output), PullSummary: pushSummary, CommitCount: pushCommitCount}
}

func pushUpstreamNameMismatch(output string) bool {

	normalized := strings.Join(strings.Fields(strings.ToLower(output)), " ")
	return strings.Contains(normalized, "does not match the name of your current branch")
}

func pushUpstreamNameMismatchMessage(localBranch, upstream string) string {
	localBranch = strings.TrimSpace(localBranch)
	upstream = strings.TrimSpace(upstream)
	remoteBranch := upstream
	if i := strings.Index(upstream, "/"); i >= 0 && i+1 < len(upstream) {
		remoteBranch = upstream[i+1:]
	}
	return "\"" + localBranch + "\" was renamed locally but still tracks " + upstream +
		", so Git won't push mismatched names. Fix: branch menu → \"Rename (remote)\" to rename it on the remote too, " +
		"or delete the old remote branch \"" + remoteBranch + "\" and push to publish \"" + localBranch + "\" anew."
}

func gitForcePushWorkspaceForRoot(root, remoteName string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	if status.Operation != "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Finish or abort the current Git " + status.Operation + " before force pushing."}
	}
	if _, err := cleanGitRemoteName(remoteName); err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	branch := currentGitBranch(status.Root, status.Branch)
	if branch == "" || branch == "HEAD" {
		return GitOperationResult{Ok: false, Git: status, Error: "Current Git branch could not be determined."}
	}
	if status.Upstream == "" {
		return GitOperationResult{Ok: false, Git: status, Error: "Cannot force push without an upstream. Push normally first to establish tracking before force pushing."}
	}
	output, err := runGit(status.Root, "push", "--force-with-lease", "--force-if-includes")
	if err != nil && strings.Contains(output, "force-if-includes") && strings.Contains(strings.ToLower(output), "unknown option") {
		output, err = runGit(status.Root, "push", "--force-with-lease")
	}
	if err != nil {
		failed := gitStatusForWorkspace(root)
		message := friendlyGitError("force push", output, err)
		annotateGitAuthFailure(&failed, output+" "+message, gitRemoteURLForRoot(status.Root, remoteName))
		return GitOperationResult{Ok: false, Git: failed, Error: message, Output: output}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
}

func gitDiscardWorkspaceFileForRoot(root, path string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	relPath, err := cleanGitRelativePath(path)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	if !isDiscardableKurloGitPath(root, status.Root, relPath) {
		return GitOperationResult{Ok: false, Git: status, Error: "Kurlo can only discard Kurlo workspace files and Kurlo-generated reports."}
	}
	if !gitChangedPathExists(status.Files, relPath) {
		return GitOperationResult{Ok: true, Git: status, Output: "No local changes for " + relPath + ".", Files: []string{}}
	}
	hasHead := gitRepositoryHasHead(status.Root)
	files := []string{relPath}
	if hasHead {
		files = expandDiscardGitPathsWithRequestIndexes(status.Files, files)
	}
	if !hasHead && relPath == fileStoreRootIndex {
		return GitOperationResult{Ok: false, Git: status, Error: "No committed baseline to restore from. Commit the initial workspace before using discard."}
	}
	output, err := discardGitPaths(status.Root, status.Files, files)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("discard", output, err), Output: output, Files: files}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output, Files: files}
}

func gitDiscardWorkspaceChangesForRoot(root string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	files := discardableChangedGitPaths(root, status)
	if len(files) == 0 {
		return GitOperationResult{Ok: true, Git: status, Output: "No Kurlo workspace changes to discard.", Files: []string{}}
	}
	if !gitRepositoryHasHead(status.Root) {
		return GitOperationResult{Ok: false, Git: status, Error: "No committed baseline to restore from. Commit the initial workspace before using discard.", Files: files}
	}
	output, err := discardGitPaths(status.Root, status.Files, files)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("discard", output, err), Output: output, Files: files}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output, Files: files}
}

func gitDiscardWorkspaceFilesForRoot(root string, paths []string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	files, err := selectedDiscardableChangedGitPaths(root, status, paths)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	if len(files) == 0 {
		return GitOperationResult{Ok: true, Git: status, Output: "No selected Kurlo workspace changes to discard.", Files: []string{}}
	}
	hasHead := gitRepositoryHasHead(status.Root)
	if hasHead {
		files = expandDiscardGitPathsWithRequestIndexes(status.Files, files)
	}
	if !hasHead && containsGitPath(files, fileStoreRootIndex) {
		return GitOperationResult{Ok: false, Git: status, Error: "No committed baseline to restore from. Commit the initial workspace before using discard.", Files: files}
	}
	output, err := discardGitPaths(status.Root, status.Files, files)
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("discard", output, err), Output: output, Files: files}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output, Files: files}
}

func gitDiffForWorkspace(workspaceRoot, path string) GitDiffResult {
	status := gitStatusForWorkspace(workspaceRoot)
	if !status.IsRepo || status.Root == "" {
		return GitDiffResult{Path: path, Error: "Current workspace is not inside a Git repository."}
	}
	relPath, err := cleanGitRelativePath(path)
	if err != nil {
		return GitDiffResult{Path: path, Error: err.Error()}
	}
	var sections []string
	stagedDiff := ""
	unstagedDiff := ""
	if staged, err := gitOutput(status.Root, "diff", "--cached", "--", relPath); err == nil && strings.TrimSpace(staged) != "" {
		stagedDiff = strings.TrimSpace(normalizeGitDiffPaths(status.Root, staged))
		sections = append(sections, staged)
	}
	if unstaged, err := gitOutput(status.Root, "diff", "--", relPath); err == nil && strings.TrimSpace(unstaged) != "" {
		unstagedDiff = strings.TrimSpace(normalizeGitDiffPaths(status.Root, unstaged))
		sections = append(sections, unstaged)
	}
	if len(sections) == 0 && gitStatusForPath(status.Files, relPath) == "untracked" {
		absolutePath := filepath.Join(status.Root, filepath.FromSlash(relPath))
		if untracked, err := gitOutputAllowExit(status.Root, "diff", "--no-index", "--", os.DevNull, absolutePath); err == nil || strings.TrimSpace(untracked) != "" {
			unstagedDiff = strings.TrimSpace(normalizeGitDiffPaths(status.Root, untracked))
			sections = append(sections, untracked)
		}
	}
	diff := strings.TrimSpace(strings.Join(sections, "\n"))
	diff = normalizeGitDiffPaths(status.Root, diff)
	stagedDiff, stagedTruncated := truncateGitOutput(stagedDiff, maxGitDiffBytes)
	unstagedDiff, unstagedTruncated := truncateGitOutput(unstagedDiff, maxGitDiffBytes)
	diff, truncated := truncateGitOutput(diff, maxGitDiffBytes)
	return GitDiffResult{
		Path:         relPath,
		Diff:         diff,
		StagedDiff:   stagedDiff,
		UnstagedDiff: unstagedDiff,
		Binary:       strings.Contains(diff, "Binary files ") || strings.Contains(diff, "GIT binary patch"),
		Truncated:    truncated || stagedTruncated || unstagedTruncated,
	}
}

func gitOutgoingChangesForWorkspace(workspaceRoot string) GitDiffResult {
	const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
	const resultPath = "Outgoing changes"

	status := gitStatusForWorkspace(workspaceRoot)
	if !status.IsRepo || status.Root == "" {
		return GitDiffResult{Path: resultPath, Error: "Current workspace is not inside a Git repository."}
	}
	if _, err := gitOutput(status.Root, "rev-parse", "--verify", "HEAD"); err != nil {
		return GitDiffResult{Path: resultPath, Diff: "No commits yet. Commit Kurlo workspace files before pushing."}
	}

	pathspecs := managedWorkspaceGitPathspecs(workspaceRoot, status.Root)

	baseRef := ""
	if status.Upstream != "" && !status.UpstreamGone {
		baseRef = status.Upstream
	} else {
		remoteName := status.PushRemote
		if remoteName == "" {
			remoteName = defaultPushRemoteName(status.Upstream, status.Remotes)
		}
		baseRef = bestRemoteBaseForPush(status.Root, remoteName, status.Branch)
	}

	var patchOutput string
	var err error
	if baseRef != "" {
		diffArgs := append([]string{"diff", baseRef + "..HEAD", "--"}, pathspecs...)
		if patchOutput, err = gitOutput(status.Root, diffArgs...); err != nil {
			return GitDiffResult{Path: resultPath, Error: friendlyGitError("diff outgoing changes", patchOutput, err)}
		}
	} else {
		diffArgs := append([]string{"diff", emptyTree, "HEAD", "--"}, pathspecs...)
		if patchOutput, err = gitOutput(status.Root, diffArgs...); err != nil {
			return GitDiffResult{Path: resultPath, Error: friendlyGitError("diff outgoing changes", patchOutput, err)}
		}
	}

	patchOutput = strings.TrimSpace(patchOutput)
	if patchOutput == "" {
		message := "No committed Kurlo workspace changes to push."
		if baseRef != "" {
			message = "No committed Kurlo workspace changes ahead of " + baseRef + "."
		}
		return GitDiffResult{Path: resultPath, Diff: message}
	}

	diff, truncated := truncateGitOutput(patchOutput, maxGitDiffBytes)
	return GitDiffResult{
		Path:      resultPath,
		Diff:      diff,
		Binary:    strings.Contains(diff, "Binary files ") || strings.Contains(diff, "GIT binary patch"),
		Truncated: truncated,
	}
}

func gitCommitLogForRoot(root string, limit int) GitLogResult {
	return gitCommitLogPageForRoot(root, limit, 0)
}

func gitCommitLogPageForRoot(root string, limit, offset int) GitLogResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return GitLogResult{Ok: false, Git: status, Error: result.Error, Output: result.Output, Commits: []GitCommitEntry{}}
	}
	if !gitRepositoryHasHead(status.Root) {
		return GitLogResult{Ok: true, Git: status, Commits: []GitCommitEntry{}, Limit: normalizeGitLogLimit(limit), Offset: normalizeGitLogOffset(offset)}
	}
	limit = normalizeGitLogLimit(limit)
	offset = normalizeGitLogOffset(offset)
	pathspecs := managedWorkspaceGitPathspecs(root, status.Root)
	revision := "HEAD"
	if status.Branch != "" && status.Branch != "HEAD" {
		revision = status.Branch
	}
	args := append([]string{
		"log",
		revision,
		"-n", strconv.Itoa(limit + 1),
		"--skip", strconv.Itoa(offset),
		"--date=iso-strict",
		"--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s",
		"--",
	}, pathspecs...)
	output, err := gitOutput(status.Root, args...)
	if err != nil {
		return GitLogResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("log", output, err), Output: output, Commits: []GitCommitEntry{}}
	}
	commits := []GitCommitEntry{}
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\x1f", 5)
		if len(parts) != 5 {
			continue
		}
		commits = append(commits, GitCommitEntry{
			Hash:      strings.TrimSpace(parts[0]),
			ShortHash: strings.TrimSpace(parts[1]),
			Author:    strings.TrimSpace(parts[2]),
			Date:      strings.TrimSpace(parts[3]),
			Message:   strings.TrimSpace(parts[4]),
		})
	}
	hasMore := len(commits) > limit
	if hasMore {
		commits = commits[:limit]
	}
	return GitLogResult{Ok: true, Git: gitStatusForWorkspace(root), Commits: commits, Limit: limit, Offset: offset, HasMore: hasMore, Output: output}
}

func gitCommitDiffForRoot(root, commit string) GitDiffResult {
	const resultPath = "Commit diff"

	status := gitStatusForWorkspace(root)
	if !status.IsRepo || status.Root == "" {
		return GitDiffResult{Path: resultPath, Error: "Current workspace is not inside a Git repository."}
	}
	commit = strings.TrimSpace(commit)
	if strings.HasPrefix(commit, "-") || !gitCommitHashPattern.MatchString(commit) {
		return GitDiffResult{Path: resultPath, Error: "Invalid Git commit hash."}
	}
	verifyOutput, verifyErr := gitOutput(status.Root, "cat-file", "-e", commit+"^{commit}")
	if verifyErr != nil {
		return GitDiffResult{Path: resultPath, Error: friendlyGitError("commit lookup", verifyOutput, verifyErr)}
	}
	pathspecs := managedWorkspaceGitPathspecs(root, status.Root)
	args := append([]string{"show", "--format=", "--patch", commit, "--"}, pathspecs...)
	output, err := gitOutput(status.Root, args...)
	if err != nil {
		return GitDiffResult{Path: resultPath, Error: friendlyGitError("commit diff", output, err)}
	}
	diff := strings.TrimSpace(normalizeGitDiffPaths(status.Root, output))
	if diff == "" {
		diff = "No Kurlo workspace changes in this commit."
	}
	diff, truncated := truncateGitOutput(diff, maxGitDiffBytes)
	return GitDiffResult{
		Path:      resultPath,
		Diff:      diff,
		Binary:    strings.Contains(diff, "Binary files ") || strings.Contains(diff, "GIT binary patch"),
		Truncated: truncated,
	}
}

func gitConflictFileForRoot(root, path string) GitConflictFileResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return GitConflictFileResult{Ok: false, Git: status, Error: result.Error, Output: result.Output}
	}
	relPath, err := cleanGitRelativePath(path)
	if err != nil {
		return GitConflictFileResult{Ok: false, Git: status, Error: err.Error()}
	}
	if !isManagedWorkspaceGitPath(root, status.Root, relPath) {
		return GitConflictFileResult{Ok: false, Git: status, Path: relPath, Error: "Kurlo can only resolve Kurlo workspace files."}
	}
	if gitStatusForPath(status.Files, relPath) != "conflicted" {
		return GitConflictFileResult{Ok: false, Git: status, Path: relPath, Error: "Selected file is not conflicted."}
	}
	absolutePath, err := safeRepoRelativeFilePath(status.Root, relPath)
	if err != nil {
		return GitConflictFileResult{Ok: false, Git: status, Path: relPath, Error: err.Error()}
	}
	data, err := os.ReadFile(absolutePath)
	if err != nil {
		return GitConflictFileResult{Ok: false, Git: status, Path: relPath, Error: err.Error()}
	}
	if !utf8.Valid(data) {
		return GitConflictFileResult{Ok: true, Git: status, Path: relPath, Binary: true, Content: ""}
	}
	content, truncated := truncateGitOutput(gitConflictContentForSemanticSides(string(data), status), maxGitDiffBytes)
	oursContent, oursAvailable, oursTruncated := gitConflictStageContent(status.Root, relPath, gitConflictStageForSemanticSide(status, "ours"))
	theirsContent, theirsAvailable, theirsTruncated := gitConflictStageContent(status.Root, relPath, gitConflictStageForSemanticSide(status, "theirs"))
	return GitConflictFileResult{
		Ok:              true,
		Git:             status,
		Path:            relPath,
		Content:         content,
		OursContent:     oursContent,
		TheirsContent:   theirsContent,
		OursAvailable:   oursAvailable,
		TheirsAvailable: theirsAvailable,
		Truncated:       truncated,
		OursTruncated:   oursTruncated,
		TheirsTruncated: theirsTruncated,
	}
}

func gitResolveConflictFileForRoot(root, path, resolution, content string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	relPath, err := cleanGitRelativePath(path)
	if err != nil {
		return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
	}
	if !isManagedWorkspaceGitPath(root, status.Root, relPath) {
		return GitOperationResult{Ok: false, Git: status, Error: "Kurlo can only resolve Kurlo workspace files."}
	}
	if gitStatusForPath(status.Files, relPath) != "conflicted" {
		return GitOperationResult{Ok: false, Git: status, Error: "Selected file is not conflicted.", Files: []string{relPath}}
	}
	resolution = strings.TrimSpace(strings.ToLower(resolution))
	var output string
	alreadyStaged := false
	switch resolution {
	case "ours":
		var err error
		stage := gitConflictStageForSemanticSide(status, "ours")
		if gitConflictStageAvailable(status.Root, relPath, stage) {
			output, err = writeGitConflictStageToWorktree(status.Root, relPath, stage)
			if err != nil {
				return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("checkout conflict side", output, err), Output: output, Files: []string{relPath}}
			}
		} else {
			absolutePath, pathErr := safeRepoRelativeFilePath(status.Root, relPath)
			if pathErr != nil {
				return GitOperationResult{Ok: false, Git: status, Error: pathErr.Error(), Files: []string{relPath}}
			}
			if removeErr := os.Remove(absolutePath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				return GitOperationResult{Ok: false, Git: status, Error: removeErr.Error(), Files: []string{relPath}}
			}
			output, err = runGit(status.Root, "rm", "--cached", "--ignore-unmatch", "--", relPath)
			if err != nil {
				return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("rm --ours", output, err), Output: output, Files: []string{relPath}}
			}
			alreadyStaged = true
		}
	case "theirs":
		var err error
		stage := gitConflictStageForSemanticSide(status, "theirs")
		if gitConflictStageAvailable(status.Root, relPath, stage) {
			output, err = writeGitConflictStageToWorktree(status.Root, relPath, stage)
			if err != nil {
				return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("checkout conflict side", output, err), Output: output, Files: []string{relPath}}
			}
		} else {
			absolutePath, pathErr := safeRepoRelativeFilePath(status.Root, relPath)
			if pathErr != nil {
				return GitOperationResult{Ok: false, Git: status, Error: pathErr.Error(), Files: []string{relPath}}
			}
			if removeErr := os.Remove(absolutePath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				return GitOperationResult{Ok: false, Git: status, Error: removeErr.Error(), Files: []string{relPath}}
			}
			output, err = runGit(status.Root, "rm", "--cached", "--ignore-unmatch", "--", relPath)
			if err != nil {
				return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("rm --theirs", output, err), Output: output, Files: []string{relPath}}
			}
			alreadyStaged = true
		}
	case "manual", "content":
		if containsGitConflictMarkers(content) {
			return GitOperationResult{Ok: false, Git: status, Error: "Resolve all Git conflict markers before marking this file resolved.", Files: []string{relPath}}
		}
		if filepath.Ext(relPath) == fileStoreYAMLExt || filepath.Ext(relPath) == ".yaml" {
			var parsed any
			if err := yaml.Unmarshal([]byte(content), &parsed); err != nil {
				return GitOperationResult{Ok: false, Git: status, Error: "Resolved YAML is invalid: " + err.Error(), Files: []string{relPath}}
			}
		}
		absolutePath, err := safeRepoRelativeFilePath(status.Root, relPath)
		if err != nil {
			return GitOperationResult{Ok: false, Git: status, Error: err.Error(), Files: []string{relPath}}
		}
		if err := os.WriteFile(absolutePath, []byte(content), 0644); err != nil {
			return GitOperationResult{Ok: false, Git: status, Error: err.Error(), Files: []string{relPath}}
		}
	case "mark":
	default:
		return GitOperationResult{Ok: false, Git: status, Error: "Unknown conflict resolution.", Files: []string{relPath}}
	}
	if !alreadyStaged {
		addOutput, addErr := runGit(status.Root, "add", "-A", "--", relPath)
		output = appendGitOutput(output, addOutput)
		if addErr != nil {
			return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("add resolved file", output, addErr), Output: output, Files: []string{relPath}}
		}
	}
	if gitResolvedConflictShouldStayLocal(status) {
		resetOutput, resetErr := runGit(status.Root, "reset", "--", relPath)
		output = appendGitOutput(output, resetOutput)
		if resetErr != nil {
			return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError("unstage resolved file", output, resetErr), Output: output, Files: []string{relPath}}
		}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output, Files: []string{relPath}}
}

func gitConflictStageForSemanticSide(status GitWorkspaceStatus, side string) int {
	if status.Operation == "rebase" || status.Operation == "" {
		if side == "ours" {
			return 3
		}
		return 2
	}
	if side == "ours" {
		return 2
	}
	return 3
}

func gitConflictContentForSemanticSides(content string, status GitWorkspaceStatus) string {
	if gitConflictStageForSemanticSide(status, "ours") == 2 {
		return content
	}
	return swapGitConflictMarkerSides(content)
}

func swapGitConflictMarkerSides(content string) string {
	lines := strings.Split(content, "\n")
	result := make([]string, 0, len(lines))
	for lineIndex := 0; lineIndex < len(lines); lineIndex++ {
		line := lines[lineIndex]
		if !strings.HasPrefix(line, "<<<<<<<") {
			result = append(result, line)
			continue
		}
		start := lineIndex
		separator := -1
		end := -1
		for scan := start + 1; scan < len(lines); scan++ {
			if separator < 0 && strings.HasPrefix(lines[scan], "=======") {
				separator = scan
				continue
			}
			if separator >= 0 && strings.HasPrefix(lines[scan], ">>>>>>>") {
				end = scan
				break
			}
		}
		if separator < 0 || end < 0 {
			result = append(result, line)
			continue
		}
		result = append(result, "<<<<<<< local")
		result = append(result, lines[separator+1:end]...)
		result = append(result, "=======")
		result = append(result, lines[start+1:separator]...)
		result = append(result, ">>>>>>> remote")
		lineIndex = end
	}
	return strings.Join(result, "\n")
}

func gitResolvedConflictShouldStayLocal(status GitWorkspaceStatus) bool {
	return status.Operation == ""
}

func writeGitConflictStageToWorktree(repoRoot, relPath string, stage int) (string, error) {
	content, err := gitOutput(repoRoot, "show", fmt.Sprintf(":%d:%s", stage, relPath))
	if err != nil {
		return content, err
	}
	absolutePath, err := safeRepoRelativeFilePath(repoRoot, relPath)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(absolutePath), 0755); err != nil {
		return "", err
	}
	return "", os.WriteFile(absolutePath, []byte(content), 0644)
}

func gitConflictStageContent(repoRoot, relPath string, stage int) (string, bool, bool) {
	output, err := gitOutput(repoRoot, "show", fmt.Sprintf(":%d:%s", stage, relPath))
	if err != nil || !utf8.ValidString(output) {
		return "", false, false
	}
	content, truncated := truncateGitOutput(output, maxGitDiffBytes)
	return content, true, truncated
}

func gitConflictStageAvailable(repoRoot, relPath string, stage int) bool {
	_, err := gitOutput(repoRoot, "show", fmt.Sprintf(":%d:%s", stage, relPath))
	return err == nil
}

func containsGitConflictMarkers(content string) bool {
	for _, line := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		if strings.HasPrefix(line, "<<<<<<< ") || strings.HasPrefix(line, "=======") || strings.HasPrefix(line, ">>>>>>> ") {
			return true
		}
	}
	return false
}

func gitContinueOperationForRoot(root, message string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	switch status.Operation {
	case "merge":
		message = strings.TrimSpace(message)
		if message == "" {
			message = "Merge Kurlo workspace"
		}
		staged, err := stagedGitFiles(status.Root)
		if err != nil {
			return GitOperationResult{Ok: false, Git: status, Error: err.Error()}
		}
		_, otherFiles := partitionManagedGitPaths(root, status.Root, staged)
		if len(otherFiles) > 0 {
			return GitOperationResult{Ok: false, Git: status, Error: "Unstage non-Kurlo files before continuing the merge: " + strings.Join(otherFiles, ", ")}
		}
		output, err := runGit(status.Root, "commit", "-m", message)
		if err != nil {
			next := gitStatusForWorkspace(root)
			return GitOperationResult{Ok: false, Git: next, Error: friendlyGitError("merge continue", output, err), Output: output}
		}
		return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
	case "rebase":
		output, err := runGit(status.Root, "-c", "core.editor=true", "rebase", "--continue")
		if err != nil {
			next := gitStatusForWorkspace(root)
			return GitOperationResult{Ok: false, Git: next, Error: friendlyGitError("rebase continue", output, err), Output: output}
		}
		return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
	default:
		return GitOperationResult{Ok: false, Git: status, Error: "There is no Git merge or rebase operation to continue."}
	}
}

func gitAbortOperationForRoot(root string) GitOperationResult {
	status, result, ok := requireGitWorkspace(root)
	if !ok {
		return result
	}
	var output string
	var err error
	switch status.Operation {
	case "merge":
		output, err = runGit(status.Root, "merge", "--abort")
	case "rebase":
		output, err = runGit(status.Root, "rebase", "--abort")
	default:
		return GitOperationResult{Ok: false, Git: status, Error: "There is no Git merge or rebase operation to abort."}
	}
	if err != nil {
		return GitOperationResult{Ok: false, Git: gitStatusForWorkspace(root), Error: friendlyGitError(status.Operation+" abort", output, err), Output: output}
	}
	return GitOperationResult{Ok: true, Git: gitStatusForWorkspace(root), Output: output}
}

func runGit(dir string, args ...string) (string, error) { return gitOutput(dir, args...) }

func gitOutput(dir string, args ...string) (string, error) {
	return gitOutputWithExitPolicy(false, dir, args...)
}

func gitOutputAllowExit(dir string, args ...string) (string, error) {
	return gitOutputWithExitPolicy(true, dir, args...)
}

func gitOutputWithExitPolicy(allowExit bool, dir string, args ...string) (string, error) {
	return gitRun(allowExit, dir, nil, args...)
}

func gitOutputEnv(dir string, extraEnv []string, args ...string) (string, error) {
	return gitRun(false, dir, extraEnv, args...)
}

func gitRun(allowExit bool, dir string, extraEnv []string, args ...string) (string, error) {
	if strings.TrimSpace(dir) == "" {
		return "", fmt.Errorf("workspace path is empty")
	}
	gitPath, lookErr := lookupGitExecutable()
	if lookErr != nil {
		return "", lookErr
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitCommandTimeout)
	defer cancel()
	prefix := []string{"-c", "core.quotePath=false", "-C", dir}
	prefix = append(prefix, gitAuthGlobalArgs()...)
	fullArgs := append(prefix, args...)
	cmd := exec.CommandContext(ctx, gitPath, fullArgs...)
	hideCmdWindow(cmd)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", "GIT_MERGE_AUTOEDIT=no")
	cmd.Env = append(cmd.Env, gitAuthEnvVars(dir)...)
	cmd.Env = append(cmd.Env, extraEnv...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	output := strings.TrimSpace(out.String())
	if ctx.Err() == context.DeadlineExceeded {
		return output, fmt.Errorf("git command timed out")
	}
	if allowExit {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return output, nil
		}
	}
	return output, err
}

func parseGitBranchLine(line string, status *GitWorkspaceStatus) {
	if line == "" {
		return
	}
	if strings.HasPrefix(line, "No commits yet on ") {
		parseGitBranchTrackingLine(strings.TrimSpace(strings.TrimPrefix(line, "No commits yet on ")), status)
		return
	}
	if strings.HasPrefix(line, "HEAD ") {
		status.Branch = "HEAD"
		return
	}
	parseGitBranchTrackingLine(line, status)
}

func parseGitBranchTrackingLine(line string, status *GitWorkspaceStatus) {
	if parts := strings.SplitN(line, "...", 2); len(parts) == 2 {
		status.Branch = strings.TrimSpace(parts[0])
		upstream := strings.TrimSpace(parts[1])
		if bracket := strings.Index(upstream, " ["); bracket >= 0 {
			status.Upstream = strings.TrimSpace(upstream[:bracket])
			parseBranchTrackingStateInto(strings.TrimSuffix(upstream[bracket+2:], "]"), status)
		} else if upstream != "" {
			status.Upstream = upstream
		}
		return
	}
	branchPart := line
	if bracket := strings.Index(branchPart, " ["); bracket >= 0 {
		parseBranchTrackingStateInto(strings.TrimSuffix(branchPart[bracket+2:], "]"), status)
		branchPart = branchPart[:bracket]
	}
	status.Branch = strings.TrimSpace(branchPart)
}

func remoteNameFromUpstream(upstream string) string {
	value := strings.TrimSpace(upstream)
	if slash := strings.Index(value, "/"); slash > 0 {
		return value[:slash]
	}
	return "origin"
}

func gitRemoteNamesForRoot(repoRoot string) []string {
	output, err := gitOutput(repoRoot, "remote")
	if err != nil {
		return []string{}
	}
	var names []string
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		name := strings.TrimSpace(line)
		if name != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func defaultPushRemoteName(upstream string, remotes []string) string {
	if strings.TrimSpace(upstream) != "" {
		return remoteNameFromUpstream(upstream)
	}
	for _, remote := range remotes {
		if remote == "origin" {
			return remote
		}
	}
	if len(remotes) > 0 {
		return remotes[0]
	}
	return "origin"
}

func gitStatusPushCommitCount(status GitWorkspaceStatus) int {
	if !status.IsRepo || status.Root == "" || status.Branch == "" || status.Branch == "HEAD" {
		return 0
	}
	if status.Upstream != "" && !status.UpstreamGone {
		return status.Ahead
	}
	remoteName := status.PushRemote
	if remoteName == "" {
		remoteName = defaultPushRemoteName(status.Upstream, status.Remotes)
	}
	baseRef := bestRemoteBaseForPush(status.Root, remoteName, status.Branch)
	return gitPushCommitCount(status.Root, baseRef, remoteName)
}

func splitRemoteBranchName(fullName string) (string, string, error) {
	value := strings.TrimSpace(fullName)
	slash := strings.Index(value, "/")
	if slash <= 0 || slash == len(value)-1 {
		return "", "", fmt.Errorf("remote branch must look like remote/name")
	}
	remoteName, err := cleanGitRemoteName(value[:slash])
	if err != nil {
		return "", "", err
	}
	branch, err := cleanGitBranchName(value[slash+1:])
	if err != nil {
		return "", "", err
	}
	return remoteName, branch, nil
}

func localGitBranches(repoRoot string) ([]GitBranchEntry, string, error) {
	output, err := gitOutput(repoRoot, "for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(HEAD)", "refs/heads")
	if err != nil {
		return []GitBranchEntry{}, output, err
	}
	var branches []GitBranchEntry
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		name := strings.TrimSpace(parts[0])
		if name == "" {
			continue
		}
		entry := GitBranchEntry{Name: name, FullName: name}
		if len(parts) > 1 {
			entry.Upstream = strings.TrimSpace(parts[1])
		}
		if len(parts) > 2 {
			entry.Current = strings.TrimSpace(parts[2]) == "*"
		}
		branches = append(branches, entry)
	}
	sort.Slice(branches, func(i, j int) bool {
		return branches[i].Name < branches[j].Name
	})
	return branches, output, nil
}

func remoteGitBranches(repoRoot string) ([]GitBranchEntry, string, error) {
	output, err := gitOutput(repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/remotes")
	if err != nil {
		return []GitBranchEntry{}, output, err
	}
	var branches []GitBranchEntry
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		fullName := strings.TrimSpace(line)
		if fullName == "" || strings.HasSuffix(fullName, "/HEAD") {
			continue
		}
		remote := remoteNameFromUpstream(fullName)
		name := strings.TrimPrefix(fullName, remote+"/")
		branches = append(branches, GitBranchEntry{Name: name, FullName: fullName, Remote: remote})
	}
	sort.Slice(branches, func(i, j int) bool {
		return branches[i].FullName < branches[j].FullName
	})
	return branches, output, nil
}

func remoteRefsForName(repoRoot, remoteName string) []string {
	remoteName = strings.TrimSpace(remoteName)
	if remoteName == "" {
		return nil
	}
	output, err := gitOutput(repoRoot, "for-each-ref", "--format=%(refname)", "refs/remotes/"+remoteName)
	if err != nil {
		return nil
	}
	var refs []string
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		ref := strings.TrimSpace(line)
		if ref != "" && !strings.HasSuffix(ref, "/HEAD") {
			refs = append(refs, ref)
		}
	}
	return refs
}

func bestRemoteBaseForPush(repoRoot, remoteName, branch string) string {
	remoteBranch := strings.TrimSpace(remoteName) + "/" + strings.TrimSpace(branch)
	if strings.Trim(remoteBranch, "/") != "" && remoteTrackingBranchExists(repoRoot, remoteBranch) {
		return remoteBranch
	}
	refs := remoteRefsForName(repoRoot, remoteName)
	if len(refs) == 0 {
		return ""
	}
	args := append([]string{"merge-base", "HEAD"}, refs...)
	output, err := gitOutput(repoRoot, args...)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(output)
}

func gitPushCommitCount(repoRoot, baseRef, remoteName string) int {
	baseRef = strings.TrimSpace(baseRef)
	var output string
	var err error
	if baseRef != "" {
		output, err = gitOutput(repoRoot, "rev-list", "--count", baseRef+"..HEAD")
	} else if refs := remoteRefsForName(repoRoot, remoteName); len(refs) > 0 {
		args := append([]string{"rev-list", "--count", "HEAD", "--not"}, refs...)
		output, err = gitOutput(repoRoot, args...)
	} else {
		output, err = gitOutput(repoRoot, "rev-list", "--count", "HEAD")
	}
	if err != nil {
		return 0
	}
	count, err := strconv.Atoi(strings.TrimSpace(output))
	if err != nil || count < 0 {
		return 0
	}
	return count
}

func parseAheadBehind(value string) (int, int) {
	var ahead, behind int
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "ahead ") {
			ahead, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(part, "ahead ")))
		}
		if strings.HasPrefix(part, "behind ") {
			behind, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(part, "behind ")))
		}
	}
	return ahead, behind
}

func parseAheadBehindInto(value string, status *GitWorkspaceStatus) {
	status.Ahead, status.Behind = parseAheadBehind(value)
}

func parseBranchTrackingStateInto(value string, status *GitWorkspaceStatus) {
	value = strings.TrimSpace(value)
	if value == "" {
		return
	}
	if value == "gone" || strings.Contains(value, "gone") {
		status.UpstreamGone = true
	}
	parseAheadBehindInto(value, status)
}

func gitStatusLabel(index, worktree string) string {
	if index == "?" && worktree == "?" {
		return "untracked"
	}
	if index == "U" || worktree == "U" || (index == "A" && worktree == "A") || (index == "D" && worktree == "D") {
		return "conflicted"
	}
	switch {
	case index == "R" || worktree == "R":
		return "renamed"
	case index == "A" || worktree == "A":
		return "added"
	case index == "D" || worktree == "D":
		return "deleted"
	case index == "M" || worktree == "M":
		return "modified"
	default:
		return "changed"
	}
}

func gitStatusForPath(files []GitFileStatus, path string) string {
	for _, file := range files {
		if filepath.ToSlash(file.Path) == filepath.ToSlash(path) {
			return file.Status
		}
	}
	return ""
}

func hasConflictedFiles(status GitWorkspaceStatus) bool {
	for _, file := range status.Files {
		if file.Status == "conflicted" {
			return true
		}
	}
	return false
}

func gitChangedPathExists(files []GitFileStatus, path string) bool {
	path = filepath.ToSlash(path)
	for _, file := range files {
		if filepath.ToSlash(file.Path) == path {
			return true
		}
	}
	return false
}

func expandDiscardGitPathsWithRequestIndexes(statusFiles []GitFileStatus, paths []string) []string {
	seen := map[string]struct{}{}
	var expanded []string
	add := func(path string) {
		path = filepath.ToSlash(strings.TrimSpace(path))
		if path == "" {
			return
		}
		if _, ok := seen[path]; ok {
			return
		}
		seen[path] = struct{}{}
		expanded = append(expanded, path)
	}
	for _, path := range paths {
		add(path)
		if collectionPath := collectionIndexForRequestGitPath(path); collectionPath != "" && gitChangedPathExists(statusFiles, collectionPath) {
			add(collectionPath)
		}
	}
	sort.Strings(expanded)
	return expanded
}

func collectionIndexForRequestGitPath(path string) string {
	path = filepath.ToSlash(strings.TrimSpace(path))
	if filepath.Ext(path) != fileStoreYAMLExt {
		return ""
	}
	requestsDir := filepath.Dir(path)
	if filepath.Base(requestsDir) != fileStoreRequestsDir {
		return ""
	}
	collectionDir := filepath.Dir(requestsDir)
	if collectionDir == "." || collectionDir == "" {
		return ""
	}
	return filepath.ToSlash(filepath.Join(collectionDir, fileStoreCollection))
}

func gitOperationState(repoRoot string) string {
	if repoRoot == "" {
		return ""
	}
	if gitMetadataPathExists(repoRoot, "rebase-merge") || gitMetadataPathExists(repoRoot, "rebase-apply") {
		return "rebase"
	}
	if gitMetadataPathExists(repoRoot, "MERGE_HEAD") {
		return "merge"
	}
	return ""
}

func gitMetadataPathExists(repoRoot, name string) bool {
	output, err := gitOutput(repoRoot, "rev-parse", "--git-path", name)
	if err != nil {
		return false
	}
	path := strings.TrimSpace(output)
	if path == "" {
		return false
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(repoRoot, path)
	}
	_, err = os.Stat(path)
	return err == nil
}

func discardGitPaths(repoRoot string, statusFiles []GitFileStatus, paths []string) (string, error) {
	var outputParts []string
	hasHead := gitRepositoryHasHead(repoRoot)
	for _, path := range paths {
		statusFile := gitFileStatusForPath(statusFiles, path)
		if statusFile.Path == "" {
			continue
		}
		if statusFile.Index == "U" || statusFile.Worktree == "U" ||
			(statusFile.Index == "A" && statusFile.Worktree == "A") ||
			(statusFile.Index == "D" && statusFile.Worktree == "D") {
			return strings.Join(outputParts, "\n"), fmt.Errorf("cannot discard %s: file has unresolved merge conflicts — resolve or abort the merge before discarding", path)
		}
		if statusFile.Index != "" && statusFile.Index != " " && statusFile.Index != "?" {
			args := []string{"restore", "--staged", "--", path}
			if !hasHead {
				args = []string{"rm", "--cached", "--ignore-unmatch", "--", path}
			}
			output, err := runGit(repoRoot, args...)
			outputParts = appendGitOutputPart(outputParts, output)
			if err != nil {
				return strings.Join(outputParts, "\n"), err
			}
		}
		if hasHead && gitPathExistsInHead(repoRoot, path) {
			output, err := runGit(repoRoot, "restore", "--worktree", "--", path)
			outputParts = appendGitOutputPart(outputParts, output)
			if err != nil {
				return strings.Join(outputParts, "\n"), err
			}
			continue
		}
		if err := removeUntrackedGitPath(repoRoot, path); err != nil {
			return strings.Join(outputParts, "\n"), err
		}
	}
	if len(outputParts) == 0 {
		return "Discarded Kurlo workspace changes.", nil
	}
	return strings.Join(outputParts, "\n"), nil
}

func gitFileStatusForPath(files []GitFileStatus, path string) GitFileStatus {
	path = filepath.ToSlash(path)
	for _, file := range files {
		if filepath.ToSlash(file.Path) == path {
			return file
		}
	}
	return GitFileStatus{}
}

func containsGitPath(paths []string, target string) bool {
	target = filepath.ToSlash(target)
	for _, path := range paths {
		if filepath.ToSlash(path) == target {
			return true
		}
	}
	return false
}

func gitRepositoryHasHead(repoRoot string) bool {
	_, err := gitOutput(repoRoot, "rev-parse", "--verify", "HEAD")
	return err == nil
}

func gitRepositoryHasRemote(repoRoot string) bool {
	output, err := gitOutput(repoRoot, "remote")
	return err == nil && strings.TrimSpace(output) != ""
}

func gitPathExistsInHead(repoRoot, path string) bool {
	_, err := gitOutput(repoRoot, "cat-file", "-e", "HEAD:"+path)
	return err == nil
}

func gitCurrentHead(repoRoot string) string {
	output, err := gitOutput(repoRoot, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(output)
}

func gitRefHash(repoRoot, ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ""
	}
	output, err := gitOutput(repoRoot, "rev-parse", "--verify", ref)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(output)
}

func gitPullSummaryForRange(repoRoot, beforeHead, afterHead string) GitPullSummary {
	beforeHead = strings.TrimSpace(beforeHead)
	afterHead = strings.TrimSpace(afterHead)
	if beforeHead == "" || afterHead == "" || beforeHead == afterHead {
		return GitPullSummary{}
	}
	output, err := gitOutput(repoRoot, "diff", "--name-status", "-M", beforeHead, afterHead, "--")
	if err != nil {
		return GitPullSummary{}
	}
	return parseGitPullSummary(output)
}

func gitPullConflictMessage(status GitWorkspaceStatus) string {
	if status.Operation != "" {
		return "Pull stopped with conflicts. Resolve the conflicted Kurlo files, then continue or abort the Git operation."
	}
	return "Pull applied remote changes, but your uncommitted edits conflicted while being re-applied. Resolve the conflicted Kurlo files; the resolved files will stay as local changes."
}

func parseGitPullSummary(output string) GitPullSummary {
	var summary GitPullSummary
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) == 0 || fields[0] == "" {
			continue
		}
		summary.Changed++
		switch fields[0][0] {
		case 'A', 'C':
			summary.Added++
		case 'D':
			summary.Deleted++
		case 'R':
			summary.Renamed++
		default:
			summary.Updated++
		}
	}
	return summary
}

func removeUntrackedGitPath(repoRoot, path string) error {
	absPath, err := safeRepoRelativeFilePath(repoRoot, path)
	if err != nil {
		return err
	}
	info, err := os.Lstat(absPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("refusing to discard directory %s", path)
	}
	return os.Remove(absPath)
}

func safeRepoRelativeFilePath(repoRoot, path string) (string, error) {
	relPath, err := cleanGitRelativePath(path)
	if err != nil {
		return "", err
	}
	rootAbs, err := filepath.Abs(repoRoot)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(rootAbs); err == nil {
		rootAbs = resolved
	}
	targetAbs, err := filepath.Abs(filepath.Join(rootAbs, filepath.FromSlash(relPath)))
	if err != nil {
		return "", err
	}
	parent := filepath.Dir(targetAbs)
	if resolvedParent, err := filepath.EvalSymlinks(parent); err == nil {
		parent = resolvedParent
		targetAbs = filepath.Join(parent, filepath.Base(targetAbs))
	}
	parentRel, err := filepath.Rel(rootAbs, parent)
	if err != nil || parentRel == ".." || strings.HasPrefix(parentRel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid repository-relative path")
	}
	rel, err := filepath.Rel(rootAbs, targetAbs)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid repository-relative path")
	}
	if info, err := os.Lstat(targetAbs); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("refusing to operate on symlink: %s", relPath)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return targetAbs, nil
}

func appendGitOutputPart(parts []string, output string) []string {
	output = strings.TrimSpace(output)
	if output == "" {
		return parts
	}
	return append(parts, output)
}

func requireGitWorkspace(root string) (GitWorkspaceStatus, GitOperationResult, bool) {
	status := gitStatusForWorkspace(root)
	if status.MissingRoot {
		return status, GitOperationResult{Ok: false, Git: status, Error: missingWorkspaceRootMessage()}, false
	}
	if !status.IsRepo || status.Root == "" {
		return status, GitOperationResult{Ok: false, Git: status, Error: "Current workspace is not inside a Git repository."}, false
	}
	return status, GitOperationResult{}, true
}

func cleanGitRemoteName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "origin"
	}
	if strings.HasPrefix(name, "-") || !gitRemoteNamePattern.MatchString(name) {
		return "", fmt.Errorf("invalid Git remote name")
	}
	return name, nil
}

func cleanGitRemoteURL(remoteURL string) (string, error) {
	remoteURL = strings.TrimSpace(remoteURL)
	if remoteURL == "" {
		return "", fmt.Errorf("remote URL is required")
	}
	if strings.HasPrefix(remoteURL, "-") {
		return "", fmt.Errorf("remote URL cannot start with '-'")
	}
	if strings.ContainsAny(remoteURL, "\x00\r\n\t") {
		return "", fmt.Errorf("invalid remote URL")
	}
	return remoteURL, nil
}

func cleanGitBranchName(branchName string) (string, error) {
	branchName = strings.TrimSpace(branchName)
	if branchName == "" {
		return "", fmt.Errorf("branch name is required")
	}
	if strings.HasPrefix(branchName, "-") ||
		strings.ContainsAny(branchName, "\x00\r\n \t\\~^:?*[") ||
		strings.Contains(branchName, "..") ||
		strings.Contains(branchName, "@{") ||
		strings.Contains(branchName, "//") ||
		strings.HasPrefix(branchName, "/") ||
		strings.HasSuffix(branchName, "/") ||
		strings.HasSuffix(branchName, ".") ||
		strings.HasSuffix(branchName, ".lock") {
		return "", fmt.Errorf("invalid Git branch name")
	}
	for _, part := range strings.Split(branchName, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".lock") {
			return "", fmt.Errorf("invalid Git branch name")
		}
	}
	return branchName, nil
}

func looksLikeGitRemoteName(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	if strings.ContainsAny(value, "/:\\") || strings.Contains(value, "@") {
		return false
	}
	return gitRemoteNamePattern.MatchString(value)
}

func gitCommandDir(root string) string {
	if dir, err := normalizeExistingDir(root); err == nil {
		return dir
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if dir, err := normalizeExistingDir(home); err == nil {
			return dir
		}
	}
	return "."
}

func truncateRemoteTestOutput(output string) string {
	output = strings.TrimSpace(output)
	if output == "" {
		return "Remote is reachable."
	}
	lines := strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	if len(lines) > 5 {
		lines = lines[:5]
		lines = append(lines, "[output truncated]")
	}
	return strings.Join(lines, "\n")
}

func managedChangedGitPaths(workspaceRoot string, status GitWorkspaceStatus) []string {
	seen := map[string]struct{}{}
	var paths []string
	for _, file := range status.Files {
		path := filepath.ToSlash(file.Path)
		if !isManagedWorkspaceGitPath(workspaceRoot, status.Root, path) {
			continue
		}
		if _, exists := seen[path]; exists {
			continue
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func partitionManagedGitPaths(workspaceRoot, repoRoot string, paths []string) ([]string, []string) {
	var managed []string
	var other []string
	for _, path := range paths {
		path = filepath.ToSlash(strings.TrimSpace(path))
		if path == "" {
			continue
		}
		if isManagedWorkspaceGitPath(workspaceRoot, repoRoot, path) {
			managed = append(managed, path)
		} else {
			other = append(other, path)
		}
	}
	sort.Strings(managed)
	sort.Strings(other)
	return managed, other
}

func selectedManagedChangedGitPaths(workspaceRoot string, status GitWorkspaceStatus, paths []string) ([]string, error) {
	changed := map[string]struct{}{}
	for _, file := range status.Files {
		path := filepath.ToSlash(file.Path)
		changed[path] = struct{}{}
	}
	seen := map[string]struct{}{}
	var selected []string
	for _, path := range paths {
		relPath, err := cleanGitRelativePath(path)
		if err != nil {
			return nil, err
		}
		if !isManagedWorkspaceGitPath(workspaceRoot, status.Root, relPath) {
			return nil, fmt.Errorf("Kurlo can only operate on Kurlo workspace files.")
		}
		if _, ok := changed[relPath]; !ok {
			continue
		}
		if _, ok := seen[relPath]; ok {
			continue
		}
		seen[relPath] = struct{}{}
		selected = append(selected, relPath)
	}
	sort.Strings(selected)
	return selected, nil
}

func managedWorkspaceGitPathspecs(workspaceRoot, repoRoot string) []string {
	prefix := workspaceGitPrefix(workspaceRoot, repoRoot)
	workspaceYAMLFiles := ":(glob)" + filepath.ToSlash(filepath.Join(fileStoreWorkspacesDir, "**", "*"+fileStoreYAMLExt))
	base := []string{fileStoreRootIndex, ".gitignore", workspaceYAMLFiles}
	if prefix == "" {
		return base
	}
	pathspecs := make([]string, 0, len(base))
	pathspecs = append(pathspecs, filepath.ToSlash(filepath.Join(prefix, fileStoreRootIndex)))
	pathspecs = append(pathspecs, filepath.ToSlash(filepath.Join(prefix, ".gitignore")))
	pathspecs = append(pathspecs, ":(glob)"+filepath.ToSlash(filepath.Join(prefix, fileStoreWorkspacesDir, "**", "*"+fileStoreYAMLExt)))
	return pathspecs
}

func isManagedWorkspaceGitPath(workspaceRoot, repoRoot, repoRelPath string) bool {
	prefix := workspaceGitPrefix(workspaceRoot, repoRoot)
	path := filepath.ToSlash(strings.TrimSpace(repoRelPath))
	if path == "" || strings.HasPrefix(path, "../") || path == ".." {
		return false
	}
	if prefix != "" {
		if path != prefix && !strings.HasPrefix(path, prefix+"/") {
			return false
		}
		path = strings.TrimPrefix(path, prefix+"/")
	}
	return path == fileStoreRootIndex ||
		path == ".gitignore" ||
		(strings.HasPrefix(path, fileStoreWorkspacesDir+"/") && filepath.Ext(path) == fileStoreYAMLExt)
}

func isKurloGeneratedArtifactGitPath(workspaceRoot, repoRoot, repoRelPath string) bool {
	prefix := workspaceGitPrefix(workspaceRoot, repoRoot)
	path := filepath.ToSlash(strings.TrimSpace(repoRelPath))
	if path == "" || strings.HasPrefix(path, "../") || path == ".." {
		return false
	}
	if prefix != "" {
		if path != prefix && !strings.HasPrefix(path, prefix+"/") {
			return false
		}
		path = strings.TrimPrefix(path, prefix+"/")
	}
	return kurloRunnerReportArtifactPattern.MatchString(filepath.Base(path))
}

func isDiscardableKurloGitPath(workspaceRoot, repoRoot, repoRelPath string) bool {
	return isManagedWorkspaceGitPath(workspaceRoot, repoRoot, repoRelPath) ||
		isKurloGeneratedArtifactGitPath(workspaceRoot, repoRoot, repoRelPath)
}

func discardableChangedGitPaths(workspaceRoot string, status GitWorkspaceStatus) []string {
	seen := map[string]struct{}{}
	var paths []string
	for _, file := range status.Files {
		path := filepath.ToSlash(file.Path)
		if !isDiscardableKurloGitPath(workspaceRoot, status.Root, path) {
			continue
		}
		if _, exists := seen[path]; exists {
			continue
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func selectedDiscardableChangedGitPaths(workspaceRoot string, status GitWorkspaceStatus, paths []string) ([]string, error) {
	changed := map[string]struct{}{}
	for _, file := range status.Files {
		changed[filepath.ToSlash(file.Path)] = struct{}{}
	}
	seen := map[string]struct{}{}
	var selected []string
	for _, path := range paths {
		relPath, err := cleanGitRelativePath(path)
		if err != nil {
			return nil, err
		}
		if !isDiscardableKurloGitPath(workspaceRoot, status.Root, relPath) {
			return nil, fmt.Errorf("Kurlo can only discard Kurlo workspace files and Kurlo-generated reports.")
		}
		if _, ok := changed[relPath]; !ok {
			continue
		}
		if _, ok := seen[relPath]; ok {
			continue
		}
		seen[relPath] = struct{}{}
		selected = append(selected, relPath)
	}
	sort.Strings(selected)
	return selected, nil
}

func workspaceGitPrefix(workspaceRoot, repoRoot string) string {
	workspaceAbs, workspaceErr := filepath.Abs(workspaceRoot)
	repoAbs, repoErr := filepath.Abs(repoRoot)
	if workspaceErr != nil || repoErr != nil {
		return ""
	}
	if resolvedWorkspace, err := filepath.EvalSymlinks(workspaceAbs); err == nil {
		workspaceAbs = resolvedWorkspace
	}
	if resolvedRepo, err := filepath.EvalSymlinks(repoAbs); err == nil {
		repoAbs = resolvedRepo
	}
	rel, err := filepath.Rel(repoAbs, workspaceAbs)
	if err != nil || rel == "." {
		return ""
	}
	return filepath.ToSlash(rel)
}

func stagedGitFiles(repoRoot string) ([]string, error) {
	output, err := gitOutput(repoRoot, "diff", "--cached", "--name-only", "--")
	if err != nil {
		return nil, fmt.Errorf("%s", friendlyGitError("diff --cached", output, err))
	}
	var files []string
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			files = append(files, filepath.ToSlash(line))
		}
	}
	return files, nil
}

func gitStashesForRoot(repoRoot string) []GitStashEntry {
	output, err := gitOutput(repoRoot, "stash", "list", "--format=%gd%x1f%s")
	if err != nil {
		return []GitStashEntry{}
	}
	stashes := []GitStashEntry{}
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\x1f", 2)
		ref := strings.TrimSpace(parts[0])
		if !gitStashRefPattern.MatchString(ref) {
			continue
		}
		indexText := strings.TrimSuffix(strings.TrimPrefix(ref, "stash@{"), "}")
		index, _ := strconv.Atoi(indexText)
		message := ""
		if len(parts) > 1 {
			message = strings.TrimSpace(parts[1])
		}
		stashes = append(stashes, GitStashEntry{Ref: ref, Index: index, Message: message})
	}
	return stashes
}

func currentGitBranch(repoRoot, fallback string) string {
	if branch, err := gitOutput(repoRoot, "branch", "--show-current"); err == nil && strings.TrimSpace(branch) != "" {
		return strings.TrimSpace(branch)
	}
	fallback = strings.TrimSpace(fallback)
	if fallback == "" || fallback == "HEAD" || strings.HasPrefix(fallback, "No commits yet on ") {
		return ""
	}
	return fallback
}

func gitBranchCheckedOutInAnotherWorktree(repoRoot, branch string) bool {
	branch = strings.TrimSpace(branch)
	if branch == "" {
		return false
	}
	output, err := gitOutput(repoRoot, "worktree", "list", "--porcelain")
	if err != nil {
		return false
	}
	branchLine := "branch refs/heads/" + branch
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == branchLine {
			return true
		}
	}
	return false
}

func localGitBranchExists(repoRoot, branch string) bool {
	_, err := gitOutput(repoRoot, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	return err == nil
}

func remoteTrackingBranchExists(repoRoot, branch string) bool {
	_, err := gitOutput(repoRoot, "show-ref", "--verify", "--quiet", "refs/remotes/"+branch)
	return err == nil
}

func cleanGitRelativePath(path string) (string, error) {
	path = strings.TrimSpace(filepath.ToSlash(path))
	if path == "" {
		return "", fmt.Errorf("file path is required")
	}
	if strings.Contains(path, "\x00") || strings.Contains(path, "\\") || filepath.IsAbs(path) {
		return "", fmt.Errorf("invalid repository-relative path")
	}
	if path == "." || path == ".." || strings.HasPrefix(path, "./") || strings.HasPrefix(path, "../") {
		return "", fmt.Errorf("invalid repository-relative path")
	}
	if strings.Contains(path, "/../") || strings.HasSuffix(path, "/..") || strings.Contains(path, "/./") || strings.HasSuffix(path, "/.") {
		return "", fmt.Errorf("invalid repository-relative path")
	}
	if strings.Contains(path, "//") {
		return "", fmt.Errorf("invalid repository-relative path")
	}
	return path, nil
}

func truncateGitOutput(value string, maxBytes int) (string, bool) {
	if len(value) <= maxBytes {
		return value, false
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut] + "\n\n[diff truncated]", true
}

func normalizeGitLogLimit(limit int) int {
	if limit <= 0 {
		return defaultGitLogPageLen
	}
	if limit > maxGitLogPageLen {
		return maxGitLogPageLen
	}
	return limit
}

func normalizeGitLogOffset(offset int) int {
	if offset < 0 {
		return 0
	}
	return offset
}

func normalizeGitDiffPaths(repoRoot, diff string) string {
	prefix := strings.TrimPrefix(filepath.ToSlash(repoRoot), "/") + "/"
	lines := strings.Split(diff, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "diff ") || strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ ") {
			lines[i] = strings.ReplaceAll(line, prefix, "")
		}
	}
	return strings.Join(lines, "\n")
}

func appendGitOutput(output, message string) string {
	output = strings.TrimSpace(output)
	message = strings.TrimSpace(message)
	if output == "" {
		return message
	}
	if message == "" {
		return output
	}
	return output + "\n" + message
}

func cloneInitializationPayload(initMode, workspaceName string) (string, string, error) {
	switch strings.TrimSpace(initMode) {
	case "", "empty":
		payload, err := emptyKurloWorkspacePayload(workspaceName)
		return payload, "Initialized an empty Kurlo YAML workspace in the cloned repository.", err
	case "copy":
		payload, err := loadKurloStorePayload(requestStorePath(), fileWorkspaceStorePath())
		if err != nil || strings.TrimSpace(payload) == "" {
			if err == nil {
				err = fmt.Errorf("current local workspace is empty")
			}
			return "", "", fmt.Errorf("repository was cloned, but Kurlo could not copy the current local workspace: %w", err)
		}
		return payload, "Copied the current Kurlo workspace into the cloned repository.", nil
	default:
		return "", "", fmt.Errorf("repository was cloned, but Kurlo workspace initialization was canceled")
	}
}

func localWorkspaceInitializationPayload(initMode, workspaceName string) (string, string, error) {
	switch strings.TrimSpace(initMode) {
	case "", "empty":
		payload, err := emptyKurloWorkspacePayload(workspaceName)
		return payload, "Created an empty Kurlo folder workspace.", err
	case "copy":
		payload, err := loadKurloStorePayload(requestStorePath(), fileWorkspaceStorePath())
		if err != nil || strings.TrimSpace(payload) == "" {
			if err == nil {
				err = fmt.Errorf("current local workspace is empty")
			}
			return "", "", fmt.Errorf("Kurlo could not copy the current workspace: %w", err)
		}
		return payload, "Copied the current Kurlo workspace into a folder workspace.", nil
	default:
		return "", "", fmt.Errorf("Kurlo folder workspace creation was canceled")
	}
}

func emptyKurloWorkspacePayload(workspaceName string) (string, error) {
	name := strings.TrimSpace(workspaceName)
	if name == "" {
		name = "Kurlo Workspace"
	}
	workspaceID := "workspace-" + pathSafeID(name)
	collectionID := "collection-default"
	payload := map[string]any{
		"version":             2,
		"activeId":            "",
		"activeWorkspaceId":   workspaceID,
		"activeEnvironmentId": "",
		"openIds":             []string{},
		"folderCollapsed":     map[string]bool{},
		"workspaces": []map[string]any{{
			"id":          workspaceID,
			"name":        name,
			"description": "",
		}},
		"collections": []map[string]any{{
			"id":          collectionID,
			"workspaceId": workspaceID,
			"name":        "Default Collection",
			"description": "",
			"collapsed":   false,
		}},
		"environments": []map[string]any{},
		"requests":     []map[string]any{},
		"history":      []map[string]any{},
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func friendlyGitError(action, output string, err error) string {
	if unavailable := gitUnavailableMessage(output, err); unavailable != "" {
		return unavailable
	}
	output = strings.TrimSpace(maskGitCredentials(output))
	var message string
	if output != "" {
		message = output
	} else if err != nil {
		message = maskGitCredentials(fmt.Sprintf("git %s failed: %v", action, err))
	} else {
		message = fmt.Sprintf("git %s failed", action)
	}
	return appendGitAuthHint(message)
}

func maskGitCredentials(message string) string {
	if message == "" {
		return message
	}
	return gitCredentialURLPattern.ReplaceAllString(message, "$1[REDACTED]@")
}

func appendGitAuthHint(message string) string {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "permission denied (publickey)"):
		return message + "\n\nAuthentication hint: for private repositories, add your SSH public key to GitHub/GitLab/Bitbucket and make sure ssh-agent has the private key loaded with ssh-add."
	case strings.Contains(lower, "could not read username") || strings.Contains(lower, "terminal prompts disabled"):
		return message + "\n\nAuthentication hint: this HTTPS repository needs credentials. Kurlo asks for a personal access token and keeps it encrypted on this device, or you can pick an SSH key instead. A system Git credential helper also works."
	case strings.Contains(lower, "authentication failed"):
		return message + "\n\nAuthentication hint: the token or password was rejected. Enter a new personal access token when Kurlo asks, or pick an SSH key instead."
	case strings.Contains(lower, "repository not found"):
		return message + "\n\nAuthentication hint: the repository may be private or the remote URL may be wrong. Verify access in your Git provider and prefer the SSH clone URL for private repositories."
	default:
		return message
	}
}

func gitRemoteURLForRoot(root, remoteName string) string {
	name := strings.TrimSpace(remoteName)
	if name == "" {
		name = "origin"
	}
	if url, err := gitOutput(root, "remote", "get-url", name); err == nil {
		return strings.TrimSpace(url)
	}
	return ""
}

func annotateGitAuthFailure(status *GitWorkspaceStatus, message, remoteURL string) {
	if status == nil || status.AuthRequired {
		return
	}
	lower := strings.ToLower(message)
	ssh := strings.Contains(lower, "permission denied (publickey)") ||
		strings.Contains(lower, "host key verification failed") ||
		(strings.Contains(lower, "git@") && strings.Contains(lower, "permission denied"))
	https := strings.Contains(lower, "could not read username") ||
		strings.Contains(lower, "could not read password") ||
		strings.Contains(lower, "terminal prompts disabled") ||
		strings.Contains(lower, "authentication failed") ||
		strings.Contains(lower, "invalid username or password") ||
		strings.Contains(lower, "http basic: access denied") ||
		strings.Contains(lower, "the requested url returned error: 401") ||
		strings.Contains(lower, "the requested url returned error: 403")
	notFound := strings.Contains(lower, "repository not found") ||
		strings.Contains(lower, "the requested url returned error: 404")

	if !ssh && !https && !notFound {
		return
	}
	host := normalizeGitHost(remoteURL)
	scheme := "https"
	if ssh || strings.HasPrefix(strings.ToLower(strings.TrimSpace(remoteURL)), "git@") ||
		strings.HasPrefix(strings.ToLower(strings.TrimSpace(remoteURL)), "ssh://") {
		scheme = "ssh"
	}
	status.AuthRequired = true
	status.AuthScheme = scheme
	status.AuthHost = host
	if scheme == "https" && host != "" && gitCredentialHasToken(host) &&
		(strings.Contains(lower, "authentication failed") ||
			strings.Contains(lower, "invalid username or password") ||
			strings.Contains(lower, "http basic: access denied") ||
			strings.Contains(lower, "error: 401") ||
			strings.Contains(lower, "error: 403")) {

		status.TokenRejected = true
	}
}

func workspaceRootMissing(path string) bool {
	path = strings.TrimSpace(path)
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return errors.Is(err, os.ErrNotExist)
}

func workspaceRootUnavailable(path string) bool {
	return workspaceRootMissing(path) && !isDefaultWorkspaceRoot(path)
}

func missingWorkspaceRootMessage() string {
	return "Workspace folder no longer exists. Choose another folder, open an existing repository, or clone it again."
}

func friendlyWorkspaceRootError(err error) string {
	if errors.Is(err, os.ErrNotExist) {
		return missingWorkspaceRootMessage()
	}
	return err.Error()
}

func normalizeExistingDir(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("folder path is required")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("path is not a folder")
	}
	return abs, nil
}

func safeCloneDirectoryName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	return safePathSegment(value)
}

func deriveCloneDirectoryName(remoteURL string) string {
	remoteURL = strings.TrimSuffix(strings.TrimSpace(remoteURL), "/")
	if remoteURL == "" {
		return ""
	}
	segment := remoteURL
	if slash := strings.LastIndex(segment, "/"); slash >= 0 {
		segment = segment[slash+1:]
	}
	if colon := strings.LastIndex(segment, ":"); colon >= 0 {
		segment = segment[colon+1:]
	}
	segment = strings.TrimSuffix(segment, ".git")
	return safeCloneDirectoryName(segment)
}

func missingWorkspaceSecrets(root string, secrets map[string]string) []WorkspaceSecretRef {
	keys := map[string]struct{}{}
	scanFile := func(path string) {
		data, err := os.ReadFile(path)
		if err != nil {
			return
		}
		for _, match := range kurloSecretRefPattern.FindAllSubmatch(data, -1) {
			if len(match) < 2 {
				continue
			}
			key := string(match[1])
			if secrets[key] == "" {
				keys[key] = struct{}{}
			}
		}
	}
	scanFile(filepath.Join(root, fileStoreRootIndex))
	_ = filepath.WalkDir(filepath.Join(root, fileStoreWorkspacesDir), func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(path) != fileStoreYAMLExt {
			return nil
		}
		scanFile(path)
		return nil
	})
	result := make([]WorkspaceSecretRef, 0, len(keys))
	for key := range keys {
		result = append(result, WorkspaceSecretRef{Key: key, Label: workspaceSecretLabel(key), Scope: workspaceSecretScope(key)})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Key < result[j].Key })
	return result
}

func workspaceSecretScope(key string) string {
	switch {
	case strings.HasPrefix(key, "request."):
		return "request"
	case strings.HasPrefix(key, "environment."):
		return "environment"
	default:
		return "workspace"
	}
}

func workspaceSecretLabel(key string) string {
	parts := strings.Split(key, ".")
	if len(parts) >= 4 && parts[0] == "request" && parts[2] == "auth" {
		return fmt.Sprintf("Request %s auth %s", parts[1], parts[3])
	}
	if len(parts) >= 6 && parts[0] == "request" && parts[3] == "row" {
		return fmt.Sprintf("Request %s %s row %s", parts[1], parts[2], parts[4])
	}
	if len(parts) >= 5 && parts[0] == "environment" && parts[2] == "row" {
		return fmt.Sprintf("Environment %s row %s", parts[1], parts[3])
	}
	return key
}

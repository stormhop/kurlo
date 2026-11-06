package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const mcpGitDiffLimit = 64 * 1024

var mcpGitReadToolNames = map[string]bool{
	"git_status":       true,
	"git_diff":         true,
	"pull_request_url": true,
}

var mcpGitWriteToolNames = map[string]bool{
	"git_create_branch": true,
	"git_commit":        true,
	"git_push":          true,
}

func mcpGitTools(readOnly bool) []map[string]any {
	readOnlyTool := map[string]any{"readOnlyHint": true, "openWorldHint": false}
	tools := []map[string]any{
		{
			"name":        "git_status",
			"title":       "Show Git status",
			"description": "Show the Git state of the workspace: branch, upstream, commits ahead and behind, and which Kurlo workspace files have uncommitted changes. Paths are relative to the repository root.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
			"annotations": readOnlyTool,
		},
		{
			"name":        "git_diff",
			"title":       "Show Git diff",
			"description": "Show the uncommitted diff of the Kurlo workspace files, or of one file. With outgoing, show the committed changes that are not pushed yet.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":     map[string]any{"type": "string", "description": "Only this file, relative to the repository root, as git_status lists it."},
					"outgoing": map[string]any{"type": "boolean", "description": "Show committed changes that are not pushed yet instead of uncommitted ones."},
				},
			},
			"annotations": readOnlyTool,
		},
		{
			"name":        "pull_request_url",
			"title":       "Pull request link",
			"description": "Build the link that opens a new pull request (merge request on GitLab) for the current branch on GitHub, GitLab or Bitbucket. Nothing is sent: the user opens the link and creates the pull request. Push the branch first.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"base": map[string]any{"type": "string", "description": "Branch to merge into. Defaults to the remote's default branch."},
				},
			},
			"annotations": readOnlyTool,
		},
	}
	if readOnly {
		return tools
	}
	return append(tools,
		map[string]any{
			"name":        "git_create_branch",
			"title":       "Create a Git branch",
			"description": "Create a branch from the current commit and switch to it. Uncommitted changes stay as they are.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name": map[string]any{"type": "string", "description": "New branch name, for example agent/cover-orders."},
				},
				"required": []string{"name"},
			},
			"annotations": map[string]any{"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
		},
		map[string]any{
			"name":        "git_commit",
			"title":       "Commit workspace changes",
			"description": "Commit uncommitted changes of Kurlo workspace files on the current branch. Other files in the repository are never committed.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"message": map[string]any{"type": "string", "description": "Commit message."},
					"paths": map[string]any{
						"type":        "array",
						"items":       map[string]any{"type": "string"},
						"description": "Only these files, relative to the repository root. Defaults to every changed workspace file.",
					},
				},
				"required": []string{"message"},
			},
			"annotations": map[string]any{"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
		},
		map[string]any{
			"name":        "git_push",
			"title":       "Push the current branch",
			"description": "Push the current branch to its remote. Call it only when the user asked to push in this conversation. Never force-pushes.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"remote": map[string]any{"type": "string", "description": "Remote name. Defaults to the branch's upstream remote or origin."},
				},
			},
			"annotations": map[string]any{"readOnlyHint": false, "destructiveHint": false, "openWorldHint": true},
		},
	)
}

type mcpGitFile struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type mcpGitStatusResult struct {
	Repository     bool         `json:"repository"`
	Branch         string       `json:"branch,omitempty"`
	Head           string       `json:"head,omitempty"`
	Upstream       string       `json:"upstream,omitempty"`
	Ahead          int          `json:"ahead"`
	Behind         int          `json:"behind"`
	Operation      string       `json:"operation,omitempty"`
	Changes        []mcpGitFile `json:"changes"`
	OtherChanges   int          `json:"otherChanges,omitempty"`
	Remotes        []string     `json:"remotes,omitempty"`
	WorkspacePath  string       `json:"workspacePath,omitempty"`
	PullRequestURL string       `json:"pullRequestUrl,omitempty"`
	Message        string       `json:"message,omitempty"`
}

func (s *mcpServer) toolGitStatus(_ context.Context, _ json.RawMessage) (any, error) {
	status := gitStatusForWorkspace(s.opts.workspace)
	out := mcpGitStatusResult{Changes: []mcpGitFile{}}
	if status.Error != "" && !status.IsRepo {
		return nil, errors.New(status.Error)
	}
	if !status.IsRepo {
		out.Message = "The workspace is not in a Git repository."
		return out, nil
	}
	out.Repository = true
	out.Branch = status.Branch
	out.Head = status.Head
	out.Upstream = status.Upstream
	out.Ahead = status.Ahead
	out.Behind = status.Behind
	out.Operation = status.Operation
	out.Remotes = status.Remotes
	out.WorkspacePath = workspaceGitPrefix(s.opts.workspace, status.Root)
	for _, file := range status.Files {
		if isManagedWorkspaceGitPath(s.opts.workspace, status.Root, file.Path) {
			out.Changes = append(out.Changes, mcpGitFile{Path: file.Path, Status: file.Status})
		} else {
			out.OtherChanges++
		}
	}
	if status.Upstream != "" && !status.UpstreamGone && status.Ahead == 0 {
		if link, err := gitPullRequestLink(status, ""); err == nil {
			out.PullRequestURL = link
		}
	}
	return out, nil
}

type mcpGitDiffResult struct {
	Diff      string `json:"diff"`
	Truncated bool   `json:"truncated,omitempty"`
}

func (s *mcpServer) toolGitDiff(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Path     string `json:"path"`
		Outgoing bool   `json:"outgoing"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	status, result, ok := requireGitWorkspace(s.opts.workspace)
	if !ok {
		return nil, errors.New(result.Error)
	}
	if args.Outgoing {
		diff := gitOutgoingChangesForWorkspace(s.opts.workspace)
		if diff.Error != "" {
			return nil, errors.New(diff.Error)
		}
		return mcpGitDiffResult{Diff: diff.Diff, Truncated: diff.Truncated}, nil
	}
	paths := managedChangedGitPaths(s.opts.workspace, status)
	if strings.TrimSpace(args.Path) != "" {
		rel, err := cleanGitRelativePath(args.Path)
		if err != nil {
			return nil, err
		}
		if !isManagedWorkspaceGitPath(s.opts.workspace, status.Root, rel) {
			return nil, errors.New("git_diff only shows Kurlo workspace files")
		}
		paths = []string{rel}
	}
	var parts []string
	truncated := false
	size := 0
	for _, rel := range paths {
		diff := gitDiffForWorkspace(s.opts.workspace, rel)
		if diff.Error != "" {
			return nil, errors.New(diff.Error)
		}
		if strings.TrimSpace(diff.Diff) == "" {
			continue
		}
		if size+len(diff.Diff) > mcpGitDiffLimit {
			truncated = true
			break
		}
		size += len(diff.Diff)
		parts = append(parts, diff.Diff)
		truncated = truncated || diff.Truncated
	}
	if len(parts) == 0 {
		return mcpGitDiffResult{Diff: "No uncommitted changes in the Kurlo workspace files."}, nil
	}
	return mcpGitDiffResult{Diff: strings.Join(parts, "\n"), Truncated: truncated}, nil
}

type mcpGitOperationResult struct {
	Branch         string   `json:"branch,omitempty"`
	Commit         string   `json:"commit,omitempty"`
	Files          []string `json:"files,omitempty"`
	Output         string   `json:"output,omitempty"`
	PullRequestURL string   `json:"pullRequestUrl,omitempty"`
}

func (s *mcpServer) toolGitCreateBranch(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Name string `json:"name"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.Name) == "" {
		return nil, errors.New("name is required")
	}
	gitOperationMu.Lock()
	result := gitCreateBranchForRoot(s.opts.workspace, args.Name, "")
	gitOperationMu.Unlock()
	if !result.Ok {
		return nil, errors.New(result.Error)
	}
	if record := mcpRecordFrom(ctx); record != nil {
		record.branch = result.Git.Branch
	}
	return mcpGitOperationResult{Branch: result.Git.Branch, Commit: result.Git.Head}, nil
}

func (s *mcpServer) toolGitCommit(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Message string   `json:"message"`
		Paths   []string `json:"paths"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	gitOperationMu.Lock()
	defer gitOperationMu.Unlock()
	unlock, err := lockWorkspaceWrites(s.opts.workspace)
	if err != nil {
		return nil, err
	}
	defer unlock()
	var result GitOperationResult
	if len(args.Paths) > 0 {
		result = gitCommitWorkspaceFilesForRoot(s.opts.workspace, args.Paths, args.Message)
	} else {
		result = gitCommitWorkspaceForRoot(s.opts.workspace, args.Message)
	}
	if !result.Ok {
		return nil, errors.New(result.Error)
	}
	if record := mcpRecordFrom(ctx); record != nil {
		record.commit = result.Git.Head
		record.branch = result.Git.Branch
	}
	return mcpGitOperationResult{Branch: result.Git.Branch, Commit: result.Git.Head, Files: result.Files}, nil
}

func (s *mcpServer) toolGitPush(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Remote string `json:"remote"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	status, failed, ok := requireGitWorkspace(s.opts.workspace)
	if !ok {
		return nil, errors.New(failed.Error)
	}
	remote := strings.TrimSpace(args.Remote)
	if remote == "" {
		remote = gitPushRemote(status)
	}
	gitOperationMu.Lock()
	result := gitPushWorkspaceForRoot(s.opts.workspace, remote)
	gitOperationMu.Unlock()
	if !result.Ok {
		return nil, errors.New(result.Error)
	}
	if record := mcpRecordFrom(ctx); record != nil {
		record.branch = result.Git.Branch
		record.commit = result.Git.Head
	}
	out := mcpGitOperationResult{Branch: result.Git.Branch, Commit: result.Git.Head, Output: strings.TrimSpace(result.Output)}
	if link, err := gitPullRequestLink(result.Git, ""); err == nil {
		out.PullRequestURL = link
	}
	return out, nil
}

type mcpPullRequestResult struct {
	URL    string `json:"url"`
	Branch string `json:"branch"`
	Base   string `json:"base"`
	Pushed bool   `json:"pushed"`
}

func (s *mcpServer) toolPullRequestURL(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Base string `json:"base"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	status, failed, ok := requireGitWorkspace(s.opts.workspace)
	if !ok {
		return nil, errors.New(failed.Error)
	}
	base := strings.TrimSpace(args.Base)
	if base == "" {
		base = gitDefaultBaseBranch(status.Root, gitPushRemote(status))
	}
	link, err := gitPullRequestLink(status, base)
	if err != nil {
		return nil, err
	}
	return mcpPullRequestResult{URL: link, Branch: status.Branch, Base: base, Pushed: status.Upstream != "" && !status.UpstreamGone && status.Ahead == 0}, nil
}

func gitPushRemote(status GitWorkspaceStatus) string {
	if status.Upstream != "" && !status.UpstreamGone {
		if remote, _, ok := strings.Cut(status.Upstream, "/"); ok && remote != "" {
			return remote
		}
	}
	if status.PushRemote != "" {
		return status.PushRemote
	}
	return "origin"
}

func gitDefaultBaseBranch(repoRoot, remote string) string {
	if out, err := gitOutput(repoRoot, "symbolic-ref", "--short", "refs/remotes/"+remote+"/HEAD"); err == nil {
		if branch := strings.TrimPrefix(strings.TrimSpace(out), remote+"/"); branch != "" {
			return branch
		}
	}
	for _, candidate := range []string{"main", "master"} {
		if remoteTrackingBranchExists(repoRoot, remote+"/"+candidate) {
			return candidate
		}
	}
	return "main"
}

func gitPullRequestLink(status GitWorkspaceStatus, base string) (string, error) {
	if !status.IsRepo || status.Root == "" {
		return "", errors.New("Current workspace is not inside a Git repository.")
	}
	branch := strings.TrimSpace(status.Branch)
	if branch == "" || branch == "HEAD" {
		return "", errors.New("Check out a branch first: the repository is not on a branch.")
	}
	remote := gitPushRemote(status)
	if base == "" {
		base = gitDefaultBaseBranch(status.Root, remote)
	}
	if branch == base {
		return "", fmt.Errorf("The current branch is %s, the branch to merge into. Create a branch for the changes first.", base)
	}
	remoteURL := gitRemoteURLForRoot(status.Root, remote)
	if remoteURL == "" {
		return "", fmt.Errorf("The repository has no remote named %s.", remote)
	}
	return pullRequestURL(remoteURL, branch, base)
}

var gitSCPRemotePattern = regexp.MustCompile(`^(?:[^@/]+@)?([^:/]+):(.+)$`)

func parseGitRemote(remoteURL string) (host, repoPath string, ok bool) {
	remoteURL = strings.TrimSpace(remoteURL)
	if strings.Contains(remoteURL, "://") {
		parsed, err := url.Parse(remoteURL)
		if err != nil || parsed.Hostname() == "" {
			return "", "", false
		}
		host = parsed.Hostname()
		repoPath = parsed.Path
	} else if match := gitSCPRemotePattern.FindStringSubmatch(remoteURL); match != nil {
		host = match[1]
		repoPath = match[2]
	} else {
		return "", "", false
	}
	repoPath = strings.TrimSuffix(strings.Trim(repoPath, "/"), ".git")
	if strings.Count(repoPath, "/") < 1 {
		return "", "", false
	}
	return strings.ToLower(host), repoPath, true
}

func escapeBranchPath(branch string) string {
	segments := strings.Split(branch, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return strings.Join(segments, "/")
}

func pullRequestURL(remoteURL, branch, base string) (string, error) {
	host, repoPath, ok := parseGitRemote(remoteURL)
	if !ok {
		return "", fmt.Errorf("Kurlo could not read the remote URL %q.", remoteURL)
	}
	if strings.HasPrefix(host, "ssh.") {
		host = strings.TrimPrefix(host, "ssh.")
	}
	web := "https://" + host + "/" + repoPath
	switch {
	case strings.Contains(host, "gitlab"):
		query := url.Values{}
		query.Set("merge_request[source_branch]", branch)
		query.Set("merge_request[target_branch]", base)
		return web + "/-/merge_requests/new?" + query.Encode(), nil
	case strings.Contains(host, "bitbucket"):
		query := url.Values{}
		query.Set("source", branch)
		query.Set("dest", base)
		return web + "/pull-requests/new?" + query.Encode(), nil
	case strings.Contains(host, "github"):
		return web + "/compare/" + escapeBranchPath(base) + "..." + escapeBranchPath(branch) + "?expand=1", nil
	}
	return "", fmt.Errorf("Kurlo builds pull request links for GitHub, GitLab and Bitbucket only; %s is not one of them.", host)
}

func gitCommitPreview(workspaceRoot string, paths []string) ([]model.AgentFileChange, error) {
	status, result, ok := requireGitWorkspace(workspaceRoot)
	if !ok {
		return nil, errors.New(result.Error)
	}
	selected := managedChangedGitPaths(workspaceRoot, status)
	if len(paths) > 0 {
		var err error
		if selected, err = selectedManagedChangedGitPaths(workspaceRoot, status, paths); err != nil {
			return nil, err
		}
	}
	changes := make([]model.AgentFileChange, 0, len(selected))
	for _, rel := range selected {
		change := model.AgentFileChange{Path: rel}
		before, beforeErr := gitOutput(status.Root, "show", "HEAD:"+rel)
		after, afterErr := os.ReadFile(filepath.Join(status.Root, filepath.FromSlash(rel)))
		if len(before) > mcpChangeMaxFileBytes || len(after) > mcpChangeMaxFileBytes {
			change.TooLarge = true
		} else {
			if beforeErr == nil {
				change.Before = &before
			}
			if afterErr == nil {
				text := string(after)
				change.After = &text
			}
		}
		changes = append(changes, change)
	}
	return changes, nil
}

var agentBranchUnsafe = regexp.MustCompile(`[^a-z0-9]+`)

func agentBranchName(chatID, title string) string {
	slug := strings.Trim(agentBranchUnsafe.ReplaceAllString(strings.ToLower(title), "-"), "-")
	if len(slug) > 40 {
		slug = strings.Trim(slug[:40], "-")
	}
	short := strings.ReplaceAll(chatID, "-", "")
	if len(short) > 6 {
		short = short[:6]
	}
	if slug == "" {
		return "kurlo-agent/" + short
	}
	return "kurlo-agent/" + slug + "-" + short
}

func agentCommitMessage(tool, chatTitle string, paths []string) string {
	names := make([]string, 0, len(paths))
	for _, rel := range paths {
		name := strings.TrimSuffix(path.Base(rel), fileStoreYAMLExt)
		switch name {
		case "kurlo", ".gitignore", "collection", "folder", "workspace":
			continue
		}
		names = append(names, name)
	}
	subject := "Agent: " + tool
	switch {
	case len(names) == 1:
		subject += " " + names[0]
	case len(names) > 1 && len(names) <= 3:
		subject += " " + strings.Join(names, ", ")
	case len(names) > 3:
		subject += fmt.Sprintf(" %s and %d more", strings.Join(names[:2], ", "), len(names)-2)
	}
	body := "Files:\n"
	for _, rel := range paths {
		body += "- " + rel + "\n"
	}
	if title := strings.TrimSpace(chatTitle); title != "" {
		body += "\nChat: " + title + "\n"
	}
	return subject + "\n\n" + body
}

type agentBranchCommit struct {
	Branch string
	Commit string
}

func commitAgentChanges(workspaceRoot, branch, tool, chatTitle string, changes []model.AgentFileChange) (agentBranchCommit, error) {
	status, result, ok := requireGitWorkspace(workspaceRoot)
	if !ok {
		return agentBranchCommit{}, errors.New(result.Error)
	}
	if status.Operation != "" {
		return agentBranchCommit{}, fmt.Errorf("a Git %s is in progress", status.Operation)
	}
	prefix := workspaceGitPrefix(workspaceRoot, status.Root)
	var paths []string
	for _, change := range changes {
		rel := filepath.ToSlash(change.Path)
		if prefix != "" {
			rel = prefix + "/" + rel
		}
		if isManagedWorkspaceGitPath(workspaceRoot, status.Root, rel) {
			paths = append(paths, rel)
		}
	}
	if len(paths) == 0 {
		return agentBranchCommit{Branch: status.Branch}, nil
	}
	if status.Branch != branch {
		var switched GitOperationResult
		if localGitBranchExists(status.Root, branch) {
			output, err := runGit(status.Root, "checkout", branch)
			if err != nil {
				return agentBranchCommit{}, fmt.Errorf("could not switch to %s: %s", branch, friendlyGitError("checkout", output, err))
			}
			switched = GitOperationResult{Ok: true}
		} else {
			switched = gitCreateBranchForRoot(workspaceRoot, branch, "")
		}
		if !switched.Ok {
			return agentBranchCommit{}, fmt.Errorf("could not create %s: %s", branch, switched.Error)
		}
	}
	committed := gitCommitWorkspaceFilesForRoot(workspaceRoot, paths, agentCommitMessage(tool, chatTitle, paths))
	if !committed.Ok {
		return agentBranchCommit{Branch: branch}, errors.New(committed.Error)
	}
	return agentBranchCommit{Branch: committed.Git.Branch, Commit: committed.Git.Head}, nil
}

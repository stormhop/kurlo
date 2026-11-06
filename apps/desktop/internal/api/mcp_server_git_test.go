package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func agentGitWorkspace(t *testing.T) (string, string) {
	t.Helper()
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	if result := gitInitWorkspaceForRoot(root); !result.Ok {
		t.Fatalf("git init: %s", result.Error)
	}
	configureGitUserForTest(t, root)
	if result := gitCommitWorkspaceForRoot(root, "Initial workspace"); !result.Ok {
		t.Fatalf("initial commit: %s", result.Error)
	}
	runGitForTest(t, root, "branch", "-M", "main")
	remote := filepath.Join(t.TempDir(), "origin.git")
	if err := os.MkdirAll(remote, 0o755); err != nil {
		t.Fatal(err)
	}
	initBareRemoteForTest(t, remote)
	if result := gitAddRemoteForRoot(root, "origin", remote); !result.Ok {
		t.Fatalf("add remote: %s", result.Error)
	}
	if result := gitPushWorkspaceForRoot(root, "origin"); !result.Ok {
		t.Fatalf("push: %s", result.Error)
	}
	runGitForTest(t, root, "remote", "set-head", "origin", "main")
	return root, remote
}

func gitLogSubjects(t *testing.T, dir, ref string) []string {
	t.Helper()
	out := strings.TrimSpace(runGitOutputForTest(t, dir, "log", "--format=%s", ref))
	if out == "" {
		return nil
	}
	return strings.Split(out, "\n")
}

func TestAgentGitToolsReadWithoutAskingAndCommitAfterApproval(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root, _ := agentGitWorkspace(t)
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalAllow, model.AgentApprovalAllow)

	if text, isError := agentBridgeCall(t, bridge, "save_request", map[string]any{"collection": "Smoke", "name": "Create order", "method": "POST", "url": "{{baseUrl}}/orders"}); isError {
		t.Fatalf("save_request: %s", text)
	}
	text, isError := agentBridgeCall(t, bridge, "git_status", map[string]any{})
	if isError || !strings.Contains(text, `"branch": "main"`) || !strings.Contains(text, "Create-order.yml") {
		t.Fatalf("git_status = %v %s", isError, text)
	}
	text, isError = agentBridgeCall(t, bridge, "git_diff", map[string]any{})
	if isError || !strings.Contains(text, "method: POST") {
		t.Fatalf("git_diff = %v %s", isError, text)
	}
	if approvals.count() != 1 {
		t.Fatalf("reading Git must not ask; approvals = %d", approvals.count())
	}

	text, isError = agentBridgeCall(t, bridge, "git_commit", map[string]any{"message": "Add Create order"})
	if isError {
		t.Fatalf("git_commit: %s", text)
	}
	approval := approvals.last()
	if approval.Tool != "git_commit" || approval.Kind != model.AgentToolWrite || !strings.Contains(approval.Reason, "on main: Add Create order") {
		t.Fatalf("commit approval = %+v", approval)
	}
	found := false
	for _, change := range approval.Changes {
		if strings.HasSuffix(change.Path, "Create-order.yml") && change.Before == nil && change.After != nil && strings.Contains(*change.After, "method: POST") {
			found = true
		}
	}
	if !found {
		t.Fatalf("commit approval should show the new file: %+v", approval.Changes)
	}
	if subjects := gitLogSubjects(t, root, "HEAD"); subjects[0] != "Add Create order" {
		t.Fatalf("log = %v", subjects)
	}
	entries, err := listAgentActivity(model.AgentActivityFilter{Tool: "git_commit"})
	if err != nil || len(entries) != 1 || entries[0].Commit == "" || entries[0].Branch != "main" {
		t.Fatalf("commit activity = %+v %v", entries, err)
	}
}

func TestAgentGitDeclinedCommitAndPushChangeNothing(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root, remote := agentGitWorkspace(t)
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalAllow, model.AgentApprovalReject, model.AgentApprovalAllow, model.AgentApprovalReject)
	if text, isError := agentBridgeCall(t, bridge, "set_variable", map[string]any{"environment": "Local", "key": "token", "value": "{{token}}"}); isError {
		t.Fatalf("set_variable: %s", text)
	}
	if _, isError := agentBridgeCall(t, bridge, "git_commit", map[string]any{"message": "Declined"}); !isError {
		t.Fatal("a declined commit should report an error")
	}
	if subjects := gitLogSubjects(t, root, "HEAD"); len(subjects) != 1 {
		t.Fatalf("a declined commit must not commit: %v", subjects)
	}
	if text, isError := agentBridgeCall(t, bridge, "git_commit", map[string]any{"message": "Set token"}); isError {
		t.Fatalf("git_commit: %s", text)
	}
	if _, isError := agentBridgeCall(t, bridge, "git_push", map[string]any{}); !isError {
		t.Fatal("a declined push should report an error")
	}
	push := approvals.last()
	if push.Tool != "git_push" || push.Kind != model.AgentToolExternal || !strings.Contains(push.Reason, "Pushes main to origin") {
		t.Fatalf("push approval = %+v", push)
	}
	if subjects := gitLogSubjects(t, remote, "main"); len(subjects) != 1 {
		t.Fatalf("a declined push must leave the remote alone: %v", subjects)
	}
	if agentAllowsChatApproval("git_push") {
		t.Fatal("push must be approved every time")
	}
}

func TestAgentOwnBranchCommitsEveryApprovedChange(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root, remote := agentGitWorkspace(t)
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalAllow, model.AgentApprovalAllow, model.AgentApprovalReject, model.AgentApprovalAllow)
	var saved []string
	bridge.setChat(model.AgentChat{ID: "chat-1", Title: "Cover orders", OwnBranch: true}, func(branch string) { saved = append(saved, branch) })

	text, isError := agentBridgeCall(t, bridge, "save_request", map[string]any{"collection": "Smoke", "name": "Create order", "method": "POST", "url": "{{baseUrl}}/orders"})
	if isError || !strings.Contains(text, "on branch kurlo-agent/cover-orders-chat1") {
		t.Fatalf("save_request = %v %s", isError, text)
	}
	if text, isError = agentBridgeCall(t, bridge, "set_variable", map[string]any{"environment": "Local", "key": "token", "value": "{{token}}"}); isError {
		t.Fatalf("set_variable: %s", text)
	}
	if _, isError = agentBridgeCall(t, bridge, "delete_request", map[string]any{"request": "Smoke/Create order"}); !isError {
		t.Fatal("a declined delete should report an error")
	}

	status := gitStatusForWorkspace(root)
	if status.Branch != "kurlo-agent/cover-orders-chat1" || !status.Clean {
		t.Fatalf("status = branch %q clean %v files %+v", status.Branch, status.Clean, status.Files)
	}
	subjects := gitLogSubjects(t, root, "HEAD")
	if len(subjects) != 3 || subjects[0] != "Agent: set_variable Local" || subjects[1] != "Agent: save_request Create-order" {
		t.Fatalf("log = %v", subjects)
	}
	if main := gitLogSubjects(t, root, "main"); len(main) != 1 {
		t.Fatalf("main must stay untouched: %v", main)
	}
	if len(saved) != 1 || saved[0] != "kurlo-agent/cover-orders-chat1" {
		t.Fatalf("branch saved to the chat = %v", saved)
	}
	entries, err := listAgentActivity(model.AgentActivityFilter{Tool: "save_request"})
	if err != nil || len(entries) != 1 || entries[0].Commit == "" || entries[0].Branch != "kurlo-agent/cover-orders-chat1" {
		t.Fatalf("activity = %+v %v", entries, err)
	}

	text, isError = agentBridgeCall(t, bridge, "git_push", map[string]any{})
	if isError {
		t.Fatalf("git_push: %s", text)
	}
	if approvals.count() != 4 {
		t.Fatalf("approvals = %d", approvals.count())
	}
	if pushed := gitLogSubjects(t, remote, "kurlo-agent/cover-orders-chat1"); len(pushed) != 3 {
		t.Fatalf("remote branch = %v", pushed)
	}
	var push struct {
		PullRequestURL string `json:"pullRequestUrl"`
	}
	if err := json.Unmarshal([]byte(text), &push); err != nil || push.PullRequestURL != "" {
		t.Fatalf("a local bare remote has no pull request link: %s", text)
	}
}

func TestAgentOwnBranchReportsWhenItCannotCommit(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, _ := newTestAgentBridge(t, root, model.AgentApprovalAllow)
	bridge.setChat(model.AgentChat{ID: "chat-1", Title: "No repo", OwnBranch: true}, nil)
	text, isError := agentBridgeCall(t, bridge, "save_request", map[string]any{"collection": "Smoke", "name": "Create order", "method": "POST", "url": "{{baseUrl}}/orders"})
	if isError || !strings.Contains(text, "Not committed to the agent branch: Current workspace is not inside a Git repository.") {
		t.Fatalf("save_request = %v %s", isError, text)
	}
	if _, err := os.Stat(filepath.Join(root, "workspaces/Demo/collections/Smoke/requests/Create-order.yml")); err != nil {
		t.Fatalf("the change itself must still be written: %v", err)
	}
}

func TestReadOnlyMCPServerOffersOnlyReadingGitTools(t *testing.T) {
	var names []string
	for _, tool := range mcpServerTools(true) {
		names = append(names, tool["name"].(string))
	}
	got := strings.Join(names, ",")
	if !strings.Contains(got, "git_status,git_diff,pull_request_url") || strings.Contains(got, "git_commit") || strings.Contains(got, "git_push") || strings.Contains(got, "git_create_branch") {
		t.Fatalf("read-only tools = %s", got)
	}
	server := newMCPServer(mcpServerOptions{workspace: t.TempDir(), readOnly: true}, nil)
	if _, err := server.callTool(t.Context(), json.RawMessage(`{"name":"git_push","arguments":{}}`)); err == nil || !strings.Contains(err.Error(), "--read-only") {
		t.Fatalf("read-only push = %v", err)
	}
}

func TestPullRequestURLForHostedRemotes(t *testing.T) {
	cases := []struct{ remote, want string }{
		{"git@github.com:stormhop/kurlo.git", "https://github.com/stormhop/kurlo/compare/main...kurlo-agent/cover-orders?expand=1"},
		{"https://github.com/stormhop/kurlo", "https://github.com/stormhop/kurlo/compare/main...kurlo-agent/cover-orders?expand=1"},
		{"ssh://git@gitlab.example.com:2222/team/api/kurlo.git", "https://gitlab.example.com/team/api/kurlo/-/merge_requests/new?merge_request%5Bsource_branch%5D=kurlo-agent%2Fcover-orders&merge_request%5Btarget_branch%5D=main"},
		{"https://user@bitbucket.org/team/kurlo.git", "https://bitbucket.org/team/kurlo/pull-requests/new?dest=main&source=kurlo-agent%2Fcover-orders"},
	}
	for _, tc := range cases {
		got, err := pullRequestURL(tc.remote, "kurlo-agent/cover-orders", "main")
		if err != nil || got != tc.want {
			t.Errorf("%s = %q, %v; want %q", tc.remote, got, err, tc.want)
		}
	}
	if _, err := pullRequestURL("/tmp/origin.git", "feature", "main"); err == nil {
		t.Error("a local path has no pull request page")
	}
	if _, err := gitPullRequestLink(GitWorkspaceStatus{IsRepo: true, Root: t.TempDir(), Branch: "main"}, "main"); err == nil || !strings.Contains(err.Error(), "Create a branch") {
		t.Errorf("same branch = %v", err)
	}
}

func TestAgentBranchNameIsSafe(t *testing.T) {
	if got := agentBranchName("ab-cd-ef-12", "Cover POST /orders & tests!"); got != "kurlo-agent/cover-post-orders-tests-abcdef" {
		t.Fatalf("branch = %q", got)
	}
	if got := agentBranchName("abcdef123", ""); got != "kurlo-agent/abcdef" {
		t.Fatalf("branch = %q", got)
	}
	if _, err := cleanGitBranchName(agentBranchName("x", strings.Repeat("long title ", 10))); err != nil {
		t.Fatal(err)
	}
}

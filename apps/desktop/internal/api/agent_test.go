package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type agentApprovalLog struct {
	mu        sync.Mutex
	approvals []model.AgentApproval
	decisions []string
}

func (l *agentApprovalLog) approver() agentApprover {
	return func(_ context.Context, approval model.AgentApproval) string {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.approvals = append(l.approvals, approval)
		if len(l.decisions) == 0 {
			return model.AgentApprovalReject
		}
		decision := l.decisions[0]
		l.decisions = l.decisions[1:]
		return decision
	}
}

func (l *agentApprovalLog) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.approvals)
}

func (l *agentApprovalLog) last() model.AgentApproval {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.approvals[len(l.approvals)-1]
}

func newTestAgentBridge(t *testing.T, root string, decisions ...string) (*agentToolBridge, *agentApprovalLog) {
	t.Helper()
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)
	log := &agentApprovalLog{decisions: decisions}
	bridge := newAgentToolBridge(mcpServerOptions{workspace: root, env: "Local"}, "chat-1", nil)
	bridge.approve = log.approver()
	return bridge, log
}

func agentBridgeCall(t *testing.T, bridge *agentToolBridge, name string, args map[string]any) (string, bool) {
	t.Helper()
	input, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return bridge.call(context.Background(), aiTool{Name: name, Original: name, Server: agentToolServer, ServerIndex: -1}, string(input), "call-1")
}

func agentTestWorkspace(t *testing.T, baseURL string) string {
	t.Helper()
	root := writeYAMLWorkspace(t, baseURL)
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	return root
}

func countingServer(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"method": r.Method, "path": r.URL.Path})
	}))
	t.Cleanup(server.Close)
	return server, &hits
}

func TestAgentPolicyAsksOnlyForUnsafeMethodsAndWrites(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	s := newMCPServer(mcpServerOptions{workspace: root, env: "Local"}, nil)
	post := filepath.Join(root, "workspaces", "Demo", "collections", "Smoke", "requests", "Chain.yml")
	data, err := os.ReadFile(post)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(post, []byte(strings.Replace(string(data), "    requestType: http", "    method: POST\n    requestType: http", 1)), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		tool string
		args string
		kind string
		ask  bool
	}{
		{"list_requests", `{}`, model.AgentToolRead, false},
		{"get_history_entry", `{}`, model.AgentToolRead, false},
		{"diagnose_last_failure", `{}`, model.AgentToolRead, false},
		{"run_request", `{"request":"Smoke/Ok"}`, model.AgentToolRun, false},
		{"run_request", `{"request":"Smoke/Chain"}`, model.AgentToolRun, true},
		{"run_collection", `{"collection":"Smoke"}`, model.AgentToolRun, true},
		{"send_request", `{"url":"http://example.test"}`, model.AgentToolRun, false},
		{"send_request", `{"method":"options","url":"http://example.test"}`, model.AgentToolRun, false},
		{"send_request", `{"method":"DELETE","url":"http://example.test"}`, model.AgentToolRun, true},
		{"save_request", `{"name":"x"}`, model.AgentToolWrite, true},
		{"patch_request", `{"request":"x","patch":{"name":"y"}}`, model.AgentToolWrite, true},
		{"apply_changes", `{"operations":[]}`, model.AgentToolWrite, true},
		{"list_globals", `{}`, model.AgentToolRead, false},
		{"authorize_oauth2", `{"request":"x"}`, model.AgentToolExternal, true},
		{"set_variable", `{"key":"x","value":"y"}`, model.AgentToolWrite, true},
		{"generate_tests", `{"request":"Smoke/Ok"}`, model.AgentToolWrite, true},
	}
	for _, tc := range cases {
		decision := agentDecide(s, tc.tool, json.RawMessage(tc.args))
		if decision.kind != tc.kind || decision.ask != tc.ask {
			t.Errorf("%s %s = %+v, want kind %s ask %v", tc.tool, tc.args, decision, tc.kind, tc.ask)
		}
	}
	if decision := agentDecide(s, "run_collection", json.RawMessage(`{"collection":"Smoke"}`)); len(decision.methods) != 1 || decision.methods[0] != "POST" || !strings.Contains(decision.reason, "POST") {
		t.Errorf("run_collection reason = %+v", decision)
	}
	if decision := agentDecide(s, "generate_tests", json.RawMessage(`{"request":"Smoke/Chain"}`)); len(decision.methods) != 1 {
		t.Errorf("generate_tests on a POST request must ask before sending it: %+v", decision)
	}
	if decision := agentDecide(s, "generate_tests", json.RawMessage(`{"request":"Smoke/Chain","from":"example"}`)); len(decision.methods) != 0 {
		t.Errorf("generate_tests from an example sends nothing: %+v", decision)
	}
}

func TestAgentBridgeShowsTheDiffWritesOnApprovalAndLogsIt(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalAllow)

	if text, isError := agentBridgeCall(t, bridge, "list_requests", map[string]any{}); isError || !strings.Contains(text, "Smoke/Ok") {
		t.Fatalf("list_requests = %v %s", isError, text)
	}
	if approvals.count() != 0 {
		t.Fatal("reading must not ask")
	}

	text, isError := agentBridgeCall(t, bridge, "save_request", map[string]any{"collection": "Smoke", "name": "Create order", "method": "POST", "url": "{{baseUrl}}/orders"})
	if isError {
		t.Fatalf("save_request failed: %s", text)
	}
	if approvals.count() != 1 {
		t.Fatalf("approvals = %d, want 1", approvals.count())
	}
	approval := approvals.last()
	if approval.Tool != "save_request" || approval.Kind != model.AgentToolWrite || approval.ChatID != "chat-1" || approval.ToolUseID != "call-1" || approval.ID == "" {
		t.Fatalf("approval = %+v", approval)
	}
	const created = "workspaces/Demo/collections/Smoke/requests/Create-order.yml"
	var newFile *model.AgentFileChange
	for i := range approval.Changes {
		if approval.Changes[i].Path == created {
			newFile = &approval.Changes[i]
		}
	}
	if newFile == nil || newFile.Before != nil || newFile.After == nil || !strings.Contains(*newFile.After, "method: POST") {
		t.Fatalf("approval changes = %+v", approval.Changes)
	}
	if file := readWorkspaceFile(t, root, created); file != *newFile.After {
		t.Fatalf("the written file differs from the approved diff:\n%s\nvs\n%s", file, *newFile.After)
	}

	entries, err := listAgentActivity(model.AgentActivityFilter{})
	if err != nil || len(entries) != 2 {
		t.Fatalf("activity = %+v, %v", entries, err)
	}
	if entries[0].Tool != "save_request" || entries[0].Client != model.AgentClientName || entries[0].ChatID != "chat-1" || entries[0].Status != model.AgentActivityOK {
		t.Fatalf("latest activity = %+v", entries[0])
	}
	if entries[1].Tool != "list_requests" || len(entries[1].Files) != 0 {
		t.Fatalf("first activity = %+v", entries[1])
	}
	found := false
	for _, file := range entries[0].Files {
		found = found || file == created
	}
	if !found {
		t.Fatalf("activity files = %v", entries[0].Files)
	}

	reverted, err := revertAgentActivity(entries[0].ID, "")
	if err != nil || !reverted.Reverted {
		t.Fatalf("revert = %+v, %v", reverted, err)
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(created))); !os.IsNotExist(err) {
		t.Fatalf("reverting must remove the created file, stat err = %v", err)
	}
	if file := readWorkspaceFile(t, root, "workspaces/Demo/collections/Smoke/collection.yml"); strings.Contains(file, "Create order") || strings.Contains(file, entriesRequestID(t, approval)) {
		t.Fatalf("collection.yml still lists the request:\n%s", file)
	}
	if _, err := revertAgentActivity(entries[0].ID, ""); err == nil {
		t.Fatal("a second revert should say there is nothing left")
	}
	if _, err := loadMCPStore(root); err != nil {
		t.Fatalf("the reverted workspace must load: %v", err)
	}
}

func entriesRequestID(t *testing.T, approval model.AgentApproval) string {
	t.Helper()
	for _, change := range approval.Changes {
		if change.After != nil && strings.HasSuffix(change.Path, "Create-order.yml") {
			for _, line := range strings.Split(*change.After, "\n") {
				if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "id: ") {
					return strings.TrimPrefix(trimmed, "id: ")
				}
			}
		}
	}
	t.Fatal("no request id in the approved file")
	return ""
}

func TestAgentBridgeDeclinedWriteChangesNothing(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	before, err := readWorkspaceFileContents(root)
	if err != nil {
		t.Fatal(err)
	}
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalReject)

	text, isError := agentBridgeCall(t, bridge, "set_variable", map[string]any{"environment": "Local", "key": "token", "value": "abc"})
	if !isError || !strings.Contains(text, "declined") {
		t.Fatalf("declined set_variable = %v %s", isError, text)
	}
	if approvals.count() != 1 || len(approvals.last().Changes) != 1 || !strings.HasSuffix(approvals.last().Changes[0].Path, "environments/Local.yml") {
		t.Fatalf("approval = %+v", approvals.last())
	}
	after, err := readWorkspaceFileContents(root)
	if err != nil {
		t.Fatal(err)
	}
	if changes := diffWorkspaceFiles(before, after); len(changes) != 0 {
		t.Fatalf("a declined change wrote files: %+v", changes)
	}
	entries, _ := listAgentActivity(model.AgentActivityFilter{})
	if len(entries) != 1 || entries[0].Status != model.AgentActivityDeclined || len(entries[0].Files) != 0 {
		t.Fatalf("activity = %+v", entries)
	}
}

func TestAgentBridgeAllowForChatStopsAsking(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalAllowChat)
	var allowed []string
	bridge.onAllow = func(tool string) { allowed = append(allowed, tool) }

	for _, value := range []string{"one", "two"} {
		if text, isError := agentBridgeCall(t, bridge, "set_variable", map[string]any{"environment": "Local", "key": "token", "value": value}); isError {
			t.Fatalf("set_variable %s: %s", value, text)
		}
	}
	if approvals.count() != 1 || len(allowed) != 1 || allowed[0] != "set_variable" {
		t.Fatalf("approvals = %d allowed = %v", approvals.count(), allowed)
	}
	if file := readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml"); !strings.Contains(file, "two") {
		t.Fatalf("Local.yml:\n%s", file)
	}
	if text, isError := agentBridgeCall(t, bridge, "save_request", map[string]any{"collection": "Smoke", "name": "Other", "url": "{{baseUrl}}/other"}); !isError || approvals.count() != 2 {
		t.Fatalf("another write tool must still ask: %v %s approvals=%d", isError, text, approvals.count())
	}
}

func TestAgentBridgeAsksBeforeSendingUnsafeMethods(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server, hits := countingServer(t)
	root := agentTestWorkspace(t, server.URL)
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalReject, model.AgentApprovalAllow)

	text, isError := agentBridgeCall(t, bridge, "send_request", map[string]any{"method": "DELETE", "url": "{{baseUrl}}/orders/1"})
	if !isError || !strings.Contains(text, "declined") || hits.Load() != 0 {
		t.Fatalf("declined DELETE = %v %s hits=%d", isError, text, hits.Load())
	}
	approval := approvals.last()
	if approval.Kind != model.AgentToolRun || !strings.Contains(approval.Reason, "DELETE") || len(approval.Changes) != 0 || !strings.Contains(approval.Arguments, "orders/1") {
		t.Fatalf("approval = %+v", approval)
	}

	if text, isError := agentBridgeCall(t, bridge, "send_request", map[string]any{"method": "DELETE", "url": "{{baseUrl}}/orders/1"}); isError || hits.Load() != 1 {
		t.Fatalf("approved DELETE = %v %s hits=%d", isError, text, hits.Load())
	}
	if text, isError := agentBridgeCall(t, bridge, "run_request", map[string]any{"request": "Smoke/Ok"}); isError || hits.Load() != 2 || approvals.count() != 2 {
		t.Fatalf("GET must run at once: %v %s hits=%d approvals=%d", isError, text, hits.Load(), approvals.count())
	}
}

func TestAgentBridgeCancelWhileWaitingWritesNothing(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	rt := newAgentRuntime()
	bridge := newAgentToolBridge(mcpServerOptions{workspace: root, env: "Local"}, "chat-1", nil)
	asked := make(chan model.AgentApproval, 1)
	bridge.approve = rt.approve(func(name string, payload any) {
		if name == "agent:approval" {
			asked <- payload.(model.AgentApproval)
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan bool, 1)
	go func() {
		_, isError := bridge.call(ctx, aiTool{Name: "set_variable", Original: "set_variable", ServerIndex: -1}, `{"environment":"Local","key":"token","value":"x"}`, "c")
		done <- isError
	}()
	approval := <-asked
	if pending := rt.pending("chat-1"); len(pending) != 1 || pending[0].ID != approval.ID {
		t.Fatalf("pending = %+v", pending)
	}
	cancel()
	select {
	case isError := <-done:
		if !isError {
			t.Fatal("a cancelled call must fail")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel did not stop the waiting call")
	}
	if len(rt.pending("")) != 0 {
		t.Fatal("the approval must be dropped after cancel")
	}
	if strings.Contains(readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml"), "token") {
		t.Fatal("a cancelled change was written")
	}
	if err := rt.answer(approval.ID, model.AgentApprovalAllow); err == nil {
		t.Fatal("answering a closed approval should fail")
	}
}

func TestAgentApprovalRejectsAChangeIfTheFileMovedOnMeanwhile(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	envFile := filepath.Join(root, "workspaces", "Demo", "environments", "Local.yml")
	bridge := newAgentToolBridge(mcpServerOptions{workspace: root, env: "Local"}, "chat-1", nil)
	bridge.approve = func(_ context.Context, _ model.AgentApproval) string {
		data, _ := os.ReadFile(envFile)
		_ = os.WriteFile(envFile, append(data, []byte("# edited\n")...), 0o644)
		return model.AgentApprovalAllow
	}
	text, isError := bridge.call(context.Background(), aiTool{Name: "set_variable", Original: "set_variable", ServerIndex: -1}, `{"environment":"Local","key":"token","value":"x"}`, "c")
	if !isError || !strings.Contains(text, "changed while waiting") {
		t.Fatalf("result = %v %s", isError, text)
	}
	if data, _ := os.ReadFile(envFile); strings.Contains(string(data), "token") {
		t.Fatal("the stale change was written over the user's edit")
	}
}

func TestAgentRevertRefusesFilesChangedSince(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, _ := newTestAgentBridge(t, root, model.AgentApprovalAllow)
	if text, isError := agentBridgeCall(t, bridge, "set_variable", map[string]any{"environment": "Local", "key": "token", "value": "abc"}); isError {
		t.Fatal(text)
	}
	entries, _ := listAgentActivity(model.AgentActivityFilter{Tool: "set_variable"})
	if len(entries) != 1 {
		t.Fatalf("entries = %+v", entries)
	}
	envFile := filepath.Join(root, "workspaces", "Demo", "environments", "Local.yml")
	data, _ := os.ReadFile(envFile)
	if err := os.WriteFile(envFile, append(data, []byte("# edited\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := revertAgentActivity(entries[0].ID, ""); err == nil || !strings.Contains(err.Error(), "changed since") {
		t.Fatalf("revert err = %v", err)
	}
	if after, _ := os.ReadFile(envFile); !strings.Contains(string(after), "# edited") {
		t.Fatal("revert overwrote a later edit")
	}
}

func TestMCPServerLogsClientCallsWithTheirFiles(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	h := startMCPHarness(t, mcpServerOptions{workspace: root, env: "Local"})
	h.request("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "claude-code", "version": "1"}})
	h.tool("set_variable", map[string]any{"environment": "Local", "key": "region", "value": "eu"}, nil)

	entries, err := listAgentActivity(model.AgentActivityFilter{Client: "claude-code"})
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries = %+v, %v", entries, err)
	}
	entry, err := readAgentActivity(entries[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if entry.Tool != "set_variable" || entry.Workspace != root || len(entry.Changes) != 1 || entry.Changes[0].Before == nil || !strings.Contains(*entry.Changes[0].After, "region") || strings.Contains(*entry.Changes[0].Before, "region") {
		t.Fatalf("entry = %+v", entry)
	}
	if !strings.Contains(entry.Arguments, `"region"`) || entry.Result == "" {
		t.Fatalf("entry arguments/result = %q / %q", entry.Arguments, entry.Result)
	}

	if result := NewApp().SetAgentActivityEnabled(false); !result.Ok {
		t.Fatal(result.Error)
	}
	h.tool("list_requests", map[string]any{}, nil)
	if list := NewApp().AgentActivity(model.AgentActivityFilter{}); list.Enabled || len(list.Entries) != 1 {
		t.Fatalf("with the log off nothing is written: %+v", list)
	}
}

func TestAgentActivityRedactsSecretsAndPrunesOldEntries(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	if err := writeAgentActivity(model.AgentActivityEntry{AgentActivitySummary: model.AgentActivitySummary{ID: newAgentActivityID(time.Now().Add(-40 * 24 * time.Hour)), Tool: "old"}}); err != nil {
		t.Fatal(err)
	}
	if err := writeAgentActivity(model.AgentActivityEntry{AgentActivitySummary: model.AgentActivitySummary{Tool: "new"}, Arguments: agentActivityText(`{"token":"s3cret-value"}`, []string{"s3cret-value"})}); err != nil {
		t.Fatal(err)
	}
	entries, err := listAgentActivity(model.AgentActivityFilter{})
	if err != nil || len(entries) != 1 || entries[0].Tool != "new" {
		t.Fatalf("entries = %+v, %v", entries, err)
	}
	entry, _ := readAgentActivity(entries[0].ID)
	if strings.Contains(entry.Arguments, "s3cret") || !strings.Contains(entry.Arguments, "[secret]") {
		t.Fatalf("arguments = %s", entry.Arguments)
	}
	raw, _ := os.ReadFile(filepath.Join(agentActivityDir(), entries[0].ID+".json"))
	if strings.Contains(string(raw), "new") {
		t.Fatal("activity files must be encrypted")
	}
}

func TestAgentCloseToolUsesAnswersDanglingCalls(t *testing.T) {
	messages := agentCloseToolUses([]model.AiMessage{
		{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "hi"}}},
		{Role: "assistant", Blocks: []model.AiBlock{{Type: model.AiBlockToolUse, ID: "c1", Name: "list_requests", Input: "{}"}}},
	})
	if len(messages) != 3 || messages[2].Role != "tool" || messages[2].Blocks[0].ID != "c1" || !messages[2].Blocks[0].IsError {
		t.Fatalf("messages = %+v", messages)
	}
	if again := agentCloseToolUses(messages); len(again) != 3 {
		t.Fatal("a closed conversation is left alone")
	}
}

func copyWorkspaceTo(t *testing.T, from, to string) {
	t.Helper()
	files, err := readWorkspaceFileContents(from)
	if err != nil {
		t.Fatal(err)
	}
	for rel, data := range files {
		target := filepath.Join(to, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSendAgentMessageRunsToolsAsksAndKeepsTheChat(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)
	root := fileWorkspaceStorePath()
	copyWorkspaceTo(t, agentTestWorkspace(t, "http://127.0.0.1:1"), root)
	shop := fixtureWorkspaceID(t, root)

	llm := newAiTestServer(t,
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_requests","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`),
			openAIChunkEvent(`[DONE]`),
		}},
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"set_variable","arguments":"{\"environment\":\"Local\",\"key\":\"region\",\"value\":\"eu\"}"}}]},"finish_reason":"tool_calls"}]}`),
			openAIChunkEvent(`[DONE]`),
		}},
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"Set region to eu."},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}`),
			openAIChunkEvent(`[DONE]`),
		}},
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"You are welcome."},"finish_reason":"stop"}]}`),
			openAIChunkEvent(`[DONE]`),
		}},
	)
	app := NewApp()
	if state := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: llm.URL, Key: "sk-agent-test-key", Model: "test-model"}); state.Error != "" {
		t.Fatal(state.Error)
	}
	var mu sync.Mutex
	var events []string
	app.agentEmit = func(name string, payload any) {
		mu.Lock()
		events = append(events, name)
		mu.Unlock()
		if name == "agent:approval" {
			approval := payload.(model.AgentApproval)
			go app.AnswerAgentApproval(approval.ID, model.AgentApprovalAllow)
		}
	}

	turn := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: shop, Text: "Set   the region\nto eu", Collection: "Smoke", Environment: "Local"})
	if turn.Error != "" {
		t.Fatalf("turn error %q", turn.Error)
	}
	if turn.Text != "Set region to eu." || len(turn.Steps) != 3 || turn.Usage.Input != 10 {
		t.Fatalf("turn text=%q steps=%d usage=%+v", turn.Text, len(turn.Steps), turn.Usage)
	}
	if !strings.Contains(readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml"), "region") {
		t.Fatal("the approved change was not written")
	}
	mu.Lock()
	joined := strings.Join(events, ",")
	mu.Unlock()
	for _, want := range []string{"ai:deltas", "ai:step", "ai:tool", "agent:approval", "agent:approval-closed"} {
		if !strings.Contains(joined, want) {
			t.Errorf("events %s are missing %s", joined, want)
		}
	}

	first := llm.body(0)
	messages := first["messages"].([]any)
	system := messages[0].(map[string]any)["content"].(string)
	for _, want := range []string{"Kurlo agent", "Smoke (2 requests)", "Environments: Local", "collection Smoke", "environment Local"} {
		if !strings.Contains(system, want) {
			t.Errorf("system prompt is missing %q:\n%s", want, system)
		}
	}
	if tools := first["tools"].([]any); len(tools) < 10 {
		t.Fatalf("the agent should offer Kurlo's tools, got %d", len(tools))
	}
	if llm.headers[0].Get("Authorization") != "Bearer sk-agent-test-key" {
		t.Fatalf("authorization = %q", llm.headers[0].Get("Authorization"))
	}

	chat := turn.Chat
	if chat.WorkspaceID != shop || chat.ID == "" || chat.Title != "Set the region to eu" || chat.Collection != "Smoke" || chat.Environment != "Local" || len(chat.Messages) != 6 || chat.Usage.Input != 10 {
		t.Fatalf("chat = %+v", chat)
	}
	if summaries := app.AgentChats(shop); len(summaries) != 1 || summaries[0].ID != chat.ID {
		t.Fatalf("summaries = %+v", summaries)
	}
	raw, _ := os.ReadFile(filepath.Join(agentChatsDir(), chat.ID+".json"))
	if strings.Contains(string(raw), "region") {
		t.Fatal("chats must be stored encrypted")
	}

	second := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: shop, ChatID: chat.ID, Text: "Thanks", Collection: "Smoke", Environment: "Local"})
	if second.Error != "" || second.Text != "You are welcome." || len(second.Chat.Messages) != 8 {
		t.Fatalf("second turn = %q %q %d", second.Error, second.Text, len(second.Chat.Messages))
	}
	if replay := llm.body(3)["messages"].([]any); len(replay) != 8 {
		t.Fatalf("the second turn must replay the chat, got %d messages", len(replay))
	}

	activity := app.AgentActivity(model.AgentActivityFilter{Client: model.AgentClientName})
	if len(activity.Entries) != 2 || activity.Entries[0].ChatID != chat.ID {
		t.Fatalf("activity = %+v", activity)
	}

	if result := app.DeleteAgentChat(chat.ID); !result.Ok || len(app.AgentChats(shop)) != 0 {
		t.Fatalf("delete = %+v chats=%d", result, len(app.AgentChats(shop)))
	}
	if _, err := app.AgentChat(chat.ID); err == nil {
		t.Fatal("a deleted chat must be gone")
	}
}

func TestSendAgentMessageNeedsAConnection(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	turn := NewApp().SendAgentMessage(model.AgentSendInput{Text: "hello"})
	if !strings.Contains(turn.Error, "Settings → AI") {
		t.Fatalf("error = %q", turn.Error)
	}
	if turn.Chat.ID == "" || len(turn.Chat.Messages) != 1 {
		t.Fatalf("the message is kept so it can be resent: %+v", turn.Chat)
	}
}

func TestAgentChatsAreScopedToTheWorkspaceAndExpire(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	now := time.Now()
	for i, workspace := range []string{"/a", "/a", "/b"} {
		if _, err := createAgentChat(model.AgentChat{ID: fmt.Sprintf("chat-%d", i), Workspace: workspace}); err != nil {
			t.Fatal(err)
		}
	}
	old, _ := readAgentChat("chat-1")
	old.UpdatedAt = now.Add(-100 * 24 * time.Hour).UnixMilli()
	if err := writeAgentChat(old); err != nil {
		t.Fatal(err)
	}
	chats, err := listAgentChats("/a", now)
	if err != nil || len(chats) != 1 || chats[0].ID != "chat-0" {
		t.Fatalf("chats = %+v, %v", chats, err)
	}
	if _, err := readAgentChat("chat-1"); !os.IsNotExist(err) {
		t.Fatalf("an expired chat is deleted, err = %v", err)
	}
	if _, err := agentChatPath("../x"); err == nil {
		t.Fatal("chat ids must not escape the folder")
	}
}

func TestAgentChatsStayInTheirSelectedWorkspace(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentWorkspaceKey(fileWorkspaceStorePath())
	for _, chat := range []model.AgentChat{
		{ID: "shop-chat", Title: "Shop", Workspace: root, WorkspaceID: "shop"},
		{ID: "shop-codex", Title: "Shop Codex", Driver: "codex", Workspace: root, WorkspaceID: "shop"},
		{ID: "other-chat", Title: "Other", Workspace: root, WorkspaceID: "other"},
		{ID: "foreign-chat", Title: "Foreign", Workspace: "another-folder", WorkspaceID: "shop"},
	} {
		if _, err := createAgentChat(chat); err != nil {
			t.Fatal(err)
		}
	}
	app := NewApp()
	for _, rebuild := range []bool{false, true} {
		if rebuild {
			if err := os.Remove(agentChatIndexPath()); err != nil {
				t.Fatal(err)
			}
		}
		shop := app.AgentChats("shop")
		if len(shop) != 2 {
			t.Fatalf("shop chats = %+v", shop)
		}
		for _, chat := range shop {
			if chat.WorkspaceID != "shop" || chat.ID == "foreign-chat" {
				t.Fatalf("foreign chat listed: %+v", chat)
			}
		}
		other := app.AgentChats("other")
		if len(other) != 1 || other[0].ID != "other-chat" {
			t.Fatalf("other chats = %+v", other)
		}
	}
	turn := app.SendAgentMessage(model.AgentSendInput{ChatID: "shop-chat", WorkspaceID: "other", Text: "Continue"})
	if !strings.Contains(turn.Error, "another workspace") {
		t.Fatalf("foreign chat resumed: %+v", turn)
	}
	saved, err := readAgentChat("shop-chat")
	if err != nil || saved.WorkspaceID != "shop" || len(saved.Messages) != 0 {
		t.Fatalf("chat changed: %+v, %v", saved, err)
	}
}

func TestAgentChatsRenameAndKeepAnIndex(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	if _, err := createAgentChat(model.AgentChat{ID: "chat-a", Title: "First", Workspace: "/w"}); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if result := app.RenameAgentChat("chat-a", "  Orders   checks  "); !result.Ok {
		t.Fatal(result.Error)
	}
	if result := app.RenameAgentChat("chat-a", "   "); result.Ok {
		t.Fatal("an empty name is refused")
	}
	chats, err := listAgentChats("/w", time.Now())
	if err != nil || len(chats) != 1 || chats[0].Title != "Orders checks" {
		t.Fatalf("chats = %+v, %v", chats, err)
	}
	if err := os.Remove(agentChatIndexPath()); err != nil {
		t.Fatal(err)
	}
	if chats, _ := listAgentChats("/w", time.Now()); len(chats) != 1 || chats[0].Title != "Orders checks" {
		t.Fatalf("the index is rebuilt from the chat files: %+v", chats)
	}
	if raw, _ := os.ReadFile(agentChatIndexPath()); strings.Contains(string(raw), "Orders") {
		t.Fatal("the index must be encrypted")
	}
	if _, err := agentChatPath("index"); err == nil {
		t.Fatal("the index file is not a chat")
	}
	if err := deleteAgentChat("chat-a"); err != nil {
		t.Fatal(err)
	}
	if chats, _ := listAgentChats("/w", time.Now()); len(chats) != 0 {
		t.Fatalf("deleted chats leave the index: %+v", chats)
	}
}

func TestAgentChatKeepsToolResultsBounded(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	huge := strings.Repeat("я", agentChatToolResultLimit)
	chat, err := createAgentChat(model.AgentChat{ID: "chat-b", Workspace: "/w", Messages: []model.AiMessage{
		{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "go"}}},
		{Role: "tool", Blocks: []model.AiBlock{{Type: model.AiBlockToolResult, ID: "c", Text: huge}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := readAgentChat(chat.ID)
	text := saved.Messages[1].Blocks[0].Text
	if len(text) > agentChatToolResultLimit+200 || !strings.Contains(text, "not kept") || !utf8.ValidString(text) {
		t.Fatalf("stored tool result is %d bytes, valid=%v", len(text), utf8.ValidString(text))
	}
}

func TestAgentHistoryForModelTrimsOldTurns(t *testing.T) {
	turn := func(prompt string, result string) []model.AiMessage {
		return []model.AiMessage{
			{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: prompt}}},
			{Role: "assistant", Blocks: []model.AiBlock{{Type: model.AiBlockThinking, Text: "hmm"}, {Type: model.AiBlockToolUse, ID: prompt, Name: "run_request", Input: "{}"}}},
			{Role: "tool", Blocks: []model.AiBlock{{Type: model.AiBlockToolResult, ID: prompt, Text: result}}},
			{Role: "assistant", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "done"}}},
		}
	}
	big := strings.Repeat("x", 5000)
	var messages []model.AiMessage
	for _, prompt := range []string{"one", "two", "three"} {
		messages = append(messages, turn(prompt, big)...)
	}
	out, dropped := agentHistoryForModel(messages, 0)
	if dropped || len(out) != len(messages) {
		t.Fatalf("len = %d dropped = %v", len(out), dropped)
	}
	if text := out[2].Blocks[0].Text; len(text) >= 5000 || !strings.Contains(text, "trimmed") {
		t.Fatalf("an old tool result is trimmed, got %d", len(text))
	}
	if len(out[1].Blocks) != 1 || out[1].Blocks[0].Type != model.AiBlockToolUse {
		t.Fatalf("old thinking is dropped and the tool call kept: %+v", out[1].Blocks)
	}
	if out[6].Blocks[0].Text != big || out[10].Blocks[0].Text != big || len(out[9].Blocks) != 2 {
		t.Fatal("the last two turns are sent in full")
	}
	if messages[2].Blocks[0].Text != big {
		t.Fatal("the saved chat is not changed")
	}

	var long []model.AiMessage
	for index := 0; index < 30; index++ {
		long = append(long, turn(fmt.Sprintf("t%d", index), strings.Repeat("y", 1900))...)
		long[len(long)-4].Blocks[0].Text = strings.Repeat("q", 20000)
	}
	cut, dropped := agentHistoryForModel(long, 0)
	if !dropped || cut[0].Role != "user" || len(cut) >= len(long) || cut[len(cut)-1].Blocks[0].Text != "done" {
		t.Fatalf("over the budget the oldest turns go: dropped=%v len=%d first=%s", dropped, len(cut), cut[0].Role)
	}
	if total := agentMessagesTokens(cut); total > agentContextBudget(agentDefaultContextTokens) {
		t.Fatalf("history is %d tokens", total)
	}
}

func TestAgentChatPagesKeepCompleteTurnsAndSavedHistory(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	messages := []model.AiMessage{}
	for i := 0; i < 123; i++ {
		messages = append(messages,
			model.AiMessage{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: fmt.Sprintf("Question %d", i)}}},
			model.AiMessage{Role: "assistant", Blocks: []model.AiBlock{{Type: model.AiBlockToolUse, ID: fmt.Sprint(i)}}},
			model.AiMessage{Role: "tool", Blocks: []model.AiBlock{{Type: model.AiBlockToolResult, ID: fmt.Sprint(i), Text: "result"}}},
			model.AiMessage{Role: "assistant", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "answer"}}},
		)
	}
	chat, err := createAgentChat(model.AgentChat{ID: "paged", Workspace: agentWorkspaceKey(fileWorkspaceStorePath()), Messages: messages})
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	page, err := app.AgentChatPage(chat.ID, -1)
	if err != nil || page.MessageOffset != 332 || len(page.Messages) != 160 || page.MessageCount != len(messages) {
		t.Fatalf("page: %+v, %v", page, err)
	}
	combined := page.Messages
	for page.MessageOffset > 0 {
		page, err = app.AgentChatPage(chat.ID, page.MessageOffset)
		if err != nil {
			t.Fatal(err)
		}
		if page.Messages[0].Role != "user" {
			t.Fatal("a turn was split")
		}
		combined = append(page.Messages, combined...)
	}
	want, _ := json.Marshal(messages)
	got, _ := json.Marshal(combined)
	if string(got) != string(want) {
		t.Fatal("paging lost or duplicated messages")
	}
	response := normalizeAgentTurn(model.AgentTurn{Chat: chat})
	if len(response.Chat.Messages) != 160 {
		t.Fatal("turn response sent the entire history")
	}
	saved, _ := loadAgentChat(chat.ID)
	if len(saved.Messages) != len(messages) || saved.MessageOffset != 0 {
		t.Fatal("paging changed stored history")
	}
	foreign := chat
	foreign.ID = "foreign-page"
	foreign.Workspace = "/another-workspace"
	if _, err := createAgentChat(foreign); err != nil {
		t.Fatal(err)
	}
	if _, err := app.AgentChatPage(foreign.ID, -1); err == nil {
		t.Fatal("loaded history from another workspace")
	}
}

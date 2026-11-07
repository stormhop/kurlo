package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type agentEvalCall struct {
	name string
	args map[string]any
}

type agentEvalHarness struct {
	t         *testing.T
	root      string
	target    *httptest.Server
	llm       *aiTestServer
	mu        sync.Mutex
	hits      []string
	approvals []model.AgentApproval
}

type agentEvalTask struct {
	name   string
	input  func(input *model.AgentSendInput)
	steps  [][]agentEvalCall
	decide func(approval model.AgentApproval) string
	check  func(h *agentEvalHarness, results []model.AiBlock)
}

func agentEvalScript(steps [][]agentEvalCall) []sseScript {
	scripts := make([]sseScript, 0, len(steps)+1)
	for stepIndex, calls := range steps {
		var toolCalls []map[string]any
		for index, call := range calls {
			args, _ := json.Marshal(call.args)
			toolCalls = append(toolCalls, map[string]any{"index": index, "id": fmt.Sprintf("call_%d_%d", stepIndex, index), "type": "function", "function": map[string]any{"name": call.name, "arguments": string(args)}})
		}
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": toolCalls}, "finish_reason": "tool_calls"}}})
		scripts = append(scripts, sseScript{events: []string{openAIChunkEvent(string(chunk)), openAIChunkEvent(`[DONE]`)}})
	}
	return append(scripts, sseScript{events: []string{
		openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`),
		openAIChunkEvent(`[DONE]`),
	}})
}

func newAgentEvalHarness(t *testing.T, task agentEvalTask) (*agentEvalHarness, *App, string) {
	t.Helper()
	useTempConfigDir(t, t.TempDir())
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)
	h := &agentEvalHarness{t: t}
	h.target = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		h.mu.Lock()
		h.hits = append(h.hits, r.Method+" "+r.URL.Path)
		h.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/fail" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `{"error":"database is down"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "method": r.Method, "path": r.URL.Path})
	}))
	t.Cleanup(h.target.Close)
	h.root = fileWorkspaceStorePath()
	copyWorkspaceTo(t, agentTestWorkspace(t, h.target.URL), h.root)
	shop := fixtureWorkspaceID(t, h.root)
	h.llm = newAiTestServer(t, agentEvalScript(task.steps)...)
	app := NewApp()
	t.Cleanup(func() { app.agentRuntime().closeMcpClients() })
	if state := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: h.llm.URL, Key: "sk-eval", Model: "eval-model"}); state.Error != "" {
		t.Fatal(state.Error)
	}
	decide := task.decide
	if decide == nil {
		decide = func(model.AgentApproval) string { return model.AgentApprovalAllow }
	}
	app.agentEmit = func(name string, payload any) {
		if name != "agent:approval" {
			return
		}
		approval := payload.(model.AgentApproval)
		h.mu.Lock()
		h.approvals = append(h.approvals, approval)
		h.mu.Unlock()
		go app.AnswerAgentApproval(approval.ID, decide(approval))
	}
	return h, app, shop
}

func (h *agentEvalHarness) hitCount(prefix string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	count := 0
	for _, hit := range h.hits {
		if strings.HasPrefix(hit, prefix) {
			count++
		}
	}
	return count
}

func (h *agentEvalHarness) approvalCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.approvals)
}

func (h *agentEvalHarness) store() *mcpStore {
	h.t.Helper()
	st, err := loadMCPStore(h.root)
	if err != nil {
		h.t.Fatal(err)
	}
	return st
}

func (h *agentEvalHarness) request(ref string) map[string]any {
	h.t.Helper()
	request, _, err := h.store().request(ref)
	if err != nil {
		return nil
	}
	return request
}

func (h *agentEvalHarness) filesContaining(text string) []string {
	h.t.Helper()
	files, err := readWorkspaceFileContents(h.root)
	if err != nil {
		h.t.Fatal(err)
	}
	var out []string
	for path, content := range files {
		if strings.Contains(string(content), text) {
			out = append(out, path)
		}
	}
	return out
}

func agentEvalResults(turn model.AgentTurn) []model.AiBlock {
	var out []model.AiBlock
	for _, message := range turn.Messages {
		for _, block := range message.Blocks {
			if block.Type == model.AiBlockToolResult {
				out = append(out, block)
			}
		}
	}
	return out
}

func evalCall(name string, args map[string]any) []agentEvalCall {
	if args == nil {
		args = map[string]any{}
	}
	return []agentEvalCall{{name: name, args: args}}
}

func evalExpect(h *agentEvalHarness, ok bool, format string, args ...any) {
	h.t.Helper()
	if !ok {
		h.t.Fatalf(format, args...)
	}
}

func rejectAll(model.AgentApproval) string { return model.AgentApprovalReject }

func agentEvalTasks() []agentEvalTask {
	newRequest := map[string]any{"collection": "Smoke", "name": "Health", "url": "{{baseUrl}}/health"}
	return []agentEvalTask{
		{
			name:  "lists the saved requests",
			steps: [][]agentEvalCall{evalCall("list_requests", nil)},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && strings.Contains(results[0].Text, "Ok") && strings.Contains(results[0].Text, "Chain") && h.approvalCount() == 0, "list = %+v", results)
			},
		},
		{
			name:  "reads one request",
			steps: [][]agentEvalCall{evalCall("get_request", map[string]any{"request": "Smoke/Ok"})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && strings.Contains(results[0].Text, "/ok"), "get = %+v", results)
			},
		},
		{
			name:  "runs a saved GET without asking",
			steps: [][]agentEvalCall{evalCall("run_request", map[string]any{"request": "Smoke/Ok"})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && strings.Contains(results[0].Text, "200") && h.hitCount("GET /ok") == 1 && h.approvalCount() == 0, "run = %+v hits %v", results, h.hits)
			},
		},
		{
			name:  "runs a whole collection",
			steps: [][]agentEvalCall{evalCall("run_collection", map[string]any{"collection": "Smoke"})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && h.hitCount("GET /ok") >= 2, "collection = %+v hits %v", results, h.hits)
			},
		},
		{
			name:  "sends a one-off GET without asking",
			steps: [][]agentEvalCall{evalCall("send_request", map[string]any{"method": "GET", "url": "{{baseUrl}}/ping"})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && h.hitCount("GET /ping") == 1 && h.approvalCount() == 0, "send = %+v", results)
			},
		},
		{
			name:   "asks before a POST and respects a refusal",
			steps:  [][]agentEvalCall{evalCall("send_request", map[string]any{"method": "POST", "url": "{{baseUrl}}/orders", "body": `{"sku":"a"}`})},
			decide: rejectAll,
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, results[0].IsError && strings.Contains(results[0].Text, "declined") && h.hitCount("POST") == 0 && h.approvalCount() == 1, "refused POST = %+v hits %v", results, h.hits)
			},
		},
		{
			name:  "sends a POST once approved",
			steps: [][]agentEvalCall{evalCall("send_request", map[string]any{"method": "POST", "url": "{{baseUrl}}/orders", "body": `{"sku":"a"}`})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && h.hitCount("POST /orders") == 1 && h.approvalCount() == 1, "approved POST = %+v hits %v", results, h.hits)
			},
		},
		{
			name:  "creates a request after review",
			steps: [][]agentEvalCall{evalCall("save_request", newRequest)},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				h.mu.Lock()
				changes := len(h.approvals) == 1 && len(h.approvals[0].Changes) > 0
				h.mu.Unlock()
				evalExpect(h, !results[0].IsError && h.request("Smoke/Health") != nil && changes, "save = %+v", results)
			},
		},
		{
			name:   "writes nothing when the change is declined",
			steps:  [][]agentEvalCall{evalCall("save_request", newRequest)},
			decide: rejectAll,
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, results[0].IsError && h.request("Smoke/Health") == nil, "declined save = %+v", results)
			},
		},
		{
			name:  "patches a request",
			steps: [][]agentEvalCall{evalCall("patch_request", map[string]any{"request": "Smoke/Ok", "patch": map[string]any{"url": "{{baseUrl}}/ok2"}})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && stringValue(h.request("Smoke/Ok"), "url") == "{{baseUrl}}/ok2", "patch = %+v", results)
			},
		},
		{
			name:  "deletes a request",
			steps: [][]agentEvalCall{evalCall("delete_request", map[string]any{"request": "Smoke/Chain"})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && h.request("Smoke/Chain") == nil && h.request("Smoke/Ok") != nil, "delete = %+v", results)
			},
		},
		{
			name:  "creates a collection",
			steps: [][]agentEvalCall{evalCall("create_collection", map[string]any{"name": "Billing"})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				_, err := h.store().collection("Billing")
				evalExpect(h, !results[0].IsError && err == nil, "collection = %+v err %v", results, err)
			},
		},
		{
			name:  "sets an environment variable",
			steps: [][]agentEvalCall{evalCall("set_variable", map[string]any{"environment": "Local", "key": "region", "value": "eu-west"})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && len(h.filesContaining("eu-west")) == 1, "variable = %+v", results)
			},
		},
		{
			name: "saves the last response as an example",
			steps: [][]agentEvalCall{
				evalCall("run_request", map[string]any{"request": "Smoke/Ok"}),
				evalCall("save_example", map[string]any{"request": "Smoke/Ok", "name": "Happy path"}),
			},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[1].IsError && len(h.filesContaining("Happy path")) == 1, "example = %+v", results)
			},
		},
		{
			name:  "writes tests from a real response",
			steps: [][]agentEvalCall{evalCall("generate_tests", map[string]any{"request": "Smoke/Ok", "saveExample": false})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				script := stringValue(h.request("Smoke/Ok"), "testScriptJs")
				evalExpect(h, !results[0].IsError && strings.Count(script, "pm.test") > 1, "generated tests = %+v script %q", results, script)
			},
		},
		{
			name:  "sees the status and body of a failing call",
			steps: [][]agentEvalCall{evalCall("send_request", map[string]any{"method": "GET", "url": "{{baseUrl}}/fail"})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, strings.Contains(results[0].Text, `"status": 500`) && strings.Contains(results[0].Text, "database is down"), "failing call = %+v", results)
			},
		},
		{
			name:  "says when the app has no failure to diagnose",
			steps: [][]agentEvalCall{evalCall("diagnose_last_failure", nil)},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, results[0].IsError && strings.Contains(results[0].Text, "history is empty"), "empty diagnosis = %+v", results)
			},
		},
		{
			name: "an approved plan runs its changes without more questions",
			steps: [][]agentEvalCall{
				evalCall(agentPlanTool, map[string]any{"summary": "Add billing", "steps": []string{"Create the collection", "Add a request"}, "calls": []map[string]any{{"tool": "create_collection"}, {"tool": "save_request"}}}),
				{{name: "create_collection", args: map[string]any{"name": "Billing"}}, {name: "save_request", args: newRequest}},
			},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				_, err := h.store().collection("Billing")
				evalExpect(h, len(results) == 3 && !results[1].IsError && !results[2].IsError && err == nil && h.request("Smoke/Health") != nil && h.approvalCount() == 1, "plan results %+v approvals %d", results, h.approvalCount())
			},
		},
		{
			name:  "auto mode writes without asking",
			input: func(input *model.AgentSendInput) { input.Mode = model.AgentModeAuto },
			steps: [][]agentEvalCall{evalCall("save_request", newRequest)},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && h.request("Smoke/Health") != nil && h.approvalCount() == 0, "auto = %+v approvals %d", results, h.approvalCount())
			},
		},
		{
			name:  "ask mode asks even for a GET",
			input: func(input *model.AgentSendInput) { input.Mode = model.AgentModeAsk },
			steps: [][]agentEvalCall{evalCall("run_request", map[string]any{"request": "Smoke/Ok"})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && h.approvalCount() == 1 && h.hitCount("GET /ok") == 1, "ask mode = %+v approvals %d", results, h.approvalCount())
			},
		},
		{
			name:  "stops at the request budget",
			input: func(input *model.AgentSendInput) { input.BudgetRequests = 1 },
			steps: [][]agentEvalCall{
				evalCall("send_request", map[string]any{"method": "GET", "url": "{{baseUrl}}/a"}),
				evalCall("send_request", map[string]any{"method": "GET", "url": "{{baseUrl}}/b"}),
			},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && results[1].IsError && strings.Contains(results[1].Text, "budget") && h.hitCount("GET /b") == 0, "budget = %+v", results)
			},
		},
		{
			name: "applies a batch of edits in one review",
			steps: [][]agentEvalCall{evalCall("apply_changes", map[string]any{"operations": []map[string]any{
				{"tool": "create_collection", "arguments": map[string]any{"name": "Ops"}},
				{"tool": "save_request", "arguments": map[string]any{"collection": "Ops", "name": "Status", "url": "{{baseUrl}}/status"}},
			}})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, !results[0].IsError && h.request("Ops/Status") != nil && h.approvalCount() == 1, "batch = %+v approvals %d", results, h.approvalCount())
			},
		},
		{
			name:  "proposes a change to the team notes",
			steps: [][]agentEvalCall{evalCall(agentNotesTool, map[string]any{"content": "# Team notes\n\n- Use the Local environment.\n", "reason": "Record the default environment."})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				data, err := os.ReadFile(filepath.Join(h.root, agentNotesFile))
				evalExpect(h, !results[0].IsError && err == nil && strings.Contains(string(data), "Use the Local environment") && h.approvalCount() == 1, "notes = %+v err %v", results, err)
			},
		},
		{
			name:  "reports an unknown tool back to the model",
			steps: [][]agentEvalCall{evalCall("does_not_exist", map[string]any{"x": 1})},
			check: func(h *agentEvalHarness, results []model.AiBlock) {
				evalExpect(h, len(results) == 1 && results[0].IsError, "unknown tool = %+v", results)
			},
		},
	}
}

func TestAgentReferenceTasksOnAFakeProvider(t *testing.T) {
	for _, task := range agentEvalTasks() {
		t.Run(task.name, func(t *testing.T) {
			h, app, shop := newAgentEvalHarness(t, task)
			input := model.AgentSendInput{WorkspaceID: shop, Text: task.name, Environment: "Local"}
			if task.input != nil {
				task.input(&input)
			}
			turn := app.SendAgentMessage(input)
			if turn.Error != "" || turn.Text != "Done." {
				t.Fatalf("turn error %q text %q warnings %v", turn.Error, turn.Text, turn.Warnings)
			}
			results := agentEvalResults(turn)
			want := 0
			for _, step := range task.steps {
				want += len(step)
			}
			if len(results) != want {
				t.Fatalf("got %d tool results, want %d: %+v", len(results), want, results)
			}
			h.llm.mu.Lock()
			calls := len(h.llm.bodies)
			h.llm.mu.Unlock()
			if calls != len(task.steps)+1 {
				t.Fatalf("the model was called %d times, want %d", calls, len(task.steps)+1)
			}
			task.check(h, results)
		})
	}
}

package api

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func agentToolTurn(id, text string) []model.AiMessage {
	return []model.AiMessage{
		{Role: "assistant", Blocks: []model.AiBlock{{Type: model.AiBlockToolUse, ID: id, Name: "get_request", Input: "{}"}}},
		{Role: "tool", Blocks: []model.AiBlock{{Type: model.AiBlockToolResult, ID: id, Name: "get_request", Text: text}}},
	}
}

func TestAgentTurnLoopCompactsOldToolResultsByTokens(t *testing.T) {
	big := strings.Repeat("x", 40_000)
	conversation := []model.AiMessage{{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "check"}}}}
	for _, id := range []string{"a", "b", "c", "d"} {
		conversation = append(conversation, agentToolTurn(id, big)...)
	}
	var events []model.AgentContext
	loop := &agentTurnLoop{chatID: "chat", turnID: "turn", window: 40_000, budget: 25_000, emit: func(name string, payload any) {
		if name == "agent:context" {
			events = append(events, payload.(model.AgentContext))
		}
	}}
	out, err := loop.prepare(1, conversation, model.AiStep{})
	if err != nil {
		t.Fatal(err)
	}
	if loop.compactions == 0 || agentMessagesTokens(out) > 25_000 {
		t.Fatalf("compactions=%d tokens=%d", loop.compactions, agentMessagesTokens(out))
	}
	if !strings.Contains(out[2].Blocks[0].Text, "compacted to fit") {
		t.Fatalf("the oldest result was not compacted: %.80q", out[2].Blocks[0].Text)
	}
	if out[len(out)-1].Blocks[0].Text != big || out[len(out)-3].Blocks[0].Text != big {
		t.Fatal("the two latest tool results must stay whole")
	}
	if conversation[2].Blocks[0].Text != big {
		t.Fatal("compaction must not change the saved messages")
	}
	if len(events) != 1 || events[0].Window != 40_000 || events[0].Tokens > 25_000 || events[0].Tokens == 0 {
		t.Fatalf("context events = %+v", events)
	}

	measured, _ := loop.prepare(2, conversation[:3], model.AiStep{HasUsage: true, Usage: model.AiUsage{Input: 100, CacheRead: 50}})
	if len(measured) != 3 || loop.lastTokens <= 150 || loop.lastTokens > 150+agentMessagesTokens(conversation[1:3]) {
		t.Fatalf("measured tokens = %d", loop.lastTokens)
	}
}

func TestAgentTurnLoopStopsAtTheChatBudget(t *testing.T) {
	loop := &agentTurnLoop{budget: 100_000, budgetLimit: 1_000, priorUsage: model.AiUsage{Input: 600}}
	if _, err := loop.prepare(1, nil, model.AiStep{Usage: model.AiUsage{Input: 300, Output: 50}}); err != nil {
		t.Fatalf("under budget: %v", err)
	}
	_, err := loop.prepare(2, nil, model.AiStep{Usage: model.AiUsage{Input: 100}})
	if err == nil || !strings.Contains(err.Error(), "budget of 1,000 tokens") {
		t.Fatalf("over budget error = %v", err)
	}
	if err := agentBudgetReached(model.AgentChat{BudgetRequests: 3, RequestsSent: 3}); err == nil {
		t.Fatal("a chat that sent its request budget must not start a turn")
	}
}

func TestAgentHistoryBudgetIsInTokens(t *testing.T) {
	var messages []model.AiMessage
	for i := 0; i < 6; i++ {
		messages = append(messages, model.AiMessage{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: strings.Repeat("y", 8_000)}}})
		messages = append(messages, model.AiMessage{Role: "assistant", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "ok"}}})
	}
	out, dropped := agentHistoryForModel(messages, 5_000)
	if !dropped || agentMessagesTokens(out) > 5_000 || out[0].Role != "user" {
		t.Fatalf("dropped=%v tokens=%d first=%s", dropped, agentMessagesTokens(out), out[0].Role)
	}
}

func TestAgentHostAllowlist(t *testing.T) {
	hosts := agentNormalizeHosts([]string{"http://LocalHost:8080/x", "*.staging.example.com, 127.0.0.1", "[::1]:3000", "*", "a*b", "{{baseUrl}}", "localhost"})
	if strings.Join(hosts, ",") != "localhost,*.staging.example.com,127.0.0.1,::1" {
		t.Fatalf("hosts = %v", hosts)
	}
	for host, want := range map[string]bool{"localhost": true, "api.staging.example.com": true, "staging.example.com": true, "evilstaging.example.com": false, "example.com": false, "::1": true, "": false} {
		if got := agentHostAllowed(host, hosts); got != want {
			t.Errorf("%q allowed = %v, want %v", host, got, want)
		}
	}
	if agentNormalizeMode("AUTO") != model.AgentModeAuto || agentNormalizeMode("writes") != "" || agentNormalizeMode("nope") != "" {
		t.Fatal("mode normalization")
	}
}

func agentChainPost(t *testing.T, root string) {
	t.Helper()
	post := filepath.Join(root, "workspaces", "Demo", "collections", "Smoke", "requests", "Chain.yml")
	data, err := os.ReadFile(post)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(post, []byte(strings.Replace(string(data), "    requestType: http", "    method: POST\n    requestType: http", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestAgentBridgeTrustedHostsRunUnsafeMethodsWithoutAsking(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server, hits := countingServer(t)
	root := agentTestWorkspace(t, server.URL)
	agentChainPost(t, root)
	bridge, approvals := newTestAgentBridge(t, root)

	bridge.setChat(model.AgentChat{ID: "chat-1", AllowedHosts: []string{"example.test"}}, nil)
	if text, isError := agentBridgeCall(t, bridge, "send_request", map[string]any{"method": "DELETE", "url": "{{baseUrl}}/orders/1"}); !isError || approvals.count() != 1 || hits.Load() != 0 {
		t.Fatalf("an untrusted host must ask: %v %s approvals=%d", isError, text, approvals.count())
	}

	bridge.setChat(model.AgentChat{ID: "chat-1", AllowedHosts: []string{"127.0.0.1"}}, nil)
	if text, isError := agentBridgeCall(t, bridge, "send_request", map[string]any{"method": "DELETE", "url": "{{baseUrl}}/orders/1"}); isError || approvals.count() != 1 || hits.Load() != 1 {
		t.Fatalf("a trusted host runs at once: %v %s approvals=%d hits=%d", isError, text, approvals.count(), hits.Load())
	}
	if text, _ := agentBridgeCall(t, bridge, "run_request", map[string]any{"request": "Smoke/Chain"}); approvals.count() != 1 || strings.Contains(text, "declined") {
		t.Fatalf("a saved POST to a trusted host runs at once: %s approvals=%d", text, approvals.count())
	}
	if text, isError := agentBridgeCall(t, bridge, "send_request", map[string]any{"method": "DELETE", "url": "http://example.test/x"}); !isError || approvals.count() != 2 {
		t.Fatalf("another host still asks: %v %s approvals=%d", isError, text, approvals.count())
	}

	bridge.setChat(model.AgentChat{ID: "chat-1", Mode: model.AgentModeAsk, AllowedHosts: []string{"127.0.0.1"}}, nil)
	if text, isError := agentBridgeCall(t, bridge, "run_request", map[string]any{"request": "Smoke/Ok"}); !isError || approvals.count() != 3 || !strings.Contains(approvals.last().Reason, "every request") {
		t.Fatalf("ask mode asks before a GET: %v %s approvals=%d", isError, text, approvals.count())
	}
	if text, isError := agentBridgeCall(t, bridge, "list_requests", map[string]any{}); isError || approvals.count() != 3 {
		t.Fatalf("ask mode still reads at once: %v %s", isError, text)
	}
}

func TestAgentBridgeSandboxEnvironmentRunsUnsafeMethods(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server, hits := countingServer(t)
	root := agentTestWorkspace(t, server.URL)
	agentChainPost(t, root)
	env := filepath.Join(root, "workspaces", "Demo", "environments", "Local.yml")
	data, err := os.ReadFile(env)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "name: Local") {
		t.Fatalf("Local.yml:\n%s", data)
	}
	if err := os.WriteFile(env, []byte(strings.Replace(string(data), "name: Local", "name: Local\n    sandbox: true", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	bridge, approvals := newTestAgentBridge(t, root)
	if text, isError := agentBridgeCall(t, bridge, "send_request", map[string]any{"method": "POST", "url": "{{baseUrl}}/orders"}); isError || approvals.count() != 0 || hits.Load() != 1 {
		t.Fatalf("a sandbox environment sends POST at once: %v %s approvals=%d hits=%d", isError, text, approvals.count(), hits.Load())
	}
}

func TestAgentBridgeAutoModeWritesWithoutAskingButNeverPushes(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, approvals := newTestAgentBridge(t, root)
	bridge.setChat(model.AgentChat{ID: "chat-1", Mode: model.AgentModeAuto}, nil)
	if text, isError := agentBridgeCall(t, bridge, "set_variable", map[string]any{"environment": "Local", "key": "region", "value": "eu"}); isError || approvals.count() != 0 {
		t.Fatalf("auto mode writes at once: %v %s approvals=%d", isError, text, approvals.count())
	}
	if !strings.Contains(readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml"), "region") {
		t.Fatal("auto write was not saved")
	}
	if decision := bridge.decide("git_push", json.RawMessage(`{}`)); !decision.ask {
		t.Fatalf("auto mode must still ask before git_push: %+v", decision)
	}
	if decision := bridge.decide("send_request", json.RawMessage(`{"method":"DELETE","url":"http://example.test/x"}`)); !decision.ask {
		t.Fatalf("auto mode must still ask before DELETE to an untrusted host: %+v", decision)
	}
}

func TestAgentBridgeStopsAtTheRequestBudget(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server, hits := countingServer(t)
	root := agentTestWorkspace(t, server.URL)
	bridge, _ := newTestAgentBridge(t, root)
	bridge.setChat(model.AgentChat{ID: "chat-1", BudgetRequests: 2, RequestsSent: 1}, nil)
	if text, isError := agentBridgeCall(t, bridge, "run_request", map[string]any{"request": "Smoke/Ok"}); isError {
		t.Fatalf("first request: %s", text)
	}
	text, isError := agentBridgeCall(t, bridge, "run_request", map[string]any{"request": "Smoke/Ok"})
	if !isError || !strings.Contains(text, "budget of 2 sent requests") || hits.Load() != 1 {
		t.Fatalf("over budget = %v %s hits=%d", isError, text, hits.Load())
	}
	if sent := bridge.takeRequestsSent(); sent != 1 {
		t.Fatalf("sent = %d", sent)
	}
}

func TestAnthropicPromptCachingMarksSystemToolsAndLastMessage(t *testing.T) {
	req := model.AiRequest{Model: "claude", System: "rules", Settings: model.AiSettings{CachePrompt: true}}
	body, _, err := anthropicProvider{}.build(req, []model.AiMessage{
		{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "hi"}}},
		{Role: "assistant", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "hello"}}},
		{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "again"}}},
	}, []aiTool{{Name: "a"}, {Name: "b"}})
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if strings.Count(text, `"cache_control":{"type":"ephemeral"}`) != 3 {
		t.Fatalf("body = %s", text)
	}
	var parsed struct {
		System   []map[string]any `json:"system"`
		Tools    []map[string]any `json:"tools"`
		Messages []struct {
			Content []map[string]any `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.System[0]["cache_control"] == nil || parsed.Tools[1]["cache_control"] == nil || parsed.Tools[0]["cache_control"] != nil || parsed.Messages[2].Content[0]["cache_control"] == nil {
		t.Fatalf("cache marks = %s", text)
	}
	plain, _, _ := anthropicProvider{}.build(model.AiRequest{Model: "claude", System: "rules"}, nil, nil)
	if strings.Contains(string(plain), "cache_control") || !strings.Contains(string(plain), `"system":"rules"`) {
		t.Fatalf("plain body = %s", plain)
	}
}

func TestOpenRouterReportsTheCostOfAStep(t *testing.T) {
	req := model.AiRequest{Model: "m", HTTP: model.HttpRequest{URL: "https://openrouter.ai/api/v1"}, Settings: model.AiSettings{Stream: true}}
	body, _, err := openAIProvider{}.build(req, nil, nil)
	if err != nil || !strings.Contains(string(body), `"usage":{"include":true}`) {
		t.Fatalf("body = %s err=%v", body, err)
	}
	other, _, _ := openAIProvider{}.build(model.AiRequest{Model: "m", HTTP: model.HttpRequest{URL: "https://api.openai.com/v1"}}, nil, nil)
	if strings.Contains(string(other), `"usage"`) {
		t.Fatalf("other providers get no usage flag: %s", other)
	}
	decoder := &openAIDecoder{toolIndex: map[int]int{}}
	decoder.applyUsage(&openAIUsage{PromptTokens: 10, CompletionTokens: 2, Cost: func() *float64 { v := 0.0042; return &v }()})
	if decoder.usage.Cost != 0.0042 {
		t.Fatalf("cost = %v", decoder.usage.Cost)
	}
}

func TestAgentContextWindowComesFromTheModelList(t *testing.T) {
	models, err := parseAiConnectionModels([]byte(`{"data":[{"id":"big","context_length":200000},{"id":"anthropic","max_input_tokens":100000},{"id":"plain"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	rememberAiModelWindows("https://example.test/v1/", models)
	if got := agentContextWindow(savedAiConnection{}, "https://example.test/v1", "big"); got != 200_000 {
		t.Fatalf("big = %d", got)
	}
	if got := agentContextWindow(savedAiConnection{}, "https://example.test/v1", "anthropic"); got != 100_000 {
		t.Fatalf("anthropic = %d", got)
	}
	if got := agentContextWindow(savedAiConnection{}, "https://example.test/v1", "plain"); got != agentDefaultContextTokens {
		t.Fatalf("plain = %d", got)
	}
	if got := agentContextWindow(savedAiConnection{Kind: model.AiConnectionLocal}, "http://localhost:11434/v1", "llama"); got != agentLocalContextTokens {
		t.Fatalf("local = %d", got)
	}
}

func TestAgentApprovedPlanAllowsOnlyItsCalls(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalAllow, model.AgentApprovalReject, model.AgentApprovalReject)
	bridge.setTurn("turn-1")

	text, isError := agentBridgeCall(t, bridge, agentPlanTool, map[string]any{
		"summary": "Add a region variable and a smoke request.",
		"steps":   []string{"Set region", "Save the request"},
		"calls":   []map[string]any{{"tool": "set_variable", "target": "region"}, {"tool": "save_request"}},
	})
	if isError || !strings.Contains(text, "approved") {
		t.Fatalf("plan = %v %s", isError, text)
	}
	plan := approvals.last()
	if plan.Plan == nil || len(plan.Plan.Steps) != 2 || len(plan.Plan.Calls) != 2 || plan.Tool != agentPlanTool {
		t.Fatalf("plan approval = %+v", plan)
	}
	if text, isError := agentBridgeCall(t, bridge, "set_variable", map[string]any{"environment": "Local", "key": "region", "value": "eu"}); isError || approvals.count() != 1 {
		t.Fatalf("a planned write runs at once: %v %s approvals=%d", isError, text, approvals.count())
	}
	if text, isError := agentBridgeCall(t, bridge, "set_variable", map[string]any{"environment": "Local", "key": "region", "value": "us"}); isError || approvals.count() != 1 {
		t.Fatalf("the same planned target can change again: %v %s", isError, text)
	}
	if text, isError := agentBridgeCall(t, bridge, "save_request", map[string]any{"collection": "Smoke", "name": "New", "url": "{{baseUrl}}/new"}); isError || approvals.count() != 1 {
		t.Fatalf("a planned call without a target runs once: %v %s", isError, text)
	}
	if _, isError := agentBridgeCall(t, bridge, "save_request", map[string]any{"collection": "Smoke", "name": "Again", "url": "{{baseUrl}}/again"}); !isError || approvals.count() != 2 {
		t.Fatalf("a second call beyond the plan must ask: approvals=%d", approvals.count())
	}
	if _, isError := agentBridgeCall(t, bridge, "set_variable", map[string]any{"environment": "Local", "key": "token", "value": "x"}); !isError || approvals.count() != 3 {
		t.Fatalf("a target outside the plan must ask: approvals=%d", approvals.count())
	}
	bridge.setTurn("turn-2")
	if decision := bridge.planCovers("set_variable", json.RawMessage(`{"key":"region"}`)); decision {
		t.Fatal("a plan ends with its turn")
	}
	if _, err := agentParsePlan(`{"summary":"x","steps":["push"],"calls":[{"tool":"git_push"}]}`); err == nil {
		t.Fatal("git_push cannot be planned")
	}
}

func TestAgentWorkspaceNotesFeedThePromptTemplatesAndUpdates(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	notes := "# Team notes\n\nUse the Local environment for tests.\n\n## Templates\n\n### Smoke check\nRun the Smoke collection and explain failures.\n\n### Empty\n\n## Other\n### Not a template\ntext\n"
	if err := os.WriteFile(filepath.Join(root, agentNotesFile), []byte(notes), 0o644); err != nil {
		t.Fatal(err)
	}
	templates := parseAgentTemplates(notes)
	if len(templates) != 1 || templates[0].Title != "Smoke check" || templates[0].Text != "Run the Smoke collection and explain failures." {
		t.Fatalf("templates = %+v", templates)
	}
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalAllowChat, model.AgentApprovalReject)
	prompt := agentSystemPrompt(bridge.server, model.AgentChat{})
	if !strings.Contains(prompt, "Use the Local environment for tests.") || !strings.Contains(prompt, "update_agent_notes") {
		t.Fatalf("prompt misses the notes:\n%s", prompt)
	}
	next := notes + "\nAlways tag smoke requests with smoke.\n"
	if text, isError := agentBridgeCall(t, bridge, agentNotesTool, map[string]any{"content": next, "reason": "Adds the tagging rule."}); isError || !strings.Contains(text, "Saved") {
		t.Fatalf("update = %v %s", isError, text)
	}
	approval := approvals.last()
	if approval.Reason != "Adds the tagging rule." || len(approval.Changes) != 1 || approval.Changes[0].Path != agentNotesFile || *approval.Changes[0].Before != notes {
		t.Fatalf("approval = %+v", approval)
	}
	if data, _ := os.ReadFile(filepath.Join(root, agentNotesFile)); string(data) != next {
		t.Fatalf("file = %q", data)
	}
	if _, isError := agentBridgeCall(t, bridge, agentNotesTool, map[string]any{"content": "# Gone\n"}); !isError || approvals.count() != 2 {
		t.Fatalf("notes always ask, even after Allow for this chat: approvals=%d", approvals.count())
	}
	entries, _ := listAgentActivity(model.AgentActivityFilter{})
	if len(entries) != 2 || entries[0].Tool != agentNotesTool {
		t.Fatalf("activity = %+v", entries)
	}
}

type parallelProbe struct {
	mu      sync.Mutex
	active  int
	peak    int
	release chan struct{}
}

func (p *parallelProbe) tools() []aiTool {
	return []aiTool{{Name: "read_a", Original: "read_a", ServerIndex: -1}, {Name: "write_b", Original: "write_b", ServerIndex: -1}}
}

func (p *parallelProbe) parallel(name string) bool { return name == "read_a" }

func (p *parallelProbe) call(_ context.Context, tool aiTool, input, _ string) (string, bool) {
	p.mu.Lock()
	p.active++
	if p.active > p.peak {
		p.peak = p.active
	}
	if p.active == 3 {
		close(p.release)
	}
	p.mu.Unlock()
	if tool.Original == "read_a" {
		select {
		case <-p.release:
		case <-time.After(2 * time.Second):
		}
	}
	p.mu.Lock()
	p.active--
	p.mu.Unlock()
	return tool.Original + input, false
}

func TestAiRunnerRunsReadToolsOfOneStepInParallel(t *testing.T) {
	probe := &parallelProbe{release: make(chan struct{})}
	var published []string
	var mu sync.Mutex
	runner := aiRunner{ctx: context.Background(), local: probe, emit: func(name string, payload any) {
		mu.Lock()
		published = append(published, payload.(model.AiToolResultEvent).Block.ID)
		mu.Unlock()
	}}
	blocks := []model.AiBlock{
		{Type: model.AiBlockToolUse, ID: "1", Name: "read_a", Input: "1"},
		{Type: model.AiBlockToolUse, ID: "2", Name: "read_a", Input: "2"},
		{Type: model.AiBlockToolUse, ID: "3", Name: "read_a", Input: "3"},
		{Type: model.AiBlockToolUse, ID: "4", Name: "write_b", Input: "4"},
	}
	start := time.Now()
	results := runner.callTools(0, blocks, probe.tools())
	if probe.peak != 3 || time.Since(start) > time.Second {
		t.Fatalf("peak = %d after %s", probe.peak, time.Since(start))
	}
	if len(results) != 4 || results[0].Text != "read_a1" || results[2].Text != "read_a3" || results[3].Text != "write_b4" {
		t.Fatalf("results = %+v", results)
	}
	if strings.Join(published, ",") != "1,2,3,4" {
		t.Fatalf("published = %v", published)
	}
}

func TestAgentBridgeReadToolsAreSafeToRunTogether(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, _ := newTestAgentBridge(t, root)
	var wg sync.WaitGroup
	for _, name := range []string{"list_requests", "list_environments", "get_request", "diagnose_last_failure", "list_history"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			args := map[string]any{}
			if name == "get_request" {
				args["request"] = "Smoke/Ok"
			}
			if text, isError := agentBridgeCall(t, bridge, name, args); isError && name != "diagnose_last_failure" {
				t.Errorf("%s: %s", name, text)
			}
		}(name)
	}
	wg.Wait()
}

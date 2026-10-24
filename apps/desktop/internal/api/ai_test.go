package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type aiEventLog struct {
	mu     sync.Mutex
	deltas []model.AiDeltaEvent
	steps  []model.AiStep
	tools  []model.AiBlock
}

func (l *aiEventLog) emit(name string, payload any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	switch name {
	case "ai:deltas":
		l.deltas = append(l.deltas, payload.(model.AiDeltaBatch).Deltas...)
	case "ai:step":
		l.steps = append(l.steps, payload.(model.AiStepEvent).Step)
	case "ai:tool":
		l.tools = append(l.tools, payload.(model.AiToolResultEvent).Block)
	}
}

func newTestAiRunner(req model.AiRequest, mcp func(model.HttpRequest) model.McpResponse) (*aiRunner, *aiEventLog) {
	sm := state.New()
	jars := newCookieJarRegistry()
	cache := newPreflightCache()
	log := &aiEventLog{}
	return &aiRunner{
		ctx:      context.Background(),
		req:      req,
		provider: aiProviderFor(req.Provider),
		emit:     log.emit,
		send: func(ctx context.Context, prepared model.HttpRequest, sink responseBodySinkFactory) model.HttpResponse {
			return sendRequestWithBodySink(ctx, prepared, sm, jars, cache, sink)
		},
		mcp: mcp,
		now: time.Now,
	}, log
}

type sseScript struct {
	events []string
	status int
	json   string
}

type aiTestServer struct {
	*httptest.Server
	mu      sync.Mutex
	bodies  []map[string]any
	headers []http.Header
	paths   []string
}

func newAiTestServer(t *testing.T, scripts ...sseScript) *aiTestServer {
	t.Helper()
	s := &aiTestServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		s.mu.Lock()
		index := len(s.bodies)
		s.bodies = append(s.bodies, body)
		s.headers = append(s.headers, r.Header.Clone())
		s.paths = append(s.paths, r.URL.Path)
		s.mu.Unlock()
		if index >= len(scripts) {
			http.Error(w, "unexpected request", http.StatusTeapot)
			return
		}
		script := scripts[index]
		if script.json != "" || script.status != 0 {
			w.Header().Set("Content-Type", "application/json")
			if script.status != 0 {
				w.WriteHeader(script.status)
			}
			_, _ = io.WriteString(w, script.json)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		for _, ev := range script.events {
			_, _ = io.WriteString(w, ev+"\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *aiTestServer) body(i int) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bodies[i]
}

func openAIChunkEvent(payload string) string {
	return "data: " + payload
}

func anthropicSSE(kind, payload string) string {
	return "event: " + kind + "\ndata: " + payload
}

func aiTestRequest(provider, url string) model.AiRequest {
	return model.AiRequest{
		HTTP:     model.HttpRequest{RequestID: "ai-1", URL: url, Auth: model.AuthConfig{Type: "bearer", Token: "sk-test"}},
		Provider: provider,
		Model:    "test-model",
		System:   "Be brief.",
		Messages: []model.AiMessage{{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "Hi"}}}},
		Settings: model.AiSettings{Stream: true, MaxTokens: 256},
	}
}

func TestAiOpenAIStreamAssemblesTextAndUsage(t *testing.T) {
	server := newAiTestServer(t, sseScript{events: []string{
		openAIChunkEvent(`{"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`),
		openAIChunkEvent(`{"model":"gpt-test","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}`),
		openAIChunkEvent(`{"model":"gpt-test","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}`),
		openAIChunkEvent(`{"model":"gpt-test","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}}}`),
		openAIChunkEvent(`[DONE]`),
	}})
	runner, log := newTestAiRunner(aiTestRequest(model.AiProviderOpenAI, server.URL+"/v1"), nil)
	out := runner.run()

	if out.Error != "" {
		t.Fatalf("unexpected error %q", out.Error)
	}
	if out.Text != "Hello" || out.StopReason != model.AiStopEndTurn {
		t.Fatalf("text=%q stop=%q", out.Text, out.StopReason)
	}
	if out.Usage.Input != 12 || out.Usage.CacheRead != 8 || out.Usage.Output != 2 || !out.HasUsage {
		t.Fatalf("usage %+v", out.Usage)
	}
	if server.paths[0] != "/v1/chat/completions" {
		t.Fatalf("path %q", server.paths[0])
	}
	if out.Steps[0].URL != server.URL+"/v1/chat/completions" || out.Steps[0].Method != "POST" || !strings.Contains(out.Steps[0].RequestBody, `"model":"test-model"`) {
		t.Fatalf("step request %s %s %s", out.Steps[0].Method, out.Steps[0].URL, out.Steps[0].RequestBody)
	}
	body := server.body(0)
	if body["max_tokens"] != float64(256) || body["stream"] != true {
		t.Fatalf("body %v", body)
	}
	messages := body["messages"].([]any)
	if messages[0].(map[string]any)["role"] != "system" || messages[1].(map[string]any)["content"] != "Hi" {
		t.Fatalf("messages %v", messages)
	}
	if got := server.headers[0].Get("Authorization"); got != "Bearer sk-test" {
		t.Fatalf("auth header %q", got)
	}
	text := ""
	for _, d := range log.deltas {
		text += d.Text
	}
	if text != "Hello" {
		t.Fatalf("deltas assembled %q", text)
	}
	if len(log.steps) != 1 || log.steps[0].StopReason != model.AiStopEndTurn {
		t.Fatalf("step events %+v", log.steps)
	}
	if !strings.Contains(out.HTTP.Body, "[DONE]") {
		t.Fatalf("raw stream not kept: %q", out.HTTP.Body)
	}
}

func TestAiEndpointKeepsAFullPath(t *testing.T) {
	cases := map[string]string{
		"https://api.deepseek.com/v1":                                              "https://api.deepseek.com/v1/chat/completions",
		"https://api.deepseek.com/v1/":                                             "https://api.deepseek.com/v1/chat/completions",
		"https://api.deepseek.com/v1/chat/completions":                             "https://api.deepseek.com/v1/chat/completions",
		"https://api.deepseek.com":                                                 "https://api.deepseek.com/chat/completions",
		"https://x.openai.azure.com/openai/deployments/gpt?api-version=2024-10-21": "https://x.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21",
		"https://x.test/v1/chat/completions/?api-version=1":                        "https://x.test/v1/chat/completions?api-version=1",
	}
	for in, want := range cases {
		if got := (openAIProvider{}).endpoint(in); got != want {
			t.Fatalf("%s -> %s, want %s", in, got, want)
		}
	}
}

func TestAiOpenAIUsesCompletionTokensOnOpenAIHost(t *testing.T) {
	req := aiTestRequest(model.AiProviderOpenAI, "https://api.openai.com/v1")
	body, _, err := openAIProvider{}.build(req, req.Messages, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"max_completion_tokens":256`) || strings.Contains(string(body), `"max_tokens"`) {
		t.Fatalf("body %s", body)
	}
}

func TestAiOpenAIToolLoopCallsMcpAndContinues(t *testing.T) {
	server := newAiTestServer(t,
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}`),
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}}]}`),
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Lisbon\"}"}}]},"finish_reason":"tool_calls"}]}`),
			openAIChunkEvent(`[DONE]`),
		}},
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"Bring an umbrella."},"finish_reason":"stop"}]}`),
			openAIChunkEvent(`[DONE]`),
		}},
	)
	req := aiTestRequest(model.AiProviderOpenAI, server.URL)
	req.ToolServers = []model.AiToolServer{{Name: "Weather", Request: model.HttpRequest{URL: "http://mcp.test"}}}
	var calls []model.HttpRequest
	mcp := func(r model.HttpRequest) model.McpResponse {
		calls = append(calls, r)
		if r.McpMethod == "tools/list" {
			return model.McpResponse{Tools: []model.McpTool{{Name: "get_weather", Description: "Forecast", InputSchema: `{"type":"object","properties":{"city":{"type":"string"}}}`}}}
		}
		return model.McpResponse{Content: []model.McpContent{{Type: "text", Text: `{"rain":0.72}`}}}
	}
	runner, log := newTestAiRunner(req, mcp)
	out := runner.run()

	if out.Error != "" {
		t.Fatalf("unexpected error %q", out.Error)
	}
	if len(out.Steps) != 2 || out.Text != "Bring an umbrella." {
		t.Fatalf("steps=%d text=%q", len(out.Steps), out.Text)
	}
	if len(calls) != 2 || calls[1].McpMethod != "tools/call" || calls[1].McpName != "get_weather" || calls[1].McpArguments != `{"city":"Lisbon"}` {
		t.Fatalf("mcp calls %+v", calls)
	}
	tools := server.body(0)["tools"].([]any)
	fn := tools[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "get_weather" || fn["description"] != "Forecast" {
		t.Fatalf("tools %v", tools)
	}
	second := server.body(1)["messages"].([]any)
	assistant := second[2].(map[string]any)
	toolMsg := second[3].(map[string]any)
	if assistant["role"] != "assistant" || assistant["tool_calls"] == nil {
		t.Fatalf("assistant message %v", assistant)
	}
	if toolMsg["role"] != "tool" || toolMsg["tool_call_id"] != "call_1" || toolMsg["content"] != `{"rain":0.72}` {
		t.Fatalf("tool message %v", toolMsg)
	}
	if len(log.tools) != 1 || log.tools[0].Server != "Weather" {
		t.Fatalf("tool events %+v", log.tools)
	}
	if len(out.Messages) != 3 {
		t.Fatalf("messages appended %d", len(out.Messages))
	}
}

func TestAiStopsAtStepLimitWithWarning(t *testing.T) {
	toolCall := sseScript{events: []string{
		openAIChunkEvent(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"ping","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`),
	}}
	server := newAiTestServer(t, toolCall, toolCall)
	req := aiTestRequest(model.AiProviderOpenAI, server.URL)
	req.MaxSteps = 2
	req.ToolServers = []model.AiToolServer{{Name: "S", Request: model.HttpRequest{URL: "http://mcp.test"}}}
	mcp := func(r model.HttpRequest) model.McpResponse {
		if r.McpMethod == "tools/list" {
			return model.McpResponse{Tools: []model.McpTool{{Name: "ping"}}}
		}
		return model.McpResponse{Content: []model.McpContent{{Type: "text", Text: "pong"}}}
	}
	runner, _ := newTestAiRunner(req, mcp)
	out := runner.run()
	if len(out.Steps) != 2 || len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], "Stopped after 2 steps") {
		t.Fatalf("steps=%d warnings=%v", len(out.Steps), out.Warnings)
	}
}

func TestAiToolErrorIsSentBackToTheModel(t *testing.T) {
	server := newAiTestServer(t,
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"boom","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`),
		}},
		sseScript{events: []string{openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"Sorry."},"finish_reason":"stop"}]}`)}},
	)
	req := aiTestRequest(model.AiProviderOpenAI, server.URL)
	req.ToolServers = []model.AiToolServer{{Name: "S", Request: model.HttpRequest{URL: "http://mcp.test"}}}
	mcp := func(r model.HttpRequest) model.McpResponse {
		if r.McpMethod == "tools/list" {
			return model.McpResponse{Tools: []model.McpTool{{Name: "boom"}}}
		}
		return model.McpResponse{IsError: true, Content: []model.McpContent{{Type: "text", Text: "disk full"}}}
	}
	runner, _ := newTestAiRunner(req, mcp)
	out := runner.run()
	results := out.Steps[0].ToolResults
	if len(results) != 1 || !results[0].IsError || results[0].Text != "disk full" {
		t.Fatalf("tool results %+v", results)
	}
	if out.Text != "Sorry." {
		t.Fatalf("text %q", out.Text)
	}
}

func TestAiAnthropicStreamWithThinkingAndToolUse(t *testing.T) {
	server := newAiTestServer(t,
		sseScript{events: []string{
			anthropicSSE("message_start", `{"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":100,"cache_read_input_tokens":40,"cache_creation_input_tokens":5,"output_tokens":1}}}`),
			anthropicSSE("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`),
			anthropicSSE("ping", `{"type":"ping"}`),
			anthropicSSE("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Need weather."}}`),
			anthropicSSE("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-1"}}`),
			anthropicSSE("content_block_stop", `{"type":"content_block_stop","index":0}`),
			anthropicSSE("content_block_start", `{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}`),
			anthropicSSE("content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\": \"Lis"}}`),
			anthropicSSE("content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"bon\"}"}}`),
			anthropicSSE("content_block_stop", `{"type":"content_block_stop","index":1}`),
			anthropicSSE("message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}`),
			anthropicSSE("message_stop", `{"type":"message_stop"}`),
		}},
		sseScript{events: []string{
			anthropicSSE("message_start", `{"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":150,"output_tokens":1}}}`),
			anthropicSSE("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
			anthropicSSE("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Yes, rain."}}`),
			anthropicSSE("message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}`),
		}},
	)
	req := aiTestRequest(model.AiProviderAnthropic, server.URL+"/v1")
	req.HTTP.Auth = model.AuthConfig{Type: "apikey", KeyName: "x-api-key", KeyValue: "k", KeyIn: "header"}
	req.Settings.Thinking = "summarized"
	req.ToolServers = []model.AiToolServer{{Name: "Weather", Request: model.HttpRequest{URL: "http://mcp.test"}}}
	mcp := func(r model.HttpRequest) model.McpResponse {
		if r.McpMethod == "tools/list" {
			return model.McpResponse{Tools: []model.McpTool{{Name: "get_weather"}}}
		}
		return model.McpResponse{Content: []model.McpContent{{Type: "text", Text: "rain 72%"}}}
	}
	runner, _ := newTestAiRunner(req, mcp)
	out := runner.run()

	if out.Error != "" {
		t.Fatalf("unexpected error %q", out.Error)
	}
	first := out.Steps[0]
	if first.StopReason != model.AiStopToolUse || first.Model != "claude-test" {
		t.Fatalf("first step %+v", first)
	}
	if first.Usage.Input != 100 || first.Usage.CacheRead != 40 || first.Usage.CacheWrite != 5 || first.Usage.Output != 30 {
		t.Fatalf("usage %+v", first.Usage)
	}
	if first.Blocks[0].Type != model.AiBlockThinking || first.Blocks[0].Text != "Need weather." || first.Blocks[0].Signature != "sig-1" {
		t.Fatalf("thinking %+v", first.Blocks[0])
	}
	if first.Blocks[1].Input != `{"city": "Lisbon"}` {
		t.Fatalf("tool input %q", first.Blocks[1].Input)
	}
	if out.Usage.Output != 34 || out.Text != "Yes, rain." {
		t.Fatalf("total usage %+v text %q", out.Usage, out.Text)
	}
	if server.paths[0] != "/v1/messages" || server.headers[0].Get("anthropic-version") != anthropicAPIVersion || server.headers[0].Get("x-api-key") != "k" {
		t.Fatalf("path %q headers %v", server.paths[0], server.headers[0])
	}
	firstBody := server.body(0)
	if firstBody["system"] != "Be brief." || firstBody["thinking"].(map[string]any)["type"] != "adaptive" {
		t.Fatalf("first body %v", firstBody)
	}
	messages := server.body(1)["messages"].([]any)
	if len(messages) != 3 {
		t.Fatalf("second request messages %v", messages)
	}
	assistant := messages[1].(map[string]any)["content"].([]any)
	if assistant[0].(map[string]any)["type"] != "thinking" || assistant[0].(map[string]any)["signature"] != "sig-1" {
		t.Fatalf("thinking not sent back: %v", assistant)
	}
	if assistant[1].(map[string]any)["input"].(map[string]any)["city"] != "Lisbon" {
		t.Fatalf("tool_use input not sent back: %v", assistant[1])
	}
	result := messages[2].(map[string]any)
	if result["role"] != "user" {
		t.Fatalf("tool result role %v", result)
	}
	block := result["content"].([]any)[0].(map[string]any)
	if block["type"] != "tool_result" || block["tool_use_id"] != "toolu_1" {
		t.Fatalf("tool result %v", block)
	}
}

func TestAiAnthropicMaxTokensAndStreamError(t *testing.T) {
	server := newAiTestServer(t, sseScript{events: []string{
		anthropicSSE("message_start", `{"type":"message_start","message":{"model":"m","usage":{"input_tokens":3,"output_tokens":1}}}`),
		anthropicSSE("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
		anthropicSSE("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial"}}`),
		anthropicSSE("error", `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`),
	}})
	runner, _ := newTestAiRunner(aiTestRequest(model.AiProviderAnthropic, server.URL), nil)
	out := runner.run()
	if out.Error != "overloaded_error: Overloaded" || out.Text != "Partial" {
		t.Fatalf("error=%q text=%q", out.Error, out.Text)
	}
	if out.HTTP.StatusCode != 200 {
		t.Fatalf("status %d", out.HTTP.StatusCode)
	}

	if got := anthropicStopReason("max_tokens"); got != model.AiStopMaxTokens {
		t.Fatalf("stop %q", got)
	}
	if got := openAIStopReason("length"); got != model.AiStopMaxTokens {
		t.Fatalf("stop %q", got)
	}
}

func TestAiProviderErrorStatusIsReadable(t *testing.T) {
	server := newAiTestServer(t, sseScript{status: 401, json: `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`})
	runner, _ := newTestAiRunner(aiTestRequest(model.AiProviderAnthropic, server.URL), nil)
	out := runner.run()
	if !strings.Contains(out.Error, "401") || !strings.Contains(out.Error, "authentication_error: invalid x-api-key") {
		t.Fatalf("error %q", out.Error)
	}
}

func TestAiNonStreamingJSONResponse(t *testing.T) {
	server := newAiTestServer(t, sseScript{json: `{"model":"gpt-x","choices":[{"message":{"content":"Plain answer","reasoning_content":"thought"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}`})
	req := aiTestRequest(model.AiProviderOpenAI, server.URL)
	req.Settings.Stream = false
	runner, _ := newTestAiRunner(req, nil)
	out := runner.run()
	if out.Text != "Plain answer" || out.Steps[0].Blocks[0].Type != model.AiBlockThinking || out.Usage.Output != 2 {
		t.Fatalf("out %+v", out)
	}
	if _, ok := server.body(0)["stream_options"]; ok {
		t.Fatalf("stream_options sent without streaming")
	}
}

func TestAiIdleTimeoutStopsAStalledStream(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"Hi"}}]}`)+"\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	req := aiTestRequest(model.AiProviderOpenAI, server.URL)
	req.Settings.IdleTimeoutSec = 1
	runner, _ := newTestAiRunner(req, nil)
	started := time.Now()
	out := runner.run()
	if !strings.Contains(out.Error, "No data from the model") || out.Text != "Hi" {
		t.Fatalf("error=%q text=%q", out.Error, out.Text)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatalf("idle timeout took %s", time.Since(started))
	}
}

func TestAiCancelStopsTheStream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	runner, _ := newTestAiRunner(aiTestRequest(model.AiProviderOpenAI, server.URL), nil)
	ctx, cancel := context.WithCancel(context.Background())
	runner.ctx = ctx
	time.AfterFunc(200*time.Millisecond, cancel)
	out := runner.run()
	if out.Error != "Cancelled" {
		t.Fatalf("error %q", out.Error)
	}
}

func TestAiToolNamesAreSanitizedAndUnique(t *testing.T) {
	tools := aiAssignToolNames([]aiTool{
		{Original: "files.read", Server: "Disk"},
		{Original: "search", Server: "Web"},
		{Original: "search", Server: "Docs"},
	})
	got := []string{tools[0].Name, tools[1].Name, tools[2].Name}
	want := []string{"files_read", "Web_search", "Docs_search"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("names %v", got)
	}
}

func TestAiRequiresModelAndURL(t *testing.T) {
	req := aiTestRequest(model.AiProviderOpenAI, "")
	runner, _ := newTestAiRunner(req, nil)
	if out := runner.run(); !strings.Contains(out.Error, "base URL") {
		t.Fatalf("error %q", out.Error)
	}
	req = aiTestRequest(model.AiProviderOpenAI, "http://x")
	req.Model = ""
	runner, _ = newTestAiRunner(req, nil)
	if out := runner.run(); !strings.Contains(out.Error, "model") {
		t.Fatalf("error %q", out.Error)
	}
}

func TestAiResponseReachesTheFrontendWithArrays(t *testing.T) {
	out := model.NormalizeAiResponse(model.AiResponse{Steps: []model.AiStep{{}}, Messages: []model.AiMessage{{Role: "assistant"}}})
	encoded, _ := json.Marshal(out)
	for _, needle := range []string{`"steps":[{`, `"blocks":[]`, `"toolResults":[]`, `"tools":[]`, `"warnings":[]`, `"headers":[]`} {
		if !strings.Contains(string(encoded), needle) {
			t.Fatalf("%s missing in %s", needle, encoded)
		}
	}
}

func TestAiTestScriptsReadTheNormalizedAnswer(t *testing.T) {
	server := newAiTestServer(t, sseScript{events: []string{
		openAIChunkEvent(`{"model":"gpt-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"kurlo\"}"}}]},"finish_reason":"tool_calls"}]}`),
		openAIChunkEvent(`{"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}`),
	}})
	req := aiTestRequest(model.AiProviderOpenAI, server.URL)
	req.HTTP.ScriptEngine = "js"
	req.HTTP.TestScript = `
const llm = pm.response.llm();
pm.test("tool", () => pm.expect(llm.toolCalls[0].name).to.equal("lookup"));
pm.test("input", () => pm.expect(llm.toolCalls[0].input.q).to.equal("kurlo"));
pm.test("stop", () => pm.expect(llm.stopReason).to.equal("tool_use"));
pm.test("usage", () => pm.expect(llm.usage.output).to.equal(4));
pm.test("model", () => pm.expect(llm.model).to.equal("gpt-test"));
`
	runner, _ := newTestAiRunner(req, nil)
	out := runner.run()
	out = finishAiTests(context.Background(), req, out, state.New(), newCookieJarRegistry())
	tests := out.HTTP.TestResult.Tests
	if len(tests) != 5 {
		t.Fatalf("tests %+v error %q", tests, out.HTTP.TestResult.Error)
	}
	for _, test := range tests {
		if !test.Passed {
			t.Fatalf("test %q failed: %s", test.Name, test.Error)
		}
	}
}

func TestAiTestScriptsRunOnceAfterAllSteps(t *testing.T) {
	server := newAiTestServer(t, sseScript{events: []string{
		openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`),
	}})
	req := aiTestRequest(model.AiProviderOpenAI, server.URL)
	req.HTTP.ScriptEngine = "js"
	req.HTTP.TestScript = `pm.test("once", () => {});`
	runner, _ := newTestAiRunner(req, nil)
	out := runner.run()
	if len(out.Steps[0].HTTP.TestResult.Tests) != 0 {
		t.Fatalf("tests ran inside the step")
	}
	out = finishAiTests(context.Background(), req, out, state.New(), newCookieJarRegistry())
	if len(out.HTTP.TestResult.Tests) != 1 {
		t.Fatalf("tests %+v", out.HTTP.TestResult)
	}
}

func TestAiRefusesPromptsOverTheLengthLimit(t *testing.T) {
	long := strings.Repeat("я", model.AiMaxPromptChars+1)
	req := aiTestRequest(model.AiProviderOpenAI, "http://127.0.0.1:1/v1")
	req.Messages[0].Blocks[0].Text = long
	runner, _ := newTestAiRunner(req, nil)
	if out := runner.run(); !strings.Contains(out.Error, "message is longer than 200000") || len(out.Steps) != 0 {
		t.Fatalf("prompt: %q, %d steps", out.Error, len(out.Steps))
	}

	req = aiTestRequest(model.AiProviderOpenAI, "http://127.0.0.1:1/v1")
	req.System = strings.Repeat("s", model.AiMaxSystemChars+1)
	runner, _ = newTestAiRunner(req, nil)
	if out := runner.run(); !strings.Contains(out.Error, "system prompt is longer than 50000") {
		t.Fatalf("system: %q", out.Error)
	}

	if aiLengthError(model.AiRequest{System: strings.Repeat("я", model.AiMaxSystemChars), Messages: []model.AiMessage{
		{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: strings.Repeat("я", model.AiMaxPromptChars)}}},
		{Role: "assistant", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: long}}},
	}}) != "" {
		t.Fatal("text at the limit and long answers are allowed")
	}
}

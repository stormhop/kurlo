package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestAiRequestKurloToolsReadAndRunButDeclineChanges(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	target, hits := countingServer(t)
	root := agentTestWorkspace(t, target.URL)
	sendArgs, _ := json.Marshal(map[string]any{"method": "POST", "url": target.URL + "/orders"})
	server := newAiTestServer(t,
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_requests","arguments":"{}"}},{"index":1,"id":"call_2","type":"function","function":{"name":"send_request","arguments":` + string(mustJSON(t, string(sendArgs))) + `}}]},"finish_reason":"tool_calls"}]}`),
			openAIChunkEvent(`[DONE]`),
		}},
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}]}`),
			openAIChunkEvent(`[DONE]`),
		}},
	)
	req := aiTestRequest(model.AiProviderOpenAI, server.URL)
	req.KurloTools = true
	runner, _ := newTestAiRunner(req, nil)
	runner.local = newAiRequestKurloTools(mcpServerOptions{workspace: root, env: "Local"}, req.HTTP.RequestID)
	out := runner.run()
	if out.Error != "" {
		t.Fatalf("unexpected error %q", out.Error)
	}

	offered := map[string]bool{}
	for _, tool := range server.body(0)["tools"].([]any) {
		offered[tool.(map[string]any)["function"].(map[string]any)["name"].(string)] = true
	}
	for _, name := range []string{"list_requests", "get_request", "run_request", "send_request"} {
		if !offered[name] {
			t.Fatalf("%s not offered: %v", name, offered)
		}
	}
	for _, name := range []string{"save_request", "delete_request", agentPlanTool, agentNotesTool} {
		if offered[name] {
			t.Fatalf("%s should not be offered", name)
		}
	}

	results := out.Steps[0].ToolResults
	if len(results) != 2 {
		t.Fatalf("tool results %+v", results)
	}
	if results[0].IsError || !strings.Contains(results[0].Text, "Ok") {
		t.Fatalf("list_requests result %+v", results[0])
	}
	if !results[1].IsError || !strings.Contains(results[1].Text, "approval") {
		t.Fatalf("send_request result %+v", results[1])
	}
	if hits.Load() != 0 {
		t.Fatalf("declined POST reached the server %d times", hits.Load())
	}
}

func TestAiRequestUsesTheChosenConnection(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	_, _, err := upsertAiConnection(model.AiConnectionInput{Kind: model.AiConnectionLocal, Label: "First", BaseURL: "http://first.test/v1", Model: "m1"})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := upsertAiConnection(model.AiConnectionInput{Kind: model.AiConnectionLocal, Label: "Second", BaseURL: "http://second.test/v1", Model: "m2"})
	if err != nil {
		t.Fatal(err)
	}
	resolved, _, err := resolveKurloAiRequest(model.AiRequest{Provider: model.AiProviderKurlo, ConnectionID: second.ID})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.HTTP.URL != "http://second.test/v1" || resolved.Model != "m2" {
		t.Fatalf("resolved %q %q", resolved.HTTP.URL, resolved.Model)
	}
	defaulted, _, err := resolveKurloAiRequest(model.AiRequest{Provider: model.AiProviderKurlo})
	if err != nil {
		t.Fatal(err)
	}
	if defaulted.HTTP.URL != "http://first.test/v1" {
		t.Fatalf("default resolved to %q", defaulted.HTTP.URL)
	}
	if _, _, err := resolveKurloAiRequest(model.AiRequest{Provider: model.AiProviderKurlo, ConnectionID: "gone"}); err == nil || !strings.Contains(err.Error(), "no longer exists") {
		t.Fatalf("missing connection error %v", err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

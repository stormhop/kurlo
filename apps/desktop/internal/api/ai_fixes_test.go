package api

import (
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func floatPtr(v float64) *float64 { return &v }

func TestAiAnthropicLeavesOutSamplingThatThinkingRefuses(t *testing.T) {
	req := aiTestRequest(model.AiProviderAnthropic, "https://api.anthropic.com/v1")
	req.Settings.Temperature = floatPtr(0.2)
	req.Settings.TopP = floatPtr(0.5)

	body, _, err := anthropicProvider{}.build(req, req.Messages, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"temperature":0.2`) || !strings.Contains(string(body), `"top_p":0.5`) {
		t.Fatalf("without thinking the settings go out as set: %s", body)
	}

	req.Settings.Thinking = "summarized"
	body, _, _ = anthropicProvider{}.build(req, req.Messages, nil)
	if strings.Contains(string(body), "temperature") || strings.Contains(string(body), "top_p") {
		t.Fatalf("thinking with a changed temperature or a low top_p is a 400: %s", body)
	}
	req.Settings.TopP = floatPtr(0.97)
	body, _, _ = anthropicProvider{}.build(req, req.Messages, nil)
	if !strings.Contains(string(body), `"top_p":0.97`) {
		t.Fatalf("a top_p from 0.95 up is allowed with thinking: %s", body)
	}
}

func TestAiAnthropicDropsToolCallsOfATurnThatLostItsThinkingSignature(t *testing.T) {
	messages := []model.AiMessage{
		{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "Weather?"}}},
		{Role: "assistant", Blocks: []model.AiBlock{
			{Type: model.AiBlockThinking, Text: "Need weather."},
			{Type: model.AiBlockText, Text: "Checking."},
			{Type: model.AiBlockToolUse, ID: "toolu_1", Name: "get_weather", Input: `{}`},
		}},
		{Role: "tool", Blocks: []model.AiBlock{{Type: model.AiBlockToolResult, ID: "toolu_1", Text: "rain"}}},
		{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "And tomorrow?"}}},
	}
	out := anthropicMessages(messages)
	if len(out) != 3 {
		t.Fatalf("messages %+v", out)
	}
	for _, message := range out {
		for _, item := range message.Content {
			if item["type"] == "tool_use" || item["type"] == "tool_result" || item["type"] == "thinking" {
				t.Fatalf("broken turn leaked %v", item)
			}
		}
	}
	if out[1].Content[0]["text"] != "Checking." || out[2].Content[0]["text"] != "And tomorrow?" {
		t.Fatalf("text was not kept: %+v", out)
	}
}

func TestAiAnthropicContinuesAPausedTurn(t *testing.T) {
	server := newAiTestServer(t,
		sseScript{events: []string{
			anthropicSSE("message_start", `{"type":"message_start","message":{"model":"m","usage":{"input_tokens":3,"output_tokens":1}}}`),
			anthropicSSE("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
			anthropicSSE("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"First half. "}}`),
			anthropicSSE("message_delta", `{"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":3}}`),
		}},
		sseScript{events: []string{
			anthropicSSE("message_start", `{"type":"message_start","message":{"model":"m","usage":{"input_tokens":6,"output_tokens":1}}}`),
			anthropicSSE("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
			anthropicSSE("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Second half."}}`),
			anthropicSSE("message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}`),
		}},
	)
	runner, _ := newTestAiRunner(aiTestRequest(model.AiProviderAnthropic, server.URL), nil)
	out := runner.run()
	if out.Error != "" || len(out.Steps) != 2 || out.StopReason != model.AiStopEndTurn {
		t.Fatalf("out %+v", out)
	}
	messages := server.body(1)["messages"].([]any)
	last := messages[len(messages)-1].(map[string]any)
	if last["role"] != "assistant" {
		t.Fatalf("the paused turn was not sent back: %v", messages)
	}
}

func TestAiEventStreamWithoutEventsIsAnError(t *testing.T) {
	server := newAiTestServer(t, sseScript{events: []string{"<html>gateway page</html>"}})
	runner, _ := newTestAiRunner(aiTestRequest(model.AiProviderOpenAI, server.URL), nil)
	out := runner.run()
	if !strings.Contains(out.Error, "sent no events") {
		t.Fatalf("error %q", out.Error)
	}
}

func TestAiOpenAIRetriesWithoutAFieldTheServerRefuses(t *testing.T) {
	done := sseScript{events: []string{
		openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`),
		openAIChunkEvent(`[DONE]`),
	}}
	server := newAiTestServer(t,
		sseScript{status: 400, json: `{"error":{"message":"Unrecognized request argument supplied: stream_options"}}`},
		done,
		done,
	)
	runner, log := newTestAiRunner(aiTestRequest(model.AiProviderOpenAI, server.URL), nil)
	out := runner.run()
	if out.Error != "" || out.Text != "ok" {
		t.Fatalf("out %+v", out)
	}
	if _, ok := server.body(0)["stream_options"]; !ok {
		t.Fatalf("first attempt should carry stream_options")
	}
	if _, ok := server.body(1)["stream_options"]; ok {
		t.Fatalf("retry still sent stream_options")
	}
	if len(log.steps) != 1 {
		t.Fatalf("the refused attempt must not show up as a step: %d", len(log.steps))
	}

	server = newAiTestServer(t,
		sseScript{status: 400, json: `{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}}`},
		done,
	)
	runner, _ = newTestAiRunner(aiTestRequest(model.AiProviderOpenAI, server.URL), nil)
	if out := runner.run(); out.Error != "" {
		t.Fatalf("error %q", out.Error)
	}
	if server.body(1)["max_completion_tokens"] != float64(256) || server.body(1)["max_tokens"] != nil {
		t.Fatalf("retry body %v", server.body(1))
	}
}

func TestAiToolCallWithoutIDGetsOne(t *testing.T) {
	decoder := openAIProvider{}.decoder()
	decoder.body([]byte(`{"choices":[{"message":{"tool_calls":[{"function":{"name":"a","arguments":"{}"}},{"id":"call_x","function":{"name":"b","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`))
	blocks := decoder.result().blocks
	if blocks[0].ID == "" || blocks[0].ID == blocks[1].ID || blocks[1].ID != "call_x" {
		t.Fatalf("ids %q %q", blocks[0].ID, blocks[1].ID)
	}
}

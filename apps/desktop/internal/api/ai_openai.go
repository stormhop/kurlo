package api

import (
	"encoding/json"
	"net/url"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type openAIProvider struct{}

func (openAIProvider) endpoint(base string) string {
	return aiEndpoint(base, "/chat/completions")
}

func openAIUsesCompletionTokens(base string) bool {
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Hostname(), "api.openai.com")
}

func (openAIProvider) build(req model.AiRequest, messages []model.AiMessage, tools []aiTool) ([]byte, []model.KeyValue, error) {
	body := map[string]any{
		"model":    req.Model,
		"messages": openAIMessages(req.System, messages),
		"stream":   req.Settings.Stream,
	}
	if req.Settings.Stream {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if req.Settings.MaxTokens > 0 {
		if openAIUsesCompletionTokens(req.HTTP.URL) {
			body["max_completion_tokens"] = req.Settings.MaxTokens
		} else {
			body["max_tokens"] = req.Settings.MaxTokens
		}
	}
	if req.Settings.Temperature != nil {
		body["temperature"] = *req.Settings.Temperature
	}
	if req.Settings.TopP != nil {
		body["top_p"] = *req.Settings.TopP
	}
	if len(tools) > 0 {
		list := make([]map[string]any, 0, len(tools))
		for _, tool := range tools {
			function := map[string]any{"name": tool.Name, "parameters": aiToolSchema(tool.Schema)}
			if tool.Description != "" {
				function["description"] = tool.Description
			}
			list = append(list, map[string]any{"type": "function", "function": function})
		}
		body["tools"] = list
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, nil, err
	}
	return encoded, nil, nil
}

func openAIMessages(system string, messages []model.AiMessage) []map[string]any {
	out := []map[string]any{}
	if strings.TrimSpace(system) != "" {
		out = append(out, map[string]any{"role": "system", "content": system})
	}
	for _, message := range messages {
		switch message.Role {
		case "assistant":
			text := aiTextOf(message.Blocks)
			entry := map[string]any{"role": "assistant"}
			var calls []map[string]any
			for _, block := range message.Blocks {
				if block.Type != model.AiBlockToolUse {
					continue
				}
				calls = append(calls, map[string]any{
					"id":   block.ID,
					"type": "function",
					"function": map[string]any{
						"name":      block.Name,
						"arguments": string(aiInputObject(block.Input)),
					},
				})
			}
			if text != "" {
				entry["content"] = text
			} else {
				entry["content"] = nil
			}
			if len(calls) > 0 {
				entry["tool_calls"] = calls
			} else if text == "" {
				continue
			}
			out = append(out, entry)
		default:
			var text []string
			for _, block := range message.Blocks {
				switch block.Type {
				case model.AiBlockToolResult:
					out = append(out, map[string]any{"role": "tool", "tool_call_id": block.ID, "content": block.Text})
				case model.AiBlockText:
					if block.Text != "" {
						text = append(text, block.Text)
					}
				}
			}
			if len(text) > 0 {
				out = append(out, map[string]any{"role": "user", "content": strings.Join(text, "\n\n")})
			}
		}
	}
	return out
}

func (openAIProvider) decoder() aiStepDecoder {
	return &openAIDecoder{toolIndex: map[int]int{}}
}

type openAIUsage struct {
	PromptTokens        int `json:"prompt_tokens"`
	CompletionTokens    int `json:"completion_tokens"`
	PromptTokensDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionTokensDetails *struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

type openAIToolCall struct {
	Index    *int   `json:"index"`
	ID       string `json:"id"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type openAIMessageBody struct {
	Content          *string          `json:"content"`
	Refusal          *string          `json:"refusal"`
	Reasoning        *string          `json:"reasoning"`
	ReasoningContent *string          `json:"reasoning_content"`
	ToolCalls        []openAIToolCall `json:"tool_calls"`
}

type openAIChoice struct {
	Delta        openAIMessageBody `json:"delta"`
	Message      openAIMessageBody `json:"message"`
	FinishReason *string           `json:"finish_reason"`
}

type openAIChunk struct {
	Model   string          `json:"model"`
	Choices []openAIChoice  `json:"choices"`
	Usage   *openAIUsage    `json:"usage"`
	Error   json.RawMessage `json:"error"`
}

type openAIDecoder struct {
	blocks    aiBlockBuilder
	toolIndex map[int]int
	stop      string
	model     string
	err       string
	usage     model.AiUsage
	hasUsage  bool
}

func (d *openAIDecoder) applyUsage(u *openAIUsage) {
	if u == nil {
		return
	}
	d.hasUsage = true
	cached := 0
	if u.PromptTokensDetails != nil {
		cached = u.PromptTokensDetails.CachedTokens
	}
	d.usage.Input = u.PromptTokens - cached
	d.usage.CacheRead = cached
	d.usage.Output = u.CompletionTokens
	if u.CompletionTokensDetails != nil {
		d.usage.Reasoning = u.CompletionTokensDetails.ReasoningTokens
	}
}

func (d *openAIDecoder) appendText(kind, text string, emit func(model.AiDeltaEvent)) {
	if text == "" {
		return
	}
	index := d.blocks.lastOfType(kind)
	if index < 0 {
		index = d.blocks.appendBlock(model.AiBlock{Type: kind})
	}
	d.blocks.blocks[index].Text += text
	emit(model.AiDeltaEvent{Index: index, Type: kind, Text: text})
}

func openAIReasoning(body openAIMessageBody) string {
	if body.ReasoningContent != nil {
		return *body.ReasoningContent
	}
	if body.Reasoning != nil {
		return *body.Reasoning
	}
	return ""
}

func (d *openAIDecoder) event(ev model.SSEEvent, emit func(model.AiDeltaEvent)) {
	data := strings.TrimSpace(ev.Data)
	if data == "" || data == "[DONE]" {
		return
	}
	var chunk openAIChunk
	if err := json.Unmarshal([]byte(data), &chunk); err != nil {
		return
	}
	if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
		d.err = aiErrorMessage([]byte(data))
		return
	}
	if chunk.Model != "" {
		d.model = chunk.Model
	}
	d.applyUsage(chunk.Usage)
	if len(chunk.Choices) == 0 {
		return
	}
	choice := chunk.Choices[0]
	delta := choice.Delta
	d.appendText(model.AiBlockThinking, openAIReasoning(delta), emit)
	if delta.Content != nil {
		d.appendText(model.AiBlockText, *delta.Content, emit)
	}
	if delta.Refusal != nil {
		d.appendText(model.AiBlockText, *delta.Refusal, emit)
		if *delta.Refusal != "" {
			d.stop = "refusal"
		}
	}
	for position, call := range delta.ToolCalls {
		key := position
		if call.Index != nil {
			key = *call.Index
		}
		index, ok := d.toolIndex[key]
		if !ok {
			index = d.blocks.appendBlock(model.AiBlock{Type: model.AiBlockToolUse, ID: call.ID, Name: call.Function.Name})
			d.toolIndex[key] = index
			emit(model.AiDeltaEvent{Index: index, Type: model.AiBlockToolUse, ID: call.ID, Name: call.Function.Name})
		} else {
			block := &d.blocks.blocks[index]
			if call.ID != "" && block.ID == "" {
				block.ID = call.ID
			}
			if call.Function.Name != "" && block.Name == "" {
				block.Name = call.Function.Name
			}
		}
		if call.Function.Arguments != "" {
			d.blocks.blocks[index].Input += call.Function.Arguments
			emit(model.AiDeltaEvent{Index: index, Type: model.AiBlockToolUse, Input: call.Function.Arguments})
		}
	}
	if choice.FinishReason != nil && *choice.FinishReason != "" && d.stop != "refusal" {
		d.stop = *choice.FinishReason
	}
}

func (d *openAIDecoder) body(body []byte) {
	var chunk openAIChunk
	if err := json.Unmarshal(body, &chunk); err != nil {
		d.err = "The response is not valid JSON: " + err.Error()
		return
	}
	if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
		d.err = aiErrorMessage(body)
		return
	}
	d.model = chunk.Model
	d.applyUsage(chunk.Usage)
	if len(chunk.Choices) == 0 {
		return
	}
	choice := chunk.Choices[0]
	message := choice.Message
	if reasoning := openAIReasoning(message); reasoning != "" {
		d.blocks.appendBlock(model.AiBlock{Type: model.AiBlockThinking, Text: reasoning})
	}
	if message.Content != nil && *message.Content != "" {
		d.blocks.appendBlock(model.AiBlock{Type: model.AiBlockText, Text: *message.Content})
	}
	if message.Refusal != nil && *message.Refusal != "" {
		d.blocks.appendBlock(model.AiBlock{Type: model.AiBlockText, Text: *message.Refusal})
		d.stop = "refusal"
	}
	for _, call := range message.ToolCalls {
		d.blocks.appendBlock(model.AiBlock{Type: model.AiBlockToolUse, ID: call.ID, Name: call.Function.Name, Input: call.Function.Arguments})
	}
	if choice.FinishReason != nil && d.stop != "refusal" {
		d.stop = *choice.FinishReason
	}
}

func (d *openAIDecoder) result() aiStepResult {
	return aiStepResult{
		blocks:   d.blocks.finish(),
		stop:     openAIStopReason(d.stop),
		rawStop:  d.stop,
		model:    d.model,
		err:      d.err,
		usage:    d.usage,
		hasUsage: d.hasUsage,
	}
}

func openAIStopReason(raw string) string {
	switch raw {
	case "stop":
		return model.AiStopEndTurn
	case "length":
		return model.AiStopMaxTokens
	case "tool_calls", "function_call":
		return model.AiStopToolUse
	case "content_filter":
		return model.AiStopContentFilter
	case "refusal":
		return model.AiStopRefusal
	}
	return raw
}

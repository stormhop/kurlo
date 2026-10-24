package api

import (
	"encoding/json"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const anthropicAPIVersion = "2023-06-01"

const anthropicDefaultMaxTokens = 8192

const anthropicThinkingMinTopP = 0.95

type anthropicProvider struct{}

func (anthropicProvider) endpoint(base string) string {
	return aiEndpoint(base, "/messages")
}

type anthropicContent map[string]any

type anthropicMessage struct {
	Role    string             `json:"role"`
	Content []anthropicContent `json:"content"`
}

func (anthropicProvider) build(req model.AiRequest, messages []model.AiMessage, tools []aiTool) ([]byte, []model.KeyValue, error) {
	body := map[string]any{
		"model":    req.Model,
		"messages": anthropicMessages(messages),
		"stream":   req.Settings.Stream,
	}
	maxTokens := req.Settings.MaxTokens
	if maxTokens <= 0 {
		maxTokens = anthropicDefaultMaxTokens
	}
	body["max_tokens"] = maxTokens
	if strings.TrimSpace(req.System) != "" {
		body["system"] = req.System
	}
	thinking := req.Settings.Thinking == "summarized"
	if req.Settings.Temperature != nil && !thinking {
		body["temperature"] = *req.Settings.Temperature
	}
	if req.Settings.TopP != nil && (!thinking || *req.Settings.TopP >= anthropicThinkingMinTopP) {
		body["top_p"] = *req.Settings.TopP
	}
	if thinking {
		body["thinking"] = map[string]any{"type": "adaptive", "display": "summarized"}
	}
	if len(tools) > 0 {
		list := make([]map[string]any, 0, len(tools))
		for _, tool := range tools {
			entry := map[string]any{"name": tool.Name, "input_schema": aiToolSchema(tool.Schema)}
			if tool.Description != "" {
				entry["description"] = tool.Description
			}
			list = append(list, entry)
		}
		body["tools"] = list
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, nil, err
	}
	var headers []model.KeyValue
	if !aiHeader(req.HTTP.Headers, "anthropic-version") {
		headers = append(headers, model.KeyValue{Key: "anthropic-version", Value: anthropicAPIVersion, Enabled: true})
	}
	return encoded, headers, nil
}

func anthropicMessages(messages []model.AiMessage) []anthropicMessage {
	out := []anthropicMessage{}
	dropped := map[string]bool{}
	for _, message := range messages {
		role := "user"
		if message.Role == "assistant" {
			role = "assistant"
		}
		broken := role == "assistant" && anthropicHasUnsignedThinking(message.Blocks)
		content := []anthropicContent{}
		for _, block := range message.Blocks {
			if broken && block.Type == model.AiBlockToolUse {
				dropped[block.ID] = true
				continue
			}
			if block.Type == model.AiBlockToolResult && dropped[block.ID] {
				continue
			}
			if item := anthropicContentFor(role, block); item != nil {
				content = append(content, item)
			}
		}
		if len(content) == 0 {
			continue
		}
		if n := len(out); n > 0 && out[n-1].Role == role {
			out[n-1].Content = append(out[n-1].Content, content...)
			continue
		}
		out = append(out, anthropicMessage{Role: role, Content: content})
	}
	return out
}

func anthropicHasUnsignedThinking(blocks []model.AiBlock) bool {
	for _, block := range blocks {
		if block.Type == model.AiBlockThinking && block.Signature == "" {
			return true
		}
	}
	return false
}

func anthropicContentFor(role string, block model.AiBlock) anthropicContent {
	switch block.Type {
	case model.AiBlockText:
		if block.Text == "" {
			return nil
		}
		return anthropicContent{"type": "text", "text": block.Text}
	case model.AiBlockThinking:
		if role != "assistant" || block.Signature == "" {
			return nil
		}
		return anthropicContent{"type": "thinking", "thinking": block.Text, "signature": block.Signature}
	case model.AiBlockRedacted:
		if role != "assistant" || block.Data == "" {
			return nil
		}
		return anthropicContent{"type": "redacted_thinking", "data": block.Data}
	case model.AiBlockToolUse:
		if role != "assistant" {
			return nil
		}
		return anthropicContent{"type": "tool_use", "id": block.ID, "name": block.Name, "input": aiInputObject(block.Input)}
	case model.AiBlockToolResult:
		item := anthropicContent{
			"type":        "tool_result",
			"tool_use_id": block.ID,
			"content":     []map[string]any{{"type": "text", "text": block.Text}},
		}
		if block.IsError {
			item["is_error"] = true
		}
		return item
	}
	return nil
}

func (anthropicProvider) decoder() aiStepDecoder {
	return &anthropicDecoder{}
}

type anthropicUsage struct {
	InputTokens              *int `json:"input_tokens"`
	OutputTokens             *int `json:"output_tokens"`
	CacheCreationInputTokens *int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     *int `json:"cache_read_input_tokens"`
}

type anthropicBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	Signature string          `json:"signature"`
	Data      string          `json:"data"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
}

type anthropicEvent struct {
	Type    string `json:"type"`
	Index   int    `json:"index"`
	Message struct {
		Model string         `json:"model"`
		Usage anthropicUsage `json:"usage"`
	} `json:"message"`
	ContentBlock anthropicBlock `json:"content_block"`
	Delta        struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		Thinking    string `json:"thinking"`
		Signature   string `json:"signature"`
		PartialJSON string `json:"partial_json"`
		StopReason  string `json:"stop_reason"`
	} `json:"delta"`
	Usage anthropicUsage `json:"usage"`
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

type anthropicDecoder struct {
	blocks   aiBlockBuilder
	stop     string
	model    string
	err      string
	usage    model.AiUsage
	hasUsage bool
}

func (d *anthropicDecoder) applyUsage(u anthropicUsage) {
	if u.InputTokens != nil {
		d.usage.Input = *u.InputTokens
		d.hasUsage = true
	}
	if u.OutputTokens != nil {
		d.usage.Output = *u.OutputTokens
		d.hasUsage = true
	}
	if u.CacheCreationInputTokens != nil {
		d.usage.CacheWrite = *u.CacheCreationInputTokens
	}
	if u.CacheReadInputTokens != nil {
		d.usage.CacheRead = *u.CacheReadInputTokens
	}
}

func (d *anthropicDecoder) event(ev model.SSEEvent, emit func(model.AiDeltaEvent)) {
	var payload anthropicEvent
	if err := json.Unmarshal([]byte(ev.Data), &payload); err != nil {
		return
	}
	switch payload.Type {
	case "message_start":
		d.model = payload.Message.Model
		d.applyUsage(payload.Message.Usage)
	case "content_block_start":
		block := d.blocks.at(payload.Index)
		cb := payload.ContentBlock
		switch cb.Type {
		case "text":
			*block = model.AiBlock{Type: model.AiBlockText, Text: cb.Text}
		case "thinking":
			*block = model.AiBlock{Type: model.AiBlockThinking, Text: cb.Thinking, Signature: cb.Signature}
		case "redacted_thinking":
			*block = model.AiBlock{Type: model.AiBlockRedacted, Data: cb.Data}
		case "tool_use":
			*block = model.AiBlock{Type: model.AiBlockToolUse, ID: cb.ID, Name: cb.Name}
		default:
			return
		}
		emit(model.AiDeltaEvent{Index: payload.Index, Type: block.Type, Text: block.Text, ID: block.ID, Name: block.Name})
	case "content_block_delta":
		if payload.Index >= len(d.blocks.blocks) || d.blocks.blocks[payload.Index].Type == "" {
			return
		}
		block := &d.blocks.blocks[payload.Index]
		switch payload.Delta.Type {
		case "text_delta":
			block.Text += payload.Delta.Text
			emit(model.AiDeltaEvent{Index: payload.Index, Type: block.Type, Text: payload.Delta.Text})
		case "thinking_delta":
			block.Text += payload.Delta.Thinking
			if payload.Delta.Thinking != "" {
				emit(model.AiDeltaEvent{Index: payload.Index, Type: block.Type, Text: payload.Delta.Thinking})
			}
		case "signature_delta":
			block.Signature += payload.Delta.Signature
		case "input_json_delta":
			block.Input += payload.Delta.PartialJSON
			emit(model.AiDeltaEvent{Index: payload.Index, Type: block.Type, Input: payload.Delta.PartialJSON})
		}
	case "message_delta":
		if payload.Delta.StopReason != "" {
			d.stop = payload.Delta.StopReason
		}
		d.applyUsage(payload.Usage)
	case "error":
		d.err = strings.TrimPrefix(payload.Error.Type+": "+payload.Error.Message, ": ")
	}
}

func (d *anthropicDecoder) body(body []byte) {
	var payload struct {
		Type       string           `json:"type"`
		Model      string           `json:"model"`
		Content    []anthropicBlock `json:"content"`
		StopReason string           `json:"stop_reason"`
		Usage      anthropicUsage   `json:"usage"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		d.err = "The response is not valid JSON: " + err.Error()
		return
	}
	if payload.Type == "error" {
		d.err = aiErrorMessage(body)
		return
	}
	d.model = payload.Model
	d.stop = payload.StopReason
	d.applyUsage(payload.Usage)
	for _, cb := range payload.Content {
		switch cb.Type {
		case "text":
			d.blocks.appendBlock(model.AiBlock{Type: model.AiBlockText, Text: cb.Text})
		case "thinking":
			d.blocks.appendBlock(model.AiBlock{Type: model.AiBlockThinking, Text: cb.Thinking, Signature: cb.Signature})
		case "redacted_thinking":
			d.blocks.appendBlock(model.AiBlock{Type: model.AiBlockRedacted, Data: cb.Data})
		case "tool_use":
			input := string(cb.Input)
			if strings.TrimSpace(input) == "" || input == "null" {
				input = "{}"
			}
			d.blocks.appendBlock(model.AiBlock{Type: model.AiBlockToolUse, ID: cb.ID, Name: cb.Name, Input: input})
		}
	}
}

func (d *anthropicDecoder) result() aiStepResult {
	return aiStepResult{
		blocks:   d.blocks.finish(),
		stop:     anthropicStopReason(d.stop),
		rawStop:  d.stop,
		model:    d.model,
		err:      d.err,
		usage:    d.usage,
		hasUsage: d.hasUsage,
	}
}

func anthropicStopReason(raw string) string {
	switch raw {
	case "end_turn":
		return model.AiStopEndTurn
	case "tool_use":
		return model.AiStopToolUse
	case "max_tokens", "model_context_window_exceeded":
		return model.AiStopMaxTokens
	case "stop_sequence":
		return model.AiStopStopSequence
	case "refusal":
		return model.AiStopRefusal
	case "pause_turn":
		return model.AiStopPauseTurn
	}
	return raw
}

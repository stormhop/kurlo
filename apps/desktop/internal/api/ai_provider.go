package api

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type aiTool struct {
	Name        string
	Original    string
	Server      string
	ServerIndex int
	Description string
	Schema      json.RawMessage
}

type aiStepResult struct {
	blocks   []model.AiBlock
	stop     string
	rawStop  string
	model    string
	err      string
	usage    model.AiUsage
	hasUsage bool
}

type aiStepDecoder interface {
	event(ev model.SSEEvent, emit func(model.AiDeltaEvent))
	body(body []byte)
	result() aiStepResult
}

type aiProvider interface {
	endpoint(base string) string
	build(req model.AiRequest, messages []model.AiMessage, tools []aiTool) ([]byte, []model.KeyValue, error)
	decoder() aiStepDecoder
}

func aiProviderFor(name string) aiProvider {
	if strings.EqualFold(strings.TrimSpace(name), model.AiProviderAnthropic) {
		return anthropicProvider{}
	}
	return openAIProvider{}
}

func aiEndpoint(base, suffix string) string {
	trimmed := strings.TrimSpace(base)
	query := ""
	if index := strings.IndexByte(trimmed, '?'); index >= 0 {
		trimmed, query = trimmed[:index], trimmed[index:]
	}
	trimmed = strings.TrimRight(trimmed, "/")
	if !strings.HasSuffix(trimmed, suffix) {
		trimmed += suffix
	}
	return trimmed + query
}

func aiErrorMessage(body []byte) string {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	switch value := payload["error"].(type) {
	case string:
		return value
	case map[string]any:
		message, _ := value["message"].(string)
		kind, _ := value["type"].(string)
		if kind == "" {
			if code, ok := value["code"].(string); ok {
				kind = code
			}
		}
		if kind != "" && message != "" {
			return kind + ": " + message
		}
		if message != "" {
			return message
		}
		return kind
	}
	if message, ok := payload["message"].(string); ok {
		return message
	}
	if detail, ok := payload["detail"].(string); ok {
		return detail
	}
	return ""
}

type aiBlockBuilder struct {
	blocks []model.AiBlock
}

func (b *aiBlockBuilder) at(index int) *model.AiBlock {
	for len(b.blocks) <= index {
		b.blocks = append(b.blocks, model.AiBlock{})
	}
	return &b.blocks[index]
}

func (b *aiBlockBuilder) appendBlock(block model.AiBlock) int {
	b.blocks = append(b.blocks, block)
	return len(b.blocks) - 1
}

func (b *aiBlockBuilder) lastOfType(kind string) int {
	if len(b.blocks) == 0 {
		return -1
	}
	last := len(b.blocks) - 1
	if b.blocks[last].Type == kind {
		return last
	}
	return -1
}

func (b *aiBlockBuilder) finish() []model.AiBlock {
	out := make([]model.AiBlock, 0, len(b.blocks))
	for _, block := range b.blocks {
		if block.Type == "" {
			continue
		}
		if block.Type == model.AiBlockToolUse && strings.TrimSpace(block.Input) == "" {
			block.Input = "{}"
		}
		out = append(out, block)
	}
	return out
}

var aiToolNameInvalid = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

func aiSanitizeToolName(name string) string {
	clean := strings.Trim(aiToolNameInvalid.ReplaceAllString(name, "_"), "_")
	if clean == "" {
		clean = "tool"
	}
	if len(clean) > 64 {
		clean = clean[:64]
	}
	return clean
}

func aiAssignToolNames(tools []aiTool) []aiTool {
	counts := map[string]int{}
	for _, tool := range tools {
		counts[aiSanitizeToolName(tool.Original)]++
	}
	used := map[string]bool{}
	out := make([]aiTool, len(tools))
	for i, tool := range tools {
		name := aiSanitizeToolName(tool.Original)
		if counts[name] > 1 {
			name = aiSanitizeToolName(tool.Server + "_" + tool.Original)
		}
		base := name
		for n := 2; used[name]; n++ {
			suffix := "_" + strconv.Itoa(n)
			if len(base)+len(suffix) > 64 {
				name = base[:64-len(suffix)] + suffix
			} else {
				name = base + suffix
			}
		}
		used[name] = true
		tool.Name = name
		out[i] = tool
	}
	return out
}

func aiToolSchema(raw json.RawMessage) json.RawMessage {
	var schema map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &schema) != nil || schema == nil {
		return json.RawMessage(`{"type":"object","properties":{}}`)
	}
	if _, ok := schema["type"]; !ok {
		schema["type"] = "object"
	}
	encoded, err := json.Marshal(schema)
	if err != nil {
		return json.RawMessage(`{"type":"object","properties":{}}`)
	}
	return encoded
}

func aiInputObject(input string) json.RawMessage {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return json.RawMessage(`{}`)
	}
	if json.Valid([]byte(trimmed)) {
		return json.RawMessage(trimmed)
	}
	return json.RawMessage(`{}`)
}

func aiTextOf(blocks []model.AiBlock) string {
	var parts []string
	for _, block := range blocks {
		if block.Type == model.AiBlockText && block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	return strings.Join(parts, "")
}

func aiHeader(headers []model.KeyValue, key string) bool {
	for _, h := range headers {
		if h.Enabled && strings.EqualFold(strings.TrimSpace(h.Key), key) {
			return true
		}
	}
	return false
}

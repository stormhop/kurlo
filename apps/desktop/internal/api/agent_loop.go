package api

import (
	"fmt"
	"strings"
	"sync"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	agentDefaultContextTokens = 128_000
	agentLocalContextTokens   = 32_000
	agentContextSharePercent  = 70
	agentCompactedToolTokens  = 300
	agentKeepRecentToolTurns  = 2
	agentImageTokens          = 1_600
)

var aiModelWindows sync.Map

func aiModelWindowKey(base, modelID string) string {
	return strings.TrimRight(strings.TrimSpace(base), "/") + "\n" + strings.TrimSpace(modelID)
}

func rememberAiModelWindows(base string, models []model.AiConnectionModel) {
	for _, entry := range models {
		if entry.ContextWindow > 0 {
			aiModelWindows.Store(aiModelWindowKey(base, entry.ID), entry.ContextWindow)
		}
	}
}

func agentContextWindow(connection savedAiConnection, baseURL, modelID string) int {
	if value, ok := aiModelWindows.Load(aiModelWindowKey(baseURL, modelID)); ok {
		if window, _ := value.(int); window > 0 {
			return window
		}
	}
	if connection.Kind == model.AiConnectionLocal {
		return agentLocalContextTokens
	}
	return agentDefaultContextTokens
}

func agentContextBudget(window int) int {
	if window <= 0 {
		window = agentDefaultContextTokens
	}
	return window * agentContextSharePercent / 100
}

func agentEstimateTokens(text string) int {
	if text == "" {
		return 0
	}
	return (len(text) + 3) / 4
}

func agentBlockTokens(block model.AiBlock) int {
	if block.Type == model.AiBlockImage {
		return agentImageTokens
	}
	return agentEstimateTokens(block.Text) + agentEstimateTokens(block.Input) + agentEstimateTokens(block.Data) + 4
}

func agentMessageTokens(message model.AiMessage) int {
	total := 4
	for _, block := range message.Blocks {
		total += agentBlockTokens(block)
	}
	return total
}

func agentMessagesTokens(messages []model.AiMessage) int {
	total := 0
	for _, message := range messages {
		total += agentMessageTokens(message)
	}
	return total
}

func agentToolsTokens(tools []aiTool) int {
	total := 0
	for _, tool := range tools {
		total += agentEstimateTokens(tool.Name) + agentEstimateTokens(tool.Description) + agentEstimateTokens(string(tool.Schema)) + 8
	}
	return total
}

func agentTrimTokens(text string, tokens int) string {
	limit := tokens * 4
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8RuneStart(text[cut]) {
		cut--
	}
	left := agentEstimateTokens(text[cut:])
	return text[:cut] + fmt.Sprintf("\n[compacted to fit the model's context: about %d tokens left out; call the tool again if you need them]", left)
}

func utf8RuneStart(b byte) bool {
	return b&0xC0 != 0x80
}

func agentCompactConversation(conversation []model.AiMessage, tokens, budget int) ([]model.AiMessage, int, int) {
	if tokens <= budget {
		return conversation, tokens, 0
	}
	var toolIndexes []int
	for index, message := range conversation {
		if message.Role == "tool" {
			toolIndexes = append(toolIndexes, index)
		}
	}
	if len(toolIndexes) <= agentKeepRecentToolTurns {
		return conversation, tokens, 0
	}
	out := append([]model.AiMessage(nil), conversation...)
	compacted := 0
	for _, index := range toolIndexes[:len(toolIndexes)-agentKeepRecentToolTurns] {
		if tokens <= budget {
			break
		}
		message := out[index]
		blocks := append([]model.AiBlock(nil), message.Blocks...)
		changed := false
		for i, block := range blocks {
			if block.Type != model.AiBlockToolResult || agentEstimateTokens(block.Text) <= agentCompactedToolTokens+40 {
				continue
			}
			before := agentBlockTokens(block)
			block.Text = agentTrimTokens(block.Text, agentCompactedToolTokens)
			tokens -= before - agentBlockTokens(block)
			blocks[i] = block
			changed = true
			compacted++
		}
		if changed {
			out[index] = model.AiMessage{Role: message.Role, Blocks: blocks}
		}
	}
	return out, tokens, compacted
}

type agentTurnLoop struct {
	chatID      string
	turnID      string
	window      int
	budget      int
	fixedTokens int
	priorUsage  model.AiUsage
	budgetLimit int64
	emit        aiEmitter
	compactions int
	turnUsage   model.AiUsage
	lastTokens  int
}

func agentUsageTokens(usage model.AiUsage) int64 {
	return int64(usage.Input + usage.Output + usage.CacheRead + usage.CacheWrite)
}

func (l *agentTurnLoop) promptTokens(conversation []model.AiMessage, last model.AiStep) int {
	if last.HasUsage {
		if measured := last.Usage.Input + last.Usage.CacheRead + last.Usage.CacheWrite; measured > 0 {
			start := len(conversation) - 1
			for start > 0 && conversation[start].Role != "assistant" {
				start--
			}
			if start < 0 {
				start = 0
			}
			return measured + agentMessagesTokens(conversation[start:])
		}
	}
	return l.fixedTokens + agentMessagesTokens(conversation)
}

func (l *agentTurnLoop) budgetError(extra model.AiUsage) error {
	if l.budgetLimit <= 0 {
		return nil
	}
	used := agentUsageTokens(l.priorUsage) + agentUsageTokens(l.turnUsage) + agentUsageTokens(extra)
	if used < l.budgetLimit {
		return nil
	}
	return fmt.Errorf("This chat reached its budget of %s tokens (%s used). Raise the budget in Chat details to continue.", agentFormatCount(l.budgetLimit), agentFormatCount(used))
}

func (l *agentTurnLoop) prepare(_ int, conversation []model.AiMessage, last model.AiStep) ([]model.AiMessage, error) {
	l.turnUsage.Add(last.Usage)
	if err := l.budgetError(model.AiUsage{}); err != nil {
		return nil, err
	}
	tokens := l.promptTokens(conversation, last)
	out, tokens, compacted := agentCompactConversation(conversation, tokens, l.budget)
	l.compactions += compacted
	l.lastTokens = tokens
	if l.emit != nil {
		l.emit("agent:context", model.AgentContext{ChatID: l.chatID, TurnID: l.turnID, Tokens: int64(tokens), Window: int64(l.window)})
	}
	return out, nil
}

func agentFormatCount(value int64) string {
	text := fmt.Sprintf("%d", value)
	var out []byte
	for i := range text {
		if i > 0 && (len(text)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, text[i])
	}
	return string(out)
}

package api

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	agentCompactSummaryTokens = 4096
	agentCompactToolTokens    = 400
)

const agentCompactPrompt = `You compact the history of a chat between a user and the Kurlo agent, an assistant that works on API requests, collections and environments in the Kurlo API client.
Write a summary that lets the agent continue the work without the original messages. Keep:
- what the user asked for and every decision or preference they stated;
- what was done: requests, collections, environments and files created or changed, with their exact names;
- results that matter later: status codes, errors, IDs, variable names, URLs;
- what is still open or was promised next.
Leave out greetings and anything already superseded. Never include secrets, tokens or keys. Write plain text with short sections, in the language the user wrote in.`

func agentCompactTranscript(chat model.AgentChat, budget int) string {
	var out strings.Builder
	if summary := strings.TrimSpace(chat.Summary); summary != "" && chat.SummaryBefore > 0 {
		out.WriteString("Summary of the chat before this point:\n")
		out.WriteString(summary)
		out.WriteString("\n\n")
	}
	start := min(max(chat.SummaryBefore, 0), len(chat.Messages))
	var turns []string
	for _, message := range chat.Messages[start:] {
		var text strings.Builder
		for _, block := range message.Blocks {
			switch block.Type {
			case model.AiBlockText:
				if strings.TrimSpace(block.Text) != "" {
					text.WriteString(block.Text)
					text.WriteString("\n")
				}
			case model.AiBlockToolUse:
				fmt.Fprintf(&text, "[called %s %s]\n", block.Name, agentTrimText(block.Input, agentCompactToolTokens/2))
			case model.AiBlockToolResult:
				label := "result"
				if block.IsError {
					label = "error"
				}
				fmt.Fprintf(&text, "[tool %s: %s]\n", label, agentTrimText(block.Text, agentCompactToolTokens))
			}
		}
		if text.Len() == 0 {
			continue
		}
		role := "User"
		if message.Role == "assistant" {
			role = "Agent"
		}
		turns = append(turns, role+":\n"+strings.TrimSpace(text.String()))
	}
	head := out.String()
	left := budget - agentEstimateTokens(head)
	kept := 0
	used := 0
	for index := len(turns) - 1; index >= 0; index-- {
		cost := agentEstimateTokens(turns[index])
		if used+cost > left && kept > 0 {
			break
		}
		used += cost
		kept++
	}
	if kept < len(turns) {
		head += fmt.Sprintf("[%d older messages were left out to fit the model's context]\n\n", len(turns)-kept)
	}
	return head + strings.Join(turns[len(turns)-kept:], "\n\n")
}

func agentSummaryPrompt(chat model.AgentChat) string {
	summary := strings.TrimSpace(chat.Summary)
	if summary == "" || chat.SummaryBefore <= 0 || chat.SummaryBefore > len(chat.Messages) {
		return ""
	}
	return "\n\nThe earlier part of this chat was compacted. You no longer see those messages; this is their summary:\n<chat-summary>\n" + summary + "\n</chat-summary>"
}

func agentHistoryAfterSummary(chat model.AgentChat) []model.AiMessage {
	if agentSummaryPrompt(chat) == "" {
		return chat.Messages
	}
	return chat.Messages[chat.SummaryBefore:]
}

func agentDropStaleSummary(chat *model.AgentChat, keep int) {
	if chat.SummaryBefore > keep {
		chat.Summary = ""
		chat.SummaryBefore = 0
	}
}

func (a *App) CompactAgentChat(id, workspaceID string) (model.AgentChat, error) {
	workspace := agentWorkspaceKey(fileWorkspaceStorePath())
	chat, err := loadAgentChat(id)
	if err != nil {
		return model.AgentChat{}, err
	}
	if chat.Workspace != workspace || chat.WorkspaceID != workspaceID {
		return model.AgentChat{}, errors.New("This chat belongs to another workspace.")
	}
	if chat.Driver != "" {
		return model.AgentChat{}, errors.New("Only Kurlo agent chats can be compacted; Codex and Claude Code manage their own history.")
	}
	if chat.ArchivedAt != 0 {
		return model.AgentChat{}, errors.New("Restore this chat before compacting it.")
	}
	if len(chat.Messages)-max(chat.SummaryBefore, 0) < 2 {
		return model.AgentChat{}, errors.New("There is nothing new to compact yet.")
	}
	rt := a.agentRuntime()
	if !rt.begin(chat.ID) {
		return model.AgentChat{}, errors.New("The agent is still working in this chat.")
	}
	defer rt.end(chat.ID)

	connection, err := agentConnection(chat.ConnectionID)
	if err != nil {
		return model.AgentChat{}, err
	}
	req := model.AiRequest{
		HTTP:     model.HttpRequest{RequestID: "compact-" + chat.ID, Method: "POST"},
		Model:    chat.Model,
		System:   agentCompactPrompt,
		Settings: model.AiSettings{Stream: true, MaxTokens: agentCompactSummaryTokens},
		MaxSteps: 1,
	}
	req, key, err := resolveAiConnectionRequest(req, connection)
	if err != nil {
		return model.AgentChat{}, err
	}
	window := agentContextWindow(connection, req.HTTP.URL, req.Model)
	budget := agentContextBudget(window) - agentEstimateTokens(agentCompactPrompt) - agentCompactSummaryTokens
	end := len(chat.Messages)
	transcript := agentCompactTranscript(chat, budget)
	req.Messages = []model.AiMessage{{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "Compact this chat:\n\n" + transcript}}}}

	baseCtx := context.Background()
	if a.ctx != nil {
		baseCtx = a.ctx
	}
	ctx, cancel := context.WithCancel(baseCtx)
	cancelKey := agentCancelPrefix + chat.ID
	seq := a.registerRequestCancel(cancelKey, cancel)
	defer func() {
		cancel()
		a.unregisterRequestCancel(cancelKey, seq)
	}()
	runner := aiRunner{
		ctx:      ctx,
		req:      req,
		provider: aiProviderFor(req.Provider),
		send: func(stepCtx context.Context, prepared model.HttpRequest, sink responseBodySinkFactory) model.HttpResponse {
			return sendRequestWithBodySink(stepCtx, prepared, a.state, a.cookieJars, a.preflightCache, sink)
		},
		now: time.Now,
	}
	out := redactAiResponseKey(model.NormalizeAiResponse(runner.run()), key)
	if ctx.Err() != nil {
		return model.AgentChat{}, errors.New("Compacting was stopped.")
	}
	if out.Error != "" {
		return model.AgentChat{}, errors.New(out.Error)
	}
	summary := strings.TrimSpace(out.Text)
	if summary == "" {
		return model.AgentChat{}, errors.New("The model returned an empty summary, so the chat was not compacted.")
	}
	saved, err := updateAgentChat(chat.ID, func(saved *model.AgentChat) {
		if len(saved.Messages) < end {
			return
		}
		saved.Summary = summary
		saved.SummaryBefore = end
		saved.Usage.Add(out.Usage)
		saved.ContextTokens = int64(agentEstimateTokens(summary))
		saved.ContextWindow = int64(window)
	})
	if err != nil {
		return model.AgentChat{}, err
	}
	if saved.SummaryBefore != end {
		return model.AgentChat{}, errors.New("The chat changed while it was being compacted. Try again.")
	}
	return agentChatPage(saved, -1), nil
}

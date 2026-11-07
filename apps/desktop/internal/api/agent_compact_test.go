package api

import (
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func agentCompactTestChat(t *testing.T, connectionID string) model.AgentChat {
	t.Helper()
	text := func(role, value string) model.AiMessage {
		return model.AiMessage{Role: role, Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: value}}}
	}
	chat, err := createAgentChat(model.AgentChat{
		ID: "compact-chat", Title: "Orders", Workspace: agentWorkspaceKey(fileWorkspaceStorePath()), WorkspaceID: "ws", ConnectionID: connectionID, Model: "m",
		Messages: []model.AiMessage{
			text("user", "Create a request that lists orders"),
			{Role: "assistant", Blocks: []model.AiBlock{{Type: model.AiBlockToolUse, ID: "t1", Name: "save_request", Input: `{"name":"List orders"}`}}},
			{Role: "tool", Blocks: []model.AiBlock{{Type: model.AiBlockToolResult, ID: "t1", Text: "Saved List orders"}}},
			text("assistant", "Saved List orders in Shop."),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return chat
}

func TestCompactAgentChatSavesASummaryTheAgentUsesNext(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := newAiTestServer(t, sseScript{events: []string{
		openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"The user asked for a List orders request; it was saved in Shop."},"finish_reason":"stop"}]}`),
		openAIChunkEvent(`[DONE]`),
	}})
	connection, _, err := upsertAiConnection(model.AiConnectionInput{Kind: model.AiConnectionLocal, Label: "Local", BaseURL: server.URL, Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	chat := agentCompactTestChat(t, connection.ID)

	app := NewApp()
	page, err := app.CompactAgentChat(chat.ID, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if page.SummaryBefore != 4 || !strings.Contains(page.Summary, "List orders") {
		t.Fatalf("summary %q before %d", page.Summary, page.SummaryBefore)
	}
	sent := server.body(0)["messages"].([]any)
	prompt := sent[len(sent)-1].(map[string]any)["content"].(string)
	if !strings.Contains(prompt, "Create a request that lists orders") || !strings.Contains(prompt, "[called save_request") {
		t.Fatalf("transcript sent to the model: %s", prompt)
	}

	saved, err := loadAgentChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Messages) != 4 {
		t.Fatalf("messages stay in the chat, got %d", len(saved.Messages))
	}
	saved.Messages = append(saved.Messages, model.AiMessage{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "Now add a test"}}})
	if system := agentSummaryPrompt(saved); !strings.Contains(system, "<chat-summary>") || !strings.Contains(system, "saved in Shop") {
		t.Fatalf("system prompt addition %q", system)
	}
	if history := agentHistoryAfterSummary(saved); len(history) != 1 || history[0].Blocks[0].Text != "Now add a test" {
		t.Fatalf("history after summary %+v", history)
	}

	if _, err := app.CompactAgentChat(chat.ID, "ws"); err == nil || !strings.Contains(err.Error(), "nothing new") {
		t.Fatalf("compacting twice without new messages: %v", err)
	}
	if _, err := app.CompactAgentChat(chat.ID, "other"); err == nil {
		t.Fatal("a chat of another workspace cannot be compacted")
	}

	edited := saved
	agentDropStaleSummary(&edited, 2)
	if edited.Summary != "" || edited.SummaryBefore != 0 {
		t.Fatal("editing a compacted message drops the summary")
	}
	kept := saved
	agentDropStaleSummary(&kept, 4)
	if kept.Summary == "" {
		t.Fatal("editing after the compacted part keeps the summary")
	}
}

func TestCompactAgentChatKeepsTheChatWhenTheModelFails(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := newAiTestServer(t, sseScript{status: 500, json: `{"error":{"message":"overloaded"}}`})
	connection, _, err := upsertAiConnection(model.AiConnectionInput{Kind: model.AiConnectionLocal, Label: "Local", BaseURL: server.URL, Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	chat := agentCompactTestChat(t, connection.ID)
	if _, err := NewApp().CompactAgentChat(chat.ID, "ws"); err == nil {
		t.Fatal("a failed summary is reported")
	}
	saved, err := loadAgentChat(chat.ID)
	if err != nil || saved.Summary != "" || saved.SummaryBefore != 0 || len(saved.Messages) != 4 {
		t.Fatalf("chat unchanged after a failure: %+v %v", saved, err)
	}
}

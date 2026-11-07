package api

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func agentPartsTestMessages(count int) []model.AiMessage {
	messages := make([]model.AiMessage, 0, count)
	filler := strings.Repeat("x", 4000)
	for i := 0; i < count; i++ {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		messages = append(messages, model.AiMessage{Role: role, Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: filler + string(rune('a'+i%26))}}})
	}
	return messages
}

func agentPartFiles(t *testing.T, id string) map[string]os.FileInfo {
	t.Helper()
	path, err := agentChatPath(id)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(agentChatPartsDir(path))
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]os.FileInfo{}
		}
		t.Fatal(err)
	}
	out := map[string]os.FileInfo{}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			t.Fatal(err)
		}
		out[entry.Name()] = info
	}
	return out
}

func TestAgentChatIsStoredInSealedParts(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	messages := agentPartsTestMessages(300)
	chat, err := createAgentChat(model.AgentChat{ID: "long-chat", Title: "Long", Workspace: "/w", Messages: messages})
	if err != nil {
		t.Fatal(err)
	}
	parts := agentPartFiles(t, chat.ID)
	if len(parts) < 2 {
		t.Fatalf("a long chat is split into parts, got %d", len(parts))
	}
	path, _ := agentChatPath(chat.ID)
	head, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if head.Size() > 2*agentChatPartMaxBytes {
		t.Fatalf("the head file keeps only the open part, size %d", head.Size())
	}
	for name := range parts {
		raw, err := os.ReadFile(agentChatPartsDir(path) + "/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), `"role"`) || strings.Contains(string(raw), strings.Repeat("x", 64)) {
			t.Fatal("chat parts are encrypted on disk")
		}
	}

	loaded, err := loadAgentChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Messages) != 300 || loaded.Messages[299].Blocks[0].Text != messages[299].Blocks[0].Text {
		t.Fatalf("loaded %d messages", len(loaded.Messages))
	}

	if _, err := updateAgentChat(chat.ID, func(saved *model.AgentChat) {
		saved.Messages = append(saved.Messages, model.AiMessage{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: "one more"}}})
	}); err != nil {
		t.Fatal(err)
	}
	after := agentPartFiles(t, chat.ID)
	for name, info := range parts {
		again, ok := after[name]
		if !ok || !again.ModTime().Equal(info.ModTime()) {
			t.Fatalf("sealed part %s was rewritten by a new message", name)
		}
	}

	if _, err := updateAgentChat(chat.ID, func(saved *model.AgentChat) {
		saved.Messages = saved.Messages[:10]
	}); err != nil {
		t.Fatal(err)
	}
	if left := agentPartFiles(t, chat.ID); len(left) != 0 {
		t.Fatalf("parts no longer used are removed, %d left", len(left))
	}
	loaded, err = loadAgentChat(chat.ID)
	if err != nil || len(loaded.Messages) != 10 {
		t.Fatalf("after edit: %d messages, %v", len(loaded.Messages), err)
	}

	if _, err := updateAgentChat(chat.ID, func(saved *model.AgentChat) { saved.Messages = messages }); err != nil {
		t.Fatal(err)
	}
	if err := removeAgentChatIndex(); err != nil {
		t.Fatal(err)
	}
	chats, err := listAgentChats("/w", time.Now())
	if err != nil || len(chats) != 1 || chats[0].Title != "Long" {
		t.Fatalf("index rebuilt from heads: %+v %v", chats, err)
	}
	if err := deleteAgentChat(chat.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(agentChatPartsDir(path)); !os.IsNotExist(err) {
		t.Fatalf("deleting a chat removes its parts, err = %v", err)
	}
}

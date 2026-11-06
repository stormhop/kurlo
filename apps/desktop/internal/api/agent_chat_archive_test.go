package api

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func TestAgentChatArchiveSurvivesRetentionAndIndexRebuild(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	now := time.Now()
	root := agentWorkspaceKey(fileWorkspaceStorePath())
	app := &App{}
	chat, err := createAgentChat(model.AgentChat{ID: "keep", Workspace: root, WorkspaceID: "shop", Driver: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.SetAgentChatArchived(chat.ID, "other", true); err == nil {
		t.Fatal("another workspace could archive the chat")
	}
	if !app.agentRuntime().begin(chat.ID) {
		t.Fatal("could not start the turn")
	}
	if _, err := app.SetAgentChatArchived(chat.ID, "shop", true); err == nil {
		t.Fatal("a running chat could be archived")
	}
	app.agentRuntime().end(chat.ID)

	archived, err := setAgentChatArchived(chat.ID, root, "shop", true, now)
	if err != nil || archived.ArchivedAt != now.UnixMilli() {
		t.Fatalf("archive = %+v, %v", archived, err)
	}
	if _, err := updateAgentChat(chat.ID, func(chat *model.AgentChat) { chat.Title = "changed" }); err == nil {
		t.Fatal("an archived chat could be updated by a turn")
	}
	if err := os.Remove(agentChatIndexPath()); err != nil {
		t.Fatal(err)
	}

	later := now.Add(agentChatRetention + time.Hour)
	index, err := rebuildAgentChatIndex()
	if err != nil || index[chat.ID].ArchivedAt != archived.ArchivedAt {
		t.Fatalf("archived index entry = %+v, %v", index[chat.ID], err)
	}
	for i := 0; i <= agentChatMaxCount; i++ {
		id := fmt.Sprintf("active-%03d", i)
		active := model.AgentChat{ID: id, Workspace: root, WorkspaceID: "shop", UpdatedAt: later.Add(-time.Duration(i) * time.Second).UnixMilli()}
		if err := writeAgentChatFile(active); err != nil {
			t.Fatal(err)
		}
		index[id] = agentChatIndexEntryOf(active)
	}
	expired := model.AgentChat{ID: "expired", Workspace: root, WorkspaceID: "shop", UpdatedAt: now.UnixMilli()}
	if err := writeAgentChatFile(expired); err != nil {
		t.Fatal(err)
	}
	index[expired.ID] = agentChatIndexEntryOf(expired)
	recentArchive := model.AgentChat{ID: "recent-archive", Workspace: root, WorkspaceID: "shop", ArchivedAt: later.UnixMilli(), UpdatedAt: later.Add(time.Millisecond).UnixMilli()}
	if err := writeAgentChatFile(recentArchive); err != nil {
		t.Fatal(err)
	}
	index[recentArchive.ID] = agentChatIndexEntryOf(recentArchive)
	if err := writeAgentChatIndex(index); err != nil {
		t.Fatal(err)
	}
	chats, err := listAgentChats(root, later)
	if err != nil || len(chats) != agentChatMaxCount+2 || chats[0].ID != recentArchive.ID || chats[len(chats)-1].ID != chat.ID {
		t.Fatalf("retention left %d chats, err = %v", len(chats), err)
	}
	for _, id := range []string{"expired", fmt.Sprintf("active-%03d", agentChatMaxCount)} {
		if _, err := readAgentChat(id); !os.IsNotExist(err) {
			t.Fatalf("expected %s to be removed, got %v", id, err)
		}
	}
	restored, err := setAgentChatArchived(chat.ID, root, "shop", false, later.Add(time.Second))
	if err != nil || restored.ArchivedAt != 0 || restored.CreatedAt != chat.CreatedAt {
		t.Fatalf("restore = %+v, %v", restored, err)
	}
	chats, err = listAgentChats(root, later.Add(time.Second))
	if err != nil || len(chats) != agentChatMaxCount+1 || chats[0].ID != chat.ID {
		t.Fatalf("retention after restore left %d chats, err = %v", len(chats), err)
	}
}

func TestAgentChatMarkdownSave(t *testing.T) {
	chat := model.AgentChat{Title: "Checkout API", Driver: "claude-code", ArchivedAt: 1, ExternalThreadID: "native-thread-id"}
	for i := range 45 {
		chat.Messages = append(chat.Messages, model.AiMessage{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: fmt.Sprintf("Prompt %02d", i)}}})
	}
	chat.Messages = append(chat.Messages, model.AiMessage{Role: "assistant", Blocks: []model.AiBlock{
		{Type: model.AiBlockToolUse, Name: "send_request", Input: `{"request":"Checkout"}`},
		{Type: model.AiBlockToolResult, Text: "~~~~\n[cut: 20 more bytes were not kept in the chat]"},
		{Type: model.AiBlockThinking, Text: "Inspecting the saved request", Signature: "private-provider-data"},
		{Type: model.AiBlockRedacted, Data: "private-provider-data"},
	}})
	dir := t.TempDir()
	path := filepath.Join(dir, "agent-Checkout-API.md")
	saved, err := saveAgentChatMarkdown(chat, func(options runtime.SaveDialogOptions) (string, error) {
		if options.DefaultFilename != filepath.Base(path) {
			t.Fatalf("default filename = %q", options.DefaultFilename)
		}
		return path, nil
	})
	if err != nil || saved != path {
		t.Fatalf("save = %q, %v", saved, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	transcript := string(data)
	for _, fragment := range []string{"# Checkout API", "Claude Code", "Prompt 00", "Prompt 44", "Inspecting the saved request", "send_request", "~~~~~text\n~~~~", "[cut: 20 more bytes were not kept in the chat]"} {
		if !strings.Contains(transcript, fragment) {
			t.Fatalf("export is missing %q", fragment)
		}
	}
	if strings.Contains(transcript, chat.ExternalThreadID) || strings.Contains(transcript, "private-provider-data") {
		t.Fatal("export includes private provider metadata")
	}
	saved, err = saveAgentChatMarkdown(chat, func(runtime.SaveDialogOptions) (string, error) { return "", nil })
	if err != nil || saved != "" {
		t.Fatalf("cancel = %q, %v", saved, err)
	}
	saved, err = saveAgentChatMarkdown(chat, func(runtime.SaveDialogOptions) (string, error) {
		return filepath.Join(dir, "missing", "chat.md"), nil
	})
	if err == nil || saved != "" {
		t.Fatalf("failed save = %q, %v", saved, err)
	}
}

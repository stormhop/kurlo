package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	agentChatsDirName   = "agent-chats"
	agentChatRetention  = 90 * 24 * time.Hour
	agentChatMaxCount   = 200
	agentChatTitleRunes = 60

	agentChatTitleMaxRunes   = 120
	agentChatIndexName       = "index.json"
	agentChatToolResultLimit = 64 * 1024
)

var agentChatsMu sync.Mutex

func agentChatsDir() string {
	return filepath.Join(requestStoreDir(), agentChatsDirName)
}

func agentChatPath(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" || id+".json" == agentChatIndexName {
		return "", errors.New("chat id is empty")
	}
	for _, ch := range id {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9', ch == '-', ch == '_':
		default:
			return "", fmt.Errorf("invalid chat id %q", id)
		}
	}
	return filepath.Join(agentChatsDir(), id+".json"), nil
}

func agentWorkspaceKey(root string) string {
	return workspaceLockKey(root)
}

func agentChatTitle(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) <= agentChatTitleRunes {
		return text
	}
	runes := []rune(text)
	return strings.TrimSpace(string(runes[:agentChatTitleRunes-1])) + "…"
}

func normalizeAgentChat(chat model.AgentChat) model.AgentChat {
	if chat.Messages == nil {
		chat.Messages = []model.AiMessage{}
	}
	for i := range chat.Messages {
		if chat.Messages[i].Blocks == nil {
			chat.Messages[i].Blocks = []model.AiBlock{}
		}
	}
	if chat.AllowedTools == nil {
		chat.AllowedTools = []string{}
	}
	return chat
}

func readAgentChat(id string) (model.AgentChat, error) {
	var chat model.AgentChat
	path, err := agentChatPath(id)
	if err != nil {
		return chat, err
	}
	head, err := readAgentChatHead(path)
	if err != nil {
		return chat, err
	}
	chat, err = readAgentChatParts(path, head)
	if err != nil {
		return chat, err
	}
	return normalizeAgentChat(chat), nil
}

type agentChatIndexEntry struct {
	ArchivedAt  int64  `json:"archivedAt,omitempty"`
	WorkspaceID string `json:"workspaceId"`
	Driver      string `json:"driver,omitempty"`
	ID          string `json:"id"`
	Title       string `json:"title"`
	Workspace   string `json:"workspace"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

func agentChatIndexPath() string {
	return filepath.Join(agentChatsDir(), agentChatIndexName)
}

func agentChatIndexEntryOf(chat model.AgentChat) agentChatIndexEntry {
	return agentChatIndexEntry{ArchivedAt: chat.ArchivedAt, WorkspaceID: chat.WorkspaceID, Driver: chat.Driver, ID: chat.ID, Title: chat.Title, Workspace: chat.Workspace, CreatedAt: chat.CreatedAt, UpdatedAt: chat.UpdatedAt}
}

func (entry agentChatIndexEntry) summary() model.AgentChatSummary {
	return model.AgentChatSummary{ArchivedAt: entry.ArchivedAt, WorkspaceID: entry.WorkspaceID, Driver: entry.Driver, ID: entry.ID, Title: entry.Title, CreatedAt: entry.CreatedAt, UpdatedAt: entry.UpdatedAt}
}

func readAgentChatIndex() (map[string]agentChatIndexEntry, error) {
	data, err := os.ReadFile(agentChatIndexPath())
	if err != nil {
		return nil, err
	}
	payload, err := decryptRequestStorePayload(data)
	if err != nil {
		return nil, err
	}
	var entries []agentChatIndexEntry
	if err := json.Unmarshal(payload, &entries); err != nil {
		return nil, err
	}
	index := make(map[string]agentChatIndexEntry, len(entries))
	for _, entry := range entries {
		index[entry.ID] = entry
	}
	return index, nil
}

func writeAgentChatIndex(index map[string]agentChatIndexEntry) error {
	entries := make([]agentChatIndexEntry, 0, len(index))
	for _, entry := range index {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].UpdatedAt > entries[j].UpdatedAt })
	payload, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	encrypted, err := encryptRequestStorePayload(payload)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(agentChatsDir(), 0o700); err != nil {
		return err
	}
	return writeFileAtomic(agentChatIndexPath(), encrypted)
}

func rebuildAgentChatIndex() (map[string]agentChatIndexEntry, error) {
	index := map[string]agentChatIndexEntry{}
	entries, err := os.ReadDir(agentChatsDir())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return index, nil
		}
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") || name == agentChatIndexName {
			continue
		}
		head, err := readAgentChatHead(filepath.Join(agentChatsDir(), name))
		if err != nil || head.ID+".json" != name {
			continue
		}
		index[head.ID] = agentChatIndexEntryOf(head.AgentChat)
	}
	return index, writeAgentChatIndex(index)
}

func loadAgentChatIndex() (map[string]agentChatIndexEntry, error) {
	index, err := readAgentChatIndex()
	if err == nil {
		return index, nil
	}
	return rebuildAgentChatIndex()
}

func agentStoredToolText(text string) string {
	if len(text) <= agentChatToolResultLimit {
		return text
	}
	cut := agentChatToolResultLimit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + fmt.Sprintf("\n[cut: %d more bytes were not kept in the chat]", len(text)-cut)
}

func compactStoredAgentMessages(messages []model.AiMessage) []model.AiMessage {
	out := make([]model.AiMessage, len(messages))
	for i, message := range messages {
		blocks := make([]model.AiBlock, len(message.Blocks))
		for j, block := range message.Blocks {
			if block.Type == model.AiBlockToolResult {
				block.Text = agentStoredToolText(block.Text)
			}
			blocks[j] = block
		}
		message.Blocks = blocks
		out[i] = message
	}
	return out
}

func writeAgentChatFile(chat model.AgentChat) error {
	path, err := agentChatPath(chat.ID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(agentChatsDir(), 0o700); err != nil {
		return err
	}
	chat = normalizeAgentChat(chat)
	head, err := writeAgentChatParts(path, chat)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(head)
	if err != nil {
		return err
	}
	encrypted, err := encryptRequestStorePayload(payload)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(path, encrypted); err != nil {
		return err
	}
	pruneAgentChatParts(path, head)
	return nil
}

func writeAgentChat(chat model.AgentChat, files ...agentAttachment) error {
	chat.Messages = compactStoredAgentMessages(chat.Messages)
	rollback, err := storeAgentAttachmentFiles(chat.ID, files)
	if err != nil {
		return err
	}
	index, err := loadAgentChatIndex()
	if err != nil {
		rollback()
		return err
	}
	if err := removeAgentChatIndex(); err != nil {
		rollback()
		return err
	}
	if err := writeAgentChatFile(chat); err != nil {
		rollback()
		return err
	}
	index[chat.ID] = agentChatIndexEntryOf(chat)
	return writeAgentChatIndex(index)
}

func removeAgentChatIndex() error {
	if err := os.Remove(agentChatIndexPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func loadAgentChat(id string) (model.AgentChat, error) {
	agentChatsMu.Lock()
	defer agentChatsMu.Unlock()
	chat, err := readAgentChat(id)
	if errors.Is(err, os.ErrNotExist) {
		return chat, fmt.Errorf("chat %s was deleted", id)
	}
	return chat, err
}

func updateAgentChat(id string, change func(chat *model.AgentChat), files ...agentAttachment) (model.AgentChat, error) {
	agentChatsMu.Lock()
	defer agentChatsMu.Unlock()
	chat, err := readAgentChat(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return chat, fmt.Errorf("chat %s was deleted", id)
		}
		return chat, err
	}
	if chat.ArchivedAt != 0 {
		return chat, errors.New("Restore this chat before sending a message.")
	}
	change(&chat)
	chat.UpdatedAt = time.Now().UnixMilli()
	return chat, writeAgentChat(chat, files...)
}

func createAgentChat(chat model.AgentChat, files ...agentAttachment) (model.AgentChat, error) {
	agentChatsMu.Lock()
	defer agentChatsMu.Unlock()
	now := time.Now().UnixMilli()
	chat.CreatedAt = now
	chat.UpdatedAt = now
	chat = normalizeAgentChat(chat)
	return chat, writeAgentChat(chat, files...)
}

func listAgentChats(workspace string, now time.Time) ([]model.AgentChatSummary, error) {
	agentChatsMu.Lock()
	defer agentChatsMu.Unlock()
	index, err := loadAgentChatIndex()
	if err != nil {
		return nil, err
	}
	entries := make([]agentChatIndexEntry, 0, len(index))
	for _, entry := range index {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].UpdatedAt > entries[j].UpdatedAt })
	cutoff := now.Add(-agentChatRetention).UnixMilli()
	summaries := []model.AgentChatSummary{}
	removed := false
	active := 0
	for _, entry := range entries {
		if entry.ArchivedAt == 0 && (entry.UpdatedAt < cutoff || active >= agentChatMaxCount) {
			if err := removeAgentChatFiles(entry.ID); err != nil {
				continue
			}
			delete(index, entry.ID)
			removed = true
			continue
		}
		if entry.ArchivedAt == 0 {
			active++
		}
		if entry.Workspace == workspace {
			summaries = append(summaries, entry.summary())
		}
	}
	if removed {
		if err := writeAgentChatIndex(index); err != nil {
			return summaries, err
		}
	}
	return summaries, nil
}

func deleteAgentChat(id string) error {
	agentChatsMu.Lock()
	defer agentChatsMu.Unlock()
	index, err := loadAgentChatIndex()
	if err != nil {
		return err
	}
	if err := removeAgentChatIndex(); err != nil {
		return err
	}
	if err := removeAgentChatFiles(id); err != nil {
		return err
	}
	delete(index, id)
	return writeAgentChatIndex(index)
}

func removeAgentChatFiles(id string) error {
	path, err := agentChatPath(id)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.RemoveAll(agentChatPartsDir(path)); err != nil {
		return err
	}
	return os.RemoveAll(path + ".attachments")
}

func renameAgentChat(id, title string) (model.AgentChat, error) {
	title = strings.Join(strings.Fields(title), " ")
	if title == "" {
		return model.AgentChat{}, errors.New("Enter a name for the chat.")
	}
	if utf8.RuneCountInString(title) > agentChatTitleMaxRunes {
		title = string([]rune(title)[:agentChatTitleMaxRunes])
	}
	agentChatsMu.Lock()
	defer agentChatsMu.Unlock()
	chat, err := readAgentChat(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return chat, fmt.Errorf("chat %s was deleted", id)
		}
		return chat, err
	}
	if chat.ArchivedAt != 0 {
		return chat, errors.New("Restore this chat before renaming it.")
	}
	chat.Title = title
	return chat, writeAgentChat(chat)
}

func agentChatPage(chat model.AgentChat, before int) model.AgentChat {
	total := len(chat.Messages)
	end := total
	if before >= 0 && before < end {
		end = before
	}
	start := end
	turns := 0
	for start > 0 {
		start--
		if chat.Messages[start].Role == "user" {
			turns++
			if turns == 40 {
				break
			}
		}
	}
	messages := make([]model.AiMessage, 0, end-start)
	for _, message := range chat.Messages[start:end] {
		messages = append(messages, agentDisplayMessage(message))
	}
	chat.Messages = messages
	chat.MessageOffset = start
	chat.MessageCount = total
	return normalizeAgentChat(chat)
}

func (a *App) AgentChatPage(id string, before int) (model.AgentChat, error) {
	chat, err := loadAgentChat(id)
	if err != nil {
		return model.AgentChat{}, err
	}
	if chat.Workspace != agentWorkspaceKey(fileWorkspaceStorePath()) {
		return model.AgentChat{}, errors.New("This chat belongs to another workspace.")
	}
	return agentChatPage(chat, before), nil
}

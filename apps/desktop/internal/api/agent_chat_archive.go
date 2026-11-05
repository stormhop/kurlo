package api

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func readWorkspaceAgentChat(id, workspace, workspaceID string) (model.AgentChat, error) {
	chat, err := readAgentChat(id)
	if errors.Is(err, os.ErrNotExist) {
		return chat, errors.New("This chat is no longer available.")
	}
	if err == nil && (chat.Workspace != workspace || chat.WorkspaceID != workspaceID) {
		return model.AgentChat{}, errors.New("This chat belongs to another workspace.")
	}
	return chat, err
}

func setAgentChatArchived(id, workspace, workspaceID string, archived bool, now time.Time) (model.AgentChat, error) {
	agentChatsMu.Lock()
	defer agentChatsMu.Unlock()
	chat, err := readWorkspaceAgentChat(id, workspace, workspaceID)
	if err != nil || archived == (chat.ArchivedAt != 0) {
		return chat, err
	}
	if archived {
		chat.ArchivedAt = now.UnixMilli()
	} else {
		chat.ArchivedAt = 0
		chat.UpdatedAt = now.UnixMilli()
	}
	index, err := loadAgentChatIndex()
	if err != nil {
		return chat, err
	}
	if err := os.Remove(agentChatIndexPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return chat, err
	}
	if err := writeAgentChatFile(chat); err != nil {
		return chat, err
	}
	index[chat.ID] = agentChatIndexEntryOf(chat)
	return chat, writeAgentChatIndex(index)
}

func (a *App) SetAgentChatArchived(id, workspaceID string, archived bool) (model.AgentChatSummary, error) {
	id = strings.TrimSpace(id)
	rt := a.agentRuntime()
	if !rt.begin(id) {
		return model.AgentChatSummary{}, errors.New("Wait for the agent to finish or stop the turn first.")
	}
	defer rt.end(id)
	chat, err := setAgentChatArchived(id, agentWorkspaceKey(fileWorkspaceStorePath()), workspaceID, archived, time.Now())
	return agentChatIndexEntryOf(chat).summary(), err
}

var (
	agentExportFilenameChars = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)
	agentExportFenceRuns     = regexp.MustCompile(`~+`)
)

func agentChatMarkdown(chat model.AgentChat) string {
	var out strings.Builder
	title := strings.Join(strings.Fields(chat.Title), " ")
	if title == "" {
		title = "Untitled chat"
	}
	title = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\\", "\\\\", "[", "\\[", "]", "\\]", "`", "\\`", "*", "\\*", "_", "\\_", "#", "\\#").Replace(title)
	driver := "Kurlo agent"
	switch chat.Driver {
	case "codex":
		driver = "Codex"
	case "claude-code":
		driver = "Claude Code"
	}
	fmt.Fprintf(&out, "# %s\n\n- Agent: %s\n- Created: %s\n- Updated: %s\n", title, driver, time.UnixMilli(chat.CreatedAt).UTC().Format(time.RFC3339), time.UnixMilli(chat.UpdatedAt).UTC().Format(time.RFC3339))
	for _, stored := range chat.Messages {
		message := agentDisplayMessage(stored)
		speaker := "Assistant"
		if message.Role == "user" {
			speaker = "User"
		}
		fmt.Fprintf(&out, "\n## %s\n", speaker)
		for _, block := range message.Blocks {
			switch block.Type {
			case model.AiBlockText:
				fmt.Fprintf(&out, "\n%s\n", block.Text)
			case model.AiBlockThinking:
				if strings.TrimSpace(block.Text) != "" {
					writeAgentMarkdownBlock(&out, "Thinking", block.Text)
				}
			case model.AiBlockToolUse:
				writeAgentMarkdownBlock(&out, "Tool call", strings.TrimSpace(block.Name+"\n"+block.Input))
			case model.AiBlockToolResult:
				label := "Tool result"
				if block.IsError {
					label = "Tool error"
				}
				writeAgentMarkdownBlock(&out, label, block.Text)
			}
		}
		if len(message.Attachments) > 0 {
			names := make([]string, 0, len(message.Attachments))
			for _, attachment := range message.Attachments {
				names = append(names, attachment.Name)
			}
			writeAgentMarkdownBlock(&out, "Attachments", strings.Join(names, "\n"))
		}
	}
	return out.String()
}

func writeAgentMarkdownBlock(out *strings.Builder, label, content string) {
	length := 3
	for _, match := range agentExportFenceRuns.FindAllStringIndex(content, -1) {
		length = max(length, match[1]-match[0]+1)
	}
	fence := strings.Repeat("~", length)
	fmt.Fprintf(out, "\n**%s**\n\n%stext\n%s\n%s\n", label, fence, content, fence)
}

func (a *App) ExportAgentChat(id, workspaceID string) (string, error) {
	agentChatsMu.Lock()
	chat, err := readWorkspaceAgentChat(id, agentWorkspaceKey(fileWorkspaceStorePath()), workspaceID)
	agentChatsMu.Unlock()
	if err != nil {
		return "", err
	}
	return saveAgentChatMarkdown(chat, func(options runtime.SaveDialogOptions) (string, error) {
		if a.ctx == nil {
			return "", errors.New("The save dialog is unavailable.")
		}
		return runtime.SaveFileDialog(a.ctx, options)
	})
}

func saveAgentChatMarkdown(chat model.AgentChat, choosePath func(runtime.SaveDialogOptions) (string, error)) (string, error) {
	name := strings.Trim(agentExportFilenameChars.ReplaceAllString(agentChatTitle(chat.Title), "-"), "-_")
	if name == "" {
		name = "chat"
	}
	path, err := choosePath(runtime.SaveDialogOptions{
		Title: "Export chat as Markdown", DefaultFilename: "agent-" + name + ".md",
		Filters: []runtime.FileFilter{{DisplayName: "Markdown", Pattern: "*.md"}},
	})
	if err != nil || path == "" {
		return "", err
	}
	if err := replaceFileAtomicMode(path, []byte(agentChatMarkdown(chat)), 0o600); err != nil {
		return "", fmt.Errorf("Could not save the chat: %w", err)
	}
	return path, nil
}

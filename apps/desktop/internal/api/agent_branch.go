package api

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func agentCheckEditIndex(chat model.AgentChat, index int) error {
	if index < 0 || index >= len(chat.Messages) || chat.Messages[index].Role != "user" {
		return errors.New("This message can no longer be edited. Reload the chat and try again.")
	}
	return nil
}

func agentBranchTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "Untitled chat"
	}
	return agentChatTitle(title + " (branch)")
}

func (a *App) BranchAgentChat(id, workspaceID string, before int) (model.AgentChat, error) {
	workspace := agentWorkspaceKey(fileWorkspaceStorePath())
	agentChatsMu.Lock()
	defer agentChatsMu.Unlock()
	source, err := readWorkspaceAgentChat(id, workspace, workspaceID)
	if err != nil {
		return model.AgentChat{}, err
	}
	if source.Driver != "" {
		return model.AgentChat{}, errors.New("Only Kurlo agent chats can be branched.")
	}
	if err := agentCheckEditIndex(source, before); err != nil {
		return model.AgentChat{}, err
	}
	now := time.Now().UnixMilli()
	branch := source
	branch.ID = uuid.NewString()
	branch.Title = agentBranchTitle(source.Title)
	branch.CreatedAt = now
	branch.UpdatedAt = now
	branch.ArchivedAt = 0
	branch.Branch = ""
	branch.OwnBranch = false
	branch.Usage = model.AiUsage{}
	branch.RequestsSent = 0
	branch.ContextTokens = 0
	branch.MessageOffset = 0
	branch.MessageCount = 0
	agentDropStaleSummary(&branch, before)
	branch.Messages = agentCloseToolUses(append([]model.AiMessage(nil), source.Messages[:before]...))
	if err := copyAgentAttachments(source, branch); err != nil {
		return model.AgentChat{}, err
	}
	if err := writeAgentChat(branch); err != nil {
		return model.AgentChat{}, err
	}
	return agentChatPage(branch, -1), nil
}

func copyAgentAttachments(source, branch model.AgentChat) error {
	from, err := agentChatPath(source.ID)
	if err != nil {
		return err
	}
	to, err := agentChatPath(branch.ID)
	if err != nil {
		return err
	}
	for _, message := range branch.Messages {
		for _, file := range message.Attachments {
			if file.ID == "" {
				continue
			}
			data, err := os.ReadFile(filepath.Join(from+".attachments", file.ID))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			if err := os.MkdirAll(to+".attachments", 0o700); err != nil {
				return err
			}
			if err := writeFileAtomic(filepath.Join(to+".attachments", file.ID), data); err != nil {
				return err
			}
		}
	}
	return nil
}

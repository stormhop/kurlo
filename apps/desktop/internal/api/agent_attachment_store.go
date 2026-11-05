package api

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

func storeAgentAttachmentFiles(chatID string, files []agentAttachment) (func(), error) {
	if len(files) == 0 {
		return func() {}, nil
	}
	chatPath, err := agentChatPath(chatID)
	if err != nil {
		return nil, err
	}
	dir := chatPath + ".attachments"
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	written := make([]string, 0, len(files))
	rollback := func() {
		for _, path := range written {
			_ = os.Remove(path)
		}
		_ = os.Remove(dir)
	}
	for _, file := range files {
		path := filepath.Join(dir, file.id)
		data, err := encryptRequestStorePayload(file.data)
		if err == nil {
			err = writeFileAtomic(path, data)
		}
		if err != nil {
			rollback()
			return nil, err
		}
		written = append(written, path)
	}
	return rollback, nil
}

func (a *App) AgentAttachmentData(chatID, workspaceID, attachmentID string) (string, error) {
	id, err := uuid.Parse(attachmentID)
	if err != nil || id.String() != attachmentID {
		return "", errors.New("This attachment is no longer available.")
	}
	workspace := agentWorkspaceKey(fileWorkspaceStorePath())
	agentChatsMu.Lock()
	defer agentChatsMu.Unlock()
	chat, err := readWorkspaceAgentChat(chatID, workspace, workspaceID)
	if err != nil {
		return "", err
	}
	chatPath, err := agentChatPath(chat.ID)
	if err != nil {
		return "", err
	}
	for _, message := range chat.Messages {
		for _, file := range message.Attachments {
			if file.ID != attachmentID || file.MediaType == "" {
				continue
			}
			encrypted, err := os.ReadFile(filepath.Join(chatPath+".attachments", attachmentID))
			if err != nil {
				return "", errors.New("Could not open the saved attachment.")
			}
			data, err := decryptRequestStorePayload(encrypted)
			if err != nil {
				return "", errors.New("Could not read the saved attachment.")
			}
			if strings.HasPrefix(file.MediaType, "image/") {
				return "data:" + file.MediaType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
			}
			return string(data), nil
		}
	}
	return "", errors.New("This attachment is no longer available.")
}

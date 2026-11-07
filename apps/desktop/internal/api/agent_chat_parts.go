package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	agentChatPartMaxBytes    = 256 * 1024
	agentChatPartMaxMessages = 200
)

type agentChatPartRef struct {
	ID    string `json:"id"`
	Hash  string `json:"hash"`
	Count int    `json:"count"`
}

type agentChatHead struct {
	model.AgentChat
	Parts []agentChatPartRef `json:"parts,omitempty"`
}

type agentChatPart struct {
	hash     string
	payload  []byte
	messages int
}

func agentChatPartsDir(chatPath string) string {
	return chatPath + ".parts"
}

func agentChatPartPath(chatPath, partID string) (string, error) {
	id, err := uuid.Parse(partID)
	if err != nil || id.String() != partID {
		return "", fmt.Errorf("invalid chat part %q", partID)
	}
	return filepath.Join(agentChatPartsDir(chatPath), partID), nil
}

func splitAgentChatParts(messages []model.AiMessage) ([]agentChatPart, []model.AiMessage, error) {
	var parts []agentChatPart
	start := 0
	size := 0
	for index, message := range messages {
		raw, err := json.Marshal(message)
		if err != nil {
			return nil, nil, err
		}
		size += len(raw) + 1
		count := index - start + 1
		if size < agentChatPartMaxBytes && count < agentChatPartMaxMessages {
			continue
		}
		payload, err := json.Marshal(messages[start : index+1])
		if err != nil {
			return nil, nil, err
		}
		sum := sha256.Sum256(payload)
		parts = append(parts, agentChatPart{hash: hex.EncodeToString(sum[:]), payload: payload, messages: count})
		start = index + 1
		size = 0
	}
	return parts, messages[start:], nil
}

func readAgentChatHead(chatPath string) (agentChatHead, error) {
	var head agentChatHead
	data, err := os.ReadFile(chatPath)
	if err != nil {
		return head, err
	}
	payload, err := decryptRequestStorePayload(data)
	if err != nil {
		return head, err
	}
	if err := json.Unmarshal(payload, &head); err != nil {
		return head, err
	}
	return head, nil
}

func readAgentChatParts(chatPath string, head agentChatHead) (model.AgentChat, error) {
	chat := head.AgentChat
	if len(head.Parts) == 0 {
		return chat, nil
	}
	total := len(chat.Messages)
	for _, ref := range head.Parts {
		total += ref.Count
	}
	messages := make([]model.AiMessage, 0, total)
	for _, ref := range head.Parts {
		path, err := agentChatPartPath(chatPath, ref.ID)
		if err != nil {
			return chat, err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return chat, errors.New("Part of this chat is missing from disk.")
			}
			return chat, err
		}
		payload, err := decryptRequestStorePayload(data)
		if err != nil {
			return chat, err
		}
		var part []model.AiMessage
		if err := json.Unmarshal(payload, &part); err != nil {
			return chat, err
		}
		messages = append(messages, part...)
	}
	chat.Messages = append(messages, chat.Messages...)
	return chat, nil
}

func writeAgentChatParts(chatPath string, chat model.AgentChat) (agentChatHead, error) {
	parts, tail, err := splitAgentChatParts(chat.Messages)
	if err != nil {
		return agentChatHead{}, err
	}
	previous, err := readAgentChatHead(chatPath)
	if err != nil {
		previous = agentChatHead{}
	}
	dir := agentChatPartsDir(chatPath)
	refs := make([]agentChatPartRef, 0, len(parts))
	for index, part := range parts {
		if index < len(previous.Parts) && previous.Parts[index].Hash == part.hash && previous.Parts[index].Count == part.messages {
			if path, err := agentChatPartPath(chatPath, previous.Parts[index].ID); err == nil {
				if _, err := os.Stat(path); err == nil {
					refs = append(refs, previous.Parts[index])
					continue
				}
			}
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return agentChatHead{}, err
		}
		ref := agentChatPartRef{ID: uuid.NewString(), Hash: part.hash, Count: part.messages}
		encrypted, err := encryptRequestStorePayload(part.payload)
		if err != nil {
			return agentChatHead{}, err
		}
		path, _ := agentChatPartPath(chatPath, ref.ID)
		if err := writeFileAtomic(path, encrypted); err != nil {
			return agentChatHead{}, err
		}
		refs = append(refs, ref)
	}
	chat.Messages = append([]model.AiMessage{}, tail...)
	return agentChatHead{AgentChat: chat, Parts: refs}, nil
}

func pruneAgentChatParts(chatPath string, head agentChatHead) {
	dir := agentChatPartsDir(chatPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	keep := make(map[string]bool, len(head.Parts))
	for _, ref := range head.Parts {
		keep[ref.ID] = true
	}
	for _, entry := range entries {
		if !keep[entry.Name()] && !strings.HasPrefix(entry.Name(), ".") {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
	if len(head.Parts) == 0 {
		_ = os.Remove(dir)
	}
}

package api

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type mcpGateFunc func(tool string, arguments json.RawMessage) error

type mcpGateKey struct{}

type mcpDeclinedError struct {
	message string
}

func (e *mcpDeclinedError) Error() string { return e.message }

func withMcpGate(ctx context.Context, gate mcpGateFunc) context.Context {
	return context.WithValue(ctx, mcpGateKey{}, gate)
}

func mcpGateFrom(ctx context.Context) mcpGateFunc {
	gate, _ := ctx.Value(mcpGateKey{}).(mcpGateFunc)
	return gate
}

func (s *mcpServer) rememberClient(params json.RawMessage) {
	var payload struct {
		ClientInfo struct {
			Name string `json:"name"`
		} `json:"clientInfo"`
		Meta map[string]json.RawMessage `json:"_meta"`
	}
	if err := json.Unmarshal(params, &payload); err != nil {
		return
	}
	name := strings.TrimSpace(payload.ClientInfo.Name)
	if name == "" {
		var info struct {
			Name string `json:"name"`
		}
		if raw, ok := payload.Meta[mcpMetaClientInfo]; ok && json.Unmarshal(raw, &info) == nil {
			name = strings.TrimSpace(info.Name)
		}
	}
	if name == "" {
		return
	}
	s.clientMu.Lock()
	s.client = name
	s.clientMu.Unlock()
}

func (s *mcpServer) clientName() string {
	s.clientMu.Lock()
	defer s.clientMu.Unlock()
	if s.client == "" {
		return "MCP client"
	}
	return s.client
}

func mcpResultPlainText(result map[string]any) (string, bool) {
	isError, _ := result["isError"].(bool)
	var parts []string
	if content, ok := result["content"].([]map[string]any); ok {
		for _, block := range content {
			if text, ok := block["text"].(string); ok {
				parts = append(parts, text)
			}
		}
	}
	return strings.Join(parts, "\n"), isError
}

func (s *mcpServer) logCall(tool string, arguments json.RawMessage, record *mcpCallRecord, result map[string]any, callErr error) {
	if !agentActivityEnabled() {
		return
	}
	secrets := agentActivitySecrets()
	entry := model.AgentActivityEntry{
		AgentActivitySummary: model.AgentActivitySummary{
			Client: s.clientName(),
			ChatID: s.chatID,
			Tool:   tool,
			Status: model.AgentActivityOK,
			Files:  []string{},
		},
		Arguments: agentActivityText(string(arguments), secrets),
		Changes:   record.changes,
	}
	var declined *mcpDeclinedError
	switch {
	case errors.As(callErr, &declined):
		entry.Status = model.AgentActivityDeclined
		entry.Error = declined.message
	case callErr != nil:
		entry.Status = model.AgentActivityError
		entry.Error = agentActivityText(callErr.Error(), secrets)
	default:
		text, isError := mcpResultPlainText(result)
		entry.Result = agentActivityText(text, secrets)
		if isError {
			entry.Status = model.AgentActivityError
		}
	}
	for _, change := range record.changes {
		entry.Files = append(entry.Files, change.Path)
	}
	if len(record.changes) > 0 {
		entry.Workspace = s.opts.workspace
	}
	_ = writeAgentActivity(entry)
}

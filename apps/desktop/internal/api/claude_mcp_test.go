package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestClaudeMCPUsesKurloApproval(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge := newAgentToolBridge(mcpServerOptions{workspace: root, env: "Local"}, "chat-1", nil)
	var approval model.AgentApproval
	bridge.approve = func(_ context.Context, request model.AgentApproval) string {
		approval = request
		return model.AgentApprovalReject
	}
	handler := claudeMCPHandler(bridge)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"set_variable","arguments":{"environment":"Local","key":"token","value":"x"}}}`,
	))
	handler.ServeHTTP(response, request)
	if approval.ChatID != "chat-1" || approval.Tool != "set_variable" || len(approval.Changes) == 0 {
		t.Fatalf("unexpected approval: %+v", approval)
	}
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"isError":true`) {
		t.Fatalf("unexpected reply: %d %s", response.Code, response.Body)
	}
	if strings.Contains(readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml"), "token") {
		t.Fatal("the rejected change was written")
	}
}

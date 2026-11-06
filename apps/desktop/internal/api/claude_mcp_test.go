package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
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

func TestClaudeMCPServerRequiresTokenAndWritesPrivateConfig(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge := newAgentToolBridge(mcpServerOptions{workspace: root, env: "Local"}, "chat-1", nil)
	url, closeServer, err := startClaudeMCP(context.Background(), bridge)
	if err != nil {
		t.Fatal(err)
	}
	defer closeServer()
	base, _, _ := strings.Cut(url, "?")
	call := func(target string) int {
		response, err := http.Post(target, "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	if code := call(base); code != http.StatusNotFound {
		t.Fatalf("unauthenticated call: %d", code)
	}
	if code := call(base + "?token=wrong"); code != http.StatusNotFound {
		t.Fatalf("wrong token: %d", code)
	}
	if code := call(url); code != http.StatusOK {
		t.Fatalf("call with the token: %d", code)
	}
	configPath, err := writeClaudeMCPConfig(t.TempDir(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(configPath)
	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("config file mode: %v", info.Mode().Perm())
	}
	body, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), url) {
		t.Fatalf("config without the url: %s", body)
	}
}

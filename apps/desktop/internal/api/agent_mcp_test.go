package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestMCPStdioHelperProcess(t *testing.T) {
	if os.Getenv("KURLO_MCP_STDIO_HELPER") != "1" {
		t.Skip("helper process")
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &message) != nil || len(message.ID) == 0 {
			continue
		}
		switch message.Method {
		case "initialize":
			fmt.Printf(`{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"helper","version":"1"}}}`+"\n", message.ID)
		case "tools/list":
			fmt.Printf(`{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"listing"}}` + "\n")
			fmt.Printf(`{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"whoami","description":"Says who runs it","inputSchema":{"type":"object"}}]}}`+"\n", message.ID)
		case "tools/call":
			fmt.Printf(`{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"token=%s"}]}}`+"\n", message.ID, os.Getenv("HELPER_TOKEN"))
		default:
			fmt.Printf(`{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"nope"}}`+"\n", message.ID)
		}
	}
	os.Exit(0)
}

func helperStdioServer(name string) model.AgentMcpServer {
	return model.AgentMcpServer{Name: name, Kind: agentMcpKindStdio, Command: os.Args[0], Args: []string{"-test.run=TestMCPStdioHelperProcess"}, Env: []model.AgentMcpPair{{Key: "KURLO_MCP_STDIO_HELPER", Value: "1"}, {Key: "HELPER_TOKEN", Value: "s3cret"}}, Enabled: true}
}

func TestAgentMcpStdioServerListsAndCallsTools(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	app := NewApp()
	t.Cleanup(func() { app.agentRuntime().closeMcpClients() })
	tested := app.TestAgentMcpServer(helperStdioServer("Helper"))
	if !tested.OK || len(tested.Tools) != 1 || tested.Tools[0].Name != "whoami" {
		t.Fatalf("test = %+v", tested)
	}
	state := app.SaveAgentMcpServer(helperStdioServer("Helper"))
	if state.Error != "" || len(state.Servers) != 1 || !state.Servers[0].Env[1].Set || state.Servers[0].Env[1].Value != "" {
		t.Fatalf("state = %+v", state)
	}
	raw, _ := os.ReadFile(appPreferencesPath())
	if strings.Contains(string(raw), "s3cret") {
		t.Fatal("env values must be stored encrypted")
	}
	edited := state.Servers[0]
	edited.Env = []model.AgentMcpPair{{Key: "KURLO_MCP_STDIO_HELPER", Set: true}, {Key: "HELPER_TOKEN", Set: true}}
	if state = app.SaveAgentMcpServer(edited); state.Error != "" {
		t.Fatal(state.Error)
	}

	tools, defs, warnings := app.agentRuntime().externalTools(context.Background())
	if len(warnings) != 0 || len(defs) != 1 || defs[0].Original != "helper__whoami" || !strings.Contains(defs[0].Description, "Helper") {
		t.Fatalf("defs = %+v warnings = %v", defs, warnings)
	}
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalAllowChat)
	bridge.setExternal(tools, defs)
	call := func() (string, bool) {
		return bridge.call(context.Background(), aiTool{Name: "helper__whoami", Original: "helper__whoami", Server: "Helper", ServerIndex: -1}, "{}", "call-1")
	}
	if text, isError := call(); isError || text != "token=s3cret" {
		t.Fatalf("call = %v %s", isError, text)
	}
	approval := approvals.last()
	if approval.Kind != model.AgentToolExternal || approval.Tool != "Helper.whoami" || !approval.External {
		t.Fatalf("approval = %+v", approval)
	}
	if text, isError := call(); isError || approvals.count() != 1 {
		t.Fatalf("Allow for this chat covers the external tool: %v %s approvals=%d", isError, text, approvals.count())
	}
	if state := app.DeleteAgentMcpServer(edited.ID); len(state.Servers) != 0 {
		t.Fatalf("delete = %+v", state)
	}
}

func TestAgentMcpHTTPServerJoinsATurn(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)
	server, fake := newSessionMCPServer(t, "2025-06-18")
	root := fileWorkspaceStorePath()
	copyWorkspaceTo(t, agentTestWorkspace(t, "http://127.0.0.1:1"), root)
	shop := fixtureWorkspaceID(t, root)
	llm := newAiTestServer(t,
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"issues__echo","arguments":"{\"text\":\"hi\"}"}}]},"finish_reason":"tool_calls"}]}`),
			openAIChunkEvent(`[DONE]`),
		}},
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0.01}}`),
			openAIChunkEvent(`[DONE]`),
		}},
	)
	app := NewApp()
	t.Cleanup(func() { app.agentRuntime().closeMcpClients() })
	if state := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: llm.URL, Key: "sk-test", Model: "test-model"}); state.Error != "" {
		t.Fatal(state.Error)
	}
	if state := app.SaveAgentMcpServer(model.AgentMcpServer{Name: "Issues", Kind: agentMcpKindHTTP, URL: server.URL, Headers: []model.AgentMcpPair{{Key: "Authorization", Value: "Bearer gh-token"}}, Enabled: true}); state.Error != "" {
		t.Fatal(state.Error)
	}
	var mu sync.Mutex
	var approvals []model.AgentApproval
	app.agentEmit = func(name string, payload any) {
		if name == "agent:approval" {
			approval := payload.(model.AgentApproval)
			mu.Lock()
			approvals = append(approvals, approval)
			mu.Unlock()
			go app.AnswerAgentApproval(approval.ID, model.AgentApprovalAllow)
		}
	}
	turn := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: shop, Text: "Echo hi"})
	if turn.Error != "" || turn.Text != "Done." {
		t.Fatalf("turn = %q %q %v", turn.Error, turn.Text, turn.Warnings)
	}
	if len(approvals) != 1 || approvals[0].Tool != "Issues.echo" {
		t.Fatalf("approvals = %+v", approvals)
	}
	var result string
	for _, message := range turn.Chat.Messages {
		for _, block := range message.Blocks {
			if block.Type == model.AiBlockToolResult {
				result = block.Text
			}
		}
	}
	if result != "echo: hi" {
		t.Fatalf("result = %q", result)
	}
	if turn.Chat.Usage.Cost != 0.01 {
		t.Fatalf("cost = %v", turn.Chat.Usage.Cost)
	}
	system := llm.body(0)["messages"].([]any)[0].(map[string]any)["content"].(string)
	if !strings.Contains(system, "External MCP servers: Issues") {
		t.Fatalf("system prompt:\n%s", system)
	}
	_, calls := fake.snapshot()
	if len(calls) == 0 {
		t.Fatal("the MCP server was not called")
	}
}

func TestAgentEditAndBranchFromAnEarlierMessage(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := fileWorkspaceStorePath()
	copyWorkspaceTo(t, agentTestWorkspace(t, "http://127.0.0.1:1"), root)
	shop := fixtureWorkspaceID(t, root)
	reply := func(text string) sseScript {
		return sseScript{events: []string{openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"` + text + `"},"finish_reason":"stop"}]}`), openAIChunkEvent(`[DONE]`)}}
	}
	llm := newAiTestServer(t, reply("A1"), reply("A2"), reply("A2 edited"), reply("A2 branch"))
	app := NewApp()
	if state := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: llm.URL, Key: "sk-test", Model: "test-model"}); state.Error != "" {
		t.Fatal(state.Error)
	}
	first := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: shop, Text: "one"})
	chatID := first.Chat.ID
	second := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: shop, ChatID: chatID, Text: "two"})
	if second.Error != "" || len(second.Chat.Messages) != 4 {
		t.Fatalf("second = %q %d", second.Error, len(second.Chat.Messages))
	}
	edit := 2
	edited := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: shop, ChatID: chatID, Text: "two, edited", EditFrom: &edit})
	if edited.Error != "" || len(edited.Chat.Messages) != 4 || edited.Chat.Messages[2].Blocks[0].Text != "two, edited" || edited.Text != "A2 edited" {
		t.Fatalf("edited = %q %+v", edited.Error, edited.Chat.Messages)
	}
	if replay := llm.body(2)["messages"].([]any); len(replay) != 4 {
		t.Fatalf("the edit must replace the old message, got %d messages", len(replay))
	}
	bad := 1
	if turn := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: shop, ChatID: chatID, Text: "x", EditFrom: &bad}); turn.Error == "" {
		t.Fatal("only user messages can be edited")
	}

	branch, err := app.BranchAgentChat(chatID, shop, 2)
	if err != nil {
		t.Fatal(err)
	}
	if branch.ID == chatID || len(branch.Messages) != 2 || !strings.HasSuffix(branch.Title, "(branch)") || branch.Usage.Input != 0 {
		t.Fatalf("branch = %+v", branch)
	}
	reply2 := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: shop, ChatID: branch.ID, Text: "two, other way"})
	if reply2.Error != "" || reply2.Text != "A2 branch" || len(reply2.Chat.Messages) != 4 {
		t.Fatalf("branch turn = %q %q %d", reply2.Error, reply2.Text, len(reply2.Chat.Messages))
	}
	original, _ := app.AgentChat(chatID)
	if len(original.Messages) != 4 || original.Messages[2].Blocks[0].Text != "two, edited" {
		t.Fatalf("the original chat must stay: %+v", original.Messages)
	}
	if _, err := app.BranchAgentChat(chatID, "other", 2); err == nil {
		t.Fatal("a chat of another workspace cannot be branched")
	}
}

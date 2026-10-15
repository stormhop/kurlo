package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type sessionMCPServer struct {
	mu          sync.Mutex
	version     string
	sessions    map[string]bool
	next        int
	initialized int
	calls       []sessionMCPCall
}

type sessionMCPCall struct {
	method   string
	session  string
	protocol string
	params   map[string]any
}

func newSessionMCPServer(t *testing.T, version string) (*httptest.Server, *sessionMCPServer) {
	t.Helper()
	fake := &sessionMCPServer{version: version, sessions: map[string]bool{}}
	server := httptest.NewServer(http.HandlerFunc(fake.serve))
	t.Cleanup(server.Close)
	return server, fake
}

func (s *sessionMCPServer) expire() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions = map[string]bool{}
}

func (s *sessionMCPServer) snapshot() (int, []sessionMCPCall) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.initialized, append([]sessionMCPCall(nil), s.calls...)
}

func (s *sessionMCPServer) serve(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var message struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params map[string]any  `json:"params"`
	}
	_ = json.Unmarshal(raw, &message)
	session := r.Header.Get("Mcp-Session-Id")

	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, sessionMCPCall{method: message.Method, session: session, protocol: r.Header.Get("MCP-Protocol-Version"), params: message.Params})

	if message.Method == "initialize" {
		s.initialized++
		s.next++
		id := fmt.Sprintf("session-%d", s.next)
		s.sessions[id] = true
		w.Header().Set("Mcp-Session-Id", id)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"protocolVersion\":%q,\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"legacy-demo\",\"version\":\"1.4.0\"},\"instructions\":\"Use echo.\"}}\n\n", message.ID, s.version)
		return
	}
	if session == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"},"id":null}`)
		return
	}
	if !s.sessions[session] {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}`)
		return
	}
	if message.Method == "notifications/initialized" {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch message.Method {
	case "tools/list":
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}}`, message.ID)
	case "tools/call":
		arguments, _ := message.Params["arguments"].(map[string]any)
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"echo: %v"}]}}`, message.ID, arguments["text"])
	default:
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found"}}`, message.ID)
	}
}

func TestMcpOpensASessionWithAServerThatPredatesStatelessMCP(t *testing.T) {
	server, fake := newSessionMCPServer(t, "2025-06-18")
	app := NewApp()

	discovered := app.SendMcpRequest(model.HttpRequest{URL: server.URL, McpMethod: mcpMethodDiscover})
	if discovered.Error != "" || discovered.RPCErrorMessage != "" {
		t.Fatalf("discover = %+v", discovered)
	}
	if discovered.ServerName != "legacy-demo" || discovered.ServerVersion != "1.4.0" || discovered.Instructions != "Use echo." {
		t.Fatalf("the server's identity must come from initialize: %+v", discovered)
	}
	if discovered.ProtocolVersion != "2025-06-18" || strings.Join(discovered.Capabilities, ",") != "tools" {
		t.Fatalf("protocol = %q, capabilities = %v", discovered.ProtocolVersion, discovered.Capabilities)
	}
	if len(discovered.Warnings) != 1 || !strings.Contains(discovered.Warnings[0], "2025-06-18") {
		t.Fatalf("warnings = %v", discovered.Warnings)
	}

	listed := app.SendMcpRequest(model.HttpRequest{URL: server.URL, McpMethod: mcpMethodToolsList})
	if len(listed.Tools) != 1 || listed.Tools[0].Name != "echo" || listed.ProtocolVersion != "2025-06-18" {
		t.Fatalf("tools/list = %+v", listed)
	}
	called := app.SendMcpRequest(model.HttpRequest{URL: server.URL, McpMethod: mcpMethodToolsCall, McpName: "echo", McpArguments: `{"text":"hi"}`})
	if len(called.Content) != 1 || called.Content[0].Text != "echo: hi" {
		t.Fatalf("tools/call = %+v", called)
	}

	initialized, calls := fake.snapshot()
	if initialized != 1 {
		t.Fatalf("one session should serve every call, initialize ran %d times", initialized)
	}
	var methods []string
	for _, call := range calls {
		methods = append(methods, call.method)
	}
	if got := strings.Join(methods, ","); got != "server/discover,initialize,notifications/initialized,tools/list,tools/call" {
		t.Fatalf("calls = %s", got)
	}
	for _, call := range calls[2:] {
		if call.session != "session-1" || call.protocol != "2025-06-18" {
			t.Fatalf("%s carried session %q and protocol %q", call.method, call.session, call.protocol)
		}
		if _, ok := call.params["_meta"]; ok {
			t.Fatalf("%s carried the stateless _meta", call.method)
		}
	}
	if calls[1].params["protocolVersion"] != "2025-11-25" {
		t.Fatalf("initialize offered %v", calls[1].params["protocolVersion"])
	}
}

func TestMcpReopensASessionTheServerForgot(t *testing.T) {
	server, fake := newSessionMCPServer(t, "2025-11-25")
	app := NewApp()
	app.SendMcpRequest(model.HttpRequest{URL: server.URL, McpMethod: mcpMethodDiscover})

	fake.expire()
	called := app.SendMcpRequest(model.HttpRequest{URL: server.URL, McpMethod: mcpMethodToolsCall, McpName: "echo", McpArguments: `{"text":"again"}`})
	if len(called.Content) != 1 || called.Content[0].Text != "echo: again" {
		t.Fatalf("tools/call after the session expired = %+v", called)
	}
	if initialized, _ := fake.snapshot(); initialized != 2 {
		t.Fatalf("initialize ran %d times", initialized)
	}
}

func TestMcpFindsASessionServerOnTheFirstCallWithoutDiscover(t *testing.T) {
	server, _ := newSessionMCPServer(t, "2025-03-26")
	app := NewApp()
	listed := app.SendMcpRequest(model.HttpRequest{URL: server.URL, McpMethod: mcpMethodToolsList})
	if len(listed.Tools) != 1 || listed.ProtocolVersion != "2025-03-26" {
		t.Fatalf("tools/list = %+v", listed)
	}
}

func TestMcpSpeaksTheVersionTheRequestAsksFor(t *testing.T) {
	server, fake := newSessionMCPServer(t, "2025-03-26")
	app := NewApp()
	listed := app.SendMcpRequest(model.HttpRequest{URL: server.URL, McpMethod: mcpMethodToolsList, McpProtocolVersion: "2025-03-26"})
	if len(listed.Tools) != 1 {
		t.Fatalf("tools/list = %+v", listed)
	}
	_, calls := fake.snapshot()
	if calls[0].method != "initialize" || calls[0].params["protocolVersion"] != "2025-03-26" {
		t.Fatalf("the first call must be initialize offering 2025-03-26: %+v", calls[0])
	}
	if last := calls[len(calls)-1]; last.protocol != "" {
		t.Fatalf("MCP 2025-03-26 has no MCP-Protocol-Version header, sent %q", last.protocol)
	}

	refused := app.SendMcpRequest(model.HttpRequest{URL: server.URL, McpMethod: mcpMethodToolsList, McpProtocolVersion: "2024-11-05"})
	if !strings.Contains(refused.Error, "does not speak MCP 2024-11-05") {
		t.Fatalf("an unknown version = %+v", refused)
	}
}

func TestMcpKeepsAStatelessServerStateless(t *testing.T) {
	var methods []string
	server, captured := mcpTestServer(t, func(w http.ResponseWriter, captured mcpCapturedRequest) {
		method, _ := captured.body["method"].(string)
		methods = append(methods, method)
		if method == mcpMethodDiscover {
			mcpJSONResult(w, `{"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{}}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Unknown tool"}}`)
	})
	app := NewApp()
	app.SendMcpRequest(model.HttpRequest{URL: server.URL, McpMethod: mcpMethodDiscover})
	called := app.SendMcpRequest(model.HttpRequest{URL: server.URL, McpMethod: mcpMethodToolsCall, McpName: "nope"})
	if called.RPCErrorCode != -32602 || called.ProtocolVersion != model.McpDefaultProtocolVersion {
		t.Fatalf("tools/call = %+v", called)
	}
	if got := strings.Join(methods, ","); got != "server/discover,tools/call" {
		t.Fatalf("a stateless server must never be sent initialize, calls = %s", got)
	}
	if captured.headers.Get("Mcp-Session-Id") != "" {
		t.Fatal("a stateless call carried a session")
	}
}

func TestMcpShowsTheOriginalFailureWhenTheServerSpeaksNeitherVersion(t *testing.T) {
	server, _ := mcpTestServer(t, func(w http.ResponseWriter, _ mcpCapturedRequest) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, "forbidden")
	})
	discovered := NewApp().SendMcpRequest(model.HttpRequest{URL: server.URL, McpMethod: mcpMethodDiscover})
	if discovered.HTTP.StatusCode != http.StatusForbidden || discovered.ProtocolVersion != model.McpDefaultProtocolVersion {
		t.Fatalf("discover = %+v", discovered)
	}
}

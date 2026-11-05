package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"google.golang.org/grpc"
	grpcTest "google.golang.org/grpc/interop/grpc_testing"
	"google.golang.org/grpc/reflection"
)

func saveExecutionFixtures(t *testing.T, root string, requests ...map[string]any) {
	t.Helper()
	store, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, req := range requests {
		req["collectionId"] = "col-smoke"
		req["collection"] = "Smoke"
		store.requests = append(store.requests, req)
	}
	if err := store.save(); err != nil {
		t.Fatal(err)
	}
}

func callExecutionTool(t *testing.T, s *mcpServer, ctx context.Context, name string, args any) map[string]any {
	t.Helper()
	params, err := json.Marshal(map[string]any{"name": name, "arguments": args})
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.callTool(ctx, params)
	if err != nil {
		t.Fatal(err)
	}
	if out["isError"] == true {
		t.Fatalf("%s: %v", name, out)
	}
	return out["structuredContent"].(map[string]any)
}

func TestAgentExecutionRunnerAndDiagnostics(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ok" {
			http.Redirect(w, r, "/target?"+r.URL.RawQuery, http.StatusFound)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "private-cookie"})
		if r.URL.Query().Get("v") == "bad" {
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	root := writeYAMLWorkspace(t, server.URL)
	if err := os.WriteFile(filepath.Join(root, "rows.csv"), []byte("apiVersion\ngood\nbad\nskipped\n"), 0600); err != nil {
		t.Fatal(err)
	}
	s := newMCPServer(mcpServerOptions{workspace: root, workspaceID: "ws-demo", env: "Local", insecure: true}, io.Discard)
	ctx := t.Context()
	start := time.Now()
	report := callExecutionTool(t, s, ctx, "run_collection", map[string]any{"collection": "Smoke", "dataFile": "rows.csv", "delayMs": 10, "failFast": true})
	summary := report["summary"].(map[string]any)
	rows := report["results"].([]any)
	if len(rows) != 3 || summary["iterations"] != float64(3) || summary["stoppedEarly"] != true || !strings.Contains(fmt.Sprint(rows[0]), "v=good") || !strings.Contains(fmt.Sprint(rows[2]), "v=bad") || time.Since(start) < 20*time.Millisecond {
		t.Fatalf("runner report = %v", report)
	}
	if err := os.WriteFile(filepath.Join(root, "rows.json"), []byte(`[{"apiVersion":"json"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	report = callExecutionTool(t, s, ctx, "run_collection", map[string]any{"collection": "Smoke", "dataFile": "rows.json"})
	if results := report["results"].([]any); len(results) != 2 || !strings.Contains(fmt.Sprint(results[0]), "v=json") {
		t.Fatalf("JSON report = %v", report)
	}
	run := callExecutionTool(t, s, ctx, "run_request", map[string]any{"request": "Ok"})
	diag := run["diagnostics"].(map[string]any)
	if len(diag["redirectChain"].([]any)) != 2 || diag["connection"].(map[string]any)["tlsVersion"] == "" {
		t.Fatalf("diagnostics = %v", diag)
	}
	cookies := callExecutionTool(t, s, ctx, "list_cookies", map[string]any{"domain": "127.0.0.1"})
	if values := cookies["cookies"].([]any); len(values) != 1 || strings.Contains(fmt.Sprint(values), "private-cookie") {
		t.Fatalf("cookies = %v", cookies)
	}
	bridge := newAgentToolBridge(s.opts, "execution", []string{"clear_cookie_jar"})
	bridge.server.jars = s.jars
	bridge.approve = func(_ context.Context, a model.AgentApproval) string {
		if a.Tool != "clear_cookie_jar" {
			t.Fatalf("unexpected approval %+v", a)
		}
		return model.AgentApprovalReject
	}
	if _, failed := agentBridgeCall(t, bridge, "clear_cookie_jar", map[string]any{}); !failed || len(s.jars.jar("ws-demo").ListCookies()) != 1 {
		t.Fatal("cleared cookies without explicit approval")
	}
	bridge.approve = func(context.Context, model.AgentApproval) string { return model.AgentApprovalAllow }
	if out, failed := agentBridgeCall(t, bridge, "clear_cookie_jar", map[string]any{}); failed || len(s.jars.jar("ws-demo").ListCookies()) != 0 {
		t.Fatalf("clear failed: %s", out)
	}
}

func TestAgentExecutionLiveSessions(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	wsClosed := make(chan struct{})
	sseClosed := make(chan struct{})
	sio := newSIOServer(t)
	t.Cleanup(func() { close(sio.push) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ws":
			upgrader := websocket.Upgrader{}
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer close(wsClosed)
			defer conn.Close()
			for {
				kind, data, err := conn.ReadMessage()
				if err != nil {
					return
				}
				if conn.WriteMessage(kind, data) != nil {
					return
				}
			}
		case "/sse":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: update\ndata: ready\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			close(sseClosed)
		default:
			sio.handler(w, r)
		}
	}))
	defer server.Close()
	root := writeYAMLWorkspace(t, server.URL)
	saveExecutionFixtures(t, root,
		map[string]any{"id": "ws", "name": "WebSocket", "requestType": "ws", "url": "{{baseUrl}}/ws"},
		map[string]any{"id": "sse", "name": "Events", "requestType": "http", "method": "SSE", "url": "{{baseUrl}}/sse"},
		map[string]any{"id": "sio", "name": "Socket.IO", "requestType": "socketio", "url": "{{baseUrl}}", "sioEvents": []any{map[string]any{"id": "incoming", "key": "welcome", "enabled": true}}},
	)
	ctx, stop := context.WithCancel(t.Context())
	defer stop()
	s := newMCPServer(mcpServerOptions{workspace: root, env: "Local"}, io.Discard)
	s.live = newAgentLiveSessions(ctx, s.jars)
	defer s.live.close()
	open := func(name string) string {
		id := callExecutionTool(t, s, ctx, "open_session", map[string]any{"request": name})["sessionId"].(string)
		callExecutionTool(t, s, ctx, "read_messages", map[string]any{"sessionId": id, "timeoutMs": 0, "limit": 1})
		return id
	}
	waitFor := func(id, message string) {
		t.Helper()
		out := callExecutionTool(t, s, ctx, "read_messages", map[string]any{"sessionId": id, "timeoutMs": 1000})
		if !strings.Contains(fmt.Sprint(out["messages"]), message) {
			t.Fatalf("expected %q, got %v", message, out)
		}
	}
	wsID := open("ws")
	callExecutionTool(t, s, ctx, "send_message", map[string]any{"sessionId": wsID, "data": "echo from agent"})
	waitFor(wsID, "echo from agent")
	sseID := open("sse")
	waitFor(sseID, "ready")
	sioID := open("sio")
	callExecutionTool(t, s, ctx, "send_message", map[string]any{"sessionId": sioID, "eventName": "hello", "args": []any{map[string]string{"from": "agent"}}})
	select {
	case got := <-sio.recv:
		if got[0] != "hello" || !strings.Contains(got[1], "agent") {
			t.Fatalf("Socket.IO packet = %v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("Socket.IO message did not arrive")
	}
	sio.push <- `42["welcome","hi from server"]`
	waitFor(sioID, "hi from server")
	callExecutionTool(t, s, ctx, "close_session", map[string]any{"sessionId": sioID})
	stop()
	for _, closed := range []<-chan struct{}{wsClosed, sseClosed} {
		select {
		case <-closed:
		case <-time.After(time.Second):
			t.Fatal("connection did not close on Stop")
		}
	}
}

type executionGrpcServer struct {
	grpcTest.UnimplementedTestServiceServer
}

func (executionGrpcServer) EmptyCall(context.Context, *grpcTest.Empty) (*grpcTest.Empty, error) {
	return &grpcTest.Empty{}, nil
}

func (executionGrpcServer) FullDuplexCall(stream grpc.BidiStreamingServer[grpcTest.StreamingOutputCallRequest, grpcTest.StreamingOutputCallResponse]) error {
	for {
		msg, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if err := stream.Send(&grpcTest.StreamingOutputCallResponse{Payload: msg.Payload}); err != nil {
			return err
		}
	}
}

func TestAgentExecutionUnaryAndStreamingGRPC(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	grpcTest.RegisterTestServiceServer(server, executionGrpcServer{})
	reflection.Register(server)
	go server.Serve(listener)
	defer server.Stop()
	root := writeYAMLWorkspace(t, "http://127.0.0.1:1")
	saveExecutionFixtures(t, root,
		map[string]any{"id": "unary", "name": "Unary", "requestType": "grpc", "url": listener.Addr().String(), "grpcMethod": "grpc.testing.TestService/EmptyCall", "bodyContent": "{}"},
		map[string]any{"id": "bidi", "name": "Bidi", "requestType": "grpc", "url": listener.Addr().String(), "grpcMethod": "grpc.testing.TestService/FullDuplexCall", "bodyContent": "{}"},
	)
	s := newMCPServer(mcpServerOptions{workspace: root, env: "Local"}, io.Discard)
	ctx := t.Context()
	s.live = newAgentLiveSessions(ctx, s.jars)
	defer s.live.close()
	unary := callExecutionTool(t, s, ctx, "run_request", map[string]any{"request": "unary"})
	if unary["response"].(map[string]any)["grpcCode"] != "OK" {
		t.Fatalf("unary = %v", unary)
	}
	id := callExecutionTool(t, s, ctx, "open_session", map[string]any{"request": "bidi"})["sessionId"].(string)
	callExecutionTool(t, s, ctx, "read_messages", map[string]any{"sessionId": id, "timeoutMs": 0, "limit": 1})
	callExecutionTool(t, s, ctx, "send_message", map[string]any{"sessionId": id, "data": `{"payload":{"body":"aGVsbG8="}}`})
	out := callExecutionTool(t, s, ctx, "read_messages", map[string]any{"sessionId": id, "timeoutMs": 1000})
	if !strings.Contains(fmt.Sprint(out), "aGVsbG8=") {
		t.Fatalf("stream message = %v", out)
	}
	callExecutionTool(t, s, ctx, "send_message", map[string]any{"sessionId": id, "endStream": true})
	out = callExecutionTool(t, s, ctx, "read_messages", map[string]any{"sessionId": id, "timeoutMs": 1000})
	if !strings.Contains(fmt.Sprint(out), "grpcCode:OK") {
		t.Fatalf("stream status = %v", out)
	}
}

func TestAgentExecutionSavedMCPAndAI(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	remote, _ := newSessionMCPServer(t, "2025-11-25")
	provider := newAiTestServer(t, sseScript{json: `{"id":"test","model":"demo","choices":[{"message":{"role":"assistant","content":"saved prompt ran"},"finish_reason":"stop"}]}`})
	root := writeYAMLWorkspace(t, remote.URL)
	saveExecutionFixtures(t, root,
		map[string]any{"id": "tool", "name": "Tools", "requestType": "mcp", "url": "{{baseUrl}}", "mcpMethod": "tools/list"},
		map[string]any{"id": "prompt", "name": "Prompt", "requestType": "ai", "url": provider.URL, "aiProvider": "openai", "aiModel": "demo", "aiPrompt": "Look at {{apiVersion}}", "aiStream": false},
	)
	s := newMCPServer(mcpServerOptions{workspace: root, env: "Local"}, io.Discard)
	ctx := t.Context()
	list := callExecutionTool(t, s, ctx, "run_request", map[string]any{"request": "tool"})
	if !strings.Contains(fmt.Sprint(list["response"].(map[string]any)["tools"]), "echo") {
		t.Fatalf("tools = %v", list)
	}
	call := callExecutionTool(t, s, ctx, "run_request", map[string]any{
		"request": "tool", "mcpMethod": "tools/call", "mcpName": "echo", "mcpArguments": map[string]string{"text": "{{apiVersion}}"},
	})
	if !strings.Contains(fmt.Sprint(call["response"].(map[string]any)["result"]), "echo: v1") {
		t.Fatalf("call = %v", call)
	}
	ai := callExecutionTool(t, s, ctx, "run_request", map[string]any{"request": "prompt"})
	if ai["response"].(map[string]any)["text"] != "saved prompt ran" || !strings.Contains(fmt.Sprint(provider.body(0)["messages"]), "Look at v1") {
		t.Fatalf("saved AI = %v, request = %v", ai, provider.body(0))
	}
	bridge := newAgentToolBridge(s.opts, "execution", []string{"run_request"})
	bridge.approve = func(_ context.Context, approval model.AgentApproval) string {
		if approval.Kind != model.AgentToolExternal {
			t.Fatalf("expected external approval, got %v", approval)
		}
		return model.AgentApprovalReject
	}
	if out, failed := agentBridgeCall(t, bridge, "run_request", map[string]any{"request": "tool", "mcpMethod": "tools/call", "mcpName": "echo"}); !failed || !strings.Contains(out, "declined") {
		t.Fatalf("a previous HTTP approval allowed an external MCP call: %s", out)
	}
}

func TestAgentExecutionMockFromExamples(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := writeYAMLWorkspace(t, "http://127.0.0.1:1")
	saveExecutionFixtures(t, root, map[string]any{
		"id": "mock", "name": "Mock", "requestType": "http", "method": "GET", "url": "https://example.test/ignored",
		"examples": []any{map[string]any{
			"id": "example", "name": "Found", "snapshot": map[string]string{"method": "POST"},
			"match":    map[string]any{"pathTemplate": "/things/:id", "query": map[string]string{"mode": "full"}},
			"response": map[string]any{"statusCode": 201, "body": "saved example", "bodyMediaType": "text/plain"},
		}},
	})
	s := newMCPServer(mcpServerOptions{workspace: root}, io.Discard)
	defer s.executionApp.StopMockServer()
	port, err := freeLocalPort()
	if err != nil {
		t.Fatal(err)
	}
	status := callExecutionTool(t, s, t.Context(), "start_mock_server", map[string]any{"collection": "Smoke", "port": port})
	req, err := http.NewRequest(http.MethodPost, status["url"].(string)+"/things/123?mode=full", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || string(body) != "saved example" || resp.StatusCode != 201 {
		t.Fatalf("mock response = %d %s, %v", resp.StatusCode, body, err)
	}
	log := callExecutionTool(t, s, t.Context(), "mock_server_log", nil)
	if !strings.Contains(fmt.Sprint(log["entries"]), "exampleId:example") {
		t.Fatalf("mock log = %v", log)
	}
	stopped := callExecutionTool(t, s, t.Context(), "stop_mock_server", nil)
	if stopped["running"] != false {
		t.Fatalf("mock still running: %v", stopped)
	}
}

func TestAgentExecutionSaveLoadTestReviewsYAML(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge := newAgentToolBridge(mcpServerOptions{workspace: root, env: "Local"}, "execution", nil)
	test := model.LoadTest{
		Name: "Smoke load", Scenarios: []model.LoadScenario{{Name: "Flow", Executor: model.LoadExecutor{Type: "constant-vus", VUs: 1, DurationMs: 1000}, Steps: []model.LoadStep{{RequestID: "req-ok"}}}},
	}
	bridge.approve = func(_ context.Context, approval model.AgentApproval) string {
		if len(approval.Changes) != 1 || !strings.Contains(approval.Changes[0].Path, "loadtests/") {
			t.Fatalf("expected load test YAML review: %v", approval)
		}
		return model.AgentApprovalReject
	}
	args := map[string]any{"collection": "Smoke", "test": test}
	if _, failed := agentBridgeCall(t, bridge, "save_load_test", args); !failed {
		t.Fatal("unapproved load test was saved")
	}
	if result := callExecutionTool(t, bridge.server, t.Context(), "list_load_tests", nil); len(result["tests"].([]any)) != 0 {
		t.Fatalf("unapproved load test was persisted: %v", result)
	}
	bridge.approve = func(context.Context, model.AgentApproval) string { return model.AgentApprovalAllow }
	if out, failed := agentBridgeCall(t, bridge, "save_load_test", args); failed {
		t.Fatalf("save_load_test = %s", out)
	}
	tests := callExecutionTool(t, bridge.server, t.Context(), "list_load_tests", nil)["tests"].([]any)
	if len(tests) != 1 {
		t.Fatalf("saved load tests = %v", tests)
	}
	test.ID = tests[0].(map[string]any)["id"].(string)
	test.Name = "Revised load"
	out := callExecutionTool(t, bridge.server, t.Context(), "save_load_test", map[string]any{"collection": "Smoke", "test": test})
	if out["created"] != false {
		t.Fatalf("edit created a second test: %v", out)
	}
	result := callExecutionTool(t, bridge.server, t.Context(), "get_load_test", map[string]any{"test": test.ID})
	if result["test"].(map[string]any)["name"] != "Revised load" {
		t.Fatalf("edited load test = %v", result)
	}
}

func TestAgentExecutionCompareRealK6Runs(t *testing.T) {
	k6 := k6ForTest(t)
	t.Setenv("PATH", filepath.Dir(k6)+string(os.PathListSeparator)+os.Getenv("PATH"))
	useTempConfigDir(t, t.TempDir())
	server, _ := countingServer(t)
	s := newMCPServer(mcpServerOptions{workspace: writeYAMLWorkspace(t, server.URL), env: "Local"}, io.Discard)
	defer s.executionApp.stopLoadRunForShutdown()
	ctx := t.Context()
	test := model.LoadTest{
		Name: "Smoke load", Scenarios: []model.LoadScenario{{Name: "Flow", Executor: model.LoadExecutor{Type: "constant-vus", VUs: 1, DurationMs: 1000}, Steps: []model.LoadStep{{RequestID: "req-ok", ThinkTimeMs: 80}}}},
	}
	saved := callExecutionTool(t, s, ctx, "save_load_test", map[string]any{"collection": "Smoke", "test": test})
	id := saved["test"].(map[string]any)["id"].(string)
	run := func() float64 {
		state := callExecutionTool(t, s, ctx, "start_load_test", map[string]any{"test": id})
		if state["running"] != true {
			t.Fatalf("k6 did not start: %v", state)
		}
		progress := callExecutionTool(t, s, ctx, "load_test_status", nil)
		if progress["loadTestId"] != id {
			t.Fatalf("k6 progress = %v", progress)
		}
		waitForLoadRun(t, s.executionApp, 20*time.Second)
		result := callExecutionTool(t, s, ctx, "load_test_result", map[string]any{"test": id})
		if result["status"] != "passed" || result["hasSummary"] != true {
			t.Fatalf("load result = %v, log = %v", result, s.executionApp.LoadRunLog())
		}
		return state["startedAt"].(float64)
	}
	first, second := run(), run()
	history := callExecutionTool(t, s, ctx, "list_load_runs", map[string]any{"test": id})
	if runs := history["runs"].([]any); len(runs) != 2 || runs[0].(map[string]any)["startedAt"] != second {
		t.Fatalf("run history = %v", history)
	}
	comparison := callExecutionTool(t, s, ctx, "compare_load_runs", map[string]any{
		"baseline":  map[string]any{"test": id, "startedAt": first},
		"candidate": map[string]any{"test": id, "startedAt": second},
	})
	if first == second || comparison["baseline"].(map[string]any)["startedAt"] != first || comparison["candidate"].(map[string]any)["startedAt"] != second {
		t.Fatalf("two completed runs were not retained: %v", comparison)
	}
}

func TestAgentExecutionClosesLiveConnectionAtTurnEnd(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	closed := make(chan struct{})
	events := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: ready\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(closed)
	}))
	defer events.Close()
	root := writeYAMLWorkspace(t, events.URL)
	saveExecutionFixtures(t, root, map[string]any{"id": "events", "name": "Events", "requestType": "http", "method": "SSE", "url": "{{baseUrl}}"})
	copyWorkspaceTo(t, root, fileWorkspaceStorePath())
	provider := newAiTestServer(t,
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"open","type":"function","function":{"name":"open_session","arguments":"{\"request\":\"events\"}"}}]},"finish_reason":"tool_calls"}]}`),
			openAIChunkEvent(`[DONE]`),
		}},
		sseScript{events: []string{
			openAIChunkEvent(`{"choices":[{"index":0,"delta":{"content":"Connection opened."},"finish_reason":"stop"}]}`),
			openAIChunkEvent(`[DONE]`),
		}},
	)
	app := NewApp()
	if saved := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: provider.URL, Key: "test", Model: "demo"}); saved.Error != "" {
		t.Fatal(saved.Error)
	}
	app.agentEmit = func(name string, payload any) {
		if name == "agent:approval" {
			approval := payload.(model.AgentApproval)
			if approval.Tool != "open_session" || !app.AnswerAgentApproval(approval.ID, model.AgentApprovalAllow).Ok {
				t.Errorf("could not approve %+v", approval)
			}
		}
	}
	done := make(chan model.AgentTurn, 1)
	go func() {
		done <- app.SendAgentMessage(model.AgentSendInput{Text: "Open the event stream", Environment: "Local", WorkspaceID: "ws-demo"})
	}()
	turn := awaitAgentLifecycleTurn(t, done)
	if turn.Error != "" || !strings.Contains(turn.Text, "Connection opened.") || !strings.Contains(fmt.Sprint(provider.body(1)["messages"]), "sessionId") {
		t.Fatalf("turn = %+v", turn)
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("the turn ended without closing SSE")
	}
	assertAgentReleased(t, app)
}

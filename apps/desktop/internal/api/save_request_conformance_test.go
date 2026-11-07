package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/grpc"
	grpcTest "google.golang.org/grpc/interop/grpc_testing"
	"google.golang.org/grpc/reflection"
)

type saveConformanceCase struct {
	id     string
	yaml   string
	fields map[string]any
	run    func(t *testing.T, s *mcpServer, ctx context.Context, id string)
}

func conformanceYAML(lines ...string) string {
	return "version: 1\nrequest:\n" + strings.Join(lines, "\n") + "\n"
}

func conformanceRun(t *testing.T, s *mcpServer, ctx context.Context, id string) map[string]any {
	t.Helper()
	return callExecutionTool(t, s, ctx, "run_request", map[string]any{"request": id})
}

func conformanceHTTP(check func(t *testing.T, out mcpRequestOutcome, echo map[string]any)) func(t *testing.T, s *mcpServer, ctx context.Context, id string) {
	return func(t *testing.T, s *mcpServer, ctx context.Context, id string) {
		t.Helper()
		raw, _ := json.Marshal(conformanceRun(t, s, ctx, id))
		var out mcpRequestOutcome
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		if out.Status != 200 || out.Error != "" {
			t.Fatalf("%s ran with status %d error %q", id, out.Status, out.Error)
		}
		var echo map[string]any
		_ = json.Unmarshal([]byte(out.Body), &echo)
		check(t, out, echo)
	}
}

func TestSaveRequestLoadsAndRunsEveryRequestType(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)
	mcpRemote, _ := newSessionMCPServer(t, "2025-06-18")
	provider := newAiTestServer(t, sseScript{json: `{"id":"x","model":"demo","choices":[{"message":{"role":"assistant","content":"conformance ok"},"finish_reason":"stop"}]}`})
	sio := newSIOServer(t)
	t.Cleanup(func() { close(sio.push) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ws":
			conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close()
			for {
				kind, data, err := conn.ReadMessage()
				if err != nil || conn.WriteMessage(kind, data) != nil {
					return
				}
			}
		case "/sse":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: tick\ndata: sse-ready\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		case "/socket.io/":
			sio.handler(w, r)
		default:
			body, _ := io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"method": r.Method, "path": r.URL.Path, "query": r.URL.RawQuery, "contentType": r.Header.Get("Content-Type"), "trace": r.Header.Get("X-Trace"), "auth": r.Header.Get("Authorization"), "body": string(body)})
		}
	}))
	t.Cleanup(server.Close)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	grpcServer := grpc.NewServer()
	grpcTest.RegisterTestServiceServer(grpcServer, executionGrpcServer{})
	reflection.Register(grpcServer)
	go grpcServer.Serve(listener)
	t.Cleanup(grpcServer.Stop)

	root := writeYAMLWorkspace(t, server.URL)
	cases := []saveConformanceCase{
		{
			id: "conf-get",
			yaml: conformanceYAML(
				"  id: conf-get", "  name: Get order", "  requestType: http", "  method: GET", `  url: "{{baseUrl}}/orders/7"`,
				"  params:", "    - {id: p1, key: expand, value: items, enabled: true}", "    - {id: p2, key: skip, value: me, enabled: false}",
				"  headers:", "    - {id: h1, key: X-Trace, value: 'conf-{{apiVersion}}', enabled: true}",
				"  testScriptJs: |", `    pm.test("status", () => pm.expect(pm.response.code).to.equal(200))`,
			),
			fields: map[string]any{"url": "{{baseUrl}}/orders/7"},
			run: conformanceHTTP(func(t *testing.T, out mcpRequestOutcome, echo map[string]any) {
				if echo["method"] != "GET" || echo["path"] != "/orders/7" || echo["query"] != "expand=items" || echo["trace"] != "conf-v1" || out.TestsPassed != 1 {
					t.Fatalf("GET echo %v tests %d/%d", echo, out.TestsPassed, out.TestsTotal)
				}
			}),
		},
		{
			id: "conf-json",
			yaml: conformanceYAML(
				"  id: conf-json", "  name: Create order", "  requestType: http", "  method: POST", `  url: "{{baseUrl}}/orders"`,
				"  bodyType: json", `  bodyContent: '{"sku": "{{apiVersion}}-a", "qty": 2}'`,
				"  auth: {type: bearer, token: '{{token}}'}",
			),
			fields: map[string]any{"method": "POST", "bodyType": "json"},
			run: conformanceHTTP(func(t *testing.T, out mcpRequestOutcome, echo map[string]any) {
				if echo["method"] != "POST" || !strings.Contains(fmt.Sprint(echo["contentType"]), "application/json") || echo["body"] != `{"sku": "v1-a", "qty": 2}` {
					t.Fatalf("JSON echo %v", echo)
				}
			}),
		},
		{
			id: "conf-form",
			yaml: conformanceYAML(
				"  id: conf-form", "  name: Login", "  requestType: http", "  method: POST", `  url: "{{baseUrl}}/login"`,
				"  bodyType: urlencoded", "  formRows:", "    - {id: f1, key: user, value: ada, enabled: true, type: text}", "    - {id: f2, key: scope, value: 'read write', enabled: true, type: text}",
			),
			fields: map[string]any{"bodyType": "urlencoded"},
			run: conformanceHTTP(func(t *testing.T, out mcpRequestOutcome, echo map[string]any) {
				if echo["body"] != "user=ada&scope=read+write" || !strings.Contains(fmt.Sprint(echo["contentType"]), "x-www-form-urlencoded") {
					t.Fatalf("form echo %v", echo)
				}
			}),
		},
		{
			id: "conf-text",
			yaml: conformanceYAML(
				"  id: conf-text", "  name: Upload note", "  requestType: http", "  method: PUT", `  url: "{{baseUrl}}/notes/1"`,
				"  bodyType: text", "  bodyContent: plain {{apiVersion}}",
			),
			fields: map[string]any{"method": "PUT", "bodyType": "text"},
			run: conformanceHTTP(func(t *testing.T, out mcpRequestOutcome, echo map[string]any) {
				if echo["method"] != "PUT" || echo["body"] != "plain v1" {
					t.Fatalf("text echo %v", echo)
				}
			}),
		},
		{
			id: "conf-graphql",
			yaml: conformanceYAML(
				"  id: conf-graphql", "  name: Orders query", "  requestType: graphql", `  url: "{{baseUrl}}/graphql"`,
				"  bodyType: graphql", `  bodyContent: '{"query":"query Orders($n: Int) { orders(first: $n) { id } }","variables":{"n":3}}'`,
			),
			fields: map[string]any{"requestType": "graphql"},
			run: conformanceHTTP(func(t *testing.T, out mcpRequestOutcome, echo map[string]any) {
				if echo["method"] != "POST" || !strings.Contains(fmt.Sprint(echo["body"]), "orders(first: $n)") || !strings.Contains(fmt.Sprint(echo["body"]), `"n":3`) {
					t.Fatalf("GraphQL echo %v", echo)
				}
			}),
		},
		{
			id: "conf-grpc",
			yaml: conformanceYAML(
				"  id: conf-grpc", "  name: Empty call", "  requestType: grpc", "  url: "+listener.Addr().String(),
				"  grpcMethod: grpc.testing.TestService/EmptyCall", "  bodyContent: '{}'",
			),
			fields: map[string]any{"requestType": "grpc", "grpcMethod": "grpc.testing.TestService/EmptyCall"},
			run: func(t *testing.T, s *mcpServer, ctx context.Context, id string) {
				if out := conformanceRun(t, s, ctx, id); out["response"].(map[string]any)["grpcCode"] != "OK" {
					t.Fatalf("gRPC = %v", out)
				}
			},
		},
		{
			id: "conf-mcp",
			yaml: conformanceYAML(
				"  id: conf-mcp", "  name: Echo tool", "  requestType: mcp", "  url: "+mcpRemote.URL,
				"  mcpMethod: tools/call", "  mcpName: echo", `  mcpArguments: '{"text":"{{apiVersion}}"}'`,
			),
			fields: map[string]any{"requestType": "mcp", "mcpMethod": "tools/call", "mcpName": "echo"},
			run: func(t *testing.T, s *mcpServer, ctx context.Context, id string) {
				if out := conformanceRun(t, s, ctx, id); !strings.Contains(fmt.Sprint(out["response"].(map[string]any)["result"]), "echo: v1") {
					t.Fatalf("MCP = %v", out)
				}
			},
		},
		{
			id: "conf-ai",
			yaml: conformanceYAML(
				"  id: conf-ai", "  name: Summarize", "  requestType: ai", "  url: "+provider.URL,
				"  aiProvider: openai", "  aiModel: demo", "  aiPrompt: Summarize {{apiVersion}}", "  aiStream: false", "  aiKurloTools: true",
			),
			fields: map[string]any{"requestType": "ai", "aiProvider": "openai", "aiKurloTools": true},
			run: func(t *testing.T, s *mcpServer, ctx context.Context, id string) {
				out := conformanceRun(t, s, ctx, id)
				if out["response"].(map[string]any)["text"] != "conformance ok" || !strings.Contains(fmt.Sprint(provider.body(0)["messages"]), "Summarize v1") {
					t.Fatalf("AI = %v", out)
				}
				if !strings.Contains(fmt.Sprint(provider.body(0)["tools"]), "list_requests") {
					t.Fatalf("AI request with Kurlo tools offers them, tools = %v", provider.body(0)["tools"])
				}
			},
		},
		{
			id:     "conf-ws",
			yaml:   conformanceYAML("  id: conf-ws", "  name: Socket", "  requestType: ws", `  url: "{{baseUrl}}/ws"`),
			fields: map[string]any{"requestType": "ws"},
			run: func(t *testing.T, s *mcpServer, ctx context.Context, id string) {
				session := conformanceOpen(t, s, ctx, id)
				callExecutionTool(t, s, ctx, "send_message", map[string]any{"sessionId": session, "data": "ping conformance"})
				conformanceWait(t, s, ctx, session, "ping conformance")
				callExecutionTool(t, s, ctx, "close_session", map[string]any{"sessionId": session})
			},
		},
		{
			id:     "conf-sse",
			yaml:   conformanceYAML("  id: conf-sse", "  name: Ticks", "  requestType: http", "  method: SSE", `  url: "{{baseUrl}}/sse"`),
			fields: map[string]any{"method": "SSE"},
			run: func(t *testing.T, s *mcpServer, ctx context.Context, id string) {
				session := conformanceOpen(t, s, ctx, id)
				conformanceWait(t, s, ctx, session, "sse-ready")
				callExecutionTool(t, s, ctx, "close_session", map[string]any{"sessionId": session})
			},
		},
		{
			id: "conf-sio",
			yaml: conformanceYAML("  id: conf-sio", "  name: Live", "  requestType: socketio", `  url: "{{baseUrl}}"`,
				"  sioEvents:", "    - {id: e1, key: welcome, enabled: true}"),
			fields: map[string]any{"requestType": "socketio"},
			run: func(t *testing.T, s *mcpServer, ctx context.Context, id string) {
				session := conformanceOpen(t, s, ctx, id)
				sio.push <- `42["welcome","conformance hi"]`
				conformanceWait(t, s, ctx, session, "conformance hi")
				callExecutionTool(t, s, ctx, "close_session", map[string]any{"sessionId": session})
			},
		},
	}

	s := newMCPServer(mcpServerOptions{workspace: root, env: "Local"}, io.Discard)
	ctx, stop := context.WithCancel(t.Context())
	defer stop()
	s.live = newAgentLiveSessions(ctx, s.jars)
	defer s.live.close()
	for _, c := range cases {
		saved := callExecutionTool(t, s, ctx, "save_request", map[string]any{"collection": "Smoke", "yaml": c.yaml})
		if saved["id"] != c.id || saved["created"] != true {
			t.Fatalf("save %s = %v", c.id, saved)
		}
	}

	_, _, requests, _, _, diagnostics, err := loadFilesystemWorkspaceStoreWithDiagnostics(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("the app reports problems with saved files: %+v", diagnostics)
	}
	byID := map[string]map[string]any{}
	for _, request := range requests {
		byID[stringValue(request, "id")] = request
	}
	_, _, cliRequests, _, err := loadCLIWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	cliByID := map[string]cliSavedRequest{}
	for _, request := range cliRequests {
		cliByID[request.ID] = request
	}
	for _, c := range cases {
		loaded := byID[c.id]
		if loaded == nil {
			t.Fatalf("the app does not load %s", c.id)
		}
		for key, want := range c.fields {
			if fmt.Sprint(loaded[key]) != fmt.Sprint(want) {
				t.Errorf("%s: the app loads %s = %v, want %v", c.id, key, loaded[key], want)
			}
		}
		if stringValue(loaded, "collectionId") != "col-smoke" {
			t.Errorf("%s is not in the Smoke collection: %v", c.id, loaded["collectionId"])
		}
		if _, ok := cliByID[c.id]; !ok {
			t.Errorf("the CLI does not load %s", c.id)
		}
		doc := callExecutionTool(t, s, ctx, "get_request", map[string]any{"request": c.id})
		if !strings.Contains(fmt.Sprint(doc), c.id) {
			t.Errorf("get_request %s = %v", c.id, doc)
		}
	}

	before, err := readWorkspaceFileContents(root)
	if err != nil {
		t.Fatal(err)
	}
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	after, err := readWorkspaceFileContents(root)
	if err != nil {
		t.Fatal(err)
	}
	for path, content := range before {
		if string(after[path]) != string(content) {
			t.Errorf("loading and saving again rewrites %s:\n%s\n---\n%s", path, content, after[path])
		}
	}

	for _, c := range cases {
		t.Run(c.id, func(t *testing.T) { c.run(t, s, ctx, c.id) })
	}
}

func conformanceOpen(t *testing.T, s *mcpServer, ctx context.Context, id string) string {
	t.Helper()
	session := callExecutionTool(t, s, ctx, "open_session", map[string]any{"request": id})["sessionId"].(string)
	callExecutionTool(t, s, ctx, "read_messages", map[string]any{"sessionId": session, "timeoutMs": 0, "limit": 1})
	return session
}

func conformanceWait(t *testing.T, s *mcpServer, ctx context.Context, session, message string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var seen []any
	for time.Now().Before(deadline) {
		out := callExecutionTool(t, s, ctx, "read_messages", map[string]any{"sessionId": session, "timeoutMs": 500})
		seen = append(seen, out["messages"])
		if strings.Contains(fmt.Sprint(out["messages"]), message) {
			return
		}
	}
	t.Fatalf("expected %q, got %v", message, seen)
}

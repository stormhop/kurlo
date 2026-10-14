package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

type mcpHarness struct {
	t      *testing.T
	in     *io.PipeWriter
	lines  chan []byte
	done   chan error
	nextID int
}

type mcpHarnessResponse struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func startMCPHarness(t *testing.T, opts mcpServerOptions) *mcpHarness {
	t.Helper()
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	inReader, inWriter := io.Pipe()
	outReader, outWriter := io.Pipe()
	h := &mcpHarness{t: t, in: inWriter, lines: make(chan []byte, 64), done: make(chan error, 1)}

	go func() {
		h.done <- newMCPServer(opts, outWriter).serve(inReader)
		_ = outWriter.Close()
	}()
	go func() {
		scanner := bufio.NewScanner(outReader)
		scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
		for scanner.Scan() {
			h.lines <- append([]byte(nil), scanner.Bytes()...)
		}
		close(h.lines)
	}()
	t.Cleanup(func() {
		_ = inWriter.Close()
		select {
		case <-h.done:
		case <-time.After(5 * time.Second):
			t.Error("server did not stop after stdin closed")
		}
	})
	return h
}

func (h *mcpHarness) send(message map[string]any) {
	h.t.Helper()
	data, err := json.Marshal(message)
	if err != nil {
		h.t.Fatalf("marshal: %v", err)
	}
	if _, err := h.in.Write(append(data, '\n')); err != nil {
		h.t.Fatalf("write: %v", err)
	}
}

func (h *mcpHarness) read() mcpHarnessResponse {
	h.t.Helper()
	select {
	case line, ok := <-h.lines:
		if !ok {
			h.t.Fatal("server closed its output")
		}
		var resp mcpHarnessResponse
		if err := json.Unmarshal(line, &resp); err != nil {
			h.t.Fatalf("server wrote invalid JSON %q: %v", line, err)
		}
		return resp
	case <-time.After(15 * time.Second):
		h.t.Fatal("timed out waiting for a response")
	}
	return mcpHarnessResponse{}
}

func (h *mcpHarness) request(method string, params any) mcpHarnessResponse {
	h.t.Helper()
	h.nextID++
	id := h.nextID
	message := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		message["params"] = params
	}
	h.send(message)
	resp := h.read()
	if string(resp.ID) != fmt.Sprint(id) {
		h.t.Fatalf("response id = %s, want %d", resp.ID, id)
	}
	return resp
}

type mcpHarnessToolResult struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StructuredContent json.RawMessage `json:"structuredContent"`
	IsError           bool            `json:"isError"`
}

func (h *mcpHarness) tool(name string, arguments map[string]any, into any) mcpHarnessToolResult {
	h.t.Helper()
	resp := h.request("tools/call", map[string]any{"name": name, "arguments": arguments})
	if resp.Error != nil {
		h.t.Fatalf("%s: rpc error %d %s", name, resp.Error.Code, resp.Error.Message)
	}
	var result mcpHarnessToolResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		h.t.Fatalf("%s: decode result: %v", name, err)
	}
	if into != nil {
		if len(result.StructuredContent) == 0 {
			h.t.Fatalf("%s: no structuredContent in %s", name, resp.Result)
		}
		if err := json.Unmarshal(result.StructuredContent, into); err != nil {
			h.t.Fatalf("%s: decode structuredContent: %v", name, err)
		}
		if len(result.Content) != 1 || result.Content[0].Type != "text" || !json.Valid([]byte(result.Content[0].Text)) {
			h.t.Fatalf("%s: expected one text block carrying the JSON, got %+v", name, result.Content)
		}
	}
	return result
}

func addSecretEnvironment(t *testing.T, root, baseURL, secret string) {
	t.Helper()
	content := strings.Join([]string{
		"version: 1",
		"environment:",
		"  id: env-prod",
		"  workspaceId: ws-demo",
		"  name: Prod",
		"  filesystemName: Prod",
		"  values:",
		"    - id: 1",
		"      enabled: true",
		"      key: baseUrl",
		"      value: " + baseURL,
		"    - id: 2",
		"      enabled: true",
		"      secret: true",
		"      key: apiToken",
		"      value: " + secret,
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(root, "workspaces", "Demo", "environments", "Prod.yml"), []byte(content), 0o644); err != nil {
		t.Fatalf("write env: %v", err)
	}
}

func echoServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Seen-Auth", r.Header.Get("Authorization"))
		_ = json.NewEncoder(w).Encode(map[string]any{
			"method":      r.Method,
			"path":        r.URL.Path,
			"query":       r.URL.RawQuery,
			"auth":        r.Header.Get("Authorization"),
			"contentType": r.Header.Get("Content-Type"),
			"body":        string(body),
		})
	}))
	t.Cleanup(server.Close)
	return server
}

func TestMCPServerHandshakeAndToolList(t *testing.T) {
	server := echoServer(t)
	h := startMCPHarness(t, mcpServerOptions{workspace: writeYAMLWorkspace(t, server.URL), env: "Local"})

	resp := h.request("initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "test", "version": "1"},
	})
	var init struct {
		ProtocolVersion string         `json:"protocolVersion"`
		Capabilities    map[string]any `json:"capabilities"`
		ServerInfo      struct {
			Name string `json:"name"`
		} `json:"serverInfo"`
		Instructions string `json:"instructions"`
	}
	if err := json.Unmarshal(resp.Result, &init); err != nil {
		t.Fatalf("decode initialize: %v", err)
	}
	if init.ProtocolVersion != "2025-06-18" {
		t.Errorf("protocolVersion = %q, want the client's version echoed", init.ProtocolVersion)
	}
	if _, ok := init.Capabilities["tools"]; !ok || init.ServerInfo.Name != "kurlo" {
		t.Errorf("initialize = %+v", init)
	}
	if !strings.Contains(init.Instructions, "Local") {
		t.Errorf("instructions should name the default environment: %q", init.Instructions)
	}

	resp = h.request("initialize", map[string]any{"protocolVersion": "1999-01-01"})
	if !strings.Contains(string(resp.Result), mcpServerLatestHandshakeVersion) {
		t.Errorf("an unknown version should be answered with the latest supported one: %s", resp.Result)
	}

	h.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})

	if resp := h.request("ping", nil); resp.Error != nil || string(resp.Result) != "{}" {
		t.Errorf("ping = %+v", resp)
	}

	resp = h.request("tools/list", map[string]any{})
	var list struct {
		Tools []struct {
			Name        string         `json:"name"`
			InputSchema map[string]any `json:"inputSchema"`
		} `json:"tools"`
		ResultType string `json:"resultType"`
	}
	if err := json.Unmarshal(resp.Result, &list); err != nil {
		t.Fatalf("decode tools/list: %v", err)
	}
	var names []string
	for _, tool := range list.Tools {
		names = append(names, tool.Name)
		if tool.InputSchema["type"] != "object" {
			t.Errorf("%s inputSchema type = %v", tool.Name, tool.InputSchema["type"])
		}
	}
	if got := strings.Join(names, ","); got != "list_requests,get_request,list_environments,run_request,run_collection,send_request,list_history,get_history_entry,create_collection,save_request,delete_request,save_example,set_variable" {
		t.Errorf("tools = %s", got)
	}
	if list.ResultType != "" {
		t.Errorf("a handshake client should not get the stateless resultType, got %q", list.ResultType)
	}
}

func TestMCPServerSpeaksTheStatelessRevision(t *testing.T) {
	server := echoServer(t)
	h := startMCPHarness(t, mcpServerOptions{workspace: writeYAMLWorkspace(t, server.URL)})
	meta := map[string]any{"_meta": map[string]any{mcpMetaProtocolVersion: "2026-07-28"}}

	resp := h.request(mcpMethodDiscover, meta)
	var discover struct {
		ResultType        string         `json:"resultType"`
		SupportedVersions []string       `json:"supportedVersions"`
		Capabilities      map[string]any `json:"capabilities"`
		Meta              map[string]struct {
			Name string `json:"name"`
		} `json:"_meta"`
	}
	if err := json.Unmarshal(resp.Result, &discover); err != nil {
		t.Fatalf("decode discover: %v", err)
	}
	if discover.ResultType != "complete" || strings.Join(discover.SupportedVersions, ",") != "2026-07-28" {
		t.Errorf("discover = %+v", discover)
	}
	if discover.Meta[mcpMetaServerInfo].Name != "kurlo" {
		t.Errorf("serverInfo missing from _meta: %s", resp.Result)
	}

	resp = h.request("tools/list", meta)
	if !strings.Contains(string(resp.Result), `"resultType":"complete"`) {
		t.Errorf("tools/list under 2026-07-28 should carry resultType: %s", resp.Result)
	}
	resp = h.request("tools/call", map[string]any{"name": "list_environments", "arguments": map[string]any{}, "_meta": meta["_meta"]})
	if !strings.Contains(string(resp.Result), `"resultType":"complete"`) {
		t.Errorf("tools/call under 2026-07-28 should carry resultType: %s", resp.Result)
	}
}

func TestMCPServerListsAndDescribesRequests(t *testing.T) {
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	addSecretEnvironment(t, root, server.URL, "tok-very-secret-123")
	h := startMCPHarness(t, mcpServerOptions{workspace: root})

	var list struct {
		Count    int                 `json:"count"`
		Requests []mcpRequestSummary `json:"requests"`
	}
	h.tool("list_requests", map[string]any{}, &list)
	if list.Count != 2 || len(list.Requests) != 2 {
		t.Fatalf("list = %+v", list)
	}
	first := list.Requests[0]
	if first.ID != "req-ok" || first.Path != "Smoke/Ok" || first.Method != "GET" || !first.Runnable || first.Type != "http" {
		t.Errorf("first request = %+v", first)
	}

	h.tool("list_requests", map[string]any{"collection": "nope"}, &list)
	if list.Count != 0 {
		t.Errorf("collection filter should drop everything, got %d", list.Count)
	}

	var detail struct {
		Path       string `json:"path"`
		URL        string `json:"url"`
		TestScript string `json:"testScript"`
		Auth       struct {
			Type string `json:"type"`
		} `json:"auth"`
	}
	h.tool("get_request", map[string]any{"request": "chain"}, &detail)
	if detail.Path != "Smoke/Chain" || !strings.Contains(detail.URL, "{{chained}}") || !strings.Contains(detail.TestScript, "chained value carried over") {
		t.Errorf("detail = %+v", detail)
	}

	result := h.tool("get_request", map[string]any{"request": "Missing"}, nil)
	if !result.IsError || !strings.Contains(result.Content[0].Text, "list_requests") {
		t.Errorf("an unknown request should be a tool error pointing at list_requests: %+v", result)
	}

	var envs struct {
		Environments []struct {
			Name      string `json:"name"`
			Variables []struct {
				Key    string `json:"key"`
				Value  string `json:"value"`
				Secret bool   `json:"secret"`
			} `json:"variables"`
		} `json:"environments"`
	}
	text := h.tool("list_environments", map[string]any{}, &envs).Content[0].Text
	if strings.Contains(text, "tok-very-secret-123") {
		t.Fatalf("list_environments leaked a secret value: %s", text)
	}
	found := false
	for _, env := range envs.Environments {
		for _, v := range env.Variables {
			if env.Name == "Prod" && v.Key == "apiToken" {
				found = v.Secret && v.Value == ""
			}
		}
	}
	if !found {
		t.Errorf("Prod.apiToken should be listed as a secret with no value: %+v", envs)
	}
}

func TestMCPServerRunsRequestsAndCarriesScriptVariables(t *testing.T) {
	server := echoServer(t)
	h := startMCPHarness(t, mcpServerOptions{workspace: writeYAMLWorkspace(t, server.URL), env: "Local"})

	result := h.tool("run_request", map[string]any{"request": "Chain"}, nil)
	var chain mcpRequestOutcome
	_ = json.Unmarshal(result.StructuredContent, &chain)
	if chain.TestsTotal != 1 || chain.TestsPassed != 0 {
		t.Fatalf("before the login-style request ran, Chain's test should fail: %+v", chain)
	}
	if strings.Join(chain.Unresolved, ",") != "chained" {
		t.Fatalf("Chain should report chained as unresolved before a script sets it: %v", chain.Unresolved)
	}

	var ok mcpRequestOutcome
	h.tool("run_request", map[string]any{"request": "Smoke/Ok"}, &ok)
	if ok.Status != 200 || ok.TestsPassed != 1 || ok.TestsTotal != 1 {
		t.Fatalf("Ok = %+v", ok)
	}
	if len(ok.Unresolved) > 0 {
		t.Errorf("collection variables are known, nothing is unresolved: %v", ok.Unresolved)
	}
	if !strings.Contains(ok.Body, `"query":"v=v1"`) {
		t.Errorf("collection variables should resolve in the URL; body = %s", ok.Body)
	}
	if ok.Environment != "Local" || strings.Join(ok.VariablesChanged, ",") != "chained" {
		t.Errorf("Ok environment=%q changed=%v", ok.Environment, ok.VariablesChanged)
	}
	if len(ok.Headers) == 0 || ok.DurationMs < 0 {
		t.Errorf("headers/timings missing: %+v", ok)
	}

	chain = mcpRequestOutcome{}
	h.tool("run_request", map[string]any{"request": "req-fail"}, &chain)
	if chain.TestsPassed != 1 || !strings.Contains(chain.URL, "chained=yes") {
		t.Fatalf("a value a script set should carry into the next call: %+v", chain)
	}
	if len(chain.Unresolved) > 0 {
		t.Fatalf("once a script set chained it is no longer unresolved: %v", chain.Unresolved)
	}

	h.tool("run_request", map[string]any{"request": "Chain", "variables": map[string]any{"chained": "override"}}, &chain)
	if !strings.Contains(chain.URL, "chained=override") {
		t.Errorf("call variables should win over session values: %s", chain.URL)
	}
}

func TestMCPServerRedactsSecretsAndTruncatesBodies(t *testing.T) {
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	secret := "tok-very-secret-123"
	addSecretEnvironment(t, root, server.URL, secret)
	h := startMCPHarness(t, mcpServerOptions{workspace: root})

	var out mcpRequestOutcome
	result := h.tool("send_request", map[string]any{
		"method":      "post",
		"url":         "{{baseUrl}}/echo?token={{apiToken}}",
		"headers":     map[string]any{"Authorization": "Bearer {{apiToken}}"},
		"body":        `{"hello":"world"}`,
		"environment": "Prod",
	}, &out)
	raw := result.Content[0].Text + string(result.StructuredContent)
	if strings.Contains(raw, secret) {
		t.Fatalf("a secret environment value reached the model: %s", raw)
	}
	if out.Status != 200 || out.Method != "POST" || !strings.Contains(out.Body, `"path":"/echo"`) {
		t.Fatalf("send_request = %+v", out)
	}
	if !strings.Contains(out.Body, `"contentType":"application/json"`) || !strings.Contains(out.Body, `\"hello\":\"world\"`) {
		t.Errorf("a JSON body should go out as application/json: %s", out.Body)
	}
	if !strings.Contains(out.Body, `"auth":"Bearer [secret]"`) || !strings.Contains(out.URL, "token=[secret]") {
		t.Errorf("the secret should have been sent and then masked in what comes back: url=%s body=%s", out.URL, out.Body)
	}

	h.tool("send_request", map[string]any{"url": server.URL + "/" + strings.Repeat("é", 200), "maxBodyBytes": 51}, &out)
	if !out.BodyTruncated || len(out.Body) > 51 || !utf8.ValidString(out.Body) {
		t.Errorf("body should be cut to the limit on a rune boundary: truncated=%v len=%d", out.BodyTruncated, len(out.Body))
	}

	result = h.tool("send_request", map[string]any{"url": "http://127.0.0.1:1/unreachable"}, &out)
	if !result.IsError || out.Error == "" {
		t.Errorf("a request that never got a response should be a tool error: %+v", out)
	}
}

func TestMCPServerRunsACollection(t *testing.T) {
	server := echoServer(t)
	h := startMCPHarness(t, mcpServerOptions{workspace: writeYAMLWorkspace(t, server.URL)})

	var run struct {
		Environment string `json:"environment"`
		Summary     struct {
			Requests   int  `json:"requests"`
			Passed     int  `json:"passed"`
			Failed     int  `json:"failed"`
			Assertions int  `json:"assertions"`
			OK         bool `json:"ok"`
		} `json:"summary"`
		Results          []cliRunResult `json:"results"`
		VariablesChanged []string       `json:"variablesChanged"`
	}
	h.tool("run_collection", map[string]any{"collection": "Smoke", "environment": "Local"}, &run)
	if run.Summary.Requests != 2 || run.Summary.Passed != 2 || !run.Summary.OK || run.Summary.Assertions != 2 {
		t.Fatalf("summary = %+v results=%+v", run.Summary, run.Results)
	}
	if run.Environment != "Local" || strings.Join(run.VariablesChanged, ",") != "chained" {
		t.Errorf("environment=%q changed=%v", run.Environment, run.VariablesChanged)
	}

	result := h.tool("run_collection", map[string]any{"collection": "Smoke", "environment": "Nope"}, nil)
	if !result.IsError || !strings.Contains(result.Content[0].Text, "Local") {
		t.Errorf("an unknown environment should be a tool error naming the real ones: %+v", result)
	}
}

func TestMCPServerProtocolErrors(t *testing.T) {
	server := echoServer(t)
	h := startMCPHarness(t, mcpServerOptions{workspace: writeYAMLWorkspace(t, server.URL)})

	if resp := h.request("resources/list", nil); resp.Error == nil || resp.Error.Code != mcpRPCMethodNotFound {
		t.Errorf("unknown method = %+v", resp)
	}
	if resp := h.request("tools/call", map[string]any{"name": "drop_tables"}); resp.Error == nil || resp.Error.Code != mcpRPCInvalidParams {
		t.Errorf("unknown tool = %+v", resp)
	}
	if resp := h.request("tools/call", map[string]any{"name": "run_request", "arguments": map[string]any{"request": 5}}); resp.Error == nil || resp.Error.Code != mcpRPCInvalidParams {
		t.Errorf("mistyped arguments = %+v", resp)
	}

	if _, err := h.in.Write([]byte("{not json\n")); err != nil {
		t.Fatal(err)
	}
	if resp := h.read(); resp.Error == nil || resp.Error.Code != mcpRPCParseError || string(resp.ID) != "null" {
		t.Errorf("parse error = %+v", resp)
	}
	if resp := h.request("ping", nil); resp.Error != nil {
		t.Errorf("the server should keep serving after a parse error: %+v", resp)
	}
}

func TestMCPServerCancelsAToolCall(t *testing.T) {
	started := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	t.Cleanup(slow.Close)
	h := startMCPHarness(t, mcpServerOptions{workspace: writeYAMLWorkspace(t, slow.URL)})

	h.send(map[string]any{"jsonrpc": "2.0", "id": "slow-1", "method": "tools/call", "params": map[string]any{
		"name": "send_request", "arguments": map[string]any{"url": slow.URL},
	}})
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the request never reached the server")
	}
	h.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": "slow-1"}})

	h.nextID = 99
	resp := h.request("ping", nil)
	if resp.Error != nil {
		t.Fatalf("ping after cancel = %+v", resp)
	}
	select {
	case line := <-h.lines:
		t.Errorf("a cancelled call must not be answered, got %s", line)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestParseMCPServerArgs(t *testing.T) {
	opts, err := parseMCPServerArgs([]string{"./ws", "--env", "Staging", "-k", "--timeout", "500"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if opts.workspace != "./ws" || opts.env != "Staging" || !opts.insecure || opts.timeoutMs != 500 || opts.loadAppSecrets {
		t.Errorf("opts = %+v", opts)
	}
	opts, err = parseMCPServerArgs([]string{"--env", "Local"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if opts.workspace != fileWorkspaceStorePath() || !opts.loadAppSecrets {
		t.Errorf("with no workspace it should serve the app's own, with its secrets: %+v", opts)
	}
}

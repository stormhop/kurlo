package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type oauthMCPFake struct {
	mu        sync.Mutex
	base      string
	sessions  map[string]bool
	next      int
	tokens    map[string]bool
	registers int
	refreshes []url.Values
	codes     []url.Values
	authorize url.Values
}

func newOAuthMCPFake(t *testing.T) (*httptest.Server, *oauthMCPFake) {
	t.Helper()
	fake := &oauthMCPFake{sessions: map[string]bool{}, tokens: map[string]bool{}}
	server := httptest.NewServer(http.HandlerFunc(fake.serve))
	fake.base = server.URL
	t.Cleanup(server.Close)
	return server, fake
}

func (f *oauthMCPFake) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.URL.Path {
	case "/.well-known/oauth-protected-resource/mcp":
		_ = json.NewEncoder(w).Encode(map[string]any{"resource": f.base + "/mcp", "authorization_servers": []string{f.base}, "scopes_supported": []string{"docs.read"}})
		return
	case "/.well-known/oauth-authorization-server":
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": f.base, "authorization_endpoint": f.base + "/authorize", "token_endpoint": f.base + "/token", "registration_endpoint": f.base + "/register", "code_challenge_methods_supported": []string{"S256"}})
		return
	case "/register":
		f.registers++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"client_id": "kurlo-client", "redirect_uris": body["redirect_uris"]})
		return
	case "/authorize":
		f.authorize = r.URL.Query()
		target := r.URL.Query().Get("redirect_uri") + "?code=code-1&state=" + url.QueryEscape(r.URL.Query().Get("state"))
		http.Redirect(w, r, target, http.StatusFound)
		return
	case "/token":
		_ = r.ParseForm()
		form := r.PostForm
		token := "tok-1"
		if form.Get("grant_type") == "refresh_token" {
			f.refreshes = append(f.refreshes, form)
			token = "tok-2"
		} else {
			f.codes = append(f.codes, form)
		}
		f.tokens[token] = true
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": token, "token_type": "Bearer", "expires_in": 1, "refresh_token": "ref-1"})
		return
	case "/mcp":
	default:
		http.NotFound(w, r)
		return
	}
	bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !f.tokens[bearer] {
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource/mcp", scope="docs.read"`, f.base))
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	raw, _ := io.ReadAll(r.Body)
	var message struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params map[string]any  `json:"params"`
	}
	_ = json.Unmarshal(raw, &message)
	if message.Method == "initialize" {
		f.next++
		id := fmt.Sprintf("s-%d", f.next)
		f.sessions[id] = true
		w.Header().Set("Mcp-Session-Id", id)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{},"resources":{},"prompts":{}},"serverInfo":{"name":"docs","version":"1"}}}`, message.ID)
		return
	}
	if !f.sessions[r.Header.Get("Mcp-Session-Id")] {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if message.Method == "notifications/initialized" {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch message.Method {
	case "tools/list":
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"search","inputSchema":{"type":"object"}}]}}`, message.ID)
	case "resources/list":
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"resources":[{"uri":"docs://orders","name":"Orders API"}]}}`, message.ID)
	case "resources/read":
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"contents":[{"uri":%q,"text":"GET /orders returns a list"}]}}`, message.ID, message.Params["uri"])
	case "prompts/list":
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"prompts":[{"name":"review","arguments":[{"name":"path"}]}]}}`, message.ID)
	case "prompts/get":
		arguments, _ := message.Params["arguments"].(map[string]any)
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"messages":[{"role":"user","content":{"type":"text","text":"Review %v"}}]}}`, message.ID, arguments["path"])
	default:
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found"}}`, message.ID)
	}
}

func TestAgentMcpOAuthSignInRefreshAndResources(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)
	server, fake := newOAuthMCPFake(t)
	previous := agentMcpOpenBrowser
	agentMcpOpenBrowser = func(_ *App, target string) error {
		go func() {
			resp, err := http.Get(target)
			if err == nil {
				resp.Body.Close()
			}
		}()
		return nil
	}
	t.Cleanup(func() { agentMcpOpenBrowser = previous })

	app := NewApp()
	t.Cleanup(func() { app.agentRuntime().closeMcpClients() })
	state := app.SaveAgentMcpServer(model.AgentMcpServer{Name: "Docs", Kind: agentMcpKindHTTP, URL: server.URL + "/mcp", Auth: agentMcpAuthOAuth, Enabled: true})
	if state.Error != "" || len(state.Servers) != 1 || state.Servers[0].SignedIn {
		t.Fatalf("state = %+v", state)
	}
	id := state.Servers[0].ID
	if tested := app.TestAgentMcpServer(state.Servers[0]); tested.OK || !strings.Contains(tested.Error, "Sign in") {
		t.Fatalf("testing before sign-in = %+v", tested)
	}

	state = app.SignInAgentMcpServer(id)
	if state.Error != "" || !state.Servers[0].SignedIn {
		t.Fatalf("sign in = %+v", state)
	}
	if fake.registers != 1 || fake.authorize.Get("resource") != server.URL+"/mcp" || fake.authorize.Get("code_challenge_method") != "S256" || fake.authorize.Get("scope") != "docs.read" {
		t.Fatalf("authorize request = %v (registers %d)", fake.authorize, fake.registers)
	}
	if len(fake.codes) != 1 || fake.codes[0].Get("code_verifier") == "" || fake.codes[0].Get("resource") != server.URL+"/mcp" {
		t.Fatalf("token request = %v", fake.codes)
	}
	raw, _ := os.ReadFile(appPreferencesPath())
	if strings.Contains(string(raw), "tok-1") || strings.Contains(string(raw), "ref-1") {
		t.Fatal("tokens are stored encrypted")
	}

	tools, defs, warnings := app.agentRuntime().externalTools(context.Background())
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v", warnings)
	}
	names := map[string]bool{}
	for _, def := range defs {
		names[def.Original] = true
	}
	for _, name := range []string{"docs__search", "docs__resources_list", "docs__resource_read", "docs__prompts_list", "docs__prompt_get"} {
		if !names[name] {
			t.Fatalf("%s missing from %v", name, names)
		}
	}
	if len(fake.refreshes) == 0 || fake.refreshes[0].Get("resource") != server.URL+"/mcp" {
		t.Fatalf("an expiring token is renewed with the resource, refreshes = %v", fake.refreshes)
	}

	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, approvals := newTestAgentBridge(t, root)
	bridge.setExternal(tools, defs)
	call := func(name, input string) (string, bool) {
		return bridge.call(context.Background(), aiTool{Name: name, Original: name, Server: "Docs", ServerIndex: -1}, input, "call-1")
	}
	if text, isError := call("docs__resource_read", `{"uri":"docs://orders"}`); isError || !strings.Contains(text, "GET /orders returns a list") {
		t.Fatalf("resource read = %q %v", text, isError)
	}
	if text, isError := call("docs__prompt_get", `{"name":"review","arguments":{"path":"orders.yml"}}`); isError || !strings.Contains(text, "Review orders.yml") {
		t.Fatalf("prompt get = %q %v", text, isError)
	}
	if text, isError := call("docs__resources_list", `{}`); isError || !strings.Contains(text, "docs://orders") {
		t.Fatalf("resources list = %q %v", text, isError)
	}
	if approvals.count() != 0 {
		t.Fatalf("reading resources and prompts needs no approval, got %d", approvals.count())
	}
	if _, isError := call("docs__search", `{}`); !isError || approvals.count() != 1 {
		t.Fatalf("tools still need approval, approvals = %d", approvals.count())
	}

	state = app.SignOutAgentMcpServer(id)
	if state.Error != "" || state.Servers[0].SignedIn {
		t.Fatalf("sign out = %+v", state)
	}
}

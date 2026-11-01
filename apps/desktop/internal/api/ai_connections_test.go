package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func readAiConnectionPreferences(t *testing.T) (string, appPreferences) {
	t.Helper()
	data, err := os.ReadFile(appPreferencesPath())
	if err != nil {
		t.Fatalf("read preferences: %v", err)
	}
	var preferences appPreferences
	if err := json.Unmarshal(data, &preferences); err != nil {
		t.Fatalf("decode preferences: %v", err)
	}
	return string(data), preferences
}

func TestSaveAiConnectionEncryptsTheKeyAndShowsOnlyAHint(t *testing.T) {
	isolateAppData(t)
	app := NewApp()
	const key = "sk-ant-api03-supersecretvalue-XYZ"

	state := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionAnthropic, Key: key, Model: "claude-sonnet-4-5"})
	if state.Error != "" {
		t.Fatalf("save failed: %s", state.Error)
	}
	if len(state.Connections) != 1 {
		t.Fatalf("connections = %d, want 1", len(state.Connections))
	}
	got := state.Connections[0]
	if got.Label != "Anthropic" || got.BaseURL != anthropicAPIBase || got.Provider != model.AiProviderAnthropic {
		t.Fatalf("unexpected connection: %+v", got)
	}
	if !got.HasKey || !got.Default || got.KeyHint != "sk-ant-…XYZ" {
		t.Fatalf("hint/default wrong: %+v", got)
	}
	raw, preferences := readAiConnectionPreferences(t)
	if strings.Contains(raw, "supersecret") {
		t.Fatal("preferences.json contains the plaintext key")
	}
	saved, err := savedAiConnectionKey(preferences.AiConnections[0])
	if err != nil || saved != key {
		t.Fatalf("decrypted key = %q, %v", saved, err)
	}
}

func TestSaveAiConnectionKeepsOtherPreferences(t *testing.T) {
	isolateAppData(t)
	if err := saveAppPreferences(appPreferences{DefaultWorkspaceLocation: "/tmp/kurlo-ws"}); err != nil {
		t.Fatal(err)
	}
	NewApp().SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionLocal, BaseURL: "http://127.0.0.1:11434/v1"})
	_, preferences := readAiConnectionPreferences(t)
	if preferences.DefaultWorkspaceLocation != "/tmp/kurlo-ws" {
		t.Fatalf("default workspace location lost: %+v", preferences)
	}
}

func TestSaveAiConnectionValidatesInput(t *testing.T) {
	isolateAppData(t)
	app := NewApp()
	cases := []struct {
		name  string
		input model.AiConnectionInput
		want  string
	}{
		{"cloud needs a key", model.AiConnectionInput{Kind: model.AiConnectionOpenAI}, "Enter the API key"},
		{"compatible needs a URL", model.AiConnectionInput{Kind: model.AiConnectionCompatible}, "Enter the base URL"},
		{"URL must be http", model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: "ftp://x"}, "not an http or https URL"},
		{"unknown kind", model.AiConnectionInput{Kind: "gemini", Key: "k"}, "unknown AI connection type"},
	}
	for _, tc := range cases {
		state := app.SaveAiConnection(tc.input)
		if !strings.Contains(state.Error, tc.want) {
			t.Errorf("%s: error = %q, want %q", tc.name, state.Error, tc.want)
		}
	}
	if state := app.AiConnections(); len(state.Connections) != 0 {
		t.Fatalf("invalid input was saved: %+v", state.Connections)
	}
}

func TestSaveAiConnectionNormalizesTheBaseURL(t *testing.T) {
	isolateAppData(t)
	state := NewApp().SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: "https://llm.example.com/v1/chat/completions/"})
	if state.Error != "" || state.Connections[0].BaseURL != "https://llm.example.com/v1" {
		t.Fatalf("base URL = %+v", state)
	}
}

func TestEditingAiConnectionKeepsTheKeyAndRefusesAKindChange(t *testing.T) {
	isolateAppData(t)
	app := NewApp()
	first := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionOpenAI, Key: "sk-proj-abcdefghijklmnop"})
	id := first.Connections[0].ID

	edited := app.SaveAiConnection(model.AiConnectionInput{ID: id, Kind: model.AiConnectionOpenAI, Label: "Work", Model: "gpt-5"})
	if edited.Error != "" {
		t.Fatalf("edit failed: %s", edited.Error)
	}
	got := edited.Connections[0]
	if got.Label != "Work" || got.Model != "gpt-5" || !got.HasKey || got.KeyHint != first.Connections[0].KeyHint {
		t.Fatalf("edit lost data: %+v", got)
	}
	if state := app.SaveAiConnection(model.AiConnectionInput{ID: id, Kind: model.AiConnectionAnthropic}); !strings.Contains(state.Error, "cannot change") {
		t.Fatalf("kind change error = %q", state.Error)
	}
	if state := app.SaveAiConnection(model.AiConnectionInput{ID: "missing", Kind: model.AiConnectionOpenAI}); !strings.Contains(state.Error, "no longer exists") {
		t.Fatalf("missing id error = %q", state.Error)
	}
}

func TestRemovingTheDefaultAiConnectionPromotesTheNextOne(t *testing.T) {
	isolateAppData(t)
	app := NewApp()
	app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionOpenAI, Key: "sk-one-1234567890"})
	state := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionLocal, BaseURL: "http://127.0.0.1:1234/v1"})
	first, second := state.Connections[0], state.Connections[1]
	if !first.Default || second.Default {
		t.Fatalf("first connection should be the default: %+v", state.Connections)
	}

	state = app.SetDefaultAiConnection(second.ID)
	if state.Connections[0].Default || !state.Connections[1].Default {
		t.Fatalf("default did not move: %+v", state.Connections)
	}
	state = app.RemoveAiConnection(second.ID)
	if len(state.Connections) != 1 || state.Connections[0].ID != first.ID || !state.Connections[0].Default {
		t.Fatalf("after removal: %+v", state.Connections)
	}
	if state := app.SetDefaultAiConnection("missing"); !strings.Contains(state.Error, "no longer exists") {
		t.Fatalf("missing default error = %q", state.Error)
	}
}

func TestAiConnectionKeyHint(t *testing.T) {
	cases := map[string]string{
		"sk-ant-api03-abcdefghijklmnop": "sk-ant-…nop",
		"sk-or-v1-0123456789abcdef":     "sk-or-v1-…def",
		"sk-proj-0123456789abcdef":      "sk-proj-…def",
		"abcdefghijklmnopqrstuvwxyz":    "abcdef…xyz",
		"short":                         "…rt",
		"":                              "",
	}
	for key, want := range cases {
		if got := aiConnectionKeyHint(key); got != want {
			t.Errorf("hint(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestTestAiConnectionListsAnthropicModelsWithItsHeaders(t *testing.T) {
	isolateAppData(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("x-api-key") != "sk-ant-good" || r.Header.Get("anthropic-version") == "" || r.Header.Get("Authorization") != "" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"claude-3-haiku-old","display_name":"Old"},{"id":"claude-sonnet-4-5","display_name":"Claude Sonnet 4.5"}]}`))
	}))
	defer server.Close()
	app := NewApp()

	result := app.TestAiConnection(model.AiConnectionInput{Kind: model.AiConnectionAnthropic, BaseURL: server.URL + "/v1", Key: "sk-ant-good"})
	if !result.OK || len(result.Models) != 2 {
		t.Fatalf("result = %+v", result)
	}
	if result.Models[0].ID != "claude-sonnet-4-5" || !result.Models[0].Recommended || result.Models[0].Name != "Claude Sonnet 4.5" {
		t.Fatalf("recommended model should come first: %+v", result.Models)
	}

	bad := app.TestAiConnection(model.AiConnectionInput{Kind: model.AiConnectionAnthropic, BaseURL: server.URL + "/v1", Key: "sk-ant-bad"})
	if bad.OK || !strings.Contains(bad.Error, "not accepted") || !strings.Contains(bad.Error, "invalid x-api-key") {
		t.Fatalf("bad key result = %+v", bad)
	}
}

func TestTestAiConnectionUsesTheSavedKey(t *testing.T) {
	isolateAppData(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-saved-1234567890" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-5"}]}`))
	}))
	defer server.Close()
	app := NewApp()
	state := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionOpenAI, BaseURL: server.URL, Key: "sk-saved-1234567890"})

	result := app.TestAiConnection(model.AiConnectionInput{ID: state.Connections[0].ID})
	if !result.OK || result.Models[0].ID != "gpt-5" {
		t.Fatalf("result = %+v", result)
	}
}

func TestTestAiConnectionChecksTheOpenRouterKeyAndMarksModelsWithoutTools(t *testing.T) {
	isolateAppData(t)
	var sawKeyCheck bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("HTTP-Referer") == "" || r.Header.Get("X-Title") != "Kurlo" {
			t.Errorf("missing attribution headers on %s", r.URL.Path)
		}
		switch r.URL.Path {
		case "/api/v1/key":
			sawKeyCheck = true
			if r.Header.Get("Authorization") != "Bearer sk-or-v1-good" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"error":{"code":401,"message":"No auth credentials found"}}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":{"label":"kurlo"}}`))
		case "/api/v1/models":
			_, _ = w.Write([]byte(`{"data":[{"id":"meta/tiny","name":"Tiny","supported_parameters":["temperature"]},{"id":"anthropic/claude-sonnet-4.5","name":"Claude Sonnet","supported_parameters":["tools","temperature"]},{"id":"mistral/medium","name":"Medium","supported_parameters":["tools"]}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	app := NewApp()

	result := app.TestAiConnection(model.AiConnectionInput{Kind: model.AiConnectionOpenRouter, BaseURL: server.URL + "/api/v1", Key: "sk-or-v1-good"})
	if !sawKeyCheck || !result.OK {
		t.Fatalf("result = %+v, key check = %v", result, sawKeyCheck)
	}
	ids := []string{result.Models[0].ID, result.Models[1].ID, result.Models[2].ID}
	if strings.Join(ids, ",") != "anthropic/claude-sonnet-4.5,mistral/medium,meta/tiny" {
		t.Fatalf("model order = %v", ids)
	}
	if !result.Models[2].WeakTools || result.Models[1].WeakTools {
		t.Fatalf("weak tools flags wrong: %+v", result.Models)
	}

	bad := app.TestAiConnection(model.AiConnectionInput{Kind: model.AiConnectionOpenRouter, BaseURL: server.URL + "/api/v1", Key: "sk-or-v1-bad"})
	if bad.OK || !strings.Contains(bad.Error, "not accepted") {
		t.Fatalf("bad key result = %+v", bad)
	}
}

func TestTestAiConnectionExplainsAMissingModelList(t *testing.T) {
	isolateAppData(t)
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	result := NewApp().TestAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: server.URL})
	if result.OK || !strings.Contains(result.Error, "no model list") {
		t.Fatalf("result = %+v", result)
	}
}

func useLocalCandidates(t *testing.T, candidates []aiLocalCandidate) {
	t.Helper()
	previous := aiLocalCandidates
	aiLocalCandidates = candidates
	t.Cleanup(func() { aiLocalCandidates = previous })
}

func TestDiscoverLocalAiServersFindsOllamaAndItsToolModels(t *testing.T) {
	ollama := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			_, _ = w.Write([]byte(`{"data":[{"id":"llama3.2:3b"},{"id":"qwen3-coder:30b"}]}`))
		case "/api/show":
			var body struct {
				Model string `json:"model"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Model == "qwen3-coder:30b" {
				_, _ = w.Write([]byte(`{"capabilities":["completion","tools"]}`))
				return
			}
			_, _ = w.Write([]byte(`{"capabilities":["completion"]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ollama.Close()
	useLocalCandidates(t, []aiLocalCandidate{
		{name: aiLocalOllamaName, root: ollama.URL, ollama: true},
		{name: aiLocalLMStudioName, root: "http://127.0.0.1:1"},
	})

	discovery := NewApp().DiscoverLocalAiServers()
	if len(discovery.Servers) != 1 {
		t.Fatalf("servers = %+v", discovery.Servers)
	}
	server := discovery.Servers[0]
	if server.Name != aiLocalOllamaName || server.BaseURL != ollama.URL+"/v1" {
		t.Fatalf("server = %+v", server)
	}
	if server.Models[0].ID != "qwen3-coder:30b" || server.Models[0].WeakTools || !server.Models[1].WeakTools {
		t.Fatalf("models = %+v", server.Models)
	}
}

type fakeOpenRouter struct {
	server     *httptest.Server
	opened     chan string
	challenge  string
	state      string
	bridgeUp   bool
	bridgeHits int
}

func startFakeOpenRouter(t *testing.T, bridgeUp bool) *fakeOpenRouter {
	t.Helper()
	isolateAppData(t)
	fake := &fakeOpenRouter{opened: make(chan string, 4), bridgeUp: bridgeUp}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/connect/openrouter/" {
			fake.bridgeHits++
			if !fake.bridgeUp {
				http.NotFound(w, r)
			}
			return
		}
		if r.URL.Path != "/api/v1/auth/keys" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		sum := sha256.Sum256([]byte(body["code_verifier"]))
		if body["code"] != "good-code" || base64.RawURLEncoding.EncodeToString(sum[:]) != fake.challenge || body["code_challenge_method"] != "S256" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":{"message":"Invalid code or code_verifier"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"key":"sk-or-v1-fromoauth-0123456789"}`))
	}))
	previousAuth, previousKeys, previousBridge, previousOpen, previousTimeout := openRouterAuthURL, openRouterKeysURL, openRouterBridgeURL, openRouterOpenBrowser, openRouterConnectTimeout
	openRouterAuthURL = fake.server.URL + "/auth"
	openRouterKeysURL = fake.server.URL + "/api/v1/auth/keys"
	openRouterBridgeURL = fake.server.URL + "/connect/openrouter/"
	openRouterOpenBrowser = func(_ *App, target string) error {
		fake.opened <- target
		return nil
	}
	t.Cleanup(func() {
		openRouterConnect.cancelConnect(nil)
		openRouterAuthURL, openRouterKeysURL, openRouterBridgeURL, openRouterOpenBrowser, openRouterConnectTimeout = previousAuth, previousKeys, previousBridge, previousOpen, previousTimeout
		fake.server.Close()
	})
	return fake
}

func (f *fakeOpenRouter) authorize(t *testing.T, state model.OpenRouterConnectState) *url.URL {
	t.Helper()
	opened := <-f.opened
	if opened != state.AuthURL {
		t.Fatalf("opened %q, state has %q", opened, state.AuthURL)
	}
	parsed, err := url.Parse(opened)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if query.Get("code_challenge_method") != "S256" || query.Get("key_label") != "Kurlo" {
		t.Fatalf("auth URL without S256 or key label: %s", opened)
	}
	f.challenge = query.Get("code_challenge")
	f.state = query.Get("state")
	port, _, ok := strings.Cut(f.state, ".")
	if !ok || port == "" {
		t.Fatalf("state %q does not carry the port", f.state)
	}
	if f.bridgeUp {
		if query.Get("callback_url") != openRouterBridgeURL {
			t.Fatalf("callback_url = %q, want the bridge", query.Get("callback_url"))
		}
	} else {
		callback, err := url.Parse(query.Get("callback_url"))
		if err != nil || callback.Hostname() != "localhost" || callback.Path != "/callback" || callback.Port() != port {
			t.Fatalf("callback_url = %q", query.Get("callback_url"))
		}
	}
	return &url.URL{Scheme: "http", Host: "127.0.0.1:" + port, Path: "/callback"}
}

func getCallback(t *testing.T, callback *url.URL, code, state string) (int, string) {
	t.Helper()
	target := *callback
	target.RawQuery = url.Values{"code": {code}, "state": {state}}.Encode()
	resp, err := http.Get(target.String())
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func TestOpenRouterConnectExchangesTheCodeAndSavesTheKey(t *testing.T) {
	fake := startFakeOpenRouter(t, false)
	app := NewApp()

	state := app.StartOpenRouterConnect()
	if state.Status != model.OpenRouterConnectWaiting || state.AuthURL == "" {
		t.Fatalf("start state = %+v", state)
	}
	callback := fake.authorize(t, state)
	status, page := getCallback(t, callback, "good-code", fake.state)
	if status != http.StatusOK || !strings.Contains(page, "connected to OpenRouter") {
		t.Fatalf("callback page %d: %s", status, page)
	}

	final := app.OpenRouterConnectStatus()
	if final.Status != model.OpenRouterConnectConnected || final.Connection == nil || final.Connection.Kind != model.AiConnectionOpenRouter {
		t.Fatalf("final state = %+v", final)
	}
	connections := app.AiConnections().Connections
	if len(connections) != 1 || connections[0].KeyHint != "sk-or-v1-…789" || connections[0].BaseURL != openRouterAPIBase {
		t.Fatalf("connections = %+v", connections)
	}
	raw, _ := readAiConnectionPreferences(t)
	if strings.Contains(raw, "fromoauth") {
		t.Fatal("preferences.json contains the plaintext OpenRouter key")
	}
}

func TestOpenRouterConnectUsesTheKurloBridgeWhenItIsUp(t *testing.T) {
	fake := startFakeOpenRouter(t, true)
	app := NewApp()

	callback := fake.authorize(t, app.StartOpenRouterConnect())
	if fake.bridgeHits == 0 {
		t.Fatal("Kurlo did not check the bridge")
	}
	status, _ := getCallback(t, callback, "good-code", fake.state)
	if status != http.StatusOK || app.OpenRouterConnectStatus().Status != model.OpenRouterConnectConnected {
		t.Fatalf("bridge sign-in did not finish: %d %+v", status, app.OpenRouterConnectStatus())
	}
}

func TestOpenRouterConnectIgnoresACallbackWithAnotherState(t *testing.T) {
	fake := startFakeOpenRouter(t, false)
	app := NewApp()

	callback := fake.authorize(t, app.StartOpenRouterConnect())
	status, page := getCallback(t, callback, "good-code", "1234.not-this-sign-in-state")
	if status != http.StatusBadRequest || !strings.Contains(page, "not for this Kurlo window") {
		t.Fatalf("foreign state page %d: %s", status, page)
	}
	if state := app.OpenRouterConnectStatus(); state.Status != model.OpenRouterConnectWaiting {
		t.Fatalf("a foreign callback changed the state: %+v", state)
	}
	status, _ = getCallback(t, callback, "good-code", fake.state)
	if status != http.StatusOK || app.OpenRouterConnectStatus().Status != model.OpenRouterConnectConnected {
		t.Fatalf("the real callback did not finish the sign-in: %+v", app.OpenRouterConnectStatus())
	}
}

func TestOpenRouterConnectWorksAgainAfterTheConnectionIsRemoved(t *testing.T) {
	fake := startFakeOpenRouter(t, false)
	app := NewApp()

	callback := fake.authorize(t, app.StartOpenRouterConnect())
	getCallback(t, callback, "good-code", fake.state)
	id := app.AiConnections().Connections[0].ID
	if state := app.RemoveAiConnection(id); len(state.Connections) != 0 {
		t.Fatalf("remove left %+v", state.Connections)
	}

	callback = fake.authorize(t, app.StartOpenRouterConnect())
	status, _ := getCallback(t, callback, "good-code", fake.state)
	if status != http.StatusOK || app.OpenRouterConnectStatus().Status != model.OpenRouterConnectConnected {
		t.Fatalf("second sign-in did not finish: %d %+v", status, app.OpenRouterConnectStatus())
	}
	if connections := app.AiConnections().Connections; len(connections) != 1 {
		t.Fatalf("connections after the second sign-in = %+v", connections)
	}
}

func TestOpenRouterConnectReusesTheExistingConnection(t *testing.T) {
	fake := startFakeOpenRouter(t, false)
	app := NewApp()
	before := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionOpenRouter, Key: "sk-or-v1-old-0000000000", Model: "anthropic/claude-sonnet-4.5"})

	callback := fake.authorize(t, app.StartOpenRouterConnect())
	getCallback(t, callback, "good-code", fake.state)

	connections := app.AiConnections().Connections
	if len(connections) != 1 || connections[0].ID != before.Connections[0].ID {
		t.Fatalf("a second OpenRouter connection was added: %+v", connections)
	}
	if connections[0].Model != "anthropic/claude-sonnet-4.5" || connections[0].KeyHint != "sk-or-v1-…789" {
		t.Fatalf("connection was not updated in place: %+v", connections[0])
	}
}

func TestOpenRouterConnectReportsARejectedCode(t *testing.T) {
	fake := startFakeOpenRouter(t, false)
	app := NewApp()

	callback := fake.authorize(t, app.StartOpenRouterConnect())
	status, page := getCallback(t, callback, "wrong-code", fake.state)
	if status != http.StatusOK || !strings.Contains(page, "did not finish") {
		t.Fatalf("callback page %d: %s", status, page)
	}
	final := app.OpenRouterConnectStatus()
	if final.Status != model.OpenRouterConnectFailed || !strings.Contains(final.Error, "did not accept the sign-in code") {
		t.Fatalf("final state = %+v", final)
	}
	if len(app.AiConnections().Connections) != 0 {
		t.Fatal("a connection was saved after a rejected code")
	}
}

func TestOpenRouterConnectCanBeCancelledAndTimesOut(t *testing.T) {
	fake := startFakeOpenRouter(t, false)
	app := NewApp()

	fake.authorize(t, app.StartOpenRouterConnect())
	if state := app.CancelOpenRouterConnect(); state.Status != model.OpenRouterConnectCancelled {
		t.Fatalf("cancel state = %+v", state)
	}

	openRouterConnectTimeout = 50 * time.Millisecond
	fake.authorize(t, app.StartOpenRouterConnect())
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if state := app.OpenRouterConnectStatus(); state.Status == model.OpenRouterConnectFailed {
			if !strings.Contains(state.Error, "timed out") {
				t.Fatalf("timeout error = %q", state.Error)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("connect did not time out: %+v", app.OpenRouterConnectStatus())
}

func TestOpenRouterConnectCallbackRejectsAMissingCode(t *testing.T) {
	fake := startFakeOpenRouter(t, false)
	app := NewApp()
	callback := fake.authorize(t, app.StartOpenRouterConnect())
	getCallback(t, callback, "", fake.state)
	if state := app.OpenRouterConnectStatus(); state.Status != model.OpenRouterConnectFailed || !strings.Contains(state.Error, "did not return a sign-in code") {
		t.Fatalf("state = %+v", state)
	}
}

func TestKurloAiRequestNeedsAConnection(t *testing.T) {
	isolateAppData(t)
	out := NewApp().SendAiRequest(model.AiRequest{Provider: model.AiProviderKurlo, HTTP: model.HttpRequest{RequestID: "ai-k"}})
	if !strings.Contains(out.Error, "Settings → AI") {
		t.Fatalf("error = %q", out.Error)
	}
}

func TestResolveKurloAiRequestUsesTheDefaultConnection(t *testing.T) {
	isolateAppData(t)
	app := NewApp()
	app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionOpenAI, Key: "sk-other-0000000000"})
	state := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionAnthropic, Key: "sk-ant-conn-secret-123", Model: "claude-sonnet-4-5"})
	app.SetDefaultAiConnection(state.Connections[1].ID)

	req, _, err := resolveKurloAiRequest(model.AiRequest{
		Provider: model.AiProviderKurlo,
		HTTP: model.HttpRequest{Headers: []model.KeyValue{
			{Key: "Authorization", Value: "Bearer stale", Enabled: true},
			{Key: "X-Trace", Value: "1", Enabled: true},
		}, Auth: model.AuthConfig{Type: "bearer", Token: "stale"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if req.Provider != model.AiProviderAnthropic || req.HTTP.URL != anthropicAPIBase || req.Model != "claude-sonnet-4-5" || req.HTTP.Auth.Type != "none" {
		t.Fatalf("resolved = %+v", req)
	}
	headers := map[string]string{}
	for _, header := range req.HTTP.Headers {
		headers[strings.ToLower(header.Key)] = header.Value
	}
	if headers["x-api-key"] != "sk-ant-conn-secret-123" || headers["authorization"] != "" || headers["x-trace"] != "1" || headers["anthropic-version"] == "" {
		t.Fatalf("headers = %v", headers)
	}
	if len(req.HTTP.SecretEnvironmentValues) != 1 || req.HTTP.SecretEnvironmentValues[0] != "sk-ant-conn-secret-123" {
		t.Fatalf("the key is not redacted: %v", req.HTTP.SecretEnvironmentValues)
	}

	keep, _, err := resolveKurloAiRequest(model.AiRequest{Provider: model.AiProviderKurlo, Model: "claude-opus-5"})
	if err != nil || keep.Model != "claude-opus-5" {
		t.Fatalf("request model was replaced: %+v %v", keep, err)
	}
}

func TestKurloAiRequestSendsWithTheConnectionKey(t *testing.T) {
	isolateAppData(t)
	server := newAiTestServer(t, sseScript{events: []string{
		openAIChunkEvent(`{"model":"gpt-test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`),
		openAIChunkEvent(`[DONE]`),
	}})
	app := NewApp()
	app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: server.URL + "/v1", Key: "sk-compat-secret-42", Model: "gpt-test"})

	req := aiTestRequest(model.AiProviderKurlo, "")
	req.Model = ""
	req.HTTP.Auth = model.AuthConfig{Type: "none"}
	out := app.SendAiRequest(req)
	if out.Error != "" || out.Text != "ok" {
		t.Fatalf("out = %+v", out)
	}
	if got := server.headers[0].Get("Authorization"); got != "Bearer sk-compat-secret-42" {
		t.Fatalf("auth header %q", got)
	}
	if server.body(0)["model"] != "gpt-test" {
		t.Fatalf("model = %v", server.body(0)["model"])
	}
	encoded, _ := json.Marshal(out)
	if strings.Contains(string(encoded), "sk-compat-secret-42") {
		t.Fatal("the connection key reached the AI response")
	}
}

func TestSaveAiConnectionStopsAtTheLimit(t *testing.T) {
	isolateAppData(t)
	app := NewApp()
	var state model.AiConnectionsState
	for i := 0; i < aiConnectionLimit; i++ {
		state = app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionLocal, BaseURL: fmt.Sprintf("http://127.0.0.1:%d/v1", 8000+i)})
		if state.Error != "" {
			t.Fatalf("connection %d: %s", i, state.Error)
		}
	}
	state = app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionLocal, BaseURL: "http://127.0.0.1:9999/v1"})
	if !strings.Contains(state.Error, "up to 10 AI connections") || len(state.Connections) != aiConnectionLimit {
		t.Fatalf("limit not enforced: %q, %d connections", state.Error, len(state.Connections))
	}
	edited := app.SaveAiConnection(model.AiConnectionInput{ID: state.Connections[0].ID, Kind: model.AiConnectionLocal, BaseURL: "http://127.0.0.1:8000/v1", Model: "llama"})
	if edited.Error != "" {
		t.Fatalf("editing at the limit failed: %s", edited.Error)
	}
}

func TestTestAiConnectionHidesTheKeyInProviderErrors(t *testing.T) {
	isolateAppData(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"type":"invalid_request_error","message":"Incorrect API key provided: ` + key + `."}}`))
	}))
	defer server.Close()
	result := NewApp().TestAiConnection(model.AiConnectionInput{Kind: model.AiConnectionOpenAI, BaseURL: server.URL, Key: "fdsfsd-typo"})
	if result.OK || strings.Contains(result.Error, "fdsfsd-typo") || !strings.Contains(result.Error, "[your key]") {
		t.Fatalf("error = %q", result.Error)
	}
}

func TestKurloAiRequestHidesTheKeyInProviderErrors(t *testing.T) {
	isolateAppData(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"Incorrect API key provided: ` + key + `"}}`))
	}))
	defer server.Close()
	app := NewApp()
	app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: server.URL + "/v1", Key: "sk-leaky-secret-77", Model: "m"})

	req := aiTestRequest(model.AiProviderKurlo, "")
	req.Settings.Stream = false
	out := app.SendAiRequest(req)
	encoded, _ := json.Marshal(out)
	if out.Error == "" || strings.Contains(string(encoded), "sk-leaky-secret-77") || !strings.Contains(string(encoded), "[your key]") {
		t.Fatalf("out = %s", encoded)
	}
}

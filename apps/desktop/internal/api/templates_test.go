package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestResolveTemplateValueSupportsNestedAndPostmanStyleNames(t *testing.T) {
	values := map[string]string{
		"base":    "{{host}}/api",
		"host":    "http://h",
		"токен":   "ru",
		"my var":  "spaced",
		"api:key": "colon",
		"plain":   "ok",
	}
	cases := map[string]string{
		"{{base}}/users":            "http://h/api/users",
		"{{токен}}":                 "ru",
		"{{my var}}":                "spaced",
		"{{api:key}}":               "colon",
		"{{ plain }}":               "ok",
		"{{missing}}":               "{{missing}}",
		"{{}}":                      "{{}}",
		`{"a":{"b":1}} {{plain}}`:   `{"a":{"b":1}} ok`,
		"{{host}}{{base}}":          "http://hhttp://h/api",
		"prefix-{{api:key}}-suffix": "prefix-colon-suffix",
	}
	for input, want := range cases {
		if got := resolveTemplateValue(input, values); got != want {
			t.Errorf("resolveTemplateValue(%q) = %q, want %q", input, got, want)
		}
	}
	if got := resolveTemplateValue("{{$guid}}", nil); !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(got) {
		t.Errorf("expected $guid to resolve to a UUID, got %q", got)
	}
}

func TestResolveTemplateValueStopsOnSelfReference(t *testing.T) {
	got := resolveTemplateValue("{{a}}", map[string]string{"a": "x{{a}}"})
	if !strings.HasPrefix(got, "xxxx") || !strings.HasSuffix(got, "{{a}}") {
		t.Fatalf("expected bounded expansion, got %q", got)
	}
}

func TestResolveTemplateURLEscapesQuerySubstitutionsAndPreservesRawParts(t *testing.T) {
	got := resolveTemplateURL("https://{{host}}/items?x={{value}}&raw=a%2Fb&flag#{{fragment}}", map[string]string{
		"host":     "api.example.test",
		"value":    "a&b=c +d",
		"fragment": "done",
	})
	want := "https://api.example.test/items?x=a%26b%3Dc+%2Bd&raw=a%2Fb&flag#done"
	if got != want {
		t.Fatalf("resolved URL = %q, want %q", got, want)
	}
}

func TestResolveTemplateURLKeepsHashInsideSecretTemplate(t *testing.T) {
	got := resolveTemplateURL("https://api.example.test/search?token={{secret:vault:app#token}}&keep=a%2fb#section", map[string]string{
		"secret:vault:app#token": "a&b+",
	})
	want := "https://api.example.test/search?token=a%26b%2B&keep=a%2fb#section"
	if got != want {
		t.Fatalf("resolved URL = %q, want %q", got, want)
	}
}

func TestCLIRequestMirroredParamsAreFilteredByOccurrence(t *testing.T) {
	saved := cliSavedRequest{
		Method: "GET",
		URL:    "https://example.test/search?tag=a&tag=a&space=a%20b&encoded=%2F&debug",
		Params: []cliKV{
			{Key: "tag", Value: "a", Enabled: true},
			{Key: "tag", Value: "a", Enabled: true},
			{Key: "space", Value: "a b", Enabled: true},
			{Key: "encoded", Value: "/", Enabled: true},
			{Key: "debug", Value: "", Enabled: true},
			{Key: "tag", Value: "extra", Enabled: true},
		},
	}
	built := buildHTTPRequest(saved, nil, nil, 0)
	if len(built.Params) != 1 || built.Params[0].Key != "tag" || built.Params[0].Value != "extra" {
		t.Fatalf("expected only the true additional parameter, got %#v", built.Params)
	}
}

func TestCLIKeepsDelimitersInsideQueryTemplateNames(t *testing.T) {
	saved := cliSavedRequest{
		URL:    "https://example.test/items?{{a=b}}={{a&b}}",
		Params: []cliKV{{Key: "{{a=b}}", Value: "{{a&b}}", Enabled: true}},
	}
	built := buildHTTPRequest(saved, nil, nil, 0)
	if len(built.Params) != 0 {
		t.Fatalf("unexpected extra params: %#v", built.Params)
	}
	got := resolveTemplateURL(built.URL, map[string]string{"a=b": "filter", "a&b": "a+b"})
	if got != "https://example.test/items?filter=a%2Bb" {
		t.Fatalf("unexpected resolved URL: %s", got)
	}
}

func TestCLIRequestMirrorFilteringKeepsExcessDuplicateRows(t *testing.T) {
	saved := cliSavedRequest{
		URL:    "https://example.test/search?tag=red",
		Params: []cliKV{{Key: "tag", Value: "red", Enabled: true}, {Key: "tag", Value: "red", Enabled: true}},
	}
	built := buildHTTPRequest(saved, nil, nil, 0)
	if len(built.Params) != 1 || built.Params[0].Key != "tag" || built.Params[0].Value != "red" {
		t.Fatalf("one raw occurrence must suppress only one row, got %#v", built.Params)
	}
}

func TestPreRequestParamMutationUpdatesRawQuery(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)
	req := traceTestRequest(server.URL + "/search?x=old&keep=a%20b&x=duplicate&flag")
	req.Params = []model.KeyValue{{Key: "x", Value: "first", Enabled: true}, {Key: "x", Value: "old", Enabled: true}}
	req.PreRequestScript = `if (pm.request.params.get("x") !== "old") throw new Error("last duplicate parameter value was not available"); pm.request.params.set("x", "a&b");`
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected request error: %s", resp.Error)
	}
	captured.mu.Lock()
	got := captured.query
	captured.mu.Unlock()
	want := "x=a%26b&keep=a%20b&flag"
	if got != want {
		t.Fatalf("query = %q, want %q", got, want)
	}
}

func TestPreRequestParamRemovalUpdatesRawQuery(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)
	req := traceTestRequest(server.URL + "/search?remove=first&keep=a%20b&remove=second")
	req.PreRequestScript = `pm.request.params.unset("remove");`
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected request error: %s", resp.Error)
	}
	captured.mu.Lock()
	got := captured.query
	captured.mu.Unlock()
	if got != "keep=a%20b" {
		t.Fatalf("query = %q, want %q", got, "keep=a%20b")
	}
}

func TestDeferredTemplateQueryValueIsEscapedOnLoopbackRequest(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)
	req := templatedRequest(map[string]string{"base": server.URL, "value": "a&b=c +d"})
	req.URL = "{{base}}/search?x={{value}}&raw=a%2Fb&flag"
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected request error: %s", resp.Error)
	}
	captured.mu.Lock()
	got := captured.query
	captured.mu.Unlock()
	want := "x=a%26b%3Dc+%2Bd&raw=a%2Fb&flag"
	if got != want {
		t.Fatalf("query = %q, want %q", got, want)
	}
}

func TestCLIResultURLMatchesSentRequest(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)
	result, resp := executeCLIRequest(t.Context(), state.New(), newCookieJarRegistry(), newPreflightCache(), newOAuth2TokenCache(), cliSavedRequest{
		Name:   "search",
		Method: "GET",
		URL:    server.URL + "/search?raw=a%20b",
		Params: []cliKV{{Key: "extra", Value: "a&b", Enabled: true}},
	}, 1, nil, cliOptions{}, nil)
	if resp.Error != "" {
		t.Fatalf("unexpected request error: %s", resp.Error)
	}
	if len(resp.SentRequests) == 0 {
		t.Fatal("expected the outbound request to be recorded")
	}
	if result.URL != resp.SentRequests[0].URL {
		t.Fatalf("reported URL = %q, sent URL = %q", result.URL, resp.SentRequests[0].URL)
	}
	if !strings.Contains(result.URL, "raw=a%20b&extra=a%26b") {
		t.Fatalf("reported URL does not show the actual outgoing query: %q", result.URL)
	}
}

type capturedRequest struct {
	mu     sync.Mutex
	header http.Header
	query  string
	body   string
}

func (c *capturedRequest) server(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		c.mu.Lock()
		c.header = r.Header.Clone()
		c.query = r.URL.RawQuery
		c.body = string(body)
		c.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	return server
}

func templatedRequest(values map[string]string) model.HttpRequest {
	req := traceTestRequest("{{base}}/items")
	req.ResolveTemplates = true
	req.TemplateValues = values

	return req
}

func TestPreRequestVariablesReachTheSameRequest(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)

	req := templatedRequest(map[string]string{"base": server.URL, "token": "stale"})
	req.Method = http.MethodPost
	req.Params = []model.KeyValue{{Key: "n", Value: "{{n}}", Enabled: true}}
	req.Headers = []model.KeyValue{{Key: "X-Nonce", Value: "{{nonce}}", Enabled: true}}
	req.Auth = model.AuthConfig{Type: "bearer", Token: "{{token}}"}
	req.BodyType = "json"
	req.Body = `{"n":"{{n}}"}`
	req.PreRequestScript = `
pm.environment.set("token", "fresh");
pm.collectionVariables.set("n", "7");
pm.globals.set("nonce", "abc");
`
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if got := captured.header.Get("Authorization"); got != "Bearer fresh" {
		t.Fatalf("expected the token written by the pre-request script, got %q", got)
	}
	if got := captured.header.Get("X-Nonce"); got != "abc" {
		t.Fatalf("expected the global written by the script, got %q", got)
	}
	if captured.query != "n=7" || captured.body != `{"n":"7"}` {
		t.Fatalf("expected the collection variable in query and body, got query=%q body=%q", captured.query, captured.body)
	}
	if resp.CollectionVariableUpdates["n"] != "7" {
		t.Fatalf("expected the collection variable update to be reported, got %v", resp.CollectionVariableUpdates)
	}
}

func TestPreRequestScriptSeesResolvedValuesAndKeepsItsEdits(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)

	req := templatedRequest(map[string]string{"base": server.URL, "token": "stale"})
	req.Headers = []model.KeyValue{{Key: "X-Token", Value: "{{token}}", Enabled: true}}
	req.PreRequestScript = `
pm.request.headers.set("X-Seen", pm.request.headers.get("X-Token") + "|" + pm.request.url);
pm.request.headers.set("X-Manual", "kept");
pm.environment.set("token", "fresh");
`
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if got := captured.header.Get("X-Seen"); got != "stale|"+server.URL+"/items" {
		t.Fatalf("expected the script to read the resolved request, got %q", got)
	}
	if got := captured.header.Get("X-Manual"); got != "kept" {
		t.Fatalf("expected the script's header edit to survive re-resolution, got %q", got)
	}
	if got := captured.header.Get("X-Token"); got != "fresh" {
		t.Fatalf("expected the header to pick up the new value, got %q", got)
	}
}

func TestPreRequestScriptURLEditWinsOverReResolution(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { path = r.URL.Path }))
	defer server.Close()

	req := templatedRequest(map[string]string{"base": server.URL})
	req.PreRequestScript = `pm.environment.set("unused", "1"); pm.request.setUrl("` + server.URL + `/scripted");`
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if path != "/scripted" {
		t.Fatalf("expected the URL set by the script, got %q", path)
	}
}

func TestPreRequestGlobalDoesNotOverrideEnvironmentValue(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)

	sm := state.New()
	sm.SetEnvironment(map[string]string{"region": "env"})
	req := templatedRequest(map[string]string{"base": server.URL, "region": "env"})
	req.Headers = []model.KeyValue{{Key: "X-Region", Value: "{{region}}", Enabled: true}}
	req.PreRequestScript = `pm.globals.set("region", "global");`
	resp := sendRequest(t.Context(), req, sm, newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if got := captured.header.Get("X-Region"); got != "env" {
		t.Fatalf("expected the environment to outrank globals, got %q", got)
	}
}

func TestPreRequestUnsetFallsBackToLowerScope(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)

	sm := state.New()
	sm.SetEnvironment(map[string]string{"region": "env"})
	req := templatedRequest(map[string]string{"base": server.URL, "region": "env"})
	req.CollectionVariables = map[string]string{"region": "collection"}
	req.Headers = []model.KeyValue{{Key: "X-Region", Value: "{{region}}", Enabled: true}}
	req.PreRequestScript = `pm.environment.unset("region");`
	sendRequest(t.Context(), req, sm, newCookieJarRegistry(), newPreflightCache())
	if got := captured.header.Get("X-Region"); got != "collection" {
		t.Fatalf("expected the collection value once the environment value is gone, got %q", got)
	}
}

func TestSecretWrittenByPreRequestIsRedacted(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)

	req := templatedRequest(map[string]string{"base": server.URL, "token": "old"})
	req.SecretEnvironmentKeys = []string{"token"}
	req.SecretEnvironmentValues = []string{"old"}
	req.Headers = []model.KeyValue{{Key: "Authorization", Value: "Bearer {{token}}", Enabled: true}}
	req.PreRequestScript = `pm.environment.set("token", "brand-new-secret"); pm.log("token is " + pm.environment.get("token"));`
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if got := captured.header.Get("Authorization"); got != "Bearer brand-new-secret" {
		t.Fatalf("expected the new secret on the wire, got %q", got)
	}
	if got := headerValue(resp.SentRequests[0].Headers, "Authorization"); strings.Contains(got, "brand-new-secret") {
		t.Fatalf("new secret leaked into the trace: %q", got)
	}
	for _, line := range resp.PreRequestResult.Logs {
		if strings.Contains(line, "brand-new-secret") {
			t.Fatalf("new secret leaked into script logs: %q", line)
		}
	}
}

func TestTemplatedRequestWithoutScriptResolvesOnce(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)

	req := templatedRequest(map[string]string{"base": server.URL, "id": "9"})
	req.Params = []model.KeyValue{{Key: "{{missing}}", Value: "x", Enabled: true}, {Key: "id", Value: "{{id}}", Enabled: true}}
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if captured.query != "%7B%7Bmissing%7D%7D=x&id=9" {
		t.Fatalf("unexpected query %q", captured.query)
	}
}

func TestTemplatedEmptyRawBodyIsNotSent(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)

	req := templatedRequest(map[string]string{"base": server.URL, "payload": "  "})
	req.Method = http.MethodPost
	req.BodyType = "json"
	req.Body = "{{payload}}"
	sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if captured.body != "" || captured.header.Get("Content-Type") != "" {
		t.Fatalf("expected no body, got body=%q content-type=%q", captured.body, captured.header.Get("Content-Type"))
	}
}

func TestTemplatedGraphQLBodyEscapesValuesInsideTheQuery(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)

	req := templatedRequest(map[string]string{"base": server.URL, "q": `a"b<c`, "id": "42"})
	req.Method = http.MethodPost
	req.BodyType = "graphql"
	req.GraphQL = &model.GraphQLPayload{
		Query:     `query($id: ID!) { user(id: $id) { name(filter: "{{q}}") } }`,
		Variables: `{ "id": "{{id}}", "z": 1, "a": 2 }`,
	}
	req.PreRequestScript = `pm.environment.set("id", "43");`
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if captured.header.Get("Content-Type") != "application/json" {
		t.Fatalf("unexpected content type %q", captured.header.Get("Content-Type"))
	}
	want := `{"query":"query($id: ID!) { user(id: $id) { name(filter: \"a\"b<c\") } }","variables":{"id":"43","z":1,"a":2}}`
	if captured.body != want {
		t.Fatalf("unexpected body\n got: %s\nwant: %s", captured.body, want)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(captured.body), &decoded); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
}

func TestTemplatedGraphQLRejectsBadInput(t *testing.T) {
	for name, payload := range map[string]model.GraphQLPayload{
		"empty query":     {Query: "  ", Variables: "{}"},
		"array variables": {Query: "{ a }", Variables: "[1]"},
		"null variables":  {Query: "{ a }", Variables: "null"},
		"broken JSON":     {Query: "{ a }", Variables: `{"a":`},
	} {
		req := templatedRequest(map[string]string{"base": "http://127.0.0.1:1"})
		req.Method = http.MethodPost
		req.BodyType = "graphql"
		req.GraphQL = &payload
		resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
		if !strings.Contains(resp.Error, "GraphQL") {
			t.Errorf("%s: expected a GraphQL error, got %q", name, resp.Error)
		}
	}
}

func TestCLIRequestResolvesNestedVariablesAfterPreRequest(t *testing.T) {
	captured := &capturedRequest{}
	server := captured.server(t)

	saved := cliSavedRequest{
		Name: "r", RequestType: "http", Method: "GET",
		URL:                "{{base}}/items",
		Headers:            []cliKV{{Key: "X-Token", Value: "{{token}}", Enabled: true}},
		PreRequestScriptJs: `pm.environment.set("token", "fresh");`,
		Settings:           cliSettings{TimeoutMs: intPointer(5000)},
	}
	values := map[string]string{"base": "{{host}}", "host": server.URL, "token": "stale"}
	built := buildHTTPRequest(saved, values, nil, 0)
	built.EnableSSLVerification = true
	resp := sendRequest(t.Context(), built, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if got := captured.header.Get("X-Token"); got != "fresh" {
		t.Fatalf("expected the pre-request value, got %q", got)
	}
}

package api

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseCLIArgsLeadingWorkspaceAndFlags(t *testing.T) {
	opts, err := parseCLIArgs([]string{"./ws", "--env", "Local", "--reporter", "json", "--var", "a=1", "--var", "b=2"}, &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if opts.workspace != "./ws" {
		t.Fatalf("workspace = %q", opts.workspace)
	}
	if opts.env != "Local" || len(opts.reporters) != 1 || opts.reporters[0] != "json" {
		t.Fatalf("env=%q reporters=%v", opts.env, opts.reporters)
	}
	if opts.vars["a"] != "1" || opts.vars["b"] != "2" {
		t.Fatalf("vars = %v", opts.vars)
	}
}

func TestParseCLIArgsRejectsBadReporterAndVar(t *testing.T) {
	if _, err := parseCLIArgs([]string{"--reporter", "yaml"}, &bytes.Buffer{}, &bytes.Buffer{}); err == nil {
		t.Fatal("expected an error for an unknown reporter")
	}
	if _, err := parseCLIArgs([]string{"--var", "noequals"}, &bytes.Buffer{}, &bytes.Buffer{}); err == nil {
		t.Fatal("expected an error for a malformed --var")
	}
}

func TestFolderPrefixMatches(t *testing.T) {
	cases := []struct {
		path, prefix []string
		want         bool
	}{
		{[]string{"Auth", "Login"}, nil, true},
		{[]string{"Auth", "Login"}, []string{"Auth"}, true},
		{[]string{"Auth", "Login"}, []string{"auth"}, true},
		{[]string{"Auth", "Login"}, []string{"Auth", "Login"}, true},
		{[]string{"Auth"}, []string{"Auth", "Login"}, false},
		{[]string{"Billing"}, []string{"Auth"}, false},
	}
	for _, tc := range cases {
		if got := folderPrefixMatches(tc.path, tc.prefix); got != tc.want {
			t.Errorf("folderPrefixMatches(%v, %v) = %v, want %v", tc.path, tc.prefix, got, tc.want)
		}
	}
}

func TestSelectCLIRequestsFiltersRealtimeDraftsAndCollection(t *testing.T) {
	requests := []cliSavedRequest{
		{Name: "http", RequestType: "http", Collection: "Smoke"},
		{Name: "graphql", RequestType: "graphql", Collection: "Smoke"},
		{Name: "ws", RequestType: "ws", Collection: "Smoke"},
		{Name: "grpc", RequestType: "grpc", Collection: "Smoke"},
		{Name: "sse", RequestType: "http", Method: "SSE", Collection: "Smoke"},
		{Name: "mcp", RequestType: "mcp", Collection: "Smoke"},
		{Name: "ai", RequestType: "ai", Collection: "Smoke"},
		{Name: "draft", RequestType: "http", Collection: "Smoke", IsDraft: true},
		{Name: "other", RequestType: "http", Collection: "Other"},
	}
	selected := selectCLIRequests(requests, cliOptions{collection: "Smoke"})
	var names []string
	for _, r := range selected {
		names = append(names, r.Name)
	}
	if strings.Join(names, ",") != "http,graphql" {
		t.Fatalf("expected only runnable Smoke requests, got %v", names)
	}
}

func TestResolveCLIValuesPrecedence(t *testing.T) {
	collections := []cliCollection{{Name: "C"}}
	collections[0].Defaults.Variables = []cliKV{
		{Enabled: true, Key: "base", Value: "collection"},
		{Enabled: true, Key: "shared", Value: "from-collection"},
	}
	environments := []cliEnvironment{{Name: "Local", Values: []cliKV{
		{Enabled: true, Key: "shared", Value: "from-env"},
		{Enabled: true, Key: "token", Value: "s3cret", Secret: true},
	}}}

	opts := cliOptions{env: "Local", vars: map[string]string{"shared": "from-flag"}}
	values, secrets, err := resolveCLIValues(opts, collections, environments, nil)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if values["base"] != "collection" {
		t.Errorf("base = %q", values["base"])
	}
	if values["shared"] != "from-flag" {
		t.Errorf("expected --var to win, got %q", values["shared"])
	}
	if values["token"] != "s3cret" {
		t.Errorf("token = %q", values["token"])
	}
	if len(secrets) != 1 || secrets[0] != "s3cret" {
		t.Errorf("expected the secret value to be collected, got %v", secrets)
	}
}

func TestResolveCLIValuesUnknownEnvironment(t *testing.T) {
	_, _, err := resolveCLIValues(cliOptions{env: "Ghost"}, nil, []cliEnvironment{{Name: "Local"}}, nil)
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected an unknown-environment error, got %v", err)
	}
}

func TestBuildHTTPRequestResolvesVariablesAndScripts(t *testing.T) {
	req := cliSavedRequest{
		Name: "r", RequestType: "http", Method: "get",
		URL:              "{{base}}/users/{{id}}",
		TestScriptJs:     `pm.test("ok", () => true)`,
		PreRequestScript: "legacy",
		Settings:         cliSettings{TimeoutMs: intPointer(1000)},
	}
	built := buildHTTPRequest(req, map[string]string{"base": "https://api.test", "id": "42"}, nil, 0)
	if !built.ResolveTemplates || built.URL != "{{base}}/users/{{id}}" {
		t.Fatalf("expected the request to carry its templates to the executor, got resolve=%v url=%q", built.ResolveTemplates, built.URL)
	}
	resolved, err := resolveHTTPRequestTemplates(built, built.TemplateValues)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.URL != "https://api.test/users/42" {
		t.Fatalf("url = %q", resolved.URL)
	}
	if built.Method != "GET" {
		t.Fatalf("method = %q", built.Method)
	}
	if built.ScriptEngine != "js" || built.TestScript == "" {
		t.Fatalf("expected JS engine with the JS test script, got engine=%q test=%q", built.ScriptEngine, built.TestScript)
	}
	if built.PreRequestScript != "" {
		t.Fatalf("expected the legacy pre-request script to be ignored, got %q", built.PreRequestScript)
	}
}

func TestBuildHTTPRequestTimeoutOverride(t *testing.T) {
	built := buildHTTPRequest(cliSavedRequest{Method: "GET", Settings: cliSettings{TimeoutMs: intPointer(1000)}}, nil, nil, 250)
	if built.TimeoutMs != 250 {
		t.Fatalf("expected the override to win, got %d", built.TimeoutMs)
	}
}

func writeYAMLWorkspace(t *testing.T, baseURL string) string {
	t.Helper()
	root := t.TempDir()
	mkdir := func(elems ...string) string {
		dir := filepath.Join(append([]string{root}, elems...)...)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		return dir
	}
	write := func(path, content string) {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	write(filepath.Join(root, "kurlo.yml"), "version: 1\nformat: kurlo.workspace.yaml.v1\nworkspaceOrder:\n  - ws-demo\n")
	wsDir := mkdir("workspaces", "Demo")
	write(filepath.Join(wsDir, "workspace.yml"), "version: 1\nworkspace:\n  id: ws-demo\n  name: Demo\n  filesystemName: Demo\n  collectionOrder:\n    - col-smoke\n")

	colDir := mkdir("workspaces", "Demo", "collections", "Smoke")
	write(filepath.Join(colDir, "collection.yml"), strings.Join([]string{
		"version: 1",
		"collection:",
		"  id: col-smoke",
		"  workspaceId: ws-demo",
		"  name: Smoke",
		"  filesystemName: Smoke",
		"  requestOrder:",
		"    - req-ok",
		"    - req-fail",
		"  defaults:",
		"    variables:",
		"      - id: 1",
		"        enabled: true",
		"        key: apiVersion",
		"        value: v1",
		"    settings: {}",
		"",
	}, "\n"))

	envDir := mkdir("workspaces", "Demo", "environments")
	write(filepath.Join(envDir, "Local.yml"), strings.Join([]string{
		"version: 1",
		"environment:",
		"  id: env-local",
		"  workspaceId: ws-demo",
		"  name: Local",
		"  filesystemName: Local",
		"  values:",
		"    - id: 1",
		"      enabled: true",
		"      key: baseUrl",
		"      value: " + baseURL,
		"",
	}, "\n"))

	reqDir := mkdir("workspaces", "Demo", "collections", "Smoke", "requests")
	write(filepath.Join(reqDir, "GET-1-ok.yml"), strings.Join([]string{
		"version: 1",
		"request:",
		"  id: req-ok",
		"  name: Ok",
		"  filesystemName: GET-1-ok",
		"  requestType: http",
		"  isDraft: false",
		"  collectionId: col-smoke",
		"  collection: Smoke",
		"  folderPath: []",
		"  method: GET",
		"  url: \"{{baseUrl}}/ok?v={{apiVersion}}\"",
		"  auth:",
		"    type: none",
		"  bodyType: none",
		"  bodyContent: \"\"",
		"  testScriptJs: |",
		"    pm.test(\"status is 200\", () => pm.expect(pm.response.code).to.equal(200))",
		"    pm.environment.set(\"chained\", \"yes\")",
		"  settings: {}",
		"",
	}, "\n"))
	write(filepath.Join(reqDir, "GET-2-chain.yml"), strings.Join([]string{
		"version: 1",
		"request:",
		"  id: req-fail",
		"  name: Chain",
		"  filesystemName: GET-2-chain",
		"  requestType: http",
		"  isDraft: false",
		"  collectionId: col-smoke",
		"  collection: Smoke",
		"  folderPath: []",
		"  method: GET",
		"  url: \"{{baseUrl}}/ok?chained={{chained}}\"",
		"  auth:",
		"    type: none",
		"  bodyType: none",
		"  bodyContent: \"\"",
		"  testScriptJs: |",
		"    pm.test(\"chained value carried over\", () => pm.expect(pm.request.url).to.include(\"chained=yes\"))",
		"  settings: {}",
		"",
	}, "\n"))
	return root
}

func TestRunCLIEndToEnd(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer server.Close()

	root := writeYAMLWorkspace(t, server.URL)
	var out bytes.Buffer
	code := runCLI(cliOptions{
		workspace: root, env: "Local", reporters: []string{"json"},
		iterations: 1, stdout: &out, stderr: &out,
	})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d. output:\n%s", code, out.String())
	}

	var payload struct {
		Summary struct {
			Requests   int  `json:"requests"`
			Passed     int  `json:"passed"`
			Failed     int  `json:"failed"`
			Assertions int  `json:"assertions"`
			OK         bool `json:"ok"`
		} `json:"summary"`
	}
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatalf("parse json report: %v\n%s", err, out.String())
	}
	if payload.Summary.Requests != 2 || payload.Summary.Passed != 2 || payload.Summary.Failed != 0 {
		t.Fatalf("unexpected summary: %+v", payload.Summary)
	}
	if payload.Summary.Assertions != 2 || !payload.Summary.OK {
		t.Fatalf("expected 2 passing assertions and ok=true, got %+v", payload.Summary)
	}
}

func TestRunCLIExitsNonZeroOnServerError(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"status":"boom"}`))
	}))
	defer server.Close()

	root := writeYAMLWorkspace(t, server.URL)
	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, env: "Local", reporters: []string{"cli"}, iterations: 1, stdout: &out, stderr: &out})
	if code != 1 {
		t.Fatalf("expected exit 1 on a failing assertion, got %d. output:\n%s", code, out.String())
	}
}

func TestRunCLIMissingWorkspace(t *testing.T) {
	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: t.TempDir(), reporters: []string{"cli"}, iterations: 1, stdout: &out, stderr: &out})
	if code != 2 {
		t.Fatalf("expected exit 2 for a non-workspace directory, got %d", code)
	}
	if !strings.Contains(out.String(), "not a Kurlo YAML workspace") {
		t.Fatalf("expected a clear error, got %q", out.String())
	}
}

func TestRunCLIHandlesAHugeIterationCount(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	root := writeYAMLWorkspace(t, server.URL)
	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, env: "Local", reporters: []string{"cli"}, iterations: math.MaxInt, failFast: true, stdout: &out, stderr: &out})
	if code != 1 {
		t.Fatalf("expected the run to stop at the first failure with exit 1, got %d. output:\n%s", code, out.String())
	}
}

func TestBuildHTTPRequestCarriesOAuth1Settings(t *testing.T) {
	req := cliSavedRequest{Method: "GET", URL: "https://api.example.test", RequestType: "http"}
	req.Auth.Type = "oauth1"
	req.Auth.OAuth1ConsumerKey = "key"
	req.Auth.OAuth1ConsumerSecret = "secret"
	req.Auth.OAuth1SignatureMethod = "HMAC-SHA256"
	req.Auth.OAuth1AddTo = "query"
	req.Auth.OAuth1IncludeBodyHash = true
	built := buildHTTPRequest(req, map[string]string{}, nil, 0)
	auth := built.Auth
	if auth.Type != "oauth1" || auth.OAuth1ConsumerKey != "key" || auth.OAuth1ConsumerSecret != "secret" ||
		auth.OAuth1SignatureMethod != "HMAC-SHA256" || auth.OAuth1AddTo != "query" || !auth.OAuth1IncludeBodyHash {
		t.Fatalf("oauth1 settings were not carried over: %+v", auth)
	}
}

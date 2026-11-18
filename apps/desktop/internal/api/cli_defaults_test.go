package api

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeDefaultsWorkspace(t *testing.T, baseURL, collectionDefaults, requestBody string) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("kurlo.yml", "version: 1\nformat: kurlo.workspace.yaml.v1\nworkspaceOrder:\n  - ws\n")
	write("workspaces/Demo/workspace.yml", "version: 1\nworkspace:\n  id: ws\n  name: Demo\n  filesystemName: Demo\n  collectionOrder:\n    - col\n")
	write("workspaces/Demo/collections/Smoke/collection.yml", strings.Join([]string{
		"version: 1",
		"collection:",
		"  id: col",
		"  workspaceId: ws",
		"  name: Smoke",
		"  filesystemName: Smoke",
		"  requestOrder: [req]",
		"  defaults:",
		collectionDefaults,
		"",
	}, "\n"))
	write("workspaces/Demo/collections/Smoke/requests/GET-x.yml", strings.Join([]string{
		"version: 1",
		"request:",
		"  id: req",
		"  name: X",
		"  filesystemName: GET-x",
		"  requestType: http",
		"  isDraft: false",
		"  collectionId: col",
		"  collection: Smoke",
		"  folderPath: []",
		"  method: GET",
		"  url: " + baseURL + "/x",
		requestBody,
		"",
	}, "\n"))
	return root
}

func TestRunCLIAppliesCollectionAuthForInherit(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	var sawAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		fmt.Fprint(w, "{}")
	}))
	defer server.Close()

	root := writeDefaultsWorkspace(t, server.URL, strings.Join([]string{
		"    auth:",
		"      type: bearer",
		"      bearerToken: collection-token",
		"    settings: {}",
	}, "\n"), strings.Join([]string{
		"  auth:",
		"    type: inherit",
		"  bodyType: none",
		"  bodyContent: \"\"",
		"  settings: {}",
	}, "\n"))

	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, reporters: []string{"cli"}, iterations: 1, stdout: &out, stderr: &out})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d\n%s", code, out.String())
	}
	if sawAuth != "Bearer collection-token" {
		t.Errorf("Authorization = %q, want the collection's bearer token", sawAuth)
	}
}

func TestRunCLIInheritWithoutCollectionAuthSendsNone(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	var sawAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		fmt.Fprint(w, "{}")
	}))
	defer server.Close()

	root := writeDefaultsWorkspace(t, server.URL, "    settings: {}", strings.Join([]string{
		"  auth:",
		"    type: inherit",
		"  bodyType: none",
		"  bodyContent: \"\"",
		"  settings: {}",
	}, "\n"))

	var out bytes.Buffer
	if code := runCLI(cliOptions{workspace: root, reporters: []string{"cli"}, iterations: 1, stdout: &out, stderr: &out}); code != 0 {
		t.Fatalf("expected exit 0, got %d\n%s", code, out.String())
	}
	if sawAuth != "" {
		t.Errorf("Authorization = %q, want none", sawAuth)
	}
}

func TestRunCLIAppliesCollectionScriptSettings(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	helper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"token":"from-helper"}`))
	}))
	defer helper.Close()

	var sawAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		fmt.Fprint(w, "{}")
	}))
	defer server.Close()

	root := writeDefaultsWorkspace(t, server.URL, strings.Join([]string{
		"    settings:",
		"      scriptTimeoutMs: 8000",
		"      allowSendRequest: true",
	}, "\n"), strings.Join([]string{
		"  auth:",
		"    type: none",
		"  bodyType: none",
		"  bodyContent: \"\"",
		"  preRequestScriptJs: |",
		"    const start = Date.now()",
		"    while (Date.now() - start < 2400) { }",
		"    const res = pm.sendRequest(\"" + helper.URL + "/token\")",
		"    pm.request.headers.set(\"Authorization\", \"Bearer \" + res.json().token)",
		"  settings: {}",
	}, "\n"))

	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, reporters: []string{"cli"}, iterations: 1, stdout: &out, stderr: &out})
	if code != 0 {
		t.Fatalf("expected exit 0 with the collection's script settings, got %d\n%s", code, out.String())
	}
	if sawAuth != "Bearer from-helper" {
		t.Errorf("Authorization = %q, want the token pm.sendRequest fetched", sawAuth)
	}
}

func TestRunCLIAppliesCollectionHeadersAndScripts(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	var sawClient, sawOwn, sawScript string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawClient = r.Header.Get("X-Client")
		sawOwn = r.Header.Get("X-Own")
		sawScript = r.Header.Get("X-From-Script")
		fmt.Fprint(w, "{}")
	}))
	defer server.Close()

	root := writeDefaultsWorkspace(t, server.URL, strings.Join([]string{
		"    headers:",
		"      - id: 1",
		"        enabled: true",
		"        key: X-Client",
		"        value: kurlo",
		"    preRequestScript: |",
		`      throw new Error("old collection script");`,
		"    preRequestScriptJs: |",
		"      pm.request.headers.set(\"X-From-Script\", \"collection\")",
		"    testScriptJs: |",
		"      pm.test(\"collection assertion ran\", () => pm.expect(pm.response.code).to.equal(200))",
		"    settings: {}",
	}, "\n"), strings.Join([]string{
		"  auth:",
		"    type: none",
		"  headers:",
		"    - id: 1",
		"      enabled: true",
		"      key: X-Own",
		"      value: mine",
		"  testScript: |",
		`    throw new Error("old request script");`,
		"  bodyType: none",
		"  bodyContent: \"\"",
		"  settings: {}",
	}, "\n"))

	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, reporters: []string{"json"}, iterations: 1, stdout: &out, stderr: &out})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d\n%s", code, out.String())
	}
	if sawClient != "kurlo" {
		t.Errorf("collection header missing: X-Client = %q", sawClient)
	}
	if sawOwn != "mine" {
		t.Errorf("request header lost: X-Own = %q", sawOwn)
	}
	if sawScript != "collection" {
		t.Errorf("collection pre-request script did not run: X-From-Script = %q", sawScript)
	}
	if !strings.Contains(out.String(), "collection assertion ran") {
		t.Errorf("collection test script did not run:\n%s", out.String())
	}
}

func TestMergeCollectionAuth(t *testing.T) {
	collectionAuth := cliAuth{Type: "bearer", BearerToken: "t"}

	if got := mergeCollectionAuth(collectionAuth, cliAuth{Type: "inherit"}); got.Type != "bearer" {
		t.Errorf("inherit should take the collection auth, got %q", got.Type)
	}
	own := cliAuth{Type: "basic", BasicUser: "u"}
	if got := mergeCollectionAuth(collectionAuth, own); got.Type != "basic" {
		t.Errorf("request auth should win, got %q", got.Type)
	}
	if got := mergeCollectionAuth(cliAuth{Type: "none"}, cliAuth{Type: "inherit"}); got.Type != "none" {
		t.Errorf("got %q, want none", got.Type)
	}
	if got := mergeCollectionAuth(cliAuth{}, cliAuth{Type: "inherit"}); got.Type != "none" {
		t.Errorf("got %q, want none", got.Type)
	}
	if got := mergeCollectionAuth(cliAuth{Type: "inherit"}, cliAuth{Type: "inherit"}); got.Type != "none" {
		t.Errorf("got %q, want none", got.Type)
	}
}

func TestMergeDefaultRows(t *testing.T) {
	defaults := []cliKV{{Key: "X-Client", Value: "kurlo", Enabled: true}, {Key: "Accept", Value: "application/json", Enabled: true}}
	request := []cliKV{{Key: "accept", Value: "text/plain", Enabled: true}}

	merged := mergeDefaultRows(defaults, request)
	if len(merged) != 2 {
		t.Fatalf("expected 2 rows, got %#v", merged)
	}
	if merged[0].Key != "X-Client" || merged[1].Key != "accept" {
		t.Errorf("unexpected merge order/content: %#v", merged)
	}
	if merged[1].Value != "text/plain" {
		t.Errorf("request header should win: %#v", merged[1])
	}
}

func TestMergeDefaultRowsSkipsBlankKeys(t *testing.T) {
	merged := mergeDefaultRows([]cliKV{{Key: "  ", Value: "x"}}, nil)
	if len(merged) != 0 {
		t.Errorf("blank keys should be dropped, got %#v", merged)
	}
}

func TestJoinScripts(t *testing.T) {
	if got := joinScripts("a", "", "  ", "b"); got != "a\n\nb" {
		t.Errorf("got %q", got)
	}
	if got := joinScripts("", ""); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

func TestMergeCollectionSettingsFillsOnlyUnset(t *testing.T) {
	yes := true
	no := false
	defaults := cliSettings{HTTPVersion: "2", TimeoutMs: intPointer(5000), EnableSSLVerification: &yes, MaxRedirects: 3}
	req := cliSettings{TimeoutMs: intPointer(1000), EnableSSLVerification: &no}

	merged := mergeCollectionSettings(defaults, req)
	if merged.TimeoutMs == nil || *merged.TimeoutMs != 1000 {
		t.Errorf("request timeout should win, got %v", merged.TimeoutMs)
	}
	if merged.EnableSSLVerification == nil || *merged.EnableSSLVerification {
		t.Error("an explicit false on the request must not be overwritten by the default")
	}
	if merged.HTTPVersion != "2" {
		t.Errorf("unset httpVersion should come from defaults, got %q", merged.HTTPVersion)
	}
	if merged.MaxRedirects != 3 {
		t.Errorf("unset maxRedirects should come from defaults, got %d", merged.MaxRedirects)
	}
}

func TestApplyCollectionDefaultsWithoutCollection(t *testing.T) {
	req := cliSavedRequest{Auth: cliAuth{Type: "inherit"}}
	got := applyCollectionDefaults(req, nil)
	if got.Auth.Type != "none" {
		t.Errorf("a missing collection should resolve inherit to none, got %q", got.Auth.Type)
	}
}

func intPointer(value int) *int {
	return &value
}

func TestCLIRequestTimeoutFromSavedFiles(t *testing.T) {
	cases := []struct {
		name       string
		collection string
		request    string
		want       int
	}{
		{"default when neither sets it", "    settings: {}", "  settings: {}", defaultCLIRequestTimeoutMs},
		{"explicit zero turns it off", "    settings: {}", "  settings:\n    timeoutMs: 0", 0},
		{"collection default fills an unset request", "    settings:\n      timeoutMs: 5000", "  settings: {}", 5000},
		{"request zero beats the collection default", "    settings:\n      timeoutMs: 5000", "  settings:\n    timeoutMs: 0", 0},
		{"request value beats the collection default", "    settings:\n      timeoutMs: 5000", "  settings:\n    timeoutMs: 750", 750},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := writeDefaultsWorkspace(t, "http://127.0.0.1:1", tc.collection, strings.Join([]string{
				"  auth:",
				"    type: none",
				"  bodyType: none",
				"  bodyContent: \"\"",
				tc.request,
			}, "\n"))
			_, collections, requests, _, err := loadCLIWorkspace(root)
			if err != nil {
				t.Fatal(err)
			}
			if len(collections) != 1 || len(requests) != 1 {
				t.Fatalf("expected one collection and one request, got %d and %d", len(collections), len(requests))
			}
			built := buildHTTPRequest(applyCollectionDefaults(requests[0], &collections[0]), nil, nil, 0)
			if built.TimeoutMs != tc.want {
				t.Fatalf("timeoutMs = %d, want %d", built.TimeoutMs, tc.want)
			}
		})
	}
}

package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestSendRequestUsesRequestVarsAndSetsPostResponseVars(t *testing.T) {
	var gotPath, gotHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotHeader = r.Header.Get("X-Tenant")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"t-9","user":{"id":42}}`))
	}))
	defer srv.Close()

	req := model.HttpRequest{
		Method:           "GET",
		URL:              "{{base}}/users/{{userId}}",
		Headers:          []model.KeyValue{{Key: "X-Tenant", Value: "{{tenant}}", Enabled: true}},
		ResolveTemplates: true,
		TemplateValues:   map[string]string{"base": srv.URL, "userId": "7", "tenant": "acme"},
		RequestVariables: map[string]string{"userId": "7", "tenant": "acme"},
		PreRequestScript: `pm.environment.set("seenUser", pm.variables.get("userId")); pm.environment.set("tenant", "changed")`,
		TestScript:       `pm.test("token visible", () => pm.expect(pm.variables.get("token")).to.eql("t-9"))`,
		ScriptEngine:     "js",
		PostResponseVars: []model.KeyValue{
			{Key: "token", Value: "res.body.token", Enabled: true},
			{Key: "userIdFromBody", Value: "res('user.id')", Enabled: true},
		},
	}
	resp := sendRequest(context.Background(), req, state.New(), newCookieJarRegistry(), nil)
	if resp.Error != "" {
		t.Fatalf("send failed: %s", resp.Error)
	}
	if gotPath != "/users/7" || gotHeader != "acme" {
		t.Fatalf("server saw path=%q tenant=%q", gotPath, gotHeader)
	}
	if resp.EnvironmentUpdates["seenUser"] != "7" {
		t.Fatalf("script could not read request var: %v", resp.EnvironmentUpdates)
	}
	if resp.GlobalVariableUpdates["token"] != "t-9" || resp.GlobalVariableUpdates["userIdFromBody"] != "42" {
		t.Fatalf("post-response vars not reported: %v", resp.GlobalVariableUpdates)
	}
	if len(resp.TestResult.Tests) != 1 || !resp.TestResult.Tests[0].Passed {
		t.Fatalf("test script did not see post-response var: %+v", resp.TestResult)
	}
}

func TestSendRequestSkipsPostResponseVarsWhenTheRequestFails(t *testing.T) {
	req := model.HttpRequest{
		Method:           "GET",
		URL:              "http://127.0.0.1:1/unreachable",
		TimeoutMs:        500,
		PostResponseVars: []model.KeyValue{{Key: "token", Value: "res.body.token", Enabled: true}},
	}
	resp := sendRequest(context.Background(), req, state.New(), newCookieJarRegistry(), nil)
	if resp.Error == "" {
		t.Fatal("expected a network error")
	}
	if _, ok := resp.GlobalVariableUpdates["token"]; ok {
		t.Fatalf("post-response var ran on a failed request: %v", resp.GlobalVariableUpdates)
	}
}

func TestCLIRequestVarsOverrideEnvironmentAndFeedLaterRequests(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.URL.Path+"|"+r.Header.Get("Authorization"))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"from-login"}`))
	}))
	defer srv.Close()

	root := t.TempDir()
	workspaces := []map[string]any{{"id": "ws", "name": "Demo"}}
	collections := []map[string]any{{"id": "col", "workspaceId": "ws", "name": "API", "defaults": map[string]any{"variables": []any{
		map[string]any{"id": 1, "key": "region", "value": "collection", "enabled": true},
	}}}}
	requests := []map[string]any{
		{
			"id": "login", "collectionId": "col", "name": "Login", "method": "POST", "url": srv.URL + "/{{region}}/login/{{who}}", "requestType": "http", "auth": map[string]any{"type": "none"},
			"vars": []any{
				map[string]any{"id": 1, "key": "region", "value": "{{region}}-eu", "enabled": true},
				map[string]any{"id": 2, "key": "who", "value": "ada", "enabled": true},
				map[string]any{"id": 3, "key": "ignored", "value": "x", "enabled": false},
			},
			"postResponseVars": []any{map[string]any{"id": 1, "key": "token", "value": "res.body.token", "enabled": true}},
		},
		{
			"id": "me", "collectionId": "col", "name": "Me", "method": "GET", "url": srv.URL + "/{{region}}/me", "requestType": "http",
			"auth": map[string]any{"type": "bearer", "bearerToken": "{{token}}"},
		},
	}
	ensureStoreFilesystemNames(workspaces, collections, requests, nil, nil, false)
	if err := writeFilesystemWorkspaceStore(root, workspaces, collections, requests, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	loginFile := findRequestFile(t, root, "Login")
	raw, err := os.ReadFile(loginFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"vars:", "key: region", "value: '{{region}}-eu'", "postResponseVars:", "value: res.body.token"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("request YAML is missing %q:\n%s", want, raw)
		}
	}

	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, reporters: []string{"cli"}, iterations: 1, stdout: &out, stderr: &out})
	if code != 0 {
		t.Fatalf("code=%d: %s", code, out.String())
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"/collection-eu/login/ada|", "/collection/me|Bearer from-login"}
	if strings.Join(seen, ",") != strings.Join(want, ",") {
		t.Fatalf("server saw %v, want %v", seen, want)
	}
}

func findRequestFile(t *testing.T, root, name string) string {
	t.Helper()
	var found string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(path, ".yml") && strings.Contains(filepath.ToSlash(path), "/requests/") {
			data, readErr := os.ReadFile(path)
			if readErr == nil && strings.Contains(string(data), "name: "+name+"\n") {
				found = path
			}
		}
		return nil
	})
	if found == "" {
		t.Fatalf("request file for %q not found", name)
	}
	return found
}

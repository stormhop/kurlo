package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

type openAPIServerRow struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
}

type openAPIServerCase struct {
	Name        string                        `json:"name"`
	Spec        map[string]any                `json:"spec"`
	SourceURL   string                        `json:"sourceUrl"`
	Variables   []openAPIServerRow            `json:"variables"`
	URLs        map[string]string             `json:"urls"`
	RequestVars map[string][]openAPIServerRow `json:"requestVars"`
	URLsByPath  bool                          `json:"urlsByPath"`
}

func openAPIServerRows(value any) []openAPIServerRow {
	rows := []openAPIServerRow{}
	for _, row := range mapSlice(value) {
		enabled, _ := row["enabled"].(bool)
		rows = append(rows, openAPIServerRow{stringValue(row, "key"), stringValue(row, "value"), enabled})
	}
	return rows
}

func TestOpenAPIImportServers(t *testing.T) {
	data, err := os.ReadFile("testdata/openapi-servers.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []openAPIServerCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, entry := range cases {
		t.Run(entry.Name, func(t *testing.T) {
			imported, err := importOpenAPI(entry.Spec, "API", entry.SourceURL)
			if err != nil {
				t.Fatal(err)
			}
			if got := openAPIServerRows(imported.defaults["variables"]); !reflect.DeepEqual(got, entry.Variables) {
				t.Fatalf("collection variables = %v, want %v", got, entry.Variables)
			}
			urls := map[string]string{}
			requestVars := map[string][]openAPIServerRow{}
			for _, request := range imported.requests {
				target := stringValue(request, "url")
				label := stringValue(request, "name")
				if entry.URLsByPath {
					label = strings.ToUpper(stringValue(request, "method")) + " " + regexp.MustCompile(`^\{\{[^}]+\}\}`).ReplaceAllString(target, "")
				}
				urls[label] = target
				if rows := openAPIServerRows(request["vars"]); len(rows) > 0 {
					requestVars[label] = rows
				}
			}
			if !reflect.DeepEqual(urls, entry.URLs) {
				t.Fatalf("URLs = %v, want %v", urls, entry.URLs)
			}
			want := entry.RequestVars
			if want == nil {
				want = map[string][]openAPIServerRow{}
			}
			if !reflect.DeepEqual(requestVars, want) {
				t.Fatalf("request vars = %v, want %v", requestVars, want)
			}
		})
	}
}

func TestOpenAPIImportServerAlternatives(t *testing.T) {
	imported, err := decodeWorkspaceImport(`{"openapi":"3.0.3","paths":{"/a":{"get":{"servers":[{"url":"https://api.test/","description":"Production"},{"url":"https://api.test","description":"Primary"},{"url":"https://one.test","description":"Sandbox"}]}}}}`, "openapi", "API")
	if err != nil {
		t.Fatal(err)
	}
	rows := mapSlice(imported.requests[0]["vars"])
	if len(rows) != 2 || stringValue(rows[0], "description") != "Production, Primary server from the spec" || stringValue(rows[1], "description") != "Sandbox server from the spec" {
		t.Fatalf("request vars = %v", rows)
	}
	values := map[string]string{}
	for _, row := range rows {
		if row["enabled"] == true {
			values[stringValue(row, "key")] = stringValue(row, "value")
		}
	}
	if got := resolveTemplateValue(stringValue(imported.requests[0], "url"), values); got != "https://api.test/a" {
		t.Fatalf("resolved URL = %s", got)
	}
}

func TestOpenAPIImportServersPersistAndSend(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	paths := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	root := agentTestWorkspace(t, server.URL)
	h := startMCPHarness(t, mcpServerOptions{workspace: root})
	spec := fmt.Sprintf(`{"openapi":"3.0.3","info":{"title":"Imported servers"},"paths":{"/ping":{"get":{"summary":"Imported ping","servers":[{"url":%q,"description":"Production"},{"url":%q,"description":"Sandbox"}]}}}}`, server.URL+"/production", server.URL+"/sandbox")
	var preview struct {
		ImportID string `json:"importId"`
	}
	h.tool("import_preview", map[string]any{"format": "openapi", "content": spec}, &preview)
	h.tool("import_apply", map[string]any{"importId": preview.ImportID, "confirm": true}, nil)
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	_, saved, err := st.request("Imported servers/Imported ping")
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Vars) != 2 || !saved.Vars[0].Enabled || saved.Vars[1].Enabled || saved.Vars[1].Value != server.URL+"/sandbox" {
		t.Fatalf("persisted request vars = %+v", saved.Vars)
	}
	h.tool("run_request", map[string]any{"request": "Imported servers/Imported ping"}, nil)
	h.tool("apply_changes", map[string]any{"operations": []any{map[string]any{
		"tool": "patch_request", "arguments": map[string]any{"request": "Imported servers/Imported ping", "patch": map[string]any{"vars": []any{
			map[string]any{"key": "baseUrl", "value": saved.Vars[0].Value, "enabled": false},
			map[string]any{"key": "baseUrl", "value": saved.Vars[1].Value, "enabled": true},
		}}},
	}}}, nil)
	h.tool("run_request", map[string]any{"request": "Imported servers/Imported ping"}, nil)
	var sent []string
	for len(paths) > 0 {
		sent = append(sent, <-paths)
	}
	if !slices.Equal(sent, []string{"/production/ping", "/sandbox/ping"}) {
		t.Fatalf("sent paths = %v", sent)
	}
}

func TestOpenAPIImportServerCredentialsAreScrubbed(t *testing.T) {
	imported, err := decodeWorkspaceImport(`{"openapi":"3.0.3","servers":[{"url":"https://user:primary-password@api.test"},{"url":"https://user:sandbox-password@sandbox.test?token=private-token"}],"paths":{"/ping":{"get":{}}}}`, "openapi", "API")
	if err != nil {
		t.Fatal(err)
	}
	scrubImportValue(imported.defaults)
	data, err := json.Marshal(imported.defaults)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"primary-password", "sandbox-password", "private-token", "user:"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("server variables or descriptions kept %s: %s", secret, data)
		}
	}
	rows := mapSlice(imported.defaults["variables"])
	if stringValue(rows[1], "value") != "https://sandbox.test?token={{token}}" {
		t.Fatalf("alternative server = %v", rows[1])
	}
}

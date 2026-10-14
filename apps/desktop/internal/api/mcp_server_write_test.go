package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readWorkspaceFile(t *testing.T, root, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(data)
}

func TestMCPServerBuildsACollectionAnAgentCanRun(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	h := startMCPHarness(t, mcpServerOptions{workspace: root, env: "Local"})

	var collection struct {
		ID   string `json:"id"`
		File string `json:"file"`
	}
	h.tool("create_collection", map[string]any{"name": "Orders API"}, &collection)
	if collection.ID == "" || collection.File != "workspaces/Demo/collections/Orders-API/collection.yml" {
		t.Fatalf("create_collection = %+v", collection)
	}
	if result := h.tool("create_collection", map[string]any{"name": "orders api"}, nil); !result.IsError {
		t.Fatal("a second collection with the same name should be refused")
	}

	var saved struct {
		ID      string `json:"id"`
		Path    string `json:"path"`
		Created bool   `json:"created"`
		File    string `json:"file"`
	}
	h.tool("save_request", map[string]any{
		"collection": "Orders API",
		"folder":     "Orders/Write",
		"name":       "Create order",
		"method":     "post",
		"url":        "{{baseUrl}}/orders",
		"headers":    []map[string]any{{"key": "X-Trace", "value": "agent"}},
		"body":       `{"amount": 500}`,
		"testScript": `pm.test("echoes the body", () => pm.expect(pm.response.json().body).to.include("500"))`,
	}, &saved)
	if !saved.Created || saved.Path != "Orders API/Orders/Write/Create order" || saved.File != "workspaces/Demo/collections/Orders-API/requests/Create-order.yml" {
		t.Fatalf("save_request = %+v", saved)
	}
	file := readWorkspaceFile(t, root, saved.File)
	for _, want := range []string{"method: POST", "url: '{{baseUrl}}/orders'", "bodyType: json", "X-Trace", "testScriptJs:"} {
		if !strings.Contains(file, want) {
			t.Errorf("request file is missing %q:\n%s", want, file)
		}
	}
	if folders := readWorkspaceFile(t, root, collection.File); !strings.Contains(folders, "- Orders\n") || !strings.Contains(folders, "- Write") {
		t.Errorf("the collection should record the new folders:\n%s", folders)
	}

	var run mcpRequestOutcome
	h.tool("run_request", map[string]any{"request": saved.ID}, &run)
	if run.Status != 200 || run.TestsTotal != 1 || run.TestsPassed != 1 {
		t.Fatalf("run_request = %+v", run)
	}

	var example struct {
		Example string `json:"example"`
		Source  string `json:"source"`
	}
	h.tool("save_example", map[string]any{"request": "Orders API/Orders/Write/Create order", "name": "Created"}, &example)
	if example.Example != "Created" || example.Source != "captured" {
		t.Fatalf("save_example = %+v", example)
	}
	exampleFile := readWorkspaceFile(t, root, "workspaces/Demo/collections/Orders-API/examples/Create-order/Created.yml")
	if !strings.Contains(exampleFile, "pathTemplate: /orders") || !strings.Contains(exampleFile, "statusCode: 200") {
		t.Errorf("example file:\n%s", exampleFile)
	}
	h.tool("save_example", map[string]any{"request": saved.ID, "name": "Rejected", "status": 422, "body": `{"error":"amount"}`}, nil)

	var detail struct {
		Examples []mcpExample `json:"examples"`
	}
	h.tool("get_request", map[string]any{"request": saved.ID}, &detail)
	if len(detail.Examples) != 2 || detail.Examples[1].Status != 422 || detail.Examples[1].ContentType != "application/json" {
		t.Fatalf("examples = %+v", detail.Examples)
	}

	h.tool("save_request", map[string]any{
		"request": saved.ID,
		"url":     "{{baseUrl}}/v2/orders",
		"auth":    map[string]any{"type": "bearer", "token": "{{apiToken}}"},
	}, &saved)
	if saved.Created {
		t.Fatal("passing request should change it, not create one")
	}
	file = readWorkspaceFile(t, root, saved.File)
	if !strings.Contains(file, "/v2/orders") || !strings.Contains(file, "'{{apiToken}}'") || !strings.Contains(file, "X-Trace") || strings.Contains(file, "kurloSecret") {
		t.Fatalf("an update should change only what it names:\n%s", file)
	}

	result := h.tool("save_request", map[string]any{"request": saved.ID, "auth": map[string]any{"type": "bearer", "token": "sk-live-123"}}, nil)
	if !result.IsError || !strings.Contains(result.Content[0].Text, "variable reference") {
		t.Fatalf("a literal token must be refused: %+v", result)
	}
	if strings.Contains(readWorkspaceFile(t, root, saved.File), "sk-live-123") {
		t.Fatal("a refused secret reached the disk")
	}

	h.tool("save_request", map[string]any{
		"collection": "Orders API",
		"type":       "graphql",
		"url":        "{{baseUrl}}/graphql",
		"query":      "query Order($id: ID!) { order(id: $id) { id } }",
		"variables":  map[string]any{"id": "ord_1"},
	}, &saved)
	if saved.Path != "Orders API/GraphQL /graphql" {
		t.Fatalf("graphql path = %q", saved.Path)
	}
	h.tool("run_request", map[string]any{"request": saved.ID}, &run)
	if run.Method != "POST" || !strings.Contains(run.Body, "ord_1") {
		t.Fatalf("graphql run = %+v", run)
	}

	var variable struct {
		CreatedEnvironment bool   `json:"createdEnvironment"`
		File               string `json:"file"`
	}
	h.tool("set_variable", map[string]any{"environment": "Staging", "key": "baseUrl", "value": server.URL + "/staging"}, &variable)
	if !variable.CreatedEnvironment || !strings.Contains(readWorkspaceFile(t, root, variable.File), "/staging") {
		t.Fatalf("set_variable = %+v", variable)
	}
	h.tool("run_request", map[string]any{"request": "Smoke/Ok", "environment": "Staging"}, &run)
	if !strings.Contains(run.URL, "/staging/ok") {
		t.Fatalf("the new environment should be usable at once: %s", run.URL)
	}

	var deleted struct {
		Deleted string `json:"deleted"`
	}
	h.tool("delete_request", map[string]any{"request": "Orders API/Orders/Write/Create order"}, &deleted)
	if deleted.Deleted != "Orders API/Orders/Write/Create order" {
		t.Fatalf("delete_request = %+v", deleted)
	}
	for _, rel := range []string{"workspaces/Demo/collections/Orders-API/requests/Create-order.yml", "workspaces/Demo/collections/Orders-API/examples/Create-order/Created.yml"} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); !os.IsNotExist(err) {
			t.Errorf("%s should be gone: %v", rel, err)
		}
	}

	if _, _, _, _, err := loadCLIWorkspace(root); err != nil {
		t.Fatalf("the workspace the agent wrote no longer loads: %v", err)
	}
}

func TestMCPServerSaveRequestKeepsSecretRowsAndRefusesToOverwriteThem(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	path := filepath.Join(root, "workspaces", "Demo", "collections", "Smoke", "requests", "GET-1-ok.yml")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	withSecret := strings.Replace(string(data), "  bodyType: none", strings.Join([]string{
		"  headers:",
		"    - id: 7",
		"      enabled: true",
		"      secret: true",
		"      key: X-Api-Key",
		"      value: '{{kurloSecret:request:req-ok:headers:7}}'",
		"  bodyType: none",
	}, "\n"), 1)
	if err := os.WriteFile(path, []byte(withSecret), 0o644); err != nil {
		t.Fatal(err)
	}
	h := startMCPHarness(t, mcpServerOptions{workspace: root})

	var detail struct {
		Headers []mcpKeyValue `json:"headers"`
	}
	h.tool("get_request", map[string]any{"request": "req-ok"}, &detail)
	if len(detail.Headers) != 1 || detail.Headers[0].Value != "<secret>" {
		t.Fatalf("secret header shown as %+v", detail.Headers)
	}

	h.tool("save_request", map[string]any{"request": "req-ok", "headers": []map[string]any{{"key": "Accept", "value": "application/json"}}}, nil)
	file, err := os.ReadFile(filepath.Join(filepath.Dir(path), "Ok.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(file), "kurloSecret:request:req-ok:headers:7") || !strings.Contains(string(file), "Accept") {
		t.Fatalf("the secret header should survive a headers update:\n%s", file)
	}
	if result := h.tool("save_request", map[string]any{"request": "req-ok", "headers": []map[string]any{{"key": "x-api-key", "value": "leak"}}}, nil); !result.IsError {
		t.Fatal("overwriting a secret header should be refused")
	}
}

func TestMCPServerHonoursProtectedEnvironments(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	addSecretEnvironment(t, root, server.URL, "tok-123456")
	envPath := filepath.Join(root, "workspaces", "Demo", "environments", "Prod.yml")
	data, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(envPath, []byte(strings.Replace(string(data), "  name: Prod\n", "  name: Prod\n  protected: true\n", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	h := startMCPHarness(t, mcpServerOptions{workspace: root})

	var envs struct {
		Environments []struct {
			Name      string `json:"name"`
			Protected bool   `json:"protected"`
		} `json:"environments"`
	}
	h.tool("list_environments", map[string]any{}, &envs)
	protected := map[string]bool{}
	for _, env := range envs.Environments {
		protected[env.Name] = env.Protected
	}
	if !protected["Prod"] || protected["Local"] {
		t.Fatalf("environments = %+v", envs)
	}

	for name, args := range map[string]map[string]any{
		"run_request":    {"request": "Smoke/Ok", "environment": "prod"},
		"send_request":   {"url": "{{baseUrl}}/x", "environment": "Prod"},
		"run_collection": {"collection": "Smoke", "environment": "Prod"},
		"set_variable":   {"environment": "Prod", "key": "baseUrl", "value": "http://elsewhere"},
	} {
		result := h.tool(name, args, nil)
		if !result.IsError || !strings.Contains(result.Content[0].Text, "protected") {
			t.Errorf("%s with a protected environment should be refused: %+v", name, result)
		}
	}
	if !strings.Contains(readWorkspaceFile(t, root, "workspaces/Demo/environments/Prod.yml"), server.URL) {
		t.Fatal("a protected environment was changed")
	}

	var run mcpRequestOutcome
	h.tool("run_request", map[string]any{"request": "Smoke/Ok", "environment": "Local"}, &run)
	if run.Status != 200 {
		t.Fatalf("other environments still work: %+v", run)
	}
}

func TestMCPServerReadOnlyOffersNoWriteTools(t *testing.T) {
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	before := workspaceTreeForTest(t, root)
	h := startMCPHarness(t, mcpServerOptions{workspace: root, readOnly: true})

	resp := h.request("tools/list", map[string]any{})
	var list struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(resp.Result, &list); err != nil {
		t.Fatal(err)
	}
	for _, tool := range list.Tools {
		if mcpWriteToolNames[tool.Name] {
			t.Errorf("--read-only still lists %s", tool.Name)
		}
	}
	resp = h.request("tools/call", map[string]any{"name": "save_request", "arguments": map[string]any{"url": "http://x"}})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "--read-only") {
		t.Fatalf("save_request under --read-only = %+v", resp)
	}
	resp = h.request("initialize", map[string]any{"protocolVersion": "2025-06-18"})
	if strings.Contains(string(resp.Result), "save_request") {
		t.Error("read-only instructions should not mention the write tools")
	}
	if after := workspaceTreeForTest(t, root); len(after) != len(before) {
		t.Fatal("a read-only server changed the workspace")
	}
}

func TestMCPPathTemplateMatchesTheApp(t *testing.T) {
	for url, want := range map[string]string{
		"{{baseUrl}}/orders/42?x=1": "/orders/:id",
		"https://api.example.test/users/0b6c2f1e-8e7a-4c55-9b1f-3d7c2a9e4f10": "/users/:id",
		"{{baseUrl}}":              "/",
		"https://api.example.test": "/",
		"/plain/{{id}}/x":          "/plain/{{id}}/x",
	} {
		if got := mcpPathTemplate(url); got != want {
			t.Errorf("mcpPathTemplate(%q) = %q, want %q", url, got, want)
		}
	}
}

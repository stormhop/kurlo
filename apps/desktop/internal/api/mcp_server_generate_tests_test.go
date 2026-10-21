package api

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func ordersServer(t *testing.T, dropCustomer *atomic.Bool) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		switch r.URL.Path {
		case "/orders/1":
			order := map[string]any{
				"id":    1,
				"paid":  true,
				"items": []any{map[string]any{"sku": "a", "qty": 2, "note": nil}, map[string]any{"sku": "b", "qty": 1}},
			}
			if !dropCustomer.Load() {
				order["customer"] = map[string]any{"name": "Ada", "email": "ada@example.test"}
			}
			_ = json.NewEncoder(w).Encode(order)
		default:
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"boom"}`))
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func readExampleFiles(t *testing.T, root string) string {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(root, "workspaces", "Demo", "collections", "*", "examples", "*", "*.yml"))
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		out.Write(data)
	}
	return out.String()
}

type mcpGenerateResult struct {
	Request         string   `json:"request"`
	File            string   `json:"file"`
	From            string   `json:"from"`
	Status          int      `json:"status"`
	Tests           []string `json:"tests"`
	KeptExisting    []string `json:"keptExisting"`
	SchemaFields    int      `json:"schemaFields"`
	Example         string   `json:"example"`
	ExampleReplaced bool     `json:"exampleReplaced"`
	Warnings        []string `json:"warnings"`
}

func TestMCPServerGeneratesTestsFromARealResponse(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	var dropCustomer atomic.Bool
	server := ordersServer(t, &dropCustomer)
	root := writeYAMLWorkspace(t, server.URL)
	h := startMCPHarness(t, mcpServerOptions{workspace: root, env: "Local"})

	h.tool("save_request", map[string]any{
		"collection": "Smoke",
		"name":       "Get order",
		"url":        "{{baseUrl}}/orders/1",
		"testScript": `pm.test("has an id", () => pm.expect(pm.response.json().id).to.equal(1));`,
	}, nil)

	var generated mcpGenerateResult
	h.tool("generate_tests", map[string]any{"request": "Smoke/Get order"}, &generated)
	if generated.From != "run" || generated.Status != 200 || generated.Example != "200 OK" || generated.ExampleReplaced {
		t.Fatalf("generate_tests = %+v", generated)
	}
	if got := strings.Join(generated.Tests, " | "); got != "status is 200 | Content-Type is application/json | body matches the response schema" {
		t.Fatalf("tests = %s", got)
	}
	if generated.SchemaFields != 9 {
		t.Errorf("schemaFields = %d, want 9 (id, paid, items, sku, qty, note, customer, name, email)", generated.SchemaFields)
	}

	file := readWorkspaceFile(t, root, generated.File)
	for _, want := range []string{`pm.test("has an id"`, `pm.test("status is 200"`, "jsonSchema(", `"required": [`} {
		if !strings.Contains(file, want) {
			t.Errorf("request file is missing %q:\n%s", want, file)
		}
	}
	for _, leaked := range []string{"Ada", "ada@example.test"} {
		if strings.Contains(file, leaked) {
			t.Errorf("a response value %q ended up in the tests:\n%s", leaked, file)
		}
	}
	if examples := readExampleFiles(t, root); !strings.Contains(examples, "statusCode: 200") || !strings.Contains(examples, "Ada") {
		t.Errorf("the response should be saved as an example:\n%s", examples)
	}

	var run mcpRequestOutcome
	h.tool("run_request", map[string]any{"request": "Smoke/Get order"}, &run)
	if run.TestsTotal != 4 || run.TestsPassed != 4 {
		t.Fatalf("the generated tests should pass on the response they came from: %+v", run.Tests)
	}

	dropCustomer.Store(true)
	h.tool("run_request", map[string]any{"request": "Smoke/Get order"}, &run)
	if run.TestsPassed != 3 {
		t.Fatalf("dropping a field the schema requires should fail only the schema test: %+v", run.Tests)
	}

	dropCustomer.Store(false)
	h.tool("generate_tests", map[string]any{"request": "Smoke/Get order"}, &generated)
	if len(generated.Tests) != 0 || len(generated.KeptExisting) != 3 || !generated.ExampleReplaced {
		t.Fatalf("a second run should add nothing and refresh the example: %+v", generated)
	}
	file = readWorkspaceFile(t, root, generated.File)
	if n := strings.Count(file, `pm.test("status is 200"`); n != 1 {
		t.Errorf("status test written %d times:\n%s", n, file)
	}
	if examples := readExampleFiles(t, root); strings.Count(examples, "statusCode: 200") != 1 {
		t.Errorf("the example should be refreshed, not added again:\n%s", examples)
	}

	h.tool("generate_tests", map[string]any{"request": "Smoke/Get order", "replace": true, "saveExample": false}, &generated)
	if file = readWorkspaceFile(t, root, generated.File); strings.Contains(file, "has an id") || len(generated.Tests) != 3 {
		t.Errorf("replace should drop the old script:\n%s", file)
	}
}

func TestMCPServerGenerateTestsRefusesAFailingResponseUnlessAsked(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	var dropCustomer atomic.Bool
	server := ordersServer(t, &dropCustomer)
	root := writeYAMLWorkspace(t, server.URL)
	h := startMCPHarness(t, mcpServerOptions{workspace: root, env: "Local"})
	h.tool("save_request", map[string]any{"collection": "Smoke", "name": "Broken", "url": "{{baseUrl}}/broken"}, nil)

	result := h.tool("generate_tests", map[string]any{"request": "Smoke/Broken"}, nil)
	if !result.IsError || !strings.Contains(result.Content[0].Text, "allowErrorStatus") {
		t.Fatalf("a 500 should be refused: %+v", result)
	}
	var generated mcpGenerateResult
	h.tool("generate_tests", map[string]any{"request": "Smoke/Broken", "allowErrorStatus": true, "exampleName": "Server error"}, &generated)
	if generated.Status != 500 || generated.Tests[0] != "status is 500" || generated.Example != "Server error" {
		t.Fatalf("generate_tests = %+v", generated)
	}
}

func TestMCPServerGeneratesTestsForAnAPIThatIsNotRunning(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadURL := "http://" + listener.Addr().String()
	_ = listener.Close()
	root := writeYAMLWorkspace(t, deadURL)
	h := startMCPHarness(t, mcpServerOptions{workspace: root, env: "Local"})
	h.tool("save_request", map[string]any{"collection": "Smoke", "name": "Create order", "method": "POST", "url": "{{baseUrl}}/orders", "body": map[string]any{"sku": "a"}}, nil)
	h.tool("save_request", map[string]any{"collection": "Smoke", "name": "Unset", "url": "{{serviceUrl}}/x"}, nil)

	result := h.tool("generate_tests", map[string]any{"request": "Smoke/Create order"}, nil)
	if !result.IsError || !strings.Contains(result.Content[0].Text, "from: example") {
		t.Fatalf("an unreachable server should point to from: example: %+v", result)
	}
	result = h.tool("generate_tests", map[string]any{"request": "Smoke/Unset"}, nil)
	if !result.IsError || !strings.Contains(result.Content[0].Text, "serviceUrl") {
		t.Fatalf("the error should name the variable nothing sets: %+v", result)
	}

	mismatch := h.tool("generate_tests", map[string]any{
		"request": "Smoke/Create order", "from": "example", "status": 201,
		"body":   `{"id":"o-1"}`,
		"schema": map[string]any{"type": "object", "required": []string{"orderId"}},
	}, nil)
	if !mismatch.IsError || !strings.Contains(mismatch.Content[0].Text, "does not match") {
		t.Fatalf("a schema that rejects its own body should be refused: %+v", mismatch)
	}

	var generated mcpGenerateResult
	h.tool("generate_tests", map[string]any{
		"request": "Smoke/Create order", "from": "example", "status": 201,
		"body": map[string]any{"id": "o-1", "status": "pending", "items": []any{map[string]any{"sku": "a", "qty": 1}}},
	}, &generated)
	if generated.From != "example" || generated.Status != 201 || generated.Example != "201 Created" || len(generated.Tests) != 3 {
		t.Fatalf("generate_tests = %+v", generated)
	}
	file := readWorkspaceFile(t, root, generated.File)
	if !strings.Contains(file, "bodyType: json") || !strings.Contains(file, `"sku": "a"`) {
		t.Errorf("a body passed as a JSON object should be saved as a JSON body:\n%s", file)
	}
	if !strings.Contains(file, `pm.response.to.have.status(201)`) || !strings.Contains(file, `"status"`) {
		t.Errorf("request file is missing the tests:\n%s", file)
	}
	examples := readExampleFiles(t, root)
	for _, want := range []string{"statusCode: 201", "source: manual", "pathTemplate: /orders"} {
		if !strings.Contains(examples, want) {
			t.Errorf("example is missing %q:\n%s", want, examples)
		}
	}

	h.tool("generate_tests", map[string]any{
		"request": "Smoke/Create order", "from": "example", "status": 422, "exampleName": "Invalid",
		"body": map[string]any{"error": "sku is required"},
	}, &generated)
	if len(generated.Tests) != 0 || generated.Example != "Invalid" || len(generated.Warnings) != 1 || !strings.Contains(generated.Warnings[0], "already expect status 201") {
		t.Fatalf("an error response should become an example, not tests that contradict the 201 ones: %+v", generated)
	}
	if file := readWorkspaceFile(t, root, generated.File); strings.Contains(file, "status(422)") {
		t.Errorf("a contradicting status test was written:\n%s", file)
	}
	if examples := readExampleFiles(t, root); !strings.Contains(examples, "statusCode: 422") {
		t.Errorf("the 422 example should be saved:\n%s", examples)
	}

	if resp := h.request("tools/call", map[string]any{"name": "generate_tests", "arguments": map[string]any{"request": "Smoke/Create order", "from": "example"}}); resp.Error == nil {
		t.Fatal("from: example without a status, body or schema should be invalid params")
	}
	if resp := h.request("tools/call", map[string]any{"name": "generate_tests", "arguments": map[string]any{"request": "Smoke/Create order", "from": "guess"}}); resp.Error == nil {
		t.Fatal("an unknown from should be invalid params")
	}
}

func TestMCPServerGenerateTestsHonoursProtectionAndReadOnly(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	addSecretEnvironment(t, root, server.URL, "prod-secret-token")
	envPath := filepath.Join(root, "workspaces", "Demo", "environments", "Prod.yml")
	prod := readWorkspaceFile(t, root, "workspaces/Demo/environments/Prod.yml")
	if err := os.WriteFile(envPath, []byte(strings.Replace(prod, "  name: Prod\n", "  name: Prod\n  protected: true\n", 1)), 0o644); err != nil {
		t.Fatal(err)
	}

	h := startMCPHarness(t, mcpServerOptions{workspace: root, env: "Local"})
	if result := h.tool("generate_tests", map[string]any{"request": "Smoke/Ok", "environment": "Prod"}, nil); !result.IsError || !strings.Contains(result.Content[0].Text, "protected") {
		t.Fatalf("a protected environment should be refused: %+v", result)
	}

	readOnly := startMCPHarness(t, mcpServerOptions{workspace: root, env: "Local", readOnly: true})
	if resp := readOnly.request("tools/call", map[string]any{"name": "generate_tests", "arguments": map[string]any{"request": "Smoke/Ok"}}); resp.Error == nil || !strings.Contains(resp.Error.Message, "read-only") {
		t.Fatalf("generate_tests should not run on a read-only server: %+v", resp)
	}
}

func TestMCPInferSchemaKeepsOnlyWhatEveryItemHas(t *testing.T) {
	var body any
	if err := json.Unmarshal([]byte(`{"list":[{"a":1,"b":"x","c":null},{"a":2,"c":"y"}],"mixed":[1,"two"],"empty":[],"none":null}`), &body); err != nil {
		t.Fatal(err)
	}
	schema := mcpInferSchema(body, 0)
	encoded, _ := json.Marshal(schema)
	got := string(encoded)
	for _, want := range []string{
		`"list":{"items":{"properties":{"a":{"type":"number"},"b":{"type":"string"},"c":{}},"required":["a","c"],"type":"object"},"type":"array"}`,
		`"mixed":{"type":"array"}`,
		`"empty":{"type":"array"}`,
		`"none":{}`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("schema is missing %s:\n%s", want, got)
		}
	}
}

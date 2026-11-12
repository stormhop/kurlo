package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func assertionResponse() model.HttpResponse {
	return model.HttpResponse{
		StatusCode: 201,
		Duration:   180,
		Size:       512,
		Headers:    []model.KeyValue{{Key: "Content-Type", Value: "application/json; charset=utf-8"}, {Key: "X-Count", Value: "5"}},
		Body:       `{"id":"8c1f6c2a-3b7e-4d1a-9b0f-2a6c1e4d5f70","total":12345678901234567890,"price":19.5,"ok":true,"tags":["new","sale"],"owner":{"name":"Ada","email":null},"items":[{"sku":"a-1"},{"sku":"b-2"}],"weird key":1}`,
	}
}

func TestRunAssertionsOperators(t *testing.T) {
	cases := []struct {
		target, operator, value string
		pass                    bool
	}{
		{"status", "eq", "201", true},
		{"status", "eq", "200", false},
		{"status", "neq", "500", true},
		{"status", "in", "200, 201, 204", true},
		{"status", "in", "[200, 204]", false},
		{"status", "notIn", "500,502", true},
		{"status", "lt", "300", true},
		{"status", "gte", "201", true},
		{"responseTime", "lt", "1000", true},
		{"responseTime", "gt", "1000", false},
		{"size", "lte", "512", true},
		{"header.content-type", "contains", "application/json", true},
		{"headers.X-Count", "eq", "5", true},
		{"header.X-Count", "gt", "4", true},
		{"header.X-Missing", "notExists", "", true},
		{"header.X-Missing", "eq", "", false},
		{"body.id", "matches", "^[0-9a-f-]{36}$", true},
		{"body.id", "type", "string", true},
		{"$.total", "eq", "12345678901234567890", true},
		{"body.total", "eq", "12345678901234567891", false},
		{"body.price", "gt", "19.4", true},
		{"body.price", "eq", "19.50", true},
		{"body.ok", "eq", "true", true},
		{"body.ok", "eq", "false", false},
		{"body.tags", "contains", `"sale"`, true},
		{"body.tags", "contains", "sale", true},
		{"body.tags", "notContains", "old", true},
		{"body.tags", "length", "2", true},
		{"body.tags", "type", "array", true},
		{"body.tags[1]", "eq", "sale", true},
		{"body.tags[-1]", "eq", "sale", true},
		{"body.items[0].sku", "eq", "a-1", true},
		{"body.items[5].sku", "exists", "", false},
		{"body.owner", "contains", "name", true},
		{"body.owner", "eq", `{"email":null,"name":"Ada"}`, true},
		{"body.owner.email", "type", "null", true},
		{"body.owner.email", "exists", "", true},
		{`body["weird key"]`, "eq", "1", true},
		{"body.owner.name", "length", "3", true},
		{"body", "type", "object", true},
		{"body.ok", "matches", "^tr", true},
	}
	resp := assertionResponse()
	for _, testCase := range cases {
		results := runAssertions([]model.Assertion{{Enabled: true, Target: testCase.target, Operator: testCase.operator, Value: testCase.value}}, resp)
		if len(results) != 1 {
			t.Fatalf("%s %s %s: %d results", testCase.target, testCase.operator, testCase.value, len(results))
		}
		if results[0].Passed != testCase.pass {
			t.Errorf("%s %s %q: passed = %v, error = %q", testCase.target, testCase.operator, testCase.value, results[0].Passed, results[0].Error)
		}
		if !results[0].Passed && results[0].Error == "" {
			t.Errorf("%s %s %q: a failure needs a reason", testCase.target, testCase.operator, testCase.value)
		}
	}
}

func TestRunAssertionsNamesAndReasons(t *testing.T) {
	resp := assertionResponse()
	results := runAssertions([]model.Assertion{
		{Enabled: true, Target: "status", Operator: "eq", Value: "200"},
		{Enabled: true, Target: "body.missing", Operator: "exists"},
		{Enabled: false, Target: "status", Operator: "eq", Value: "1"},
		{Enabled: true, Target: "  ", Operator: "eq", Value: "1"},
		{Enabled: true, Target: "cookies.sid", Operator: "exists"},
		{Enabled: true, Target: "status", Operator: "approximately", Value: "1"},
		{Enabled: true, Target: "body.items[", Operator: "exists"},
		{Enabled: true, Target: "body.id", Operator: "matches", Value: "("},
	}, resp)
	if len(results) != 6 {
		t.Fatalf("disabled and blank rows must be skipped, got %d results: %+v", len(results), results)
	}
	want := []struct{ name, reason string }{
		{"status equals 200", "got 201"},
		{"body.missing exists", "it is missing"},
		{"cookies.sid exists", "unknown target"},
		{"status approximately 1", "unknown operator"},
		{"body.items[ exists", "missing ]"},
		{"body.id matches (", "invalid regular expression"},
	}
	for i, expected := range want {
		if results[i].Name != expected.name || results[i].Passed || !strings.Contains(results[i].Error, expected.reason) {
			t.Errorf("result %d = %+v, want name %q and reason containing %q", i, results[i], expected.name, expected.reason)
		}
	}
}

func TestRunAssertionsWithoutAUsableResponse(t *testing.T) {
	checks := []model.Assertion{{Enabled: true, Target: "status", Operator: "eq", Value: "200"}}
	if result := runAssertions(checks, model.HttpResponse{Error: "dial tcp: connection refused"})[0]; result.Passed || !strings.Contains(result.Error, "connection refused") {
		t.Errorf("network error result = %+v", result)
	}
	if result := runAssertions(checks, model.HttpResponse{Skipped: true})[0]; result.Passed || !strings.Contains(result.Error, "skipped") {
		t.Errorf("skipped result = %+v", result)
	}
	text := runAssertions([]model.Assertion{{Enabled: true, Target: "body.id", Operator: "exists"}}, model.HttpResponse{StatusCode: 200, Body: "<html>"})[0]
	if text.Passed || !strings.Contains(text.Error, "not JSON") {
		t.Errorf("non-JSON body result = %+v", text)
	}
	whole := runAssertions([]model.Assertion{{Enabled: true, Target: "body", Operator: "contains", Value: "html"}}, model.HttpResponse{StatusCode: 200, Body: "<html>"})[0]
	if !whole.Passed {
		t.Errorf("a text body should be checked as text: %+v", whole)
	}
	binary := runAssertions([]model.Assertion{{Enabled: true, Target: "body", Operator: "exists"}}, model.HttpResponse{StatusCode: 200, BodyIsBinary: true})[0]
	if binary.Passed || !strings.Contains(binary.Error, "not kept as text") {
		t.Errorf("binary body result = %+v", binary)
	}
}

func TestSendRequestRunsAssertionsAfterTheTestScript(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"42","token":"tok-very-secret"}`))
	}))
	defer server.Close()

	resp := NewApp().SendRequest(model.HttpRequest{
		Method:                  http.MethodPost,
		URL:                     server.URL + "/orders",
		TestScript:              `pm.test("script test", () => pm.expect(1).to.eql(1))`,
		ScriptEngine:            "js",
		Assertions:              []model.Assertion{{Enabled: true, Target: "status", Operator: "eq", Value: "201"}, {Enabled: true, Target: "body.token", Operator: "eq", Value: "tok-very-secret"}},
		SecretEnvironmentValues: []string{"tok-very-secret"},
		FollowRedirects:         true,
		TimeoutMs:               5000,
		HTTPVersion:             "auto",
		EnableSSLVerification:   true,
		MaxRedirects:            10,
	})
	if resp.Error != "" {
		t.Fatal(resp.Error)
	}
	tests := resp.TestResult.Tests
	if len(tests) != 3 || tests[0].Name != "script test" || tests[1].Name != "status equals 201" || !tests[1].Passed || !tests[2].Passed {
		t.Fatalf("tests = %+v", tests)
	}
	if strings.Contains(tests[2].Name, "tok-very-secret") {
		t.Fatalf("a secret expected value leaked into the test name: %q", tests[2].Name)
	}
}

func TestAssertionsAreStrippedForFilesystem(t *testing.T) {
	request := map[string]any{
		"id": "r1", "requestType": "http", "name": "Req", "method": "GET", "url": "https://example.test",
		"assertions": []any{
			map[string]any{"id": 7, "enabled": true, "target": "status", "operator": "eq", "value": "200"},
			map[string]any{"id": 8, "enabled": true, "target": "", "operator": "eq", "value": ""},
		},
	}
	stripRequestForFilesystem(request)
	rows, _ := request["assertions"].([]any)
	if len(rows) != 1 {
		t.Fatalf("assertions = %#v", request["assertions"])
	}
	if row := rows[0].(map[string]any); row["id"] != nil || row["target"] != "status" {
		t.Fatalf("row = %#v", row)
	}

	empty := map[string]any{"id": "r2", "requestType": "http", "assertions": []any{map[string]any{"id": 1, "target": " "}}}
	stripRequestForFilesystem(empty)
	if _, ok := empty["assertions"]; ok {
		t.Fatal("a list of blank rows should be dropped")
	}
	socket := map[string]any{"id": "r3", "requestType": "ws", "assertions": []any{map[string]any{"target": "status"}}}
	stripRequestForFilesystem(socket)
	if _, ok := socket["assertions"]; ok {
		t.Fatal("assertions only apply to HTTP and GraphQL requests")
	}
}

func TestCLIRunFailsOnAFailedAssertionAndReportsIt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[1,2,3]}`))
	}))
	defer server.Close()

	root := writeYAMLWorkspace(t, server.URL)
	path := filepath.Join(root, "workspaces", "Demo", "collections", "Smoke", "requests", "GET-1-ok.yml")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	checks := strings.Join([]string{
		"  assertions:",
		"    - enabled: true",
		"      target: status",
		"      operator: eq",
		"      value: \"200\"",
		"    - enabled: true",
		"      target: body.items",
		"      operator: length",
		"      value: \"4\"",
		"  settings: {}",
	}, "\n")
	updated := strings.Replace(string(data), "  settings: {}", checks, 1)
	if err := os.WriteFile(path, []byte(updated), 0o644); err != nil {
		t.Fatal(err)
	}

	junitPath := filepath.Join(t.TempDir(), "report.xml")
	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, env: "Local", reporters: []string{"cli", "junit"}, reporterJUnitExport: junitPath, iterations: 1, stdout: &out, stderr: &out})
	if code != 1 {
		t.Fatalf("a failed assertion should fail the run, got exit %d:\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "body.items has length 4") || !strings.Contains(out.String(), "got length 3") {
		t.Fatalf("the CLI should name the failed assertion and why:\n%s", out.String())
	}
	report, err := os.ReadFile(junitPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(report), `failures="1"`) || !strings.Contains(string(report), "body.items has length 4 — got length 3") {
		t.Fatalf("junit report:\n%s", report)
	}
}

func TestMCPSaveRequestWritesAssertions(t *testing.T) {
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	h := startMCPHarness(t, mcpServerOptions{workspace: root, env: "Local"})

	var saved struct {
		ID   string `json:"id"`
		File string `json:"file"`
	}
	h.tool("save_request", map[string]any{
		"collection": "Smoke",
		"name":       "Checked",
		"method":     "GET",
		"url":        "{{baseUrl}}/checked",
		"assertions": []map[string]any{{"target": "status", "operator": "eq", "value": "200"}, {"target": "body", "operator": "exists", "value": "ignored"}},
	}, &saved)
	file := readWorkspaceFile(t, root, saved.File)
	for _, want := range []string{"assertions:", "target: status", "operator: eq", "operator: exists"} {
		if !strings.Contains(file, want) {
			t.Errorf("request file is missing %q:\n%s", want, file)
		}
	}
	if strings.Contains(file, "ignored") {
		t.Errorf("exists takes no value:\n%s", file)
	}

	var detail struct {
		Assertions []model.Assertion `json:"assertions"`
	}
	h.tool("get_request", map[string]any{"request": saved.ID}, &detail)
	if len(detail.Assertions) != 2 || detail.Assertions[0].Target != "status" {
		t.Fatalf("get_request assertions = %+v", detail.Assertions)
	}

	var run mcpRequestOutcome
	h.tool("run_request", map[string]any{"request": saved.ID}, &run)
	if run.TestsTotal != 2 || run.TestsPassed != 2 {
		t.Fatalf("run_request = %+v", run)
	}

	if result := h.tool("save_request", map[string]any{"request": saved.ID, "assertions": []map[string]any{{"target": "status", "operator": "roughly"}}}, nil); !result.IsError || !strings.Contains(result.Content[0].Text, "unknown operator") {
		t.Fatalf("an unknown operator should be refused: %+v", result)
	}
	tooMany := make([]map[string]any, maxRequestAssertions+1)
	for i := range tooMany {
		tooMany[i] = map[string]any{"target": "status", "operator": "exists"}
	}
	if result := h.tool("save_request", map[string]any{"request": saved.ID, "assertions": tooMany}, nil); !result.IsError || !strings.Contains(result.Content[0].Text, "up to 200") {
		t.Fatalf("more than the limit should be refused: %+v", result)
	}
	h.tool("save_request", map[string]any{"request": saved.ID, "assertions": []map[string]any{}}, nil)
	if file := readWorkspaceFile(t, root, saved.File); strings.Contains(file, "assertions:") {
		t.Fatalf("[] should remove the assertions:\n%s", file)
	}
}

package api

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestMCPServerDiagnosesTheLastFailure(t *testing.T) {
	withRequestStoreTestKey(t)
	useTempConfigDir(t, t.TempDir())
	app := NewApp()

	var store map[string]any
	if err := json.Unmarshal([]byte(kurloSaveFlowPayload("https://api.example.test/v1/orders/1", "{{token}}", []string{"req-main"}, "")), &store); err != nil {
		t.Fatal(err)
	}
	requests := store["requests"].([]any)
	requests[0].(map[string]any)["examples"] = []any{map[string]any{
		"id": "example-ok", "requestId": "req-main", "name": "Order", "source": "manual", "createdAt": 1,
		"snapshot": map[string]any{"method": "GET", "url": "https://api.example.test/v1/orders/1", "params": []any{}, "headers": []any{}, "bodyType": "none", "bodyContent": ""},
		"response": map[string]any{
			"statusCode": 200, "status": "200 OK", "bodyMediaType": "application/json",
			"headers": []any{map[string]any{"id": 1, "enabled": true, "key": "Content-Type", "value": "application/json"}},
			"body":    `{"id":"o-1","total":5,"items":[{"sku":"a"}]}`,
		},
		"match": map[string]any{"pathTemplate": "/v1/orders/:id"},
	}}
	now := time.Now().UnixMilli()
	snapshot := func(id, url string, auth map[string]any) map[string]any {
		return map[string]any{"id": id, "name": "Get order", "requestType": "http", "method": "GET", "url": url, "auth": auth}
	}
	bearer := map[string]any{"type": "bearer", "bearerToken": "{{token}}"}
	store["history"] = []any{
		map[string]any{"id": "h-ok", "statusCode": 200, "status": "200 OK", "createdAt": now, "responseStored": true, "request": snapshot("s-ok", "https://api.example.test/health", map[string]any{"type": "none"})},
		map[string]any{"id": "h-401", "sourceRequestId": "req-main", "statusCode": 401, "status": "401 Unauthorized", "createdAt": now - 1000, "responseStored": true, "request": snapshot("s-401", "https://api.example.test/v1/orders/1", bearer)},
		map[string]any{"id": "h-refused", "statusCode": 0, "createdAt": now - 2000, "responseStored": true, "request": snapshot("s-refused", "{{baseUrl}}/orders/1", map[string]any{"type": "none"})},
		map[string]any{"id": "h-tests", "sourceRequestId": "req-main", "statusCode": 200, "status": "200 OK", "createdAt": now - 3000, "responseStored": true, "request": snapshot("s-tests", "https://api.example.test/v1/orders/1", bearer)},
	}
	payload, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	if result := app.SaveRequestStoreWithError(string(payload)); !result.Ok {
		t.Fatalf("save: %s", result.Error)
	}
	for id, response := range map[string]map[string]any{
		"h-ok":      {"statusCode": 200, "status": "200 OK", "body": "ok", "testResult": map[string]any{"tests": []any{map[string]any{"name": "is up", "passed": true}}}},
		"h-401":     {"statusCode": 401, "status": "401 Unauthorized", "body": `{"error":"missing token"}`},
		"h-refused": {"error": "Get \"http://127.0.0.1:1/orders/1\": dial tcp 127.0.0.1:1: connect: connection refused"},
		"h-tests": {
			"statusCode": 200, "status": "200 OK", "body": `{"id":"o-1","total":"5"}`,
			"headers":    []any{map[string]any{"key": "Content-Type", "value": "application/json"}},
			"testResult": map[string]any{"tests": []any{map[string]any{"name": "total is a number", "passed": false, "error": "expected '5' to be a number"}}},
		},
	} {
		data, _ := json.Marshal(response)
		if result := app.SaveHistoryResponse(id, string(data)); !result.Stored {
			t.Fatalf("store %s: %+v", id, result)
		}
	}

	h := startMCPHarness(t, mcpServerOptions{workspace: fileWorkspaceStorePath(), loadAppSecrets: true, readOnly: true})
	diagnose := func(entry string) mcpDiagnosis {
		var out mcpDiagnosis
		args := map[string]any{}
		if entry != "" {
			args["entry"] = entry
		}
		h.tool("diagnose_last_failure", args, &out)
		return out
	}
	hints := func(d mcpDiagnosis) string { return strings.Join(d.Hints, "\n") }

	last := diagnose("")
	if last.Entry != "h-401" || last.Status != 401 || last.SavedRequest != "Core/Auth/Main request" || last.Environment != "Local" {
		t.Fatalf("the newest failure should be picked, skipping the passing request: %+v", last)
	}
	if strings.Join(last.Unresolved, ",") != "token" || !strings.Contains(hints(last), "{{token}}") || !strings.Contains(hints(last), "login request") {
		t.Fatalf("a 401 with an unset token should say to log in first: %+v", last)
	}
	if last.Example == nil || last.Example.StatusMatches {
		t.Errorf("the 401 should be compared with the 200 example: %+v", last.Example)
	}

	refused := diagnose("h-refused")
	if !strings.Contains(hints(refused), "{{baseUrl}}") || !strings.Contains(hints(refused), "Nothing is listening") {
		t.Fatalf("an unset baseUrl and a refused connection should both be named: %+v", refused.Hints)
	}

	tests := diagnose("h-tests")
	if len(tests.FailedTests) != 1 || tests.FailedTests[0].Name != "total is a number" {
		t.Fatalf("failed tests = %+v", tests.FailedTests)
	}
	diff := tests.Example
	if diff == nil || !diff.StatusMatches || strings.Join(diff.MissingFields, ",") != "items,items[].sku" || strings.Join(diff.TypeChanges, ",") != "total: number → string" {
		t.Fatalf("example diff = %+v", diff)
	}
	if !strings.Contains(hints(tests), "lacks fields") || !strings.Contains(hints(tests), "changed type") {
		t.Fatalf("hints = %v", tests.Hints)
	}
}

func TestMCPDiagnosisHintsCoverTheCommonStatuses(t *testing.T) {
	cases := []struct {
		status  int
		err     string
		headers []model.KeyValue
		want    string
	}{
		{0, "dial tcp: lookup api.nope.test: no such host", nil, "does not resolve"},
		{0, "Error: getaddrinfo ENOTFOUND api.nope.test", nil, "does not resolve"},
		{0, "Error: connect ECONNREFUSED 127.0.0.1:3005", nil, "Nothing is listening"},
		{0, "read tcp 127.0.0.1:5000: read: connection reset by peer", nil, "closed the connection"},
		{0, "Error: connect ETIMEDOUT 10.0.0.1:443", nil, "did not answer in time"},
		{0, "pre-request script failed: TypeError: Cannot read property 'code' of undefined", nil, "pre-request script threw"},
		{0, "invalid URL: parse \"localhost:3005/x\": first path segment in URL cannot contain colon", nil, "not a valid address"},
		{0, "context deadline exceeded", nil, "did not answer in time"},
		{0, "tls: failed to verify certificate: x509: certificate signed by unknown authority", nil, "TLS handshake failed"},
		{401, "", nil, "sends none"},
		{403, "", nil, "not allowed"},
		{404, "", nil, "Nothing answers GET"},
		{405, "", []model.KeyValue{{Key: "Allow", Value: "POST"}}, "allows POST"},
		{415, "", nil, "Content-Type"},
		{422, "", nil, "names the field"},
		{429, "", []model.KeyValue{{Key: "Retry-After", Value: "30"}}, "wait 30 seconds"},
		{503, "", nil, "server's logs"},
	}
	for _, c := range []struct{ url, err, want string }{
		{"localhost:3005/api/hook", "Error: connect ECONNREFUSED 127.0.0.1:3005", "Nothing is listening at localhost:3005"},
		{"GET https://httpbin.org/headers", "invalid URL: parse \"GET https://httpbin.org/headers\": first path segment in URL cannot contain colon", `Remove "GET" from the URL`},
		{"https://api.test/x", "pre-request script failed: TypeError: boom", "never sent: TypeError: boom."},
	} {
		d := mcpDiagnosis{Error: c.err, Method: "GET", URL: c.url}
		got := strings.Join(mcpDiagnosisHints(d, cliSavedRequest{Method: "GET", URL: c.url}, nil), "\n")
		if !strings.Contains(got, c.want) {
			t.Errorf("%s %q: hints %q do not mention %q", c.url, c.err, got, c.want)
		}
	}
	for _, c := range cases {
		d := mcpDiagnosis{Status: c.status, Error: c.err, Method: "GET", URL: "https://api.nope.test/x", Environment: "Local"}
		got := strings.Join(mcpDiagnosisHints(d, cliSavedRequest{Method: "GET", URL: "https://api.nope.test/x"}, &model.HttpResponse{StatusCode: c.status, Headers: c.headers}), "\n")
		if !strings.Contains(got, c.want) {
			t.Errorf("status %d %q: hints %q do not mention %q", c.status, c.err, got, c.want)
		}
	}
}

package api

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestMCPServerReadsWhatTheAppSent(t *testing.T) {
	withRequestStoreTestKey(t)
	useTempConfigDir(t, t.TempDir())
	app := NewApp()

	var store map[string]any
	if err := json.Unmarshal([]byte(kurloSaveFlowPayload("https://api.example.test/v1", "main-bearer-token", []string{"req-main"}, "")), &store); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	store["history"] = []any{
		map[string]any{
			"id": "history-new", "sourceRequestId": "req-main", "statusCode": 500, "status": "500 Internal Server Error",
			"duration": 87, "createdAt": now, "responseStored": true, "responseSize": 64, "responseContentType": "application/json",
			"request": map[string]any{
				"id": "snap-1", "name": "Main request", "requestType": "http", "method": "POST", "url": "https://api.example.test/v1/orders",
				"headers": []any{
					map[string]any{"enabled": true, "key": "Authorization", "value": "Bearer literal-header-token"},
					map[string]any{"enabled": true, "key": "X-Trace", "value": "abc"},
				},
				"auth":     map[string]any{"type": "bearer", "bearerToken": "main-bearer-token"},
				"bodyType": "json", "bodyContent": `{"amount":5}`,
			},
		},
		map[string]any{
			"id": "history-old", "statusCode": 200, "status": "200 OK", "duration": 12, "createdAt": now - 60_000, "responseStored": false,
			"request": map[string]any{"id": "snap-2", "name": "Health", "requestType": "http", "method": "GET", "url": "https://api.example.test/health"},
		},
	}
	payload, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	if result := app.SaveRequestStoreWithError(string(payload)); !result.Ok {
		t.Fatalf("save: %s", result.Error)
	}
	response, err := json.Marshal(map[string]any{
		"statusCode": 500, "status": "500 Internal Server Error", "duration": 87, "size": 64,
		"headers": []any{map[string]any{"key": "Content-Type", "value": "application/json"}},
		"body":    `{"error":"token main-bearer-token is not allowed to create orders"}`,
		"testResult": map[string]any{
			"tests": []any{map[string]any{"name": "status is 201", "passed": false, "error": "expected 500 to equal 201"}},
			"logs":  []any{"sending with main-bearer-token"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result := app.SaveHistoryResponse("history-new", string(response)); !result.Stored {
		t.Fatalf("store response: %+v", result)
	}

	h := startMCPHarness(t, mcpServerOptions{workspace: fileWorkspaceStorePath(), loadAppSecrets: true, readOnly: true})

	var list struct {
		Count   int                 `json:"count"`
		Entries []mcpHistorySummary `json:"entries"`
	}
	h.tool("list_history", map[string]any{}, &list)
	if list.Count != 2 || list.Entries[0].ID != "history-new" || list.Entries[0].SavedRequest != "Core/Auth/Main request" || list.Entries[0].Method != "POST" {
		t.Fatalf("list_history = %+v", list)
	}
	h.tool("list_history", map[string]any{"failedOnly": true}, &list)
	if list.Count != 1 || list.Entries[0].Status != 500 {
		t.Fatalf("failedOnly = %+v", list)
	}
	h.tool("list_history", map[string]any{"query": "health"}, &list)
	if list.Count != 1 || list.Entries[0].ID != "history-old" {
		t.Fatalf("query = %+v", list)
	}

	result := h.tool("get_history_entry", map[string]any{}, nil)
	text := result.Content[0].Text
	if result.IsError {
		t.Fatalf("get_history_entry: %s", text)
	}
	for _, leaked := range []string{"main-bearer-token", "literal-header-token"} {
		if strings.Contains(text, leaked) {
			t.Errorf("%q leaked:\n%s", leaked, text)
		}
	}
	var entry struct {
		ID      string `json:"id"`
		Request struct {
			Headers []mcpKeyValue  `json:"headers"`
			Auth    map[string]any `json:"auth"`
			Body    string         `json:"body"`
		} `json:"request"`
		Response struct {
			Status     int             `json:"status"`
			Body       string          `json:"body"`
			Tests      []cliTestResult `json:"tests"`
			TestsTotal int             `json:"testsTotal"`
			Logs       []string        `json:"logs"`
		} `json:"response"`
	}
	if err := json.Unmarshal(result.StructuredContent, &entry); err != nil {
		t.Fatal(err)
	}
	if entry.ID != "history-new" || entry.Response.Status != 500 || entry.Response.TestsTotal != 1 || !strings.Contains(entry.Response.Body, "[secret]") || len(entry.Response.Logs) != 1 {
		t.Fatalf("entry = %+v", entry)
	}
	if entry.Request.Auth["type"] != "bearer" || len(entry.Request.Auth) != 1 || entry.Request.Body != `{"amount":5}` {
		t.Fatalf("request = %+v", entry.Request)
	}
	if entry.Request.Headers[0].Value != "[secret]" || entry.Request.Headers[1].Value != "abc" {
		t.Fatalf("headers = %+v", entry.Request.Headers)
	}

	result = h.tool("get_history_entry", map[string]any{"entry": "history-old"}, nil)
	if result.IsError || !strings.Contains(result.Content[0].Text, "did not keep") {
		t.Fatalf("an entry without a stored response: %+v", result)
	}

	if result := app.SaveHistoryResponse("history-old", `{"statusCode":200,"status":"200 OK","body":"healthy"}`); !result.Stored {
		t.Fatalf("store response: %+v", result)
	}
	h.tool("list_history", map[string]any{"query": "health"}, &list)
	if list.Count != 1 || !list.Entries[0].ResponseStored {
		t.Fatalf("an entry whose mark was lost should still show its stored response: %+v", list)
	}
	result = h.tool("get_history_entry", map[string]any{"entry": "history-old"}, nil)
	if result.IsError || !strings.Contains(result.Content[0].Text, "healthy") {
		t.Fatalf("an entry whose mark was lost should return its stored response: %+v", result)
	}
	if result := h.tool("get_history_entry", map[string]any{"entry": "nope"}, nil); !result.IsError {
		t.Fatal("an unknown entry should be an error")
	}
}

func TestMCPServerHistoryIsEmptyOnAFreshMachine(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := echoServer(t)
	h := startMCPHarness(t, mcpServerOptions{workspace: writeYAMLWorkspace(t, server.URL)})
	var list struct {
		Count int `json:"count"`
	}
	h.tool("list_history", map[string]any{}, &list)
	if list.Count != 0 {
		t.Fatalf("count = %d", list.Count)
	}
	if result := h.tool("get_history_entry", map[string]any{}, nil); !result.IsError || !strings.Contains(result.Content[0].Text, "empty") {
		t.Fatalf("get_history_entry on no history: %+v", result)
	}
}

package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	mcpHistoryDefaultLimit = 20
	mcpHistoryMaxLimit     = 100
)

type mcpStoredHistoryEntry struct {
	ID                  string          `json:"id"`
	Request             cliSavedRequest `json:"request"`
	SourceRequestID     string          `json:"sourceRequestId"`
	StatusCode          int             `json:"statusCode"`
	Status              string          `json:"status"`
	Duration            int64           `json:"duration"`
	CreatedAt           int64           `json:"createdAt"`
	ResponseStored      bool            `json:"responseStored"`
	ResponseSize        int64           `json:"responseSize"`
	ResponseContentType string          `json:"responseContentType"`
	ResponseTruncated   bool            `json:"responseTruncated"`
}

type mcpHistorySummary struct {
	ID             string `json:"id"`
	SentAt         string `json:"sentAt"`
	Name           string `json:"name"`
	SavedRequest   string `json:"savedRequest,omitempty"`
	Method         string `json:"method"`
	URL            string `json:"url"`
	Status         int    `json:"status"`
	StatusText     string `json:"statusText,omitempty"`
	DurationMs     int64  `json:"durationMs"`
	Size           int64  `json:"size"`
	ContentType    string `json:"contentType,omitempty"`
	ResponseStored bool   `json:"responseStored"`
}

type mcpAppHistory struct {
	entries             []mcpStoredHistoryEntry
	secrets             []string
	activeEnvironmentID string
}

func loadMCPAppHistory() (mcpAppHistory, error) {
	store, _, err := loadLocalRequestStore(requestStorePath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return mcpAppHistory{}, nil
		}
		return mcpAppHistory{}, fmt.Errorf("could not read Kurlo's history: %v", err)
	}
	var history mcpAppHistory
	raw, err := json.Marshal(store["history"])
	if err != nil {
		return history, err
	}
	if string(raw) != "null" {
		if err := json.Unmarshal(raw, &history.entries); err != nil {
			return history, fmt.Errorf("could not read Kurlo's history: %v", err)
		}
	}
	history.activeEnvironmentID = stringValue(store, "activeEnvironmentId")
	sort.SliceStable(history.entries, func(i, j int) bool { return history.entries[i].CreatedAt > history.entries[j].CreatedAt })
	stored := storedHistoryResponseIDs()
	for i := range history.entries {
		history.entries[i].ResponseStored = stored[history.entries[i].ID]
	}
	for _, value := range stringMap(store["secrets"]) {
		history.secrets = append(history.secrets, value)
	}
	for _, row := range mapSlice(store["globals"]) {
		if boolValue(row["secret"]) {
			history.secrets = append(history.secrets, stringValue(row, "value"))
		}
	}
	return history, nil
}

func mcpHistoryMethod(req cliSavedRequest) string {
	if isGraphQLRequest(req) {
		return "POST"
	}
	switch mcpRequestType(req) {
	case "http", "graphql":
		return strings.ToUpper(defaultString(req.Method, "GET"))
	default:
		return strings.ToUpper(mcpRequestType(req))
	}
}

func (s *mcpServer) savedRequestPaths() map[string]string {
	paths := map[string]string{}
	ws, err := s.loadWorkspace()
	if err != nil {
		return paths
	}
	for _, req := range ws.requests {
		paths[req.ID] = mcpRequestPath(req)
	}
	return paths
}

func mcpHistorySecrets(history mcpAppHistory, entry mcpStoredHistoryEntry) []string {
	secrets := append([]string{}, history.secrets...)
	auth, err := json.Marshal(entry.Request.Auth)
	if err == nil {
		var fields map[string]any
		_ = json.Unmarshal(auth, &fields)
		for _, field := range requestAuthSecretFields {
			if value := stringFromAny(fields[field]); secretFieldNeedsVault(value) {
				if _, placeholder := kurloSecretKeyFromPlaceholder(value); !placeholder {
					secrets = append(secrets, value)
				}
			}
		}
	}
	for _, rows := range [][]cliKV{entry.Request.Params, entry.Request.Headers, entry.Request.FormRows} {
		for _, row := range rows {
			if row.Secret {
				secrets = append(secrets, row.Value)
			}
		}
	}
	kept := secrets[:0]
	for _, value := range secrets {
		if len(value) >= 4 {
			kept = append(kept, value)
		}
	}
	return kept
}

func (s *mcpServer) toolListHistory(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Limit      int    `json:"limit"`
		Query      string `json:"query"`
		FailedOnly bool   `json:"failedOnly"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	limit := args.Limit
	if limit <= 0 {
		limit = mcpHistoryDefaultLimit
	}
	if limit > mcpHistoryMaxLimit {
		limit = mcpHistoryMaxLimit
	}
	history, err := loadMCPAppHistory()
	if err != nil {
		return nil, err
	}
	paths := s.savedRequestPaths()
	terms := strings.Fields(strings.ToLower(args.Query))
	entries := []mcpHistorySummary{}
	for _, entry := range history.entries {
		if args.FailedOnly && entry.StatusCode != 0 && entry.StatusCode < 400 {
			continue
		}
		summary := mcpSummarizeHistory(entry, paths, mcpHistorySecrets(history, entry))
		if !mcpMatchesTerms(strings.ToLower(strings.Join([]string{summary.Name, summary.SavedRequest, summary.Method, summary.URL, fmt.Sprint(summary.Status)}, " ")), terms) {
			continue
		}
		entries = append(entries, summary)
		if len(entries) == limit {
			break
		}
	}
	return map[string]any{"count": len(entries), "entries": entries}, nil
}

func mcpSummarizeHistory(entry mcpStoredHistoryEntry, paths map[string]string, secrets []string) mcpHistorySummary {
	return mcpHistorySummary{
		ID:             entry.ID,
		SentAt:         time.UnixMilli(entry.CreatedAt).UTC().Format(time.RFC3339),
		Name:           mcpRequestLabel(entry.Request),
		SavedRequest:   paths[entry.SourceRequestID],
		Method:         mcpHistoryMethod(entry.Request),
		URL:            redactSecrets(entry.Request.URL, secrets),
		Status:         entry.StatusCode,
		StatusText:     entry.Status,
		DurationMs:     entry.Duration,
		Size:           entry.ResponseSize,
		ContentType:    entry.ResponseContentType,
		ResponseStored: entry.ResponseStored,
	}
}

var mcpSensitiveRequestHeaders = map[string]bool{"authorization": true, "proxy-authorization": true, "cookie": true, "x-api-key": true}

func mcpHistoryRows(rows []cliKV, secrets []string, sensitive map[string]bool) []mcpKeyValue {
	out := []mcpKeyValue{}
	for _, row := range rows {
		if !row.Enabled || strings.TrimSpace(row.Key) == "" {
			continue
		}
		value := redactSecrets(row.Value, secrets)
		switch {
		case row.Secret:
			value = "<secret>"
		case sensitive[strings.ToLower(strings.TrimSpace(row.Key))] && secretFieldNeedsVault(value):
			value = "[secret]"
		case row.IsFile:
			value = "<file " + defaultString(row.FileName, row.Value) + ">"
		}
		out = append(out, mcpKeyValue{Key: row.Key, Value: value})
	}
	return out
}

func (s *mcpServer) toolGetHistoryEntry(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Entry        string `json:"entry"`
		MaxBodyBytes int    `json:"maxBodyBytes"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	history, err := loadMCPAppHistory()
	if err != nil {
		return nil, err
	}
	if len(history.entries) == 0 {
		return nil, fmt.Errorf("Kurlo's history is empty: nothing has been sent from the app on this machine yet")
	}
	entry := history.entries[0]
	if ref := strings.TrimSpace(args.Entry); ref != "" && ref != "last" {
		found := false
		for _, candidate := range history.entries {
			if candidate.ID == ref {
				entry, found = candidate, true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("no history entry %q; call list_history to see them", ref)
		}
	}
	secrets := mcpHistorySecrets(history, entry)
	req := entry.Request
	request := map[string]any{
		"name":     mcpRequestLabel(req),
		"type":     mcpRequestType(req),
		"method":   mcpHistoryMethod(req),
		"url":      redactSecrets(req.URL, secrets),
		"params":   mcpHistoryRows(req.Params, secrets, nil),
		"headers":  mcpHistoryRows(req.Headers, secrets, mcpSensitiveRequestHeaders),
		"bodyType": defaultString(req.BodyType, "none"),
		"auth":     map[string]any{"type": defaultString(req.Auth.Type, "none")},
	}
	if path := s.savedRequestPaths()[entry.SourceRequestID]; path != "" {
		request["savedRequest"] = path
	}
	if req.BodyContent != "" {
		request["body"] = redactSecrets(req.BodyContent, secrets)
	}
	if rows := mcpHistoryRows(req.PathParams, secrets, nil); len(rows) > 0 {
		request["pathVariables"] = rows
	}
	if rows := mcpHistoryRows(req.FormRows, secrets, nil); len(rows) > 0 {
		request["form"] = rows
	}
	result := map[string]any{
		"id":      entry.ID,
		"sentAt":  time.UnixMilli(entry.CreatedAt).UTC().Format(time.RFC3339),
		"request": request,
	}
	if !entry.ResponseStored {
		result["response"] = map[string]any{"status": entry.StatusCode, "statusText": entry.Status, "durationMs": entry.Duration, "note": "Kurlo did not keep this response's body and headers"}
		return result, nil
	}
	stored := readHistoryResponse(entry.ID)
	if stored.Error != "" {
		return nil, fmt.Errorf("could not read the stored response: %s", stored.Error)
	}
	var resp model.HttpResponse
	if !stored.Stored || json.Unmarshal([]byte(stored.Payload), &resp) != nil {
		result["response"] = map[string]any{"status": entry.StatusCode, "statusText": entry.Status, "durationMs": entry.Duration, "note": "the stored response is gone or unreadable"}
		return result, nil
	}
	result["response"] = mcpHistoryResponse(resp, entry, secrets, mcpBodyLimit(args.MaxBodyBytes))
	return result, nil
}

func mcpHistoryResponse(resp model.HttpResponse, entry mcpStoredHistoryEntry, secrets []string, bodyLimit int) map[string]any {
	out := map[string]any{
		"status":     resp.StatusCode,
		"statusText": resp.Status,
		"durationMs": resp.Duration,
		"size":       resp.Size,
	}
	if resp.Error != "" {
		out["error"] = redactSecrets(resp.Error, secrets)
	}
	headers := make([]mcpHeader, 0, len(resp.Headers))
	for _, header := range resp.Headers {
		headers = append(headers, mcpHeader{Name: header.Key, Value: redactSecrets(header.Value, secrets)})
	}
	out["headers"] = headers
	switch {
	case resp.BodyIsBinary:
		out["bodyOmitted"] = fmt.Sprintf("binary body (%s, %d bytes) is not included", defaultString(resp.BodySniffedType, entry.ResponseContentType), resp.Size)
	case resp.Body != "":
		body, truncated := mcpTruncate(redactSecrets(resp.Body, secrets), bodyLimit)
		out["body"] = body
		if truncated || entry.ResponseTruncated {
			out["bodyTruncated"] = true
		}
	}
	var tests []cliTestResult
	passed := 0
	for _, test := range resp.TestResult.Tests {
		tests = append(tests, cliTestResult{Name: test.Name, Passed: test.Passed, Error: redactSecrets(test.Error, secrets)})
		if test.Passed {
			passed++
		}
	}
	if len(tests) > 0 {
		out["tests"] = tests
		out["testsPassed"] = passed
		out["testsTotal"] = len(tests)
	}
	var logs []string
	for _, log := range append(append([]string{}, resp.PreRequestResult.Logs...), resp.TestResult.Logs...) {
		logs = append(logs, redactSecrets(log, secrets))
	}
	if len(logs) > 0 {
		out["logs"] = logs
	}
	for _, scriptErr := range []struct{ key, value string }{{"preRequestScriptError", resp.PreRequestResult.Error}, {"testScriptError", resp.TestResult.Error}} {
		if scriptErr.value != "" {
			out[scriptErr.key] = redactSecrets(scriptErr.value, secrets)
		}
	}
	if len(resp.Warnings) > 0 {
		var warnings []string
		for _, warning := range resp.Warnings {
			warnings = append(warnings, redactSecrets(warning, secrets))
		}
		out["warnings"] = warnings
	}
	return out
}

func mcpServerHistoryTools() []map[string]any {
	readOnly := map[string]any{"readOnlyHint": true, "openWorldHint": false}
	return []map[string]any{
		{
			"name":  "list_history",
			"title": "List requests sent from the Kurlo app",
			"description": "List the requests the user recently sent from the Kurlo app on this machine, newest first, with status, timing and the saved request each came from. " +
				"Use it when the user refers to something they just sent or saw in Kurlo, then get_history_entry to read one.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"limit":      map[string]any{"type": "integer", "description": "Most entries to return (default 20, max 100)."},
					"query":      map[string]any{"type": "string", "description": "Only entries whose name, saved request, method, URL or status contains every word of this text."},
					"failedOnly": map[string]any{"type": "boolean", "description": "Only requests that failed to send or got a 4xx or 5xx status."},
				},
			},
			"annotations": readOnly,
		},
		{
			"name":  "get_history_entry",
			"title": "Show a request sent from the Kurlo app",
			"description": "Show one request the user sent from the Kurlo app and the response they got: status, headers, body, errors, test results and script logs. " +
				"Without entry it shows the last one sent, so \"why did my last request fail?\" needs no other input. Secrets are masked.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"entry":        map[string]any{"type": "string", "description": "History entry id from list_history. Omit, or pass \"last\", for the newest."},
					"maxBodyBytes": map[string]any{"type": "integer", "description": "Most bytes of the response body to return (default 65536, max 1048576)."},
				},
			},
			"annotations": readOnly,
		},
	}
}

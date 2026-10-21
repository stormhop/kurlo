package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	mcpDiagnoseScanEntries     = 50
	mcpDiagnoseScanResponses   = 20
	mcpDiagnoseBodyLimit       = 2 * 1024
	mcpDiagnoseMaxFieldChanges = 20
)

type mcpDiagnosis struct {
	Entry        string          `json:"entry"`
	SentAt       string          `json:"sentAt"`
	SavedRequest string          `json:"savedRequest,omitempty"`
	Method       string          `json:"method"`
	URL          string          `json:"url"`
	Environment  string          `json:"environment,omitempty"`
	Status       int             `json:"status"`
	StatusText   string          `json:"statusText,omitempty"`
	Error        string          `json:"error,omitempty"`
	DurationMs   int64           `json:"durationMs"`
	Body         string          `json:"body,omitempty"`
	FailedTests  []cliTestResult `json:"failedTests,omitempty"`
	ScriptErrors []string        `json:"scriptErrors,omitempty"`
	Unresolved   []string        `json:"unresolvedVariables,omitempty"`
	Example      *mcpExampleDiff `json:"example,omitempty"`
	Hints        []string        `json:"hints"`
}

type mcpExampleDiff struct {
	Name          string   `json:"name"`
	Status        int      `json:"status"`
	StatusMatches bool     `json:"statusMatches"`
	MissingFields []string `json:"missingFields,omitempty"`
	ExtraFields   []string `json:"extraFields,omitempty"`
	TypeChanges   []string `json:"typeChanges,omitempty"`
}

func (s *mcpServer) toolDiagnoseLastFailure(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Entry       string `json:"entry"`
		Environment string `json:"environment"`
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
	entry, resp, found, err := mcpFindFailure(history, args.Entry)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("none of the last %d requests sent from Kurlo failed: every one got a 1xx-3xx status and passed its tests", min(len(history.entries), mcpDiagnoseScanEntries))
	}

	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	secrets := mcpHistorySecrets(history, entry)
	req := entry.Request
	diagnosis := mcpDiagnosis{
		Entry:      entry.ID,
		SentAt:     time.UnixMilli(entry.CreatedAt).UTC().Format(time.RFC3339),
		Method:     mcpHistoryMethod(req),
		URL:        redactSecrets(req.URL, secrets),
		Status:     entry.StatusCode,
		StatusText: entry.Status,
		DurationMs: entry.Duration,
		Hints:      []string{},
	}
	var saved *cliSavedRequest
	for i := range ws.requests {
		if ws.requests[i].ID == entry.SourceRequestID {
			saved = &ws.requests[i]
			diagnosis.SavedRequest = mcpRequestPath(*saved)
		}
	}
	if resp != nil {
		diagnosis.Status = defaultInt(resp.StatusCode, diagnosis.Status)
		diagnosis.StatusText = defaultString(resp.Status, diagnosis.StatusText)
		diagnosis.Error = redactSecrets(resp.Error, secrets)
		if !resp.BodyIsBinary && resp.Body != "" {
			diagnosis.Body, _ = mcpTruncate(redactSecrets(resp.Body, secrets), mcpDiagnoseBodyLimit)
		}
		for _, test := range resp.TestResult.Tests {
			if !test.Passed {
				diagnosis.FailedTests = append(diagnosis.FailedTests, cliTestResult{Name: test.Name, Error: redactSecrets(test.Error, secrets)})
			}
		}
		for _, scriptErr := range []string{resp.PreRequestResult.Error, resp.TestResult.Error} {
			if scriptErr != "" {
				diagnosis.ScriptErrors = append(diagnosis.ScriptErrors, redactSecrets(scriptErr, secrets))
			}
		}
	}

	envName := strings.TrimSpace(args.Environment)
	if envName == "" {
		for _, env := range ws.environments {
			if env.ID != "" && env.ID == history.activeEnvironmentID {
				envName = env.Name
			}
		}
	}
	if envName == "" {
		envName = s.opts.env
	}
	diagnosis.Environment = envName
	if values, _, err := resolveCLIValues(cliOptions{env: envName}, ws.collections, ws.environments, nil); err == nil {
		if scope := s.session[strings.ToLower(envName)]; scope != nil {
			for key, value := range scope.set {
				values[key] = value
			}
		}
		sm := state.New()
		sm.SetEnvironment(values)
		diagnosis.Unresolved = mcpUnresolvedVariables(req, &mcpRunContext{envName: envName, values: values, sm: sm})
	}
	if saved != nil && resp != nil {
		diagnosis.Example = mcpDiffAgainstExample(saved.Examples, resp)
	}
	diagnosis.Hints = mcpDiagnosisHints(diagnosis, req, resp)
	return diagnosis, nil
}

func mcpFindFailure(history mcpAppHistory, ref string) (mcpStoredHistoryEntry, *model.HttpResponse, bool, error) {
	if ref = strings.TrimSpace(ref); ref != "" && ref != "last" {
		for _, entry := range history.entries {
			if entry.ID == ref {
				return entry, mcpStoredResponse(entry), true, nil
			}
		}
		return mcpStoredHistoryEntry{}, nil, false, fmt.Errorf("no history entry %q; call list_history to see them", ref)
	}
	for i, entry := range history.entries {
		if i == mcpDiagnoseScanEntries {
			break
		}
		if entry.StatusCode == 0 || entry.StatusCode >= 400 {
			return entry, mcpStoredResponse(entry), true, nil
		}
		if i >= mcpDiagnoseScanResponses {
			continue
		}
		if resp := mcpStoredResponse(entry); resp != nil && mcpResponseFailedTests(resp) {
			return entry, resp, true, nil
		}
	}
	return mcpStoredHistoryEntry{}, nil, false, nil
}

func mcpStoredResponse(entry mcpStoredHistoryEntry) *model.HttpResponse {
	if !entry.ResponseStored {
		return nil
	}
	stored := readHistoryResponse(entry.ID)
	if !stored.Stored || stored.Error != "" {
		return nil
	}
	var resp model.HttpResponse
	if json.Unmarshal([]byte(stored.Payload), &resp) != nil {
		return nil
	}
	return &resp
}

func mcpResponseFailedTests(resp *model.HttpResponse) bool {
	if resp.TestResult.Error != "" || resp.PreRequestResult.Error != "" {
		return true
	}
	for _, test := range resp.TestResult.Tests {
		if !test.Passed {
			return true
		}
	}
	return false
}

func defaultInt(value, fallback int) int {
	if value != 0 {
		return value
	}
	return fallback
}

func mcpDiffAgainstExample(examples []cliExample, resp *model.HttpResponse) *mcpExampleDiff {
	if len(examples) == 0 {
		return nil
	}
	chosen := -1
	for i, example := range examples {
		if example.Response.StatusCode == resp.StatusCode {
			chosen = i
			break
		}
	}
	if chosen < 0 {
		for i, example := range examples {
			if code := example.Response.StatusCode; code >= 200 && code < 300 {
				chosen = i
				break
			}
		}
	}
	if chosen < 0 {
		chosen = 0
	}
	example := examples[chosen]
	diff := &mcpExampleDiff{Name: example.Name, Status: example.Response.StatusCode, StatusMatches: example.Response.StatusCode == resp.StatusCode}
	var want, got any
	if json.Unmarshal([]byte(example.Response.Body), &want) != nil || json.Unmarshal([]byte(resp.Body), &got) != nil {
		return diff
	}
	wantFields, gotFields := map[string]string{}, map[string]string{}
	mcpJSONFieldTypes(want, "", wantFields)
	mcpJSONFieldTypes(got, "", gotFields)
	for _, path := range sortedKeys(wantFields) {
		gotType, ok := gotFields[path]
		switch {
		case !ok:
			diff.MissingFields = append(diff.MissingFields, path)
		case wantFields[path] != "null" && gotType != wantFields[path]:
			diff.TypeChanges = append(diff.TypeChanges, fmt.Sprintf("%s: %s → %s", path, wantFields[path], gotType))
		}
	}
	for _, path := range sortedKeys(gotFields) {
		if _, ok := wantFields[path]; !ok {
			diff.ExtraFields = append(diff.ExtraFields, path)
		}
	}
	diff.MissingFields = mcpCapList(diff.MissingFields)
	diff.ExtraFields = mcpCapList(diff.ExtraFields)
	diff.TypeChanges = mcpCapList(diff.TypeChanges)
	return diff
}

func mcpCapList(values []string) []string {
	if len(values) <= mcpDiagnoseMaxFieldChanges {
		return values
	}
	return append(values[:mcpDiagnoseMaxFieldChanges:mcpDiagnoseMaxFieldChanges], fmt.Sprintf("and %d more", len(values)-mcpDiagnoseMaxFieldChanges))
}

func mcpJSONFieldTypes(value any, path string, out map[string]string) {
	switch typed := value.(type) {
	case map[string]any:
		if path != "" && !strings.HasSuffix(path, "[]") {
			out[path] = "object"
		}
		for key, child := range typed {
			mcpJSONFieldTypes(child, strings.TrimPrefix(path+"."+key, "."), out)
		}
	case []any:
		if path != "" && !strings.HasSuffix(path, "[]") {
			out[path] = "array"
		}
		for _, child := range typed {
			mcpJSONFieldTypes(child, path+"[]", out)
		}
	case string:
		out[path] = "string"
	case float64:
		out[path] = "number"
	case bool:
		out[path] = "boolean"
	case nil:
		if _, ok := out[path]; !ok {
			out[path] = "null"
		}
	}
	delete(out, "")
}

func mcpDiagnosisHints(d mcpDiagnosis, req cliSavedRequest, resp *model.HttpResponse) []string {
	var hints []string
	add := func(format string, args ...any) { hints = append(hints, fmt.Sprintf(format, args...)) }
	unresolved := map[string]bool{}
	for _, name := range d.Unresolved {
		unresolved[name] = true
	}
	inURL := mcpTemplateNames(req.URL, unresolved)
	inAuth := mcpTemplateNames(mcpAuthText(req), unresolved)
	host := mcpURLHost(d.URL)
	env := defaultString(d.Environment, "the environment")
	var headers []model.KeyValue
	if resp != nil {
		headers = resp.Headers
	}

	if len(inURL) > 0 {
		add("The URL uses %s, which nothing sets in %s, so the request did not go to a real address. Set it with set_variable or pick the environment that has it.", mcpJoinVariables(inURL), env)
	}
	switch status, lower := d.Status, strings.ToLower(d.Error); {
	case status == 0 && strings.Contains(lower, "pre-request script"):
		add("The pre-request script threw, so the request was never sent: %s. Fix the script, or run the request it depends on first.", mcpPreRequestScriptPrefix.ReplaceAllString(d.Error, ""))
	case status == 0 && mcpMethodInURL.MatchString(strings.TrimSpace(req.URL)):
		add("The URL field holds %q: the method is part of it. Remove %q from the URL and pick the method in the method selector.", strings.TrimSpace(req.URL), strings.Fields(req.URL)[0])
	case status == 0 && (strings.Contains(lower, "invalid url") || strings.Contains(lower, "unsupported protocol scheme")):
		add("The URL %s is not a valid address: it needs a scheme such as http:// and no unset {{variables}}.", d.URL)
	case status == 0 && strings.Contains(lower, "cors"):
		add("A browser would block this response: the server's CORS headers do not allow the page origin. Fix Access-Control-Allow-Origin on the server, or turn off browser emulation if the client is not a browser.")
	case status == 0 && mcpContainsAny(lower, "no such host", "server misbehaving", "enotfound", "getaddrinfo"):
		add("The host %s does not resolve. Check baseUrl in %s.", defaultString(host, "in the URL"), env)
	case status == 0 && mcpContainsAny(lower, "connection refused", "econnrefused"):
		add("Nothing is listening at %s: the server is not running, or the URL points at the wrong port.", defaultString(host, "that address"))
	case status == 0 && mcpContainsAny(lower, "connection reset", "econnreset", "eof"):
		add("The server closed the connection without answering: it crashed while handling the request, or a proxy cut it off.")
	case status == 0 && mcpContainsAny(lower, "timeout", "timed out", "deadline exceeded", "etimedout"):
		add("The server did not answer in time. It may be down or slow, or a firewall or VPN drops the connection.")
	case status == 0 && mcpContainsAny(lower, "certificate", "x509", "tls", "self signed", "self-signed", "unable to verify"):
		add("The TLS handshake failed: the certificate is self-signed, expired or for another host. Trust the certificate, or turn off certificate checks in the request's settings for a test server only.")
	case status == 0 && len(inURL) == 0:
		add("The request failed before any response: %s", defaultString(d.Error, "no error was recorded"))
	case status == 401:
		switch {
		case len(inAuth) > 0:
			add("The server wants credentials and the auth uses %s, which nothing sets in %s. Run the login request first so its script sets it, or set it in Kurlo.", mcpJoinVariables(inAuth), env)
		case !mcpSendsCredentials(req):
			add("The server wants credentials and the request sends none: set auth on the request or its collection.")
		default:
			add("The server rejected the credentials: the token may have expired or belong to another environment. Log in again and resend.")
		}
	case status == 403:
		add("The credentials were accepted but are not allowed to do this: check the user's role or the token's scopes.")
	case status == 404:
		add("Nothing answers %s %s. Check the path, the method and that baseUrl points at the right service and version.", d.Method, d.URL)
	case status == 405:
		allowed := headerLookup(headers, "Allow")
		if allowed != "" {
			add("The path exists but not for %s: the server allows %s.", d.Method, allowed)
		} else {
			add("The path exists but not for %s: check the method.", d.Method)
		}
	case status == 415:
		add("The server does not accept the body's Content-Type (%s). Send the type the endpoint expects.", defaultString(mcpSentContentType(req), "none was sent"))
	case status == 400 || status == 422:
		add("The server rejected the request's body or parameters. The response body usually names the field: compare it with the handler's validation rules.")
	case status == 429:
		if retry := headerLookup(headers, "Retry-After"); retry != "" {
			add("Rate limited: wait %s seconds before sending again.", retry)
		} else {
			add("Rate limited: slow down or wait before sending again.")
		}
	case status >= 500:
		add("The server failed while handling the request. The cause is on the server side: read the response body and the server's logs around %s.", d.SentAt)
	}
	if len(d.FailedTests) > 0 {
		names := make([]string, 0, len(d.FailedTests))
		for _, test := range d.FailedTests {
			names = append(names, test.Name)
		}
		add("%d test(s) failed: %s.", len(d.FailedTests), strings.Join(names, "; "))
	}
	if len(d.ScriptErrors) > 0 {
		add("A script threw an error, so its later lines did not run: %s", d.ScriptErrors[0])
	}
	if diff := d.Example; diff != nil {
		if !diff.StatusMatches {
			add("The saved example %q expects status %d, the response was %d.", diff.Name, diff.Status, d.Status)
		}
		if len(diff.MissingFields) > 0 {
			add("The response lacks fields the example %q has: %s.", diff.Name, strings.Join(diff.MissingFields, ", "))
		}
		if len(diff.TypeChanges) > 0 {
			add("Fields changed type since the example %q: %s.", diff.Name, strings.Join(diff.TypeChanges, ", "))
		}
	}
	if len(hints) == 0 {
		add("Nothing obvious: read the response body and compare the request with the endpoint's handler.")
	}
	return hints
}

var (
	mcpPreRequestScriptPrefix = regexp.MustCompile(`(?i)^pre-request script failed:\s*`)
	mcpMethodInURL            = regexp.MustCompile(`(?i)^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S`)
	mcpHasScheme              = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
)

func mcpURLHost(raw string) string {
	raw = strings.TrimSpace(raw)
	if !mcpHasScheme.MatchString(raw) {
		raw = "http://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || strings.Contains(parsed.Host, "{{") {
		return ""
	}
	return parsed.Host
}

func mcpContainsAny(text string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}

func mcpTemplateNames(text string, keep map[string]bool) []string {
	seen := map[string]bool{}
	var names []string
	for _, match := range mcpVariableRe.FindAllStringSubmatch(text, -1) {
		name := strings.TrimSpace(match[1])
		if keep[name] && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func mcpJoinVariables(names []string) string {
	wrapped := make([]string, 0, len(names))
	for _, name := range names {
		wrapped = append(wrapped, "{{"+name+"}}")
	}
	return strings.Join(wrapped, ", ")
}

func mcpAuthText(req cliSavedRequest) string {
	text := ""
	if auth, err := json.Marshal(req.Auth); err == nil {
		text = string(auth)
	}
	for _, row := range append(append([]cliKV{}, req.Headers...), req.Params...) {
		if row.Enabled && mcpCredentialName(row.Key) {
			text += " " + row.Value
		}
	}
	return text
}

func mcpCredentialName(key string) bool {
	lower := strings.ToLower(strings.TrimSpace(key))
	return lower == "authorization" || lower == "cookie" || strings.Contains(lower, "token") || strings.Contains(lower, "api-key") || strings.Contains(lower, "apikey")
}

func mcpSendsCredentials(req cliSavedRequest) bool {
	switch strings.ToLower(defaultString(req.Auth.Type, "none")) {
	case "none", "inherit", "":
	default:
		return true
	}
	for _, row := range append(append([]cliKV{}, req.Headers...), req.Params...) {
		if row.Enabled && mcpCredentialName(row.Key) {
			return true
		}
	}
	return false
}

func mcpSentContentType(req cliSavedRequest) string {
	for _, row := range req.Headers {
		if row.Enabled && strings.EqualFold(strings.TrimSpace(row.Key), "Content-Type") {
			return row.Value
		}
	}
	switch strings.ToLower(req.BodyType) {
	case "json":
		return "application/json"
	case "urlencoded":
		return "application/x-www-form-urlencoded"
	case "form":
		return "multipart/form-data"
	case "text":
		return "text/plain"
	}
	return ""
}

func mcpDiagnoseTool() map[string]any {
	return map[string]any{
		"name":  "diagnose_last_failure",
		"title": "Diagnose a failed request",
		"description": "Explain why a request sent from the Kurlo app failed. Without entry it takes the most recent request that got no response, a 4xx or 5xx status, or failing tests. " +
			"Returns the status, error, failed tests, the {{variables}} nothing sets, how the response differs from the saved example, and hints for the likely cause. Secrets are masked.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"entry":       map[string]any{"type": "string", "description": "History entry id from list_history. Defaults to the most recent failure."},
				"environment": map[string]any{"type": "string", "description": "Environment to check variables against. Defaults to the one active in the app."},
			},
		},
		"annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false},
	}
}

package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

func k6ForTest(t *testing.T) string {
	t.Helper()
	if path := os.Getenv("KURLO_K6"); path != "" {
		return path
	}
	path, err := exec.LookPath("k6")
	if err != nil {
		t.Skip("k6 is not installed; set KURLO_K6 to run a load test for real")
	}
	return path
}

func runPayload(t *testing.T, baseURL string, executor map[string]any) string {
	t.Helper()
	payload := map[string]any{
		"loadTest": map[string]any{
			"id": "lt-run", "name": "Run me",
			"scenarios": []any{map[string]any{"id": "sc", "name": "Flow", "executor": executor, "steps": []any{
				map[string]any{"id": "st-login", "requestId": "req-login", "once": true,
					"extract": []any{map[string]any{"var": "token", "from": "json", "path": "$.token"}},
					"checks":  []any{map[string]any{"type": "status", "value": "200"}}},
				map[string]any{"id": "st-orders", "requestId": "req-orders", "thinkTimeMs": 100},
			}}},
			"thresholds": []any{
				map[string]any{"metric": "http_req_failed", "stat": "rate", "op": "<", "value": 0.01},
				map[string]any{"metric": "http_req_duration", "stat": "p(95)", "op": "<", "value": 2000, "step": "st-orders"},
			},
			"settings": map[string]any{},
		},
		"collection": map[string]any{"id": "col", "name": "Shop", "defaults": map[string]any{}},
		"requests": []any{
			map[string]any{"id": "req-login", "name": "Login", "requestType": "http", "method": "POST", "url": "{{host}}/login",
				"bodyType": "json", "bodyContent": `{"password":"{{password}}"}`, "auth": map[string]any{"type": "none"}},
			map[string]any{"id": "req-orders", "name": "Orders", "requestType": "http", "method": "GET", "url": "{{host}}/orders",
				"auth": map[string]any{"type": "bearer", "bearerToken": "{{token}}"}},
		},
		"environment": map[string]any{"name": "local", "values": []any{
			map[string]any{"key": "host", "value": baseURL, "enabled": true},
			map[string]any{"key": "password", "value": "s3cret", "enabled": true, "secret": true},
		}},
		"globals": []any{},
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func waitForLoadRun(t *testing.T, app *App, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for app.LoadRunStatus().Running {
		if time.Now().After(deadline) {
			t.Fatal("the load run did not finish in time")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestLoadRunWithRealK6(t *testing.T) {
	k6 := k6ForTest(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	var mu sync.Mutex
	passwords := map[string]int{}
	tokens := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/login":
			body, _ := io.ReadAll(r.Body)
			passwords[string(body)]++
			_, _ = io.WriteString(w, `{"token":"t-1"}`)
		case "/orders":
			tokens[r.Header.Get("Authorization")]++
			_, _ = io.WriteString(w, `[]`)
		}
	}))
	defer server.Close()

	app := &App{}
	payload := runPayload(t, server.URL, map[string]any{"type": "constant-vus", "vus": 2, "durationMs": 2000})
	if targets := app.LoadTestTargets(payload); len(targets) != 1 || targets[0] != "127.0.0.1" {
		t.Errorf("targets = %v", targets)
	}
	state := app.StartLoadRun(payload, k6)
	if !state.Running || state.Error != "" || state.PlannedMs != 2000 {
		t.Fatalf("the run should start: %+v", state)
	}
	if again := app.StartLoadRun(payload, k6); again.Error == "" {
		t.Error("a second run must be refused while one is running")
	}
	waitForLoadRun(t, app, 60*time.Second)

	result := app.LastLoadRun("lt-run")
	if result.Status != "passed" || result.ExitCode != 0 {
		t.Fatalf("the run should pass: %+v\n%s", result, strings.Join(app.LoadRunLog(), "\n"))
	}
	if result.Totals.Requests == 0 || result.Totals.Iterations == 0 || result.Environment != "local" || result.K6Version == "" {
		t.Errorf("totals and run details should be filled: %+v", result)
	}
	if len(result.Steps) != 2 || result.Steps[0].Requests != 2 || result.Steps[1].Requests == 0 {
		t.Errorf("each user logs in once and lists orders repeatedly: %+v", result.Steps)
	}
	if len(result.Thresholds) != 2 || !result.Thresholds[0].Ok || !result.Thresholds[1].Ok || result.Thresholds[1].StepID != "st-orders" {
		t.Errorf("thresholds = %+v", result.Thresholds)
	}
	if !result.HasSummary || app.LoadRunSummaryJSON("lt-run") == "" {
		t.Error("the k6 summary should be kept with the result")
	}
	mu.Lock()
	if passwords[`{"password":"s3cret"}`] != 2 || tokens["Bearer t-1"] == 0 {
		t.Errorf("the secret reaches k6 through the environment and the token is reused: %v %v", passwords, tokens)
	}
	mu.Unlock()
	if logs := strings.Join(app.LoadRunLog(), "\n"); strings.Contains(logs, "s3cret") {
		t.Error("the secret must not show up in the k6 output")
	}
}

func TestStopLoadRunWithRealK6(t *testing.T) {
	k6 := k6ForTest(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"token":"t"}`)
	}))
	defer server.Close()
	app := &App{}
	state := app.StartLoadRun(runPayload(t, server.URL, map[string]any{"type": "constant-vus", "vus": 1, "durationMs": 60000}), k6)
	if !state.Running {
		t.Fatalf("the run should start: %+v", state)
	}
	deadline := time.Now().Add(20 * time.Second)
	for app.LoadRunStatus().Progress.ElapsedMs == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("no progress from k6:\n%s", strings.Join(app.LoadRunLog(), "\n"))
		}
		time.Sleep(50 * time.Millisecond)
	}
	if status := app.LoadRunStatus(); status.DashboardURL == "" {
		t.Errorf("the k6 web dashboard address should be known: %+v", status)
	}
	if stopping := app.StopLoadRun(); !stopping.Stopping {
		t.Errorf("stop should be acknowledged: %+v", stopping)
	}
	waitForLoadRun(t, app, 30*time.Second)
	result := app.LastLoadRun("lt-run")
	if result.Status != "stopped" || !result.HasSummary {
		t.Fatalf("a stopped run keeps its summary: %+v", result)
	}
}

func TestStartLoadRunRefusesBrokenTestsAndMissingK6(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	app := &App{}
	broken := strings.Replace(runPayload(t, "http://127.0.0.1:1", map[string]any{"type": "constant-vus", "vus": 1, "durationMs": 1000}), `"req-orders","thinkTimeMs"`, `"req-gone","thinkTimeMs"`, 1)
	if state := app.StartLoadRun(broken, "/no/k6"); state.Running || !strings.Contains(state.Error, "Fix the problems") {
		t.Errorf("an invalid test must not start: %+v", state)
	}
	valid := runPayload(t, "http://127.0.0.1:1", map[string]any{"type": "constant-vus", "vus": 1, "durationMs": 1000})
	if state := app.StartLoadRun(valid, "/no/k6"); state.Running || state.Error == "" {
		t.Errorf("a missing k6 must be reported: %+v", state)
	}
	if result := app.LastLoadRun("never-ran"); result.LoadTestID != "" || result.Steps == nil {
		t.Errorf("no result yet: %+v", result)
	}
	if message := app.OpenLoadRunReport("never-ran"); message == "" {
		t.Error("a missing report should be explained")
	}
	if loadRunDir("../escape") == loadRunDir("..") || strings.Contains(loadRunDir("../escape"), "..") {
		t.Error("a load test id must not reach outside the runs folder")
	}
}

func TestLastErrorLine(t *testing.T) {
	lines := []string{"running (01.0s)", `time="2026" level=error msg="GoError: unknown module" hint="x"`}
	if got := lastErrorLine(lines, 107); got != "GoError: unknown module" {
		t.Errorf("got %q", got)
	}
	if got := lastErrorLine(nil, 3); got != "k6 ended with exit code 3." {
		t.Errorf("got %q", got)
	}
}

func TestStartLoadRunRejectsNULInSecret(t *testing.T) {
	payload := strings.Replace(runPayload(t, "http://127.0.0.1:1", map[string]any{"type": "constant-vus", "vus": 1, "durationMs": 1000}), `"s3cret"`, `"private\u0000value"`, 1)
	app := &App{}
	state := app.StartLoadRun(payload, "/no/k6")
	if state.Running || !strings.Contains(state.Error, `Secret variable "password" contains a NUL byte`) {
		t.Fatalf("invalid secrets should be explained before starting k6: %+v", state)
	}
	if strings.Contains(state.Error, "private") || strings.Contains(state.Error, "value") {
		t.Fatal("the error must not reveal the secret")
	}
	if app.LoadRunStatus().Running {
		t.Fatal("a rejected run must not change the running state")
	}
}

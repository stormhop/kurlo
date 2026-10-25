package loadtest

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func k6Binary(t *testing.T) string {
	t.Helper()
	if path := os.Getenv("KURLO_K6"); path != "" {
		return path
	}
	path, err := exec.LookPath("k6")
	if err != nil {
		t.Skip("k6 is not installed; set KURLO_K6 to run the script for real")
	}
	return path
}

type shopServer struct {
	mu        sync.Mutex
	logins    int
	passwords map[string]bool
	authed    map[string]int
	details   int
	created   int
}

func (s *shopServer) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Email, Password string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		s.logins++
		s.passwords[body.Email+"/"+body.Password] = true
		s.mu.Unlock()
		_, _ = io.WriteString(w, `{"access_token":"tok-`+strings.Split(body.Email, "@")[0]+`"}`)
	})
	mux.HandleFunc("GET /api/orders", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.authed[r.Header.Get("Authorization")]++
		s.mu.Unlock()
		if r.URL.Query().Get("limit") != "20" || len(r.URL.Query().Get("trace")) != 36 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, `{"items":[{"id":"o-42"}]}`)
	})
	mux.HandleFunc("GET /api/orders/o-42", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.details++
		s.mu.Unlock()
		_, _ = io.WriteString(w, `{"id":"o-42"}`)
	})
	mux.HandleFunc("POST /api/graphql", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.created++
		s.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"data":{"createOrder":{"id":"o-42"}}}`)
	})
	return mux
}

func TestGeneratedScriptRunsInK6(t *testing.T) {
	k6 := k6Binary(t)
	server := &shopServer{passwords: map[string]bool{}, authed: map[string]int{}}
	ts := httptest.NewServer(server.handler())
	defer ts.Close()

	plan := checkoutPlan()
	plan.Test.Scenarios[0].Executor = model.LoadExecutor{Type: "constant-vus", VUs: 2, DurationMs: 3000}
	for i := range plan.Test.Scenarios[0].Steps {
		plan.Test.Scenarios[0].Steps[i].ThinkTimeMs = 100
		plan.Test.Scenarios[0].Steps[i].ThinkJitterMs = 0
	}
	plan.Test.Thresholds = append(plan.Test.Thresholds, model.LoadThreshold{Metric: "checks", Stat: "rate", Op: ">", Value: 0.99})
	plan.Variables[1].Value = ts.URL
	script := GenerateK6(plan, Options{}).Script

	dir := t.TempDir()
	path := filepath.Join(dir, "checkout.k6.js")
	if err := os.WriteFile(path, []byte(script), 0644); err != nil {
		t.Fatal(err)
	}
	summary := filepath.Join(dir, "summary.json")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, k6, "run", "--quiet", "--no-color", "--summary-export", summary, path)
	cmd.Env = append(os.Environ(), "password=pw-1", "K6_NO_USAGE_REPORT=true")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("k6 run failed: %v\n%s", err, output)
	}

	server.mu.Lock()
	defer server.mu.Unlock()
	if server.logins != 2 {
		t.Errorf("each of the 2 users should log in once, got %d logins", server.logins)
	}
	if !server.passwords["ada@shop.test/pw-1"] || !server.passwords["grace@shop.test/pw-1"] {
		t.Errorf("each user should log in with its own data row and the secret from the environment, got %v", server.passwords)
	}
	if server.authed["Bearer tok-ada"] == 0 || server.authed["Bearer tok-grace"] == 0 || len(server.authed) != 2 {
		t.Errorf("orders should be listed with the token each user saved, got %v", server.authed)
	}
	if server.details == 0 || server.created == 0 {
		t.Errorf("the saved order id should reach the later steps, details=%d created=%d", server.details, server.created)
	}

	raw, err := os.ReadFile(summary)
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Metrics map[string]json.RawMessage `json:"metrics"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	for _, metric := range []string{"http_req_duration{step:login}", "http_req_failed{step:create_order}", "checks{step:list_orders}"} {
		if _, ok := parsed.Metrics[metric]; !ok {
			t.Errorf("the summary should break %s out per step", metric)
		}
	}
}

func TestFailedThresholdFailsTheK6Run(t *testing.T) {
	k6 := k6Binary(t)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer ts.Close()
	plan := Plan{
		Test: model.LoadTest{
			ID: "lt", Name: "Broken",
			Scenarios: []model.LoadScenario{{ID: "sc", Executor: model.LoadExecutor{Type: "constant-vus", VUs: 1, DurationMs: 1000},
				Steps: []model.LoadStep{{ID: "st", RequestID: "r", ThinkTimeMs: 100}}}},
			Thresholds: []model.LoadThreshold{{Metric: "http_req_failed", Stat: "rate", Op: "<", Value: 0.01}},
		},
		Requests: map[string]Request{"r": {ID: "r", Name: "Ping", Type: "http", Method: "GET", URL: ts.URL, VerifyTLS: true}},
	}
	path := filepath.Join(t.TempDir(), "broken.k6.js")
	if err := os.WriteFile(path, []byte(GenerateK6(plan, Options{}).Script), 0644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(k6, "run", "--quiet", "--no-color", path)
	cmd.Env = append(os.Environ(), "K6_NO_USAGE_REPORT=true")
	err := cmd.Run()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 99 {
		t.Fatalf("a failed threshold should end k6 with exit code 99, got %v", err)
	}
}

func TestGeneratedAuthWorksInK6(t *testing.T) {
	k6 := k6Binary(t)
	var mu sync.Mutex
	seen := map[string]string{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/token":
			_ = r.ParseForm()
			user, pass, _ := r.BasicAuth()
			seen["token"] = r.PostForm.Get("grant_type") + " " + r.PostForm.Get("scope") + " " + user + ":" + pass
			_, _ = io.WriteString(w, `{"access_token":"granted"}`)
		case "/sync":
			_ = r.ParseForm()
			seen["sync"] = r.Header.Get("Authorization") + " since=" + r.PostForm.Get("since")
		case "/report":
			seen["report"] = r.Header.Get("Authorization")
		case "/status":
			seen["status"] = r.URL.RawQuery
		}
	}))
	defer ts.Close()

	plan := authPlan()
	plan.Test.Scenarios[0].Executor = model.LoadExecutor{Type: "constant-vus", VUs: 1, DurationMs: 1000}
	plan.Test.Scenarios[0].Steps = plan.Test.Scenarios[0].Steps[:4]
	for i := range plan.Test.Scenarios[0].Steps {
		plan.Test.Scenarios[0].Steps[i].ThinkTimeMs = 200
	}
	for id, request := range plan.Requests {
		request.URL = strings.Replace(request.URL, "https://partner.test", ts.URL, 1)
		request.Auth.OAuth2TokenURL = strings.Replace(request.Auth.OAuth2TokenURL, "https://id.partner.test", ts.URL, 1)
		plan.Requests[id] = request
	}
	path := filepath.Join(t.TempDir(), "partner.k6.js")
	if err := os.WriteFile(path, []byte(GenerateK6(plan, Options{InlineSecrets: true}).Script), 0644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(k6, "run", "--quiet", "--no-color", path)
	cmd.Env = append(os.Environ(), "K6_NO_USAGE_REPORT=true")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("k6 run failed: %v\n%s", err, output)
	}
	mu.Lock()
	defer mu.Unlock()
	if seen["token"] != "client_credentials sync kurlo:s3cret" {
		t.Errorf("token request = %q", seen["token"])
	}
	if !strings.HasPrefix(seen["sync"], "Bearer granted since=") || len(seen["sync"]) <= len("Bearer granted since=") {
		t.Errorf("sync request = %q", seen["sync"])
	}
	if seen["report"] != "Basic b3BzOm9wcy1wYXNz" {
		t.Errorf("basic auth header = %q", seen["report"])
	}
	if seen["status"] != "v=2&api_key=key-123" {
		t.Errorf("api key query = %q", seen["status"])
	}
}

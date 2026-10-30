package loadtest

import (
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/dop251/goja"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

var update = flag.Bool("update", false, "rewrite the golden k6 scripts")

func checkoutPlan() Plan {
	return Plan{
		Collection: "Shop API",
		Test: model.LoadTest{
			ID:   "lt-checkout",
			Name: "Checkout flow",
			Scenarios: []model.LoadScenario{{
				ID: "sc-main", Name: "Flow",
				Executor: model.LoadExecutor{Type: "ramping-vus", Stages: []model.LoadStage{
					{DurationMs: 120000, Target: 100}, {DurationMs: 600000, Target: 100}, {DurationMs: 60000, Target: 0},
				}},
				Steps: []model.LoadStep{
					{
						ID: "st-login", RequestID: "req-login", Once: true,
						Extract: []model.LoadExtract{{Var: "token", From: "json", Path: "$.access_token"}},
						Checks:  []model.LoadCheck{{Type: "status", Value: "200"}},
					},
					{
						ID: "st-orders", RequestID: "req-orders", ThinkTimeMs: 500, ThinkJitterMs: 1000,
						Extract: []model.LoadExtract{{Var: "orderId", From: "json", Path: "$.items[0].id"}},
						Checks:  []model.LoadCheck{{Type: "jsonExists", Path: "$.items"}},
					},
					{ID: "st-order", RequestID: "req-order"},
					{
						ID: "st-create", RequestID: "req-create", Name: "create order", ThinkTimeMs: 2000,
						Checks: []model.LoadCheck{{Type: "status", Value: "201"}, {Type: "bodyContains", Value: "{{orderId}}"}},
					},
				},
			}},
			Thresholds: []model.LoadThreshold{
				{Metric: "http_req_duration", Stat: "p(95)", Op: "<", Value: 300},
				{Metric: "http_req_duration", Stat: "p(99)", Op: "<", Value: 400, Step: "st-create"},
				{Metric: "http_req_failed", Stat: "rate", Op: "<", Value: 0.01, AbortOnFail: true},
			},
			Data:     &model.LoadDataSource{Path: "data/users.csv", Mode: "per-vu"},
			Settings: model.LoadSettings{TimeoutMs: 10000},
		},
		Requests: map[string]Request{
			"req-login": {
				ID: "req-login", Name: "Login", Type: "http", Method: "POST", URL: "{{baseUrl}}/auth/login",
				BodyType: "json", Body: `{"email":"{{email}}","password":"{{password}}"}`, VerifyTLS: true, TimeoutMs: 30000,
			},
			"req-orders": {
				ID: "req-orders", Name: "List orders", Type: "http", Method: "GET", URL: "{{baseUrl}}/orders",
				Query:   []Pair{{Key: "limit", Value: "20"}, {Key: "trace", Value: "{{$guid}}"}},
				Headers: []Pair{{Key: "X-Team", Value: "checkout"}},
				Auth:    model.AuthConfig{Type: "bearer", Token: "{{token}}"}, VerifyTLS: true,
			},
			"req-order": {
				ID: "req-order", Name: "Order details", Type: "http", Method: "GET", URL: "{{baseUrl}}/orders/:id",
				PathParams: []Pair{{Key: "id", Value: "{{orderId}}"}},
				Auth:       model.AuthConfig{Type: "bearer", Token: "{{token}}"}, VerifyTLS: true,
			},
			"req-create": {
				ID: "req-create", Name: "Create order", Type: "graphql", Method: "POST", URL: "{{baseUrl}}/graphql",
				BodyType: "graphql", Body: `{"query":"mutation { createOrder { id } }"}`,
				Auth: model.AuthConfig{Type: "bearer", Token: "{{token}}"}, VerifyTLS: true, HasScripts: true,
			},
		},
		Variables: []Variable{
			{Name: "baseUrl", Value: "{{host}}/api"},
			{Name: "host", Value: "https://staging.shop.test"},
			{Name: "password", Value: "hunter2", Secret: true},
			{Name: "unused", Value: "never written"},
		},
		Data: []map[string]string{{"email": "ada@shop.test"}, {"email": "grace@shop.test"}},
	}
}

func authPlan() Plan {
	return Plan{
		Collection: "Partner API",
		Test: model.LoadTest{
			ID:   "lt-partner",
			Name: "Partner sync",
			Scenarios: []model.LoadScenario{{
				ID: "sc", Name: "Flow",
				Executor: model.LoadExecutor{Type: "constant-arrival-rate", Rate: 20, DurationMs: 90000, PreAllocatedVUs: 10, MaxVUs: 50},
				Steps: []model.LoadStep{
					{ID: "s1", RequestID: "oauth", Extract: []model.LoadExtract{
						{Var: "trace", From: "header", Path: "X-Trace-Id"},
						{Var: "cursor", From: "regex", Path: `next=(\w+)`},
					}},
					{ID: "s2", RequestID: "oauth"},
					{ID: "s3", RequestID: "basic"},
					{ID: "s4", RequestID: "apikey"},
					{ID: "s5", RequestID: "digest"},
					{ID: "s6", RequestID: "aws"},
					{ID: "s7", RequestID: "upload"},
					{ID: "s8", RequestID: "missing"},
					{ID: "s9", RequestID: "socket"},
				},
			}},
			Settings: model.LoadSettings{Insecure: true},
		},
		Requests: map[string]Request{
			"oauth": {ID: "oauth", Name: "Sync", Type: "http", Method: "POST", URL: "https://partner.test/sync",
				BodyType: "urlencoded", Form: []FormField{{Key: "since", Value: "{{$timestamp}}"}},
				Auth: model.AuthConfig{Type: "oauth2", OAuth2GrantType: "client_credentials", OAuth2TokenURL: "https://id.partner.test/token",
					OAuth2ClientID: "kurlo", OAuth2Secret: "{{clientSecret}}", OAuth2Scope: "sync"}, VerifyTLS: true},
			"basic":  {ID: "basic", Name: "Report", Type: "http", Method: "GET", URL: "https://partner.test/report", Auth: model.AuthConfig{Type: "basic", Username: "ops", Password: "{{opsPassword}}"}, VerifyTLS: true},
			"apikey": {ID: "apikey", Name: "Status", Type: "http", Method: "GET", URL: "https://partner.test/status?v=2", Auth: model.AuthConfig{Type: "apikey", KeyName: "api_key", KeyValue: "{{apiKey}}", KeyIn: "query"}, VerifyTLS: false},
			"digest": {ID: "digest", Name: "Legacy", Type: "http", Method: "GET", URL: "https://partner.test/legacy", Auth: model.AuthConfig{Type: "digest", Username: "legacy", Password: "{{legacyPassword}}"}, VerifyTLS: true},
			"aws":    {ID: "aws", Name: "Bucket", Type: "http", Method: "GET", URL: "https://s3.test/bucket", Auth: model.AuthConfig{Type: "aws"}, VerifyTLS: true},
			"upload": {ID: "upload", Name: "Upload", Type: "http", Method: "POST", URL: "https://partner.test/upload", BodyType: "form",
				Form: []FormField{{Key: "title", Value: "report"}, {Key: "file", IsFile: true}}, VerifyTLS: true},
			"socket": {ID: "socket", Name: "Live", Type: "ws", URL: "wss://partner.test/live", VerifyTLS: true},
		},
		Variables: []Variable{
			{Name: "clientSecret", Value: "s3cret", Secret: true},
			{Name: "opsPassword", Value: "ops-pass", Secret: true},
			{Name: "apiKey", Value: "key-123", Secret: true},
		},
	}
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.MkdirAll("testdata", 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden file (run with -update to create it): %v", err)
	}
	if string(want) != got {
		t.Fatalf("%s changed; run go test ./internal/loadtest -update and review the diff.\n%s", name, got)
	}
}

func warningMessages(result model.K6ExportResult) string {
	lines := make([]string, 0, len(result.Warnings))
	for _, warning := range result.Warnings {
		lines = append(lines, warning.Level+" "+strconv.Itoa(warning.Step)+" "+warning.Message)
	}
	return strings.Join(lines, "\n")
}

func TestGenerateCheckoutScript(t *testing.T) {
	result := GenerateK6(checkoutPlan(), Options{})
	golden(t, "checkout.k6.js", result.Script)
	if result.FileName != "checkout-flow.k6.js" {
		t.Errorf("file name = %q", result.FileName)
	}
	for _, want := range []string{
		"The pre-request and test scripts of Create order are not exported",
		"password is secret and is not written into the script",
		"{{email}}",
	} {
		if !strings.Contains(warningMessages(result), want) && !strings.Contains(result.Script, want) {
			t.Errorf("expected %q in the warnings or the script:\n%s", want, warningMessages(result))
		}
	}
	if strings.Contains(result.Script, "hunter2") {
		t.Error("a secret value must not be written into the script")
	}
	if strings.Contains(result.Script, "never written") {
		t.Error("a variable no request uses must not be written into the script")
	}
	if strings.Contains(warningMessages(result), "email") {
		t.Errorf("a data column is not an unknown variable:\n%s", warningMessages(result))
	}
}

func TestGenerateInlinesSecretsWhenAsked(t *testing.T) {
	result := GenerateK6(checkoutPlan(), Options{InlineSecrets: true})
	if !strings.Contains(result.Script, `"password": "hunter2"`) {
		t.Fatalf("the secret should be written when asked:\n%s", result.Script)
	}
	if strings.Contains(warningMessages(result), "is secret") {
		t.Error("no secret warning when secrets are written")
	}
}

func TestGenerateAuthAndUnsupportedParts(t *testing.T) {
	result := GenerateK6(authPlan(), Options{})
	golden(t, "partner.k6.js", result.Script)
	messages := warningMessages(result)
	for _, want := range []string{
		"Aws auth of Bucket is not exported",
		"The multipart form of Upload is sent URL-encoded",
		"File fields of Upload are not exported",
		"The request of this step is not in the collection",
		"Live is a ws request",
	} {
		if !strings.Contains(messages, want) {
			t.Errorf("expected warning %q in:\n%s", want, messages)
		}
	}
	if strings.Contains(messages, "skips TLS certificate checks") {
		t.Error("no TLS warning when the test already skips TLS checks")
	}
}

func TestGenerateIsDeterministic(t *testing.T) {
	first := GenerateK6(checkoutPlan(), Options{}).Script
	for i := 0; i < 20; i++ {
		if next := GenerateK6(checkoutPlan(), Options{}).Script; next != first {
			t.Fatal("the script must be the same on every export")
		}
	}
}

func TestGenerateWarnsAboutUnknownVariablesAndMissingData(t *testing.T) {
	plan := checkoutPlan()
	plan.Data = nil
	plan.DataError = "open data/users.csv: no such file"
	plan.Variables = nil
	messages := warningMessages(GenerateK6(plan, Options{}))
	for _, want := range []string{
		"{{baseUrl}} is not set in the environment",
		"{{email}} is not set",
		"Test data data/users.csv is not exported: open data/users.csv: no such file",
	} {
		if !strings.Contains(messages, want) {
			t.Errorf("expected warning %q in:\n%s", want, messages)
		}
	}
}

func TestK6Duration(t *testing.T) {
	for ms, want := range map[int]string{0: "0s", 1500: "1500ms", 60000: "1m", 90000: "1m30s", 7200000: "2h", 3723000: "1h2m3s"} {
		if got := k6Duration(ms); got != want {
			t.Errorf("k6Duration(%d) = %q, want %q", ms, got, want)
		}
	}
}

func TestJSONPathToGJSON(t *testing.T) {
	for path, want := range map[string]string{
		"$":                  "",
		"$.access_token":     "access_token",
		"$.items[0].id":      "items.0.id",
		"$['x-trace'].value": "x-trace.value",
		`$["a.b"]`:           `a\.b`,
		"$.data.users[12]":   "data.users.12",
		`$['a[b]'].id`:       `a\[b\].id`,
		`$["[key]"]`:         `\[key\]`,
		`$['['].id`:          `\[.id`,
		`$[']'].id`:          `\].id`,
	} {
		got, err := jsonPathToGJSON(path)
		if err != nil || got != want {
			t.Errorf("jsonPathToGJSON(%q) = %q, %v; want %q", path, got, err, want)
		}
	}
	for _, path := range []string{"items", "$.items[*]", "$.items[-1]", "$..id", "$.items[0", "$.*", `$['a]']x`, `$['a]`, `$['a']` + `]`} {
		if _, err := jsonPathToGJSON(path); err == nil {
			t.Errorf("jsonPathToGJSON(%q) should fail", path)
		}
	}
}

func TestStepThinkTimeRunsOnlyWhenStepRuns(t *testing.T) {
	for _, once := range []bool{false, true} {
		for _, jitter := range []int{0, 1000} {
			plan := checkoutPlan()
			step := model.LoadStep{ID: "st", RequestID: "req-order", Once: once, ThinkTimeMs: 500, ThinkJitterMs: jitter}
			g := &generator{plan: plan, needs: map[string]bool{}}
			g.writeStep(1, step, Request{Method: "GET", URL: "http://localhost", VerifyTLS: true}, "order")
			vm := goja.New()
			requests, sleeps := 0, 0
			_ = vm.Set("request", func() { requests++ })
			_ = vm.Set("sleep", func(seconds float64) {
				sleeps++
				if seconds < 0.5 || seconds > 0.5+float64(jitter)/1000 {
					t.Errorf("sleep = %v, jitter = %d", seconds, jitter)
				}
			})
			_, err := vm.RunString("const done = {}; const http = { request }; function group(name, fn) { fn(); } function iteration() {\n" + g.out.String() + "\n} for (let i = 0; i < 3; i++) iteration();")
			if err != nil {
				t.Fatal(err)
			}
			want := 3
			if once {
				want = 1
			}
			if requests != want || sleeps != want {
				t.Errorf("once=%v jitter=%d: requests=%d sleeps=%d, want %d each", once, jitter, requests, sleeps, want)
			}
		}
	}
}

func TestApplyPathParams(t *testing.T) {
	cases := []struct{ url, want string }{
		{"{{baseUrl}}/orders/:id", "{{baseUrl}}/orders/{{orderId}}"},
		{"https://shop.test/orders/:id/items/:item?x=:id", "https://shop.test/orders/{{orderId}}/items/a%2Fb?x=:id"},
		{"https://shop.test/:missing", "https://shop.test/:missing"},
	}
	params := []Pair{{Key: "id", Value: "{{orderId}}"}, {Key: "item", Value: "a/b"}}
	for _, tc := range cases {
		if got := applyPathParams(tc.url, params); got != tc.want {
			t.Errorf("applyPathParams(%q) = %q, want %q", tc.url, got, tc.want)
		}
	}
}

func TestGenerateK6FolderSeparatesDataAndPreservesSecrets(t *testing.T) {
	plan := checkoutPlan()
	result := GenerateK6(plan, Options{SeparateData: true})
	if result.FileName != "script.k6.js" || len(result.Files) != 2 || result.Files[0].Content != result.Script || result.Files[1].Path != "data.json" {
		t.Fatalf("unexpected bundle: %+v", result)
	}
	if !strings.Contains(result.Script, "JSON.parse(open('./data.json'))") || strings.Contains(result.Script, "ada@shop.test") || !strings.Contains(result.Files[1].Content, "ada@shop.test") {
		t.Fatal("data should be read from the companion file")
	}
	for _, file := range result.Files {
		if strings.Contains(file.Content, "hunter2") {
			t.Fatal("secret leaked into export")
		}
	}
	inlined := GenerateK6(plan, Options{SeparateData: true, InlineSecrets: true})
	if !strings.Contains(inlined.Script, "hunter2") {
		t.Fatal("explicit inline option should include secrets")
	}
	plan.Data = nil
	plan.Test.Data = nil
	if result := GenerateK6(plan, Options{SeparateData: true}); len(result.Files) != 1 || strings.Contains(result.Script, "data.json") {
		t.Fatal("a test without data should export only the script")
	}
}

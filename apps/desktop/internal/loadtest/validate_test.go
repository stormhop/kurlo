package loadtest

import (
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func validTest() model.LoadTest {
	return model.LoadTest{
		ID:   "lt_1",
		Name: "Checkout flow",
		Scenarios: []model.LoadScenario{{
			ID:   "sc_1",
			Name: "Checkout",
			Executor: model.LoadExecutor{Type: "ramping-vus", Stages: []model.LoadStage{
				{DurationMs: 120000, Target: 100},
				{DurationMs: 600000, Target: 100},
				{DurationMs: 60000, Target: 0},
			}},
			Steps: []model.LoadStep{
				{
					ID: "st_1", RequestID: "req_login", Once: true,
					Extract: []model.LoadExtract{{Var: "token", From: "json", Path: "$.access_token"}},
					Checks:  []model.LoadCheck{{Type: "status", Value: "200"}},
				},
				{
					ID: "st_2", RequestID: "req_orders", ThinkTimeMs: 500, ThinkJitterMs: 1000,
					Extract: []model.LoadExtract{
						{Var: "orderId", From: "json", Path: "$.items[0].id"},
						{Var: "trace", From: "header", Path: "X-Trace-Id"},
						{Var: "cursor", From: "regex", Path: `next=(\w+)`},
					},
					Checks: []model.LoadCheck{{Type: "jsonExists", Path: "$.items"}, {Type: "bodyContains", Value: "items"}},
				},
			},
		}},
		Thresholds: []model.LoadThreshold{
			{Metric: "http_req_duration", Stat: "p(95)", Op: "<", Value: 300},
			{Metric: "http_req_duration", Stat: "p(99)", Op: "<", Value: 400, Step: "st_2"},
			{Metric: "http_req_failed", Stat: "rate", Op: "<", Value: 0.01, AbortOnFail: true},
		},
		Data: &model.LoadDataSource{Path: "data/users.csv", Mode: "per-vu"},
	}
}

func testRequests() []model.LoadTestRequest {
	return []model.LoadTestRequest{
		{ID: "req_login", RequestType: "http"},
		{ID: "req_orders", RequestType: ""},
		{ID: "req_query", RequestType: "graphql"},
		{ID: "req_socket", RequestType: "ws"},
	}
}

func TestValidateAcceptsACompleteTest(t *testing.T) {
	if problems := Validate(validTest(), testRequests()); len(problems) != 0 {
		t.Fatalf("expected no problems, got %v", problems)
	}
}

func TestValidateAcceptsEveryLoadModel(t *testing.T) {
	executors := []model.LoadExecutor{
		{Type: "constant-vus", VUs: 2, DurationMs: 60000},
		{Type: "constant-arrival-rate", Rate: 50, DurationMs: 60000, PreAllocatedVUs: 10, MaxVUs: 50},
		{Type: "ramping-arrival-rate", Stages: []model.LoadStage{{DurationMs: 60000, Target: 100}}, PreAllocatedVUs: 10},
	}
	for _, executor := range executors {
		test := validTest()
		test.Scenarios[0].Executor = executor
		if problems := Validate(test, testRequests()); len(problems) != 0 {
			t.Errorf("%s: expected no problems, got %v", executor.Type, problems)
		}
	}
}

func TestValidateReportsProblems(t *testing.T) {
	cases := []struct {
		name   string
		change func(*model.LoadTest)
		want   string
	}{
		{"no name", func(lt *model.LoadTest) { lt.Name = " " }, "needs a name"},
		{"no flow", func(lt *model.LoadTest) { lt.Scenarios = nil }, "needs a flow"},
		{"two flows", func(lt *model.LoadTest) { lt.Scenarios = append(lt.Scenarios, lt.Scenarios[0]) }, "runs one flow"},
		{"no steps", func(lt *model.LoadTest) { lt.Scenarios[0].Steps = nil }, "at least one request"},
		{"duplicate step id", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[1].ID = "st_1" }, "same id as an earlier step"},
		{"missing request", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[0].RequestID = "req_gone" }, "not in this collection"},
		{"empty request", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[0].RequestID = "" }, "has no request"},
		{"websocket request", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[0].RequestID = "req_socket" }, "HTTP and GraphQL requests only"},
		{"unknown model", func(lt *model.LoadTest) { lt.Scenarios[0].Executor = model.LoadExecutor{Type: "per-vu-iterations"} }, "Unknown load model"},
		{"constant without users", func(lt *model.LoadTest) {
			lt.Scenarios[0].Executor = model.LoadExecutor{Type: "constant-vus", DurationMs: 1000}
		}, "number of virtual users"},
		{"constant without duration", func(lt *model.LoadTest) {
			lt.Scenarios[0].Executor = model.LoadExecutor{Type: "constant-vus", VUs: 1}
		}, "how long the test runs"},
		{"ramp without stages", func(lt *model.LoadTest) { lt.Scenarios[0].Executor.Stages = nil }, "at least one stage"},
		{"stage without duration", func(lt *model.LoadTest) { lt.Scenarios[0].Executor.Stages[1].DurationMs = 0 }, "Stage 2 needs a duration"},
		{"negative target", func(lt *model.LoadTest) { lt.Scenarios[0].Executor.Stages[0].Target = -1 }, "target cannot be negative"},
		{"rate without rate", func(lt *model.LoadTest) {
			lt.Scenarios[0].Executor = model.LoadExecutor{Type: "constant-arrival-rate", DurationMs: 1000, PreAllocatedVUs: 1}
		}, "iterations start per second"},
		{"rate without pool", func(lt *model.LoadTest) {
			lt.Scenarios[0].Executor = model.LoadExecutor{Type: "constant-arrival-rate", Rate: 1, DurationMs: 1000}
		}, "how many virtual users to prepare"},
		{"limit below pool", func(lt *model.LoadTest) {
			lt.Scenarios[0].Executor = model.LoadExecutor{Type: "constant-arrival-rate", Rate: 1, DurationMs: 1000, PreAllocatedVUs: 10, MaxVUs: 5}
		}, "limit is lower"},
		{"bad variable", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[0].Extract[0].Var = "1token" }, "not a valid variable name"},
		{"saved twice", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[1].Extract[0].Var = "token" }, "step 1 already saves"},
		{"json path without dollar", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[0].Extract[0].Path = "access_token" }, "must start with $"},
		{"empty header", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[1].Extract[1].Path = "" }, "name the header"},
		{"broken regex", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[1].Extract[2].Path = "next=(" }, "not a valid regular expression"},
		{"regex without group", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[1].Extract[2].Path = `next=\w+` }, "exactly one ( ) group"},
		{"unknown source", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[0].Extract[0].From = "cookie" }, "unknown source"},
		{"bad status", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[0].Checks[0].Value = "ok" }, "from 100 to 599"},
		{"status out of range", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[0].Checks[0].Value = "700" }, "from 100 to 599"},
		{"json check path", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[1].Checks[0].Path = "" }, "path to check must start with $"},
		{"empty contains", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[1].Checks[1].Value = "" }, "text the body must contain"},
		{"unknown check", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[0].Checks[0].Type = "schema" }, "unknown check"},
		{"negative wait", func(lt *model.LoadTest) { lt.Scenarios[0].Steps[1].ThinkTimeMs = -1 }, "cannot be negative"},
		{"unknown metric", func(lt *model.LoadTest) { lt.Thresholds[0].Metric = "vus" }, "unknown metric"},
		{"stat for wrong metric", func(lt *model.LoadTest) { lt.Thresholds[2].Stat = "p(95)" }, "does not apply"},
		{"unknown op", func(lt *model.LoadTest) { lt.Thresholds[0].Op = "==" }, "unknown comparison"},
		{"rate over one", func(lt *model.LoadTest) { lt.Thresholds[2].Value = 2 }, "out of range"},
		{"negative limit", func(lt *model.LoadTest) { lt.Thresholds[0].Value = -1 }, "out of range"},
		{"threshold on missing step", func(lt *model.LoadTest) { lt.Thresholds[1].Step = "st_9" }, "not in the flow"},
		{"no data path", func(lt *model.LoadTest) { lt.Data.Path = "" }, "Choose a test data file"},
		{"data outside workspace", func(lt *model.LoadTest) { lt.Data.Path = "../secrets.csv" }, "inside the workspace"},
		{"absolute data path", func(lt *model.LoadTest) { lt.Data.Path = "/etc/users.csv" }, "inside the workspace"},
		{"windows data path", func(lt *model.LoadTest) { lt.Data.Path = `C:\users.csv` }, "inside the workspace"},
		{"data type", func(lt *model.LoadTest) { lt.Data.Path = "data/users.xlsx" }, "CSV or JSON"},
		{"data mode", func(lt *model.LoadTest) { lt.Data.Mode = "sequential" }, "Unknown test data mode"},
		{"negative timeout", func(lt *model.LoadTest) { lt.Settings.TimeoutMs = -5 }, "timeout cannot be negative"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			test := validTest()
			tc.change(&test)
			problems := Validate(test, testRequests())
			for _, problem := range problems {
				if strings.Contains(problem, tc.want) {
					return
				}
			}
			t.Fatalf("expected a problem containing %q, got %v", tc.want, problems)
		})
	}
}

package loadtest

import (
	"errors"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const recordedSummary = `{"metrics":{
  "http_reqs":{"rate":9.85,"count":40},
  "http_req_failed":{"passes":2,"fails":38,"thresholds":{"rate<0.01":true},"value":0.05},
  "vus_max":{"max":2,"value":2,"min":2},
  "checks":{"fails":1,"passes":39,"thresholds":{"rate>0.9":false},"value":0.975},
  "http_req_duration":{"p(90)":2.08,"p(95)":2.41,"p(99)":2.89,"avg":1.43,"min":0.69,"med":1.33,"max":3.2,"thresholds":{"p(95)<300":false}},
  "http_req_duration{step:login}":{"p(90)":2,"p(95)":2.5,"p(99)":4.5,"avg":1.5,"min":0.7,"med":1.2,"max":5,"thresholds":{"p(99)<4":true}},
  "http_reqs{step:login}":{"count":40,"rate":9.85},
  "http_req_failed{step:login}":{"passes":2,"fails":38,"value":0.05},
  "checks{step:login}":{"passes":39,"fails":1,"value":0.975},
  "iterations":{"rate":9.85,"count":40}
}}`

func TestApplySummaryReadsTotalsStepsAndThresholds(t *testing.T) {
	test := model.LoadTest{Thresholds: []model.LoadThreshold{
		{Metric: "http_req_duration", Stat: "p(95)", Op: "<", Value: 300},
		{Metric: "http_req_duration", Stat: "p(99)", Op: "<", Value: 4, Step: "st-login"},
		{Metric: "http_req_failed", Stat: "rate", Op: "<", Value: 0.01},
		{Metric: "checks", Stat: "rate", Op: ">", Value: 0.9},
		{Metric: "http_req_duration", Stat: "max", Op: "<", Value: 1, Step: "st-gone"},
	}}
	result := model.LoadRunResult{Totals: model.LoadRunTotals{Interrupted: 3}}
	if err := ApplySummary(&result, []byte(recordedSummary), test, []model.K6ExportStep{{StepID: "st-login", Tag: "login"}}); err != nil {
		t.Fatal(err)
	}
	totals := result.Totals
	if totals.Requests != 40 || totals.FailedCount != 2 || totals.FailedRate != 0.05 || totals.ChecksPassed != 39 || totals.ChecksFailed != 1 || totals.Iterations != 40 || totals.MaxVUs != 2 || totals.P95 != 2.41 || totals.Interrupted != 3 {
		t.Errorf("totals = %+v", totals)
	}
	if len(result.Steps) != 1 || result.Steps[0].Requests != 40 || result.Steps[0].P99 != 4.5 || result.Steps[0].FailedRate != 0.05 || result.Steps[0].ChecksFailed != 1 {
		t.Errorf("steps = %+v", result.Steps)
	}
	want := []struct {
		expression string
		ok         bool
		actual     float64
	}{{"p(95)<300", true, 2.41}, {"p(99)<4", false, 4.5}, {"rate<0.01", false, 0.05}, {"rate>0.9", true, 0.975}}
	if len(result.Thresholds) != len(want) {
		t.Fatalf("thresholds = %+v", result.Thresholds)
	}
	for i, threshold := range result.Thresholds {
		if threshold.Expression != want[i].expression || threshold.Ok != want[i].ok || threshold.Actual != want[i].actual || !threshold.HasActual {
			t.Errorf("threshold %d = %+v, want %+v", i, threshold, want[i])
		}
	}
	if result.Thresholds[1].StepID != "st-login" {
		t.Error("a step threshold keeps its step")
	}
}

func TestApplySummaryRefusesBrokenJSON(t *testing.T) {
	if err := ApplySummary(&model.LoadRunResult{}, []byte("{"), model.LoadTest{}, nil); err == nil {
		t.Fatal("expected an error")
	}
}

func TestParseProgress(t *testing.T) {
	cases := map[string]model.LoadRunProgress{
		"running (01.0s), 2/2 VUs, 8 complete and 0 interrupted iterations":              {ElapsedMs: 1000, VUs: 2, MaxVUs: 2, Iterations: 8},
		"running (0m04.0s), 0/2 VUs, 38 complete and 2 interrupted iterations":           {ElapsedMs: 4000, VUs: 0, MaxVUs: 2, Iterations: 38, Interrupted: 2},
		"running (1h02m03.5s), 140/200 VUs, 99012 complete and 0 interrupted iterations": {ElapsedMs: 3723500, VUs: 140, MaxVUs: 200, Iterations: 99012},
	}
	for line, want := range cases {
		got, ok := ParseProgress(line)
		if !ok || got != want {
			t.Errorf("ParseProgress(%q) = %+v, %v; want %+v", line, got, ok, want)
		}
	}
	if _, ok := ParseProgress("main   [  25% ] 2 VUs  1.0s/4s"); ok {
		t.Error("the bar line is not progress")
	}
}

func TestParseDashboardURL(t *testing.T) {
	if got := ParseDashboardURL(" web dashboard: http://127.0.0.1:18090"); got != "http://127.0.0.1:18090" {
		t.Errorf("got %q", got)
	}
	if got := ParseDashboardURL("        output: -"); got != "" {
		t.Errorf("got %q", got)
	}
}

func TestRunStatus(t *testing.T) {
	for _, tc := range []struct {
		code    int
		stopped bool
		err     error
		want    string
	}{
		{0, false, nil, "passed"},
		{99, false, nil, "failed"},
		{105, true, nil, "stopped"},
		{107, false, nil, "error"},
		{0, false, errors.New("boom"), "error"},
	} {
		if got := RunStatus(tc.code, tc.stopped, tc.err); got != tc.want {
			t.Errorf("RunStatus(%d, %v, %v) = %q, want %q", tc.code, tc.stopped, tc.err, got, tc.want)
		}
	}
}

func TestPlannedDurationMs(t *testing.T) {
	ramp := model.LoadTest{Scenarios: []model.LoadScenario{{Executor: model.LoadExecutor{Type: "ramping-vus", Stages: []model.LoadStage{{DurationMs: 1000}, {DurationMs: 2500}}}}}}
	if got := PlannedDurationMs(ramp); got != 3500 {
		t.Errorf("got %d", got)
	}
	constant := model.LoadTest{Scenarios: []model.LoadScenario{{Executor: model.LoadExecutor{Type: "constant-vus", DurationMs: 60000}}}}
	if got := PlannedDurationMs(constant); got != 60000 {
		t.Errorf("got %d", got)
	}
	if got := PlannedDurationMs(model.LoadTest{}); got != 0 {
		t.Errorf("got %d", got)
	}
}

func TestFindK6ReportsAMissingProgram(t *testing.T) {
	info := FindK6("/definitely/not/k6", nil)
	if info.Found || info.Error == "" {
		t.Fatalf("got %+v", info)
	}
}

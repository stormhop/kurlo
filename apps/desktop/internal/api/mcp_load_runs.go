package api

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/stormhop/kurlo/apps/desktop/internal/loadtest"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func (s *mcpServer) toolListLoadTests(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Collection string `json:"collection"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	tests := []map[string]string{}
	for _, collection := range ws.collections {
		if args.Collection != "" && !loadCLICollectionMatches(collection, args.Collection) {
			continue
		}
		for _, test := range collection.LoadTests {
			tests = append(tests, map[string]string{"id": test.ID, "name": test.Name, "collection": collection.Name, "collectionId": collection.ID})
		}
	}
	return map[string]any{"tests": tests}, nil
}

func (s *mcpServer) loadTestEntry(ws mcpWorkspace, ref string) (cliLoadTest, error) {
	if strings.TrimSpace(ref) == "" {
		return cliLoadTest{}, fmt.Errorf("provide a load test ID or name")
	}
	var entries []cliLoadTest
	for _, collection := range ws.collections {
		for _, test := range collection.LoadTests {
			entries = append(entries, cliLoadTest{collection: collection, test: test})
		}
	}
	return selectCLILoadTest(s.opts.workspace, ref, entries)
}

type mcpLoadRunRef struct {
	Test      string `json:"test"`
	StartedAt int64  `json:"startedAt"`
}

func (s *mcpServer) toolGetLoadTest(_ context.Context, arguments json.RawMessage) (any, error) {
	var args mcpLoadRunRef
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	entry, err := s.loadTestEntry(ws, args.Test)
	if err != nil {
		return nil, err
	}
	return map[string]any{"collection": entry.collection.Name, "collectionId": entry.collection.ID, "test": entry.test}, nil
}

func (s *mcpServer) toolSaveLoadTest(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Collection string         `json:"collection"`
		Test       model.LoadTest `json:"test"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	args.Test.Name = strings.TrimSpace(args.Test.Name)
	return s.mutate(ctx, func(st *mcpStore) (func() any, error) {
		collection, err := st.collection(args.Collection)
		if err != nil {
			return nil, err
		}
		id := stringValue(collection, "id")
		tests := mapSlice(collection["loadTests"])
		index := -1
		for i, test := range tests {
			if stringValue(test, "id") == args.Test.ID && args.Test.ID != "" {
				index = i
			}
		}
		if args.Test.ID == "" {
			args.Test.ID = uuid.NewString()
		} else if index < 0 {
			return nil, fmt.Errorf("load test ID %q does not exist in this collection; omit id to create a test", args.Test.ID)
		}
		var targets []model.LoadTestRequest
		for _, request := range st.requests {
			if stringValue(request, "collectionId") == id && request["isDraft"] != true {
				kind := stringValue(request, "requestType")
				if strings.EqualFold(stringValue(request, "method"), "SSE") {
					kind = "sse"
				}
				targets = append(targets, model.LoadTestRequest{ID: stringValue(request, "id"), RequestType: kind})
			}
		}
		for i := range args.Test.Scenarios {
			scenario := &args.Test.Scenarios[i]
			if scenario.ID == "" {
				scenario.ID = uuid.NewString()
			}
			for j := range scenario.Steps {
				if scenario.Steps[j].ID == "" {
					scenario.Steps[j].ID = uuid.NewString()
				}
			}
		}
		if problems := loadtest.Validate(args.Test, targets); len(problems) > 0 {
			return nil, fmt.Errorf("invalid load test: %s", strings.Join(problems, "; "))
		}
		encoded, err := json.Marshal(args.Test)
		if err != nil {
			return nil, err
		}
		var stored map[string]any
		if err := json.Unmarshal(encoded, &stored); err != nil {
			return nil, err
		}
		delete(stored, filesystemNameField)
		if index >= 0 {
			if name := stringValue(tests[index], filesystemNameField); name != "" {
				stored[filesystemNameField] = name
			}
			tests[index] = stored
		} else {
			tests = append(tests, stored)
		}
		collection["loadTests"] = tests
		return func() any { return map[string]any{"test": args.Test, "collectionId": id, "created": index < 0} }, nil
	})
}

func (s *mcpServer) toolStartLoadTest(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Test        string `json:"test"`
		Environment string `json:"environment"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	entry, err := s.loadTestEntry(ws, args.Test)
	if err != nil {
		return nil, err
	}
	payload := loadTestPayload{LoadTest: entry.test, Collection: entry.collection}
	for _, request := range ws.requests {
		if request.CollectionID == entry.collection.ID {
			payload.Requests = append(payload.Requests, request)
		}
	}
	environment := defaultString(args.Environment, defaultString(entry.test.Settings.Environment, s.opts.env))
	if environment != "" {
		for i := range ws.environments {
			env := &ws.environments[i]
			if env.WorkspaceID != entry.collection.WorkspaceID || !strings.EqualFold(env.Name, environment) {
				continue
			}
			if env.Protected {
				return nil, fmt.Errorf("environment %q is protected; run this test in Kurlo", env.Name)
			}
			if payload.Environment != nil {
				return nil, fmt.Errorf("environment %q is ambiguous", environment)
			}
			payload.Environment = env
		}
		if payload.Environment == nil {
			return nil, fmt.Errorf("environment %q was not found in the collection's workspace", environment)
		}
		payload.LoadTest.Settings.Environment = payload.Environment.Name
	}
	globals, secrets := mcpGlobalValues(s.opts.workspace, s.opts.loadAppSecrets)
	for name, value := range globals {
		secret := false
		for _, candidate := range secrets {
			if value != "" && value == candidate {
				secret = true
				break
			}
		}
		payload.Globals = append(payload.Globals, cliKV{Key: name, Value: value, Enabled: true, Secret: secret})
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	plan, err := loadTestPlanFromPayload(string(encoded), s.opts.workspace)
	if err != nil {
		return nil, err
	}
	if plan.DataError != "" {
		return nil, fmt.Errorf("test data: %s", plan.DataError)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	state := s.executionApp.startLoadPlan(plan, payload, "")
	if state.Error != "" {
		return nil, fmt.Errorf("%s", state.Error)
	}
	return state, nil
}

func (s *mcpServer) toolLoadTestStatus(_ context.Context, _ json.RawMessage) (any, error) {
	state := s.executionApp.LoadRunStatus()
	if state.Running {
		ws, err := s.loadWorkspace()
		if err != nil {
			return nil, err
		}
		for _, collection := range ws.collections {
			if collection.ID == state.CollectionID {
				return state, nil
			}
		}
		return nil, fmt.Errorf("the active k6 run belongs to another workspace")
	}
	return state, nil
}

func (s *mcpServer) toolStopLoadTest(ctx context.Context, arguments json.RawMessage) (any, error) {
	out, err := s.toolLoadTestStatus(ctx, arguments)
	if err != nil {
		return nil, err
	}
	checked := out.(model.LoadRunState)
	manager := &s.executionApp.loadRuns
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.run != nil && checked.Running && checked.StartedAt == manager.state.StartedAt && checked.CollectionID == manager.state.CollectionID {
		manager.state.Stopping = true
		manager.run.Stop()
		return manager.state, nil
	}
	return model.LoadRunState{}, nil
}

func (s *mcpServer) loadTestResult(ws mcpWorkspace, ref mcpLoadRunRef) (model.LoadRunResult, error) {
	entry, err := s.loadTestEntry(ws, ref.Test)
	if err != nil {
		return model.LoadRunResult{}, err
	}
	result := model.LoadRunResult{}
	if ref.StartedAt == 0 {
		result = s.executionApp.LastLoadRun(entry.test.ID)
	} else {
		data, err := os.ReadFile(loadRunSnapshotPath(entry.collection.ID, entry.test.ID, ref.StartedAt))
		if err == nil {
			err = json.Unmarshal(data, &result)
		}
		if os.IsNotExist(err) {
			latest := s.executionApp.LastLoadRun(entry.test.ID)
			if latest.StartedAt == ref.StartedAt {
				result = latest
			}
		} else if err != nil {
			return result, err
		}
	}
	if result.LoadTestID != entry.test.ID || result.CollectionID != entry.collection.ID || result.FinishedAt == 0 {
		return model.LoadRunResult{}, fmt.Errorf("no completed run found for load test %q", entry.test.Name)
	}
	return result, nil
}

func (s *mcpServer) toolLoadTestResult(_ context.Context, arguments json.RawMessage) (any, error) {
	var args mcpLoadRunRef
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	return s.loadTestResult(ws, args)
}

func (s *mcpServer) toolCompareLoadRuns(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Baseline  mcpLoadRunRef `json:"baseline"`
		Candidate mcpLoadRunRef `json:"candidate"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	baseline, err := s.loadTestResult(ws, args.Baseline)
	if err != nil {
		return nil, fmt.Errorf("baseline: %w", err)
	}
	candidate, err := s.loadTestResult(ws, args.Candidate)
	if err != nil {
		return nil, fmt.Errorf("candidate: %w", err)
	}
	if !baseline.HasSummary || !candidate.HasSummary {
		return nil, fmt.Errorf("both runs need a k6 summary")
	}
	a, b := baseline.Totals, candidate.Totals
	return map[string]any{"baseline": baseline, "candidate": candidate, "delta": map[string]any{
		"requests": b.Requests - a.Requests, "rps": b.RPS - a.RPS, "avgMs": b.Avg - a.Avg, "p95Ms": b.P95 - a.P95, "p99Ms": b.P99 - a.P99,
		"failedRate": b.FailedRate - a.FailedRate, "checksFailed": b.ChecksFailed - a.ChecksFailed,
	}}, nil
}

func (s *mcpServer) toolListLoadRuns(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Test  string `json:"test"`
		Limit int    `json:"limit"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if args.Limit < 0 || args.Limit > 50 {
		return nil, fmt.Errorf("limit must be between 1 and 50")
	}
	limit := args.Limit
	if limit == 0 {
		limit = 10
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	entry, err := s.loadTestEntry(ws, args.Test)
	if err != nil {
		return nil, err
	}
	files, err := os.ReadDir(filepath.Dir(loadRunSnapshotPath(entry.collection.ID, entry.test.ID, 0)))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	var timestamps []int64
	for _, file := range files {
		if name, ok := strings.CutSuffix(file.Name(), ".json"); ok && !file.IsDir() {
			if at, err := strconv.ParseInt(name, 10, 64); err == nil && at > 0 {
				timestamps = append(timestamps, at)
			}
		}
	}
	if latest := s.executionApp.LastLoadRun(entry.test.ID); latest.CollectionID == entry.collection.ID && latest.FinishedAt > 0 && !slices.Contains(timestamps, latest.StartedAt) {
		timestamps = append(timestamps, latest.StartedAt)
	}
	slices.Sort(timestamps)
	slices.Reverse(timestamps)
	runs := []map[string]any{}
	for _, at := range timestamps[:min(limit, len(timestamps))] {
		run, err := s.loadTestResult(ws, mcpLoadRunRef{Test: entry.test.ID, StartedAt: at})
		if err == nil {
			runs = append(runs, map[string]any{"startedAt": at, "finishedAt": run.FinishedAt, "status": run.Status, "environment": run.Environment, "totals": run.Totals})
		}
	}
	return map[string]any{"test": entry.test.ID, "runs": runs}, nil
}

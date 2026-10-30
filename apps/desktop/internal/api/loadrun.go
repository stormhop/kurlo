package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/loadtest"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	loadRunsDirName   = "loadruns"
	loadRunLogLimit   = 500
	loadRunResultFile = "result.json"
	loadRunReportFile = "report.html"
	loadRunSummary    = "summary.json"
)

var safeLoadTestID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

type loadRunManager struct {
	mu     sync.Mutex
	run    *loadtest.Run
	state  model.LoadRunState
	log    []string
	result model.LoadRunResult
}

func loadRunDir(loadTestID string) string {
	name := loadTestID
	if !safeLoadTestID.MatchString(name) {
		sum := sha256.Sum256([]byte(loadTestID))
		name = hex.EncodeToString(sum[:12])
	}
	return filepath.Join(requestStoreDir(), loadRunsDirName, name)
}

func (a *App) emit(name string, payload any) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, name, payload)
}

func (a *App) K6Info(path string) model.K6Info {
	return loadtest.FindK6(path, hideCmdWindow)
}

func (a *App) LoadRunStatus() model.LoadRunState {
	a.loadRuns.mu.Lock()
	defer a.loadRuns.mu.Unlock()
	return a.loadRuns.state
}

func (a *App) LoadRunLog() []string {
	a.loadRuns.mu.Lock()
	defer a.loadRuns.mu.Unlock()
	return append([]string{}, a.loadRuns.log...)
}

func (a *App) LoadTestTargets(payload string) []string {
	plan, err := loadTestPlanFromPayload(payload, "")
	if err != nil {
		return []string{}
	}
	return loadTestHosts(plan)
}

func loadTestHosts(plan loadtest.Plan) []string {
	values := map[string]string{}
	for _, variable := range plan.Variables {
		values[variable.Name] = variable.Value
	}
	seen := map[string]bool{}
	hosts := []string{}
	if len(plan.Test.Scenarios) == 0 {
		return hosts
	}
	for _, step := range plan.Test.Scenarios[0].Steps {
		request, ok := plan.Requests[step.RequestID]
		if !ok {
			continue
		}
		target := resolveTemplateValue(request.URL, values)
		host := target
		if parsed, err := url.Parse(target); err == nil && parsed.Hostname() != "" {
			host = parsed.Hostname()
		}
		if host != "" && !seen[host] {
			seen[host] = true
			hosts = append(hosts, host)
		}
	}
	sort.Strings(hosts)
	return hosts
}

func (a *App) StartLoadRun(payload, k6Path string) model.LoadRunState {
	failed := func(message string) model.LoadRunState {
		return model.LoadRunState{Error: message}
	}
	a.loadRuns.mu.Lock()
	if a.loadRuns.state.Running {
		state := a.loadRuns.state
		a.loadRuns.mu.Unlock()
		state.Error = "Another load test is running. Stop it first."
		return state
	}
	a.loadRuns.mu.Unlock()

	plan, err := loadTestPlanFromPayload(payload, fileWorkspaceStorePath())
	if err != nil {
		return failed(err.Error())
	}
	var decoded loadTestPayload
	_ = json.Unmarshal([]byte(payload), &decoded)
	targets := make([]model.LoadTestRequest, 0, len(decoded.Requests))
	for _, request := range decoded.Requests {
		if !request.IsDraft {
			targets = append(targets, model.LoadTestRequest{ID: request.ID, RequestType: request.RequestType})
		}
	}
	if problems := loadtest.Validate(plan.Test, targets); len(problems) > 0 {
		return failed("Fix the problems in the load test before running it: " + problems[0])
	}
	for _, variable := range plan.Variables {
		if variable.Secret && strings.ContainsRune(variable.Value, '\x00') {
			return failed(fmt.Sprintf("Secret variable %q contains a NUL byte. Remove it before running with k6.", variable.Name))
		}
	}
	k6 := loadtest.FindK6(k6Path, hideCmdWindow)
	if !k6.Found {
		return failed(k6.Error)
	}
	export := loadtest.GenerateK6(plan, loadtest.Options{})
	dir, err := os.MkdirTemp("", "kurlo-load-*")
	if err != nil {
		return failed(err.Error())
	}
	if err := os.WriteFile(filepath.Join(dir, export.FileName), []byte(export.Script), 0600); err != nil {
		_ = os.RemoveAll(dir)
		return failed(err.Error())
	}
	env := []string{"K6_NO_USAGE_REPORT=true", "K6_WEB_DASHBOARD=true", "K6_WEB_DASHBOARD_OPEN=false", "K6_WEB_DASHBOARD_EXPORT=" + loadRunReportFile}
	if port, err := freeLocalPort(); err == nil {
		env = append(env, fmt.Sprintf("K6_WEB_DASHBOARD_PORT=%d", port))
	}
	for _, variable := range plan.Variables {
		if variable.Secret && variable.Value != "" && !strings.ContainsAny(variable.Name, "=\x00") {
			env = append(env, variable.Name+"="+variable.Value)
		}
	}

	environment := ""
	if decoded.Environment != nil {
		environment = decoded.Environment.Name
	}
	started := time.Now()
	state := model.LoadRunState{
		Running:      true,
		LoadTestID:   plan.Test.ID,
		CollectionID: decoded.Collection.ID,
		StartedAt:    started.UnixMilli(),
		PlannedMs:    loadtest.PlannedDurationMs(plan.Test),
		K6Version:    k6.Version,
	}
	result := model.LoadRunResult{
		LoadTestID:   plan.Test.ID,
		CollectionID: decoded.Collection.ID,
		LoadTestName: plan.Test.Name,
		Environment:  environment,
		K6Version:    k6.Version,
		StartedAt:    started.UnixMilli(),
		Thresholds:   []model.LoadRunThreshold{},
		Steps:        []model.LoadRunStep{},
	}

	a.loadRuns.mu.Lock()
	if a.loadRuns.state.Running {
		a.loadRuns.mu.Unlock()
		_ = os.RemoveAll(dir)
		return failed("Another load test is running. Stop it first.")
	}
	a.loadRuns.state = state
	a.loadRuns.log = nil
	a.loadRuns.result = result
	run, err := loadtest.StartK6(loadtest.RunOptions{
		K6Path:     k6.Path,
		Dir:        dir,
		ScriptName: export.FileName,
		Env:        env,
		Prepare:    hideCmdWindow,
		OnLine:     a.onLoadRunLine,
	})
	if err != nil {
		a.loadRuns.state = model.LoadRunState{}
		a.loadRuns.mu.Unlock()
		_ = os.RemoveAll(dir)
		return failed(fmt.Sprintf("k6 did not start: %v", err))
	}
	a.loadRuns.run = run
	a.loadRuns.mu.Unlock()
	a.emit("load:progress", state)
	go a.finishLoadRun(run, dir, plan.Test, export.Steps)
	return state
}

func freeLocalPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func (a *App) onLoadRunLine(line string) {
	a.loadRuns.mu.Lock()
	a.loadRuns.log = append(a.loadRuns.log, line)
	if len(a.loadRuns.log) > loadRunLogLimit {
		a.loadRuns.log = a.loadRuns.log[len(a.loadRuns.log)-loadRunLogLimit:]
	}
	changed := false
	if progress, ok := loadtest.ParseProgress(line); ok {
		a.loadRuns.state.Progress = progress
		a.loadRuns.result.Totals.Interrupted = progress.Interrupted
		changed = true
	}
	if dashboard := loadtest.ParseDashboardURL(line); dashboard != "" {
		a.loadRuns.state.DashboardURL = dashboard
		changed = true
	}
	state := a.loadRuns.state
	a.loadRuns.mu.Unlock()
	a.emit("load:log", line)
	if changed {
		a.emit("load:progress", state)
	}
}

func (a *App) finishLoadRun(run *loadtest.Run, dir string, test model.LoadTest, steps []model.K6ExportStep) {
	exitCode, runErr := run.Wait()
	defer os.RemoveAll(dir)

	a.loadRuns.mu.Lock()
	result := a.loadRuns.result
	logTail := append([]string{}, a.loadRuns.log...)
	a.loadRuns.mu.Unlock()

	result.FinishedAt = time.Now().UnixMilli()
	result.ExitCode = exitCode
	result.Status = loadtest.RunStatus(exitCode, run.Stopped(), runErr)
	if runErr != nil {
		result.Error = runErr.Error()
	}
	summary, summaryErr := os.ReadFile(filepath.Join(dir, loadRunSummary))
	if summaryErr == nil {
		if err := loadtest.ApplySummary(&result, summary, test, steps); err != nil && result.Error == "" {
			result.Error = err.Error()
		}
	}
	if result.Status == "error" && result.Error == "" {
		result.Error = lastErrorLine(logTail, exitCode)
	}
	report, reportErr := os.ReadFile(filepath.Join(dir, loadRunReportFile))
	result.HasSummary = summaryErr == nil
	result.HasReport = reportErr == nil
	if err := saveLoadRun(result, summary, report); err != nil && result.Error == "" {
		result.Error = "The result could not be saved: " + err.Error()
	}

	a.loadRuns.mu.Lock()
	a.loadRuns.run = nil
	a.loadRuns.state = model.LoadRunState{}
	a.loadRuns.mu.Unlock()
	a.emit("load:progress", model.LoadRunState{})
	a.emit("load:done", result)
}

func lastErrorLine(lines []string, exitCode int) string {
	for i := len(lines) - 1; i >= 0; i-- {
		line := lines[i]
		if strings.Contains(line, "level=error") {
			if start := strings.Index(line, `msg="`); start >= 0 {
				message := line[start+5:]
				if end := strings.Index(message, `"`); end >= 0 {
					return message[:end]
				}
			}
			return line
		}
	}
	return fmt.Sprintf("k6 ended with exit code %d.", exitCode)
}

func saveLoadRun(result model.LoadRunResult, summary, report []byte) error {
	dir := loadRunDir(result.LoadTestID)
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, loadRunResultFile), data, 0600); err != nil {
		return err
	}
	if summary != nil {
		if err := os.WriteFile(filepath.Join(dir, loadRunSummary), summary, 0600); err != nil {
			return err
		}
	}
	if report != nil {
		if err := os.WriteFile(filepath.Join(dir, loadRunReportFile), report, 0600); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) StopLoadRun() model.LoadRunState {
	a.loadRuns.mu.Lock()
	defer a.loadRuns.mu.Unlock()
	if a.loadRuns.run == nil {
		return a.loadRuns.state
	}
	a.loadRuns.state.Stopping = true
	a.loadRuns.run.Stop()
	return a.loadRuns.state
}

func (a *App) LastLoadRun(loadTestID string) model.LoadRunResult {
	data, err := os.ReadFile(filepath.Join(loadRunDir(loadTestID), loadRunResultFile))
	if err != nil {
		return model.LoadRunResult{Thresholds: []model.LoadRunThreshold{}, Steps: []model.LoadRunStep{}}
	}
	var result model.LoadRunResult
	if err := json.Unmarshal(data, &result); err != nil || result.LoadTestID != loadTestID {
		return model.LoadRunResult{Thresholds: []model.LoadRunThreshold{}, Steps: []model.LoadRunStep{}}
	}
	return result
}

func (a *App) LoadRunSummaryJSON(loadTestID string) string {
	data, err := os.ReadFile(filepath.Join(loadRunDir(loadTestID), loadRunSummary))
	if err != nil {
		return ""
	}
	return string(data)
}

func (a *App) OpenLoadRunReport(loadTestID string) string {
	path := filepath.Join(loadRunDir(loadTestID), loadRunReportFile)
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "This run has no HTML report. k6 writes one only for runs long enough to chart."
		}
		return err.Error()
	}
	if err := revealInFileManager(path); err != nil {
		return err.Error()
	}
	return ""
}

func (a *App) stopLoadRunForShutdown() {
	a.loadRuns.mu.Lock()
	run := a.loadRuns.run
	a.loadRuns.mu.Unlock()
	if run == nil {
		return
	}
	run.Stop()
	done := make(chan struct{})
	go func() {
		_, _ = run.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
	}
}

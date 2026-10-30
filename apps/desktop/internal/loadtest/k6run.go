package loadtest

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	ExitThresholdsFailed = 99
	stopGrace            = 10 * time.Second
)

var (
	progressLine  = regexp.MustCompile(`running \(([^)]*)\), (\d+)/(\d+) VUs, (\d+) complete and (\d+) interrupted iterations`)
	dashboardLine = regexp.MustCompile(`web dashboard: (https?://\S+)`)
	versionLine   = regexp.MustCompile(`k6 (v\d+\.\d+\.\d+\S*)`)
)

func FindK6(configured string, prepare func(*exec.Cmd)) model.K6Info {
	path := strings.TrimSpace(configured)
	if path == "" {
		found, err := exec.LookPath("k6")
		if err != nil {
			return model.K6Info{Error: "k6 is not installed or not on the PATH."}
		}
		path = found
	} else if info, err := os.Stat(path); err != nil || info.IsDir() {
		return model.K6Info{Path: path, Error: "There is no k6 program at this path."}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version")
	if prepare != nil {
		prepare(cmd)
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		return model.K6Info{Path: path, Error: fmt.Sprintf("k6 did not start: %v", err)}
	}
	match := versionLine.FindStringSubmatch(string(output))
	if match == nil {
		return model.K6Info{Path: path, Error: "This program does not look like k6."}
	}
	return model.K6Info{Found: true, Path: path, Version: match[1]}
}

func ParseProgress(line string) (model.LoadRunProgress, bool) {
	match := progressLine.FindStringSubmatch(line)
	if match == nil {
		return model.LoadRunProgress{}, false
	}
	elapsed, err := time.ParseDuration(strings.TrimSpace(match[1]))
	if err != nil {
		return model.LoadRunProgress{}, false
	}
	vus, _ := strconv.Atoi(match[2])
	maxVUs, _ := strconv.Atoi(match[3])
	complete, _ := strconv.ParseInt(match[4], 10, 64)
	interrupted, _ := strconv.ParseInt(match[5], 10, 64)
	return model.LoadRunProgress{ElapsedMs: elapsed.Milliseconds(), VUs: vus, MaxVUs: maxVUs, Iterations: complete, Interrupted: interrupted}, true
}

func ParseDashboardURL(line string) string {
	if match := dashboardLine.FindStringSubmatch(line); match != nil {
		return match[1]
	}
	return ""
}

type RunOptions struct {
	K6Path     string
	Dir        string
	ScriptName string
	Env        []string
	Prepare    func(*exec.Cmd)
	OnLine     func(string)
}

type Run struct {
	cmd      *exec.Cmd
	done     chan struct{}
	exitCode int
	err      error
	mu       sync.Mutex
	stopping bool
}

func StartK6(options RunOptions) (*Run, error) {
	cmd := exec.Command(options.K6Path, "run", "--no-color", "--summary-export", "summary.json", options.ScriptName)
	cmd.Dir = options.Dir
	cmd.Env = append(os.Environ(), options.Env...)
	if options.Prepare != nil {
		options.Prepare(cmd)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	run := &Run{cmd: cmd, done: make(chan struct{})}
	go func() {
		scanLines(stdout, options.OnLine)
		err := cmd.Wait()
		run.exitCode = 0
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			run.exitCode = exit.ExitCode()
		} else if err != nil {
			run.err = err
			run.exitCode = -1
		}
		close(run.done)
	}()
	return run, nil
}

func scanLines(reader io.Reader, onLine func(string)) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		if onLine != nil {
			onLine(scanner.Text())
		}
	}
	_, _ = io.Copy(io.Discard, reader)
}

func (r *Run) Stop() {
	r.mu.Lock()
	if r.stopping {
		r.mu.Unlock()
		return
	}
	r.stopping = true
	r.mu.Unlock()
	if goruntime.GOOS == "windows" {
		_ = r.cmd.Process.Kill()
		return
	}
	_ = r.cmd.Process.Signal(os.Interrupt)
	go func() {
		select {
		case <-r.done:
		case <-time.After(stopGrace):
			_ = r.cmd.Process.Kill()
		}
	}()
}

func (r *Run) Stopped() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stopping
}

func (r *Run) Wait() (int, error) {
	<-r.done
	return r.exitCode, r.err
}

type summaryMetric map[string]json.RawMessage

func (m summaryMetric) number(key string) (float64, bool) {
	raw, ok := m[key]
	if !ok {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

func (m summaryMetric) value(key string) float64 {
	value, _ := m.number(key)
	return value
}

func (m summaryMetric) count(key string) int64 {
	return int64(m.value(key))
}

func (m summaryMetric) failedThreshold(expression string) (bool, bool) {
	raw, ok := m["thresholds"]
	if !ok {
		return false, false
	}
	var thresholds map[string]bool
	if err := json.Unmarshal(raw, &thresholds); err != nil {
		return false, false
	}
	failed, ok := thresholds[expression]
	return failed, ok
}

func ApplySummary(result *model.LoadRunResult, data []byte, test model.LoadTest, steps []model.K6ExportStep) error {
	var summary struct {
		Metrics map[string]summaryMetric `json:"metrics"`
	}
	if err := json.Unmarshal(data, &summary); err != nil {
		return fmt.Errorf("k6 summary: %w", err)
	}
	metric := func(name string) summaryMetric {
		if found, ok := summary.Metrics[name]; ok {
			return found
		}
		return summaryMetric{}
	}
	duration := metric("http_req_duration")
	failed := metric("http_req_failed")
	checks := metric("checks")
	result.Totals = model.LoadRunTotals{
		Requests:     metric("http_reqs").count("count"),
		RPS:          metric("http_reqs").value("rate"),
		Avg:          duration.value("avg"),
		Med:          duration.value("med"),
		P95:          duration.value("p(95)"),
		P99:          duration.value("p(99)"),
		Max:          duration.value("max"),
		FailedRate:   failed.value("value"),
		FailedCount:  failed.count("passes"),
		ChecksPassed: checks.count("passes"),
		ChecksFailed: checks.count("fails"),
		Iterations:   metric("iterations").count("count"),
		Interrupted:  result.Totals.Interrupted,
		MaxVUs:       int(metric("vus_max").value("max")),
	}
	tags := map[string]string{}
	result.Steps = make([]model.LoadRunStep, 0, len(steps))
	for _, step := range steps {
		tags[step.StepID] = step.Tag
		stepDuration := metric("http_req_duration{step:" + step.Tag + "}")
		stepChecks := metric("checks{step:" + step.Tag + "}")
		result.Steps = append(result.Steps, model.LoadRunStep{
			StepID:       step.StepID,
			Tag:          step.Tag,
			Requests:     metric("http_reqs{step:" + step.Tag + "}").count("count"),
			Med:          stepDuration.value("med"),
			P95:          stepDuration.value("p(95)"),
			P99:          stepDuration.value("p(99)"),
			FailedRate:   metric("http_req_failed{step:" + step.Tag + "}").value("value"),
			ChecksRate:   stepChecks.value("value"),
			ChecksPassed: stepChecks.count("passes"),
			ChecksFailed: stepChecks.count("fails"),
		})
	}
	result.Thresholds = make([]model.LoadRunThreshold, 0, len(test.Thresholds))
	for _, threshold := range test.Thresholds {
		tag := ""
		if threshold.Step != "" {
			tag = tags[threshold.Step]
			if tag == "" {
				continue
			}
		}
		source := metric(ThresholdKey(threshold, tag))
		expression := ThresholdExpression(threshold)
		failedThreshold, known := source.failedThreshold(expression)
		statKey := threshold.Stat
		if statKey == "rate" {
			statKey = "value"
		}
		actual, hasActual := source.number(statKey)
		result.Thresholds = append(result.Thresholds, model.LoadRunThreshold{
			Metric:     threshold.Metric,
			StepID:     threshold.Step,
			Expression: expression,
			Ok:         known && !failedThreshold,
			Actual:     actual,
			HasActual:  hasActual,
		})
	}
	return nil
}

func RunStatus(exitCode int, stopped bool, runErr error) string {
	switch {
	case runErr != nil:
		return "error"
	case exitCode == 0:
		return "passed"
	case exitCode == ExitThresholdsFailed:
		return "failed"
	case stopped:
		return "stopped"
	default:
		return "error"
	}
}

func PlannedDurationMs(test model.LoadTest) int64 {
	if len(test.Scenarios) == 0 {
		return 0
	}
	executor := test.Scenarios[0].Executor
	if len(executor.Stages) > 0 {
		var total int64
		for _, stage := range executor.Stages {
			total += int64(stage.DurationMs)
		}
		return total
	}
	return int64(executor.DurationMs)
}

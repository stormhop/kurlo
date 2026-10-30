package api

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/loadtest"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func runCLILoadTest(ctx context.Context, opts loadCLIOptions, plan loadtest.Plan, export model.K6ExportResult, stdout, stderr io.Writer) int {
	fail := func(err error) int {
		fmt.Fprintln(stderr, "kurlo load run:", err)
		return 1
	}
	if ctx.Err() != nil {
		return 130
	}
	if opts.k6 != "" {
		path, err := filepath.Abs(opts.k6)
		if err != nil {
			return fail(err)
		}
		opts.k6 = path
	}
	k6 := loadtest.FindK6(opts.k6, hideCmdWindow)
	if !k6.Found {
		return fail(fmt.Errorf("%s Install Grafana k6 (macOS: brew install k6), or pass --k6 /path/to/k6. Export works without k6", k6.Error))
	}
	if ctx.Err() != nil {
		return 130
	}
	dir, err := os.MkdirTemp("", "kurlo-load-cli-*")
	if err != nil {
		return fail(err)
	}
	defer os.RemoveAll(dir)
	if err := os.WriteFile(filepath.Join(dir, export.FileName), []byte(export.Script), 0600); err != nil {
		return fail(err)
	}
	env := []string{"K6_NO_USAGE_REPORT=true", "K6_WEB_DASHBOARD=false"}
	if opts.report != "" {
		port, err := freeLocalPort()
		if err != nil {
			return fail(err)
		}
		env = []string{
			"K6_NO_USAGE_REPORT=true", "K6_WEB_DASHBOARD=true", "K6_WEB_DASHBOARD_OPEN=false",
			fmt.Sprintf("K6_WEB_DASHBOARD_PORT=%d", port), "K6_WEB_DASHBOARD_EXPORT=report.html",
		}
	}
	var secrets []string
	for _, variable := range plan.Variables {
		if variable.Secret && variable.Value == "" {
			continue
		}
		env = append(env, variable.Name+"="+variable.Value)
		if variable.Secret {
			secrets = append(secrets, variable.Value)
		}
	}
	started := time.Now()
	fmt.Fprintf(stdout, "Running %s / %s with k6 %s\n", plan.Collection, plan.Test.Name, k6.Version)
	fmt.Fprintln(stdout, "Targets:", strings.Join(loadTestHosts(plan), ", "))
	var logError error
	run, err := loadtest.StartK6(loadtest.RunOptions{
		K6Path: k6.Path, Dir: dir, ScriptName: export.FileName, Env: env, Prepare: hideCmdWindow,
		OnLine: func(line string) {
			if _, err := fmt.Fprintln(stderr, redactSecrets(line, secrets)); err != nil && logError == nil {
				logError = err
			}
		},
	})
	if err != nil {
		return fail(err)
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			run.Stop()
		case <-done:
		}
	}()
	exitCode, runErr := run.Wait()
	close(done)
	result := model.LoadRunResult{
		LoadTestID: plan.Test.ID, LoadTestName: plan.Test.Name, Environment: plan.Test.Settings.Environment,
		StartedAt: started.UnixMilli(), FinishedAt: time.Now().UnixMilli(), K6Version: k6.Version,
		ExitCode: exitCode, Status: loadtest.RunStatus(exitCode, run.Stopped(), runErr),
	}
	summary, summaryErr := os.ReadFile(filepath.Join(dir, "summary.json"))
	if summaryErr == nil {
		summaryErr = loadtest.ApplySummary(&result, summary, plan.Test, export.Steps)
	}
	var artifactError error
	if opts.summary != "" && summaryErr == nil {
		artifactError = writeFileAtomic(opts.summary, summary)
	}
	if opts.report != "" {
		report, err := os.ReadFile(filepath.Join(dir, "report.html"))
		if err == nil {
			err = writeFileAtomic(opts.report, report)
		} else {
			err = fmt.Errorf("k6 did not produce an HTML report; use a run long enough for the web dashboard to collect samples: %w", err)
		}
		if artifactError == nil {
			artifactError = err
		}
	}
	display := result
	if result.Status != "stopped" && (summaryErr != nil || artifactError != nil || logError != nil) {
		display.Status = "error"
	}
	printCLILoadResult(stdout, display)
	if result.Status == "stopped" {
		if artifactError != nil {
			fmt.Fprintln(stderr, "kurlo load run:", artifactError)
		}
		return 130
	}
	if logError != nil {
		return fail(logError)
	}
	if artifactError != nil {
		return fail(artifactError)
	}
	if runErr != nil {
		return fail(runErr)
	}
	if result.Status == "error" {
		return fail(fmt.Errorf("k6 exited with code %d", exitCode))
	}
	if summaryErr != nil {
		return fail(fmt.Errorf("k6 summary: %w", summaryErr))
	}
	if result.Status == "failed" {
		return loadtest.ExitThresholdsFailed
	}
	return 0
}

func printCLILoadResult(stdout io.Writer, result model.LoadRunResult) {
	fmt.Fprintf(stdout, "\n%s · %d requests · %.1f req/s · p95 %.2f ms · %.2f%% failed\n", strings.ToUpper(result.Status), result.Totals.Requests, result.Totals.RPS, result.Totals.P95, result.Totals.FailedRate*100)
	if len(result.Thresholds) == 0 {
		return
	}
	writer := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(writer, "RESULT\tMETRIC\tSTEP\tTHRESHOLD\tACTUAL")
	for _, threshold := range result.Thresholds {
		status := "FAIL"
		if threshold.Ok {
			status = "PASS"
		}
		actual := "—"
		if threshold.HasActual {
			actual = fmt.Sprintf("%.4g", threshold.Actual)
			if threshold.Metric == "http_req_duration" {
				actual += " ms"
			} else {
				actual = fmt.Sprintf("%.4g%%", threshold.Actual*100)
			}
		}
		step := threshold.StepID
		if step == "" {
			step = "all"
		}
		fmt.Fprintf(writer, "%s\t%s\t%s\t%s\t%s\n", status, threshold.Metric, step, threshold.Expression, actual)
	}
	_ = writer.Flush()
}

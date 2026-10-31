package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func writeCLILoadFixture(t *testing.T, baseURL string) (string, string) {
	t.Helper()
	root := writeYAMLWorkspace(t, baseURL)
	test := model.LoadTest{
		ID: "lt-smoke", Name: "API smoke", Settings: model.LoadSettings{Environment: "Local"},
		Scenarios: []model.LoadScenario{{ID: "main", Name: "Flow", Executor: model.LoadExecutor{Type: "constant-vus", VUs: 1, DurationMs: 1000},
			Steps: []model.LoadStep{{ID: "step-ok", RequestID: "req-ok", ThinkTimeMs: 50, Checks: []model.LoadCheck{{Type: "status", Value: "200"}}}}}},
		Thresholds: []model.LoadThreshold{{Metric: "http_req_failed", Stat: "rate", Op: "<", Value: 0.01}},
	}
	data, err := json.Marshal(test)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "workspaces", "Demo", "collections", "Smoke", "loadtests")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "api-smoke.yml")
	if err := writeYAMLFile(path, filesystemLoadTestFile{Version: 1, LoadTest: raw}); err != nil {
		t.Fatal(err)
	}
	return root, path
}

func callLoadCLI(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := runLoadCLI(context.Background(), args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestLoadCLIArgumentsAndHelp(t *testing.T) {
	for _, args := range [][]string{nil, {"unknown"}, {"export"}, {"list", "test"}, {"run", "test", "extra"}, {"export", "test", "-o", "x", "--dir", "out"}, {"run", "test", "--inline-secrets"}, {"run", "test", "--json", "x", "--report", "x"}, {"export", "test", "--var", "bad"}} {
		if code, _, stderr := callLoadCLI(args...); code != 2 || stderr == "" {
			t.Errorf("%v: code %d, stderr %q", args, code, stderr)
		}
	}
	for _, args := range [][]string{{"--help"}, {"list", "--help"}, {"export", "--help"}, {"run", "--help"}} {
		if code, _, help := callLoadCLI(args...); code != 0 || !strings.Contains(help, "kurlo load") {
			t.Errorf("%v: code %d, help %q", args, code, help)
		}
	}
	opts, err := parseLoadCLIArgs([]string{"export", "--workspace", "workspace", "API smoke", "--env=Local", "--var", "x=y"}, &bytes.Buffer{})
	if err != nil || opts.test != "API smoke" || opts.workspace != "workspace" || opts.vars["x"] != "y" || opts.environment != "Local" {
		t.Fatalf("interspersed flags: %+v, %v", opts, err)
	}
}

func TestLoadCLIListsAndExportsByNameIDAndPath(t *testing.T) {
	root, path := writeCLILoadFixture(t, "http://127.0.0.1:1")
	if code, stdout, stderr := callLoadCLI("list", "--workspace", root); code != 0 || !strings.Contains(stdout, "API smoke") || !strings.Contains(stdout, "api-smoke.yml") {
		t.Fatalf("list: %d %s %s", code, stdout, stderr)
	}
	relative, _ := filepath.Rel(root, path)
	for _, selector := range []string{"API smoke", "api SMOKE", "lt-smoke", path, relative} {
		code, stdout, stderr := callLoadCLI("export", selector, "--workspace", root)
		if code != 0 || !strings.HasPrefix(stdout, "import http") || !strings.Contains(stdout, "http://127.0.0.1:1") || !strings.Contains(stderr, "not exported") {
			t.Fatalf("export %s: %d %s %s", selector, code, stdout, stderr)
		}
	}
	output := filepath.Join(t.TempDir(), "smoke.k6.js")
	if code, stdout, stderr := callLoadCLI("export", "API smoke", "--workspace", root, "-o", output); code != 0 || stdout != "" {
		t.Fatalf("file export: %d %s %s", code, stdout, stderr)
	}
	if data, err := os.ReadFile(output); err != nil || !bytes.Contains(data, []byte("http.request")) {
		t.Fatalf("file: %s %v", data, err)
	}
	for _, args := range [][]string{{"list", "--workspace", t.TempDir()}, {"list", "--workspace", root, "--collection", "missing"}, {"export", "missing", "--workspace", root}, {"run", "API smoke", "--workspace", root, "--env", "missing"}, {"run", "API smoke", "--workspace", root, "--k6", "/missing/k6"}} {
		if code, _, stderr := callLoadCLI(args...); code != 1 || stderr == "" {
			t.Errorf("%v: %d %s", args, code, stderr)
		}
	}
}

func TestLoadCLIRejectsAmbiguousNamesAndInvalidTests(t *testing.T) {
	root, path := writeCLILoadFixture(t, "http://127.0.0.1:1")
	data, _ := os.ReadFile(path)
	duplicate := strings.Replace(string(data), "lt-smoke", "lt-other", 1)
	second := filepath.Join(filepath.Dir(path), "duplicate.yml")
	if err := os.WriteFile(second, []byte(duplicate), 0600); err != nil {
		t.Fatal(err)
	}
	if code, _, stderr := callLoadCLI("export", "API smoke", "--workspace", root); code != 1 || !strings.Contains(stderr, "ambiguous") {
		t.Fatalf("ambiguity: %d %s", code, stderr)
	}
	if code, _, stderr := callLoadCLI("export", "lt-smoke", "--workspace", root); code != 0 {
		t.Fatalf("unique ID: %d %s", code, stderr)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(string(data), "req-ok", "req-missing", 1)), 0600); err != nil {
		t.Fatal(err)
	}
	if code, _, stderr := callLoadCLI("export", "lt-smoke", "--workspace", root); code != 1 || !strings.Contains(stderr, "invalid load test") {
		t.Fatalf("invalid test: %d %s", code, stderr)
	}
	if err := os.WriteFile(path, []byte("loadTest: ["), 0600); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := callLoadCLI("list", "--workspace", root); code != 1 {
		t.Fatal("malformed YAML should be diagnosed")
	}
}

func TestLoadCLIEnvironmentPrecedenceAndFolderExport(t *testing.T) {
	root, path := writeCLILoadFixture(t, "http://127.0.0.1:1")
	data, _ := os.ReadFile(path)
	var doc filesystemLoadTestFile
	if err := readYAMLFile(path, &doc); err != nil {
		t.Fatal(err)
	}
	doc.LoadTest["data"] = map[string]any{"path": "users.csv", "mode": "per-iteration"}
	if err := writeYAMLFile(path, doc); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "users.csv"), []byte("email\nada@test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	envFile := filepath.Join(t.TempDir(), "ci.env")
	if err := os.WriteFile(envFile, []byte("baseUrl=https://file.test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("baseUrl", "https://process.test")
	args := []string{"export", "API smoke", "--workspace", root, "--env-file", envFile, "--var", "baseUrl=https://override.test"}
	code, stdout, stderr := callLoadCLI(args...)
	if code != 0 || strings.Contains(stdout, "override.test") || !strings.Contains(stderr, "baseUrl is secret") {
		t.Fatalf("external secrets: %d %s %s", code, stdout, stderr)
	}
	code, stdout, stderr = callLoadCLI(append(args, "--inline-secrets")...)
	if code != 0 || !strings.Contains(stdout, "https://override.test") || !strings.Contains(stderr, "Do not commit") {
		t.Fatalf("inline secrets: %d %s %s", code, stdout, stderr)
	}
	dir := filepath.Join(t.TempDir(), "nested", "bundle")
	if code, stdout, stderr := callLoadCLI(append(args, "--dir", dir)...); code != 0 || stdout != "" {
		t.Fatalf("folder: %d %s %s", code, stdout, stderr)
	}
	for _, file := range []string{"script.k6.js", "data.json"} {
		if content, err := os.ReadFile(filepath.Join(dir, file)); err != nil || len(content) == 0 || bytes.Contains(content, []byte("override.test")) {
			t.Fatalf("bundle file %s: %s %v", file, content, err)
		}
	}
	if code, _, _ := callLoadCLI(append(args, "--dir", dir)...); code != 1 {
		t.Fatal("existing bundle must be preserved")
	}
	if err := os.Remove(filepath.Join(root, "users.csv")); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := callLoadCLI(args...); code != 1 {
		t.Fatal("missing data should prevent export")
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func runFakeCLIK6() int {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println("k6 v1.3.0")
		return 0
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	mode := os.Getenv("KURLO_FAKE_K6_MODE")
	script, _ := os.ReadFile(os.Args[len(os.Args)-1])
	if path := os.Getenv("KURLO_FAKE_K6_CAPTURE"); path != "" {
		data, _ := json.Marshal(map[string]any{"args": os.Args[1:], "secret": os.Getenv("baseUrl"), "script": string(script), "dir": mustCLIK6WorkingDir()})
		_ = os.WriteFile(path, data, 0600)
	}
	if mode != "no-summary" {
		summary := `{"metrics":{"http_reqs":{"count":5,"rate":2},"http_req_failed":{"value":0,"thresholds":{"rate<0.01":false}}}}`
		if mode == "failed" {
			summary = strings.ReplaceAll(summary, "false", "true")
		}
		if mode == "broken-summary" {
			summary = "{"
		}
		_ = os.WriteFile("summary.json", []byte(summary), 0600)
	}
	if path := os.Getenv("K6_WEB_DASHBOARD_EXPORT"); path != "" && mode != "no-report" {
		_ = os.WriteFile(path, []byte("<html>k6 report</html>"), 0600)
	}
	fmt.Println("running (00m01.0s), 1/1 VUs, 5 complete and 0 interrupted iterations")
	fmt.Println("baseUrl=" + os.Getenv("baseUrl"))
	if mode == "stop" {
		fmt.Println("READY")
		<-ctx.Done()
		return 105
	}
	if mode == "failed" {
		return 99
	}
	if mode == "error" {
		return 107
	}
	return 0
}

func mustCLIK6WorkingDir() string {
	dir, _ := os.Getwd()
	return dir
}

type cancelLoadCLIWriter struct {
	bytes.Buffer
	cancel context.CancelFunc
}

func (w *cancelLoadCLIWriter) Write(data []byte) (int, error) {
	if bytes.Contains(data, []byte("READY")) {
		w.cancel()
	}
	return w.Buffer.Write(data)
}

func TestLoadCLIRunExitCodesArtifactsSecretsAndStop(t *testing.T) {
	root, _ := writeCLILoadFixture(t, "http://127.0.0.1:1")
	k6, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(filepath.Dir(k6))
	t.Setenv("KURLO_TEST_K6_HELPER", "1")
	t.Setenv("baseUrl", "https://ci-secret.test")
	for mode, want := range map[string]int{"passed": 0, "failed": 99, "error": 1, "no-summary": 1, "broken-summary": 1, "no-report": 1, "stop": 130} {
		t.Run(mode, func(t *testing.T) {
			if mode == "stop" && runtime.GOOS == "windows" {
				t.Skip("Windows kills the process without a signal handler")
			}
			t.Setenv("KURLO_FAKE_K6_MODE", mode)
			dir := t.TempDir()
			capture := filepath.Join(dir, "capture.json")
			t.Setenv("KURLO_FAKE_K6_CAPTURE", capture)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			var stdout bytes.Buffer
			stderr := &cancelLoadCLIWriter{cancel: cancel}
			binary := k6
			if mode == "passed" {
				cwd, _ := os.Getwd()
				binary, _ = filepath.Rel(cwd, k6)
			}
			args := []string{"run", "API smoke", "--workspace", root, "--k6", binary, "--json", filepath.Join(dir, "summary.json")}
			if mode != "stop" {
				args = append(args, "--report", filepath.Join(dir, "report.html"))
			}
			code := runLoadCLI(ctx, args, &stdout, stderr)
			if code != want || strings.Contains(stderr.String(), "https://ci-secret.test") {
				t.Fatalf("code %d, want %d\n%s\n%s", code, want, stdout.String(), stderr.String())
			}
			if mode == "passed" || mode == "failed" || mode == "stop" {
				if _, err := os.Stat(filepath.Join(dir, "summary.json")); err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(stdout.String(), "http_req_failed") {
					t.Fatal("threshold table missing")
				}
			}
			data, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			var captured struct {
				Args   []string `json:"args"`
				Secret string   `json:"secret"`
				Script string   `json:"script"`
				Dir    string   `json:"dir"`
			}
			if err := json.Unmarshal(data, &captured); err != nil {
				t.Fatal(err)
			}
			if captured.Secret != "https://ci-secret.test" || strings.Contains(captured.Script, captured.Secret) || strings.Contains(strings.Join(captured.Args, " "), captured.Secret) {
				t.Fatalf("secret must travel only through the process environment: %+v", captured)
			}
			if _, err := os.Stat(captured.Dir); !os.IsNotExist(err) {
				t.Fatal("run directory should be removed")
			}
		})
	}
}

func TestLoadCLIWithRealK6(t *testing.T) {
	k6, err := exec.LookPath("k6")
	if err != nil {
		t.Skip("k6 is not installed")
	}
	for _, status := range []int{200, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("v") != "v1" {
					t.Error("collection variables did not reach k6")
				}
				w.WriteHeader(status)
			}))
			defer server.Close()
			root, path := writeCLILoadFixture(t, server.URL)
			t.Setenv("baseUrl", server.URL)
			dir := t.TempDir()
			summary := filepath.Join(dir, "summary.json")
			args := []string{"run", "API smoke", "--workspace", root, "--k6", k6, "--json", summary}
			if status == 200 && os.Getenv("KURLO_K6_REPORT_TEST") == "1" {
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				updated := strings.Replace(string(data), "durationMs: 1000", "durationMs: 35000", 1)
				if updated == string(data) {
					t.Fatal("could not extend the report test duration")
				}
				if err := os.WriteFile(path, []byte(updated), 0600); err != nil {
					t.Fatal(err)
				}
				args = append(args, "--report", filepath.Join(dir, "report.html"))
			}
			code, stdout, stderr := callLoadCLI(args...)
			want := 0
			if status == 500 {
				want = 99
			}
			if code != want || !strings.Contains(stdout, "http_req_failed") {
				t.Fatalf("real k6: %d, want %d\n%s\n%s", code, want, stdout, stderr)
			}
			if _, err := os.Stat(summary); err != nil {
				t.Fatal(err)
			}
			if status == 200 && os.Getenv("KURLO_K6_REPORT_TEST") == "1" {
				data, err := os.ReadFile(filepath.Join(dir, "report.html"))
				if err != nil || !bytes.Contains(bytes.ToLower(data), []byte("<html")) {
					t.Fatalf("k6 HTML report missing: %v", err)
				}
			}
		})
	}
}

func TestLoadCLIPlanScopesEnvironmentAndOverrides(t *testing.T) {
	root, _ := writeCLILoadFixture(t, "http://127.0.0.1:1")
	workspaces, collections, requests, environments, err := loadCLIWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	entry := loadCLIEntries(root, workspaces, collections, "col-smoke")[0]
	environments = append(environments, cliEnvironment{WorkspaceID: "other-workspace", Name: "Local", Values: []cliKV{{Key: "baseUrl", Value: "https://wrong.test", Enabled: true}}})
	opts := loadCLIOptions{globalVars: map[string]string{"baseUrl": "https://global.test", "globalOnly": "shared"}}
	plan, err := buildCLILoadPlan(root, opts, entry, requests, environments)
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]string{}
	for _, variable := range plan.Variables {
		values[variable.Name] = variable.Value
	}
	if values["baseUrl"] != "http://127.0.0.1:1" || values["globalOnly"] != "shared" || values["apiVersion"] != "v1" {
		t.Fatalf("incorrect scope precedence: %v", values)
	}
	entry.test.Settings.Environment = "missing"
	opts.environment = "Local"
	if _, err := buildCLILoadPlan(root, opts, entry, requests, environments); err != nil {
		t.Fatalf("--env must override the saved environment: %v", err)
	}
	opts.vars = map[string]string{"secret": "bad\x00value"}
	if _, err := buildCLILoadPlan(root, opts, entry, requests, environments); err == nil || strings.Contains(err.Error(), "bad") {
		t.Fatalf("NUL byte must be rejected without exposing its value: %v", err)
	}
}

func TestLoadCLIExportAndArtifactWriteFailures(t *testing.T) {
	root, _ := writeCLILoadFixture(t, "http://127.0.0.1:1")
	missing := filepath.Join(t.TempDir(), "missing", "output.js")
	if code, _, stderr := callLoadCLI("export", "API smoke", "--workspace", root, "-o", missing); code != 1 || stderr == "" {
		t.Fatalf("failed script write: %d %s", code, stderr)
	}
	k6, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("KURLO_TEST_K6_HELPER", "1")
	t.Setenv("KURLO_FAKE_K6_MODE", "passed")
	if code, stdout, stderr := callLoadCLI("run", "API smoke", "--workspace", root, "--k6", k6, "--json", missing); code != 1 || !strings.Contains(stdout, "ERROR") || stderr == "" {
		t.Fatalf("failed artifact write: %d %s %s", code, stdout, stderr)
	}
}

package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLoadDataFileCSV(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.csv")
	os.WriteFile(path, []byte("user,role\nada,admin\ngrace,\"eng, lead\"\n"), 0o644)

	rows, err := loadDataFile(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(rows))
	}
	if rows[0]["user"] != "ada" || rows[0]["role"] != "admin" {
		t.Fatalf("row 0 = %v", rows[0])
	}
	if rows[1]["role"] != "eng, lead" {
		t.Fatalf("expected quoted comma to survive, got %q", rows[1]["role"])
	}
}

func TestLoadDataFileJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.json")
	os.WriteFile(path, []byte(`[{"id":1,"active":true},{"id":2,"active":false}]`), 0o644)

	rows, err := loadDataFile(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(rows))
	}
	if rows[0]["id"] != "1" || rows[0]["active"] != "true" {
		t.Fatalf("row 0 = %v", rows[0])
	}
	if rows[1]["id"] != "2" || rows[1]["active"] != "false" {
		t.Fatalf("row 1 = %v", rows[1])
	}
}

func TestLoadDataFileWrapsAndRejects(t *testing.T) {
	dir := t.TempDir()
	wrapped := filepath.Join(dir, "d.json")
	os.WriteFile(wrapped, []byte(`{"data":[{"a":"1"}]}`), 0o644)
	if rows, err := loadDataFile(wrapped); err != nil || len(rows) != 1 || rows[0]["a"] != "1" {
		t.Fatalf("wrapped rows = %v err = %v", rows, err)
	}

	empty := filepath.Join(dir, "empty.csv")
	os.WriteFile(empty, []byte("only_header\n"), 0o644)
	if _, err := loadDataFile(empty); err == nil {
		t.Fatal("expected an error for a header-only CSV")
	}
}

func TestDynamicGeneratorsParity(t *testing.T) {
	for name, gen := range dynamicGenerators {
		value := gen()
		if value == "" {
			t.Errorf("%s produced an empty value", name)
		}
		if strings.Contains(value, "{{") {
			t.Errorf("%s produced an unresolved value %q", name, value)
		}
	}
	if v, _ := resolveDynamicCLIVariable("$guid"); len(v) != 36 {
		t.Errorf("$guid = %q", v)
	}
	if _, ok := resolveDynamicCLIVariable("$notAThing"); ok {
		t.Error("expected an unknown dynamic variable to be reported as such")
	}
}

func TestReadVariableFilePostmanEnvironment(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "env.json")
	os.WriteFile(path, []byte(`{"name":"CI","values":[{"key":"token","value":"abc","enabled":true},{"key":"skip","value":"x","enabled":false}]}`), 0o644)

	values, err := readVariableFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if values["token"] != "abc" {
		t.Fatalf("token = %q", values["token"])
	}
	if _, ok := values["skip"]; ok {
		t.Fatal("expected a disabled value to be skipped")
	}
}

func TestWriteVariableExportRoundTrips(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "out.json")
	if err := writeVariableExport(path, "CI", map[string]string{"a": "1", "b": "2"}); err != nil {
		t.Fatalf("export: %v", err)
	}
	values, err := readVariableFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if values["a"] != "1" || values["b"] != "2" {
		t.Fatalf("round-trip = %v", values)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("export mode: %v", info.Mode().Perm())
		}
		if err := os.Chmod(path, 0644); err != nil {
			t.Fatal(err)
		}
		if err := writeVariableExport(path, "CI", values); err != nil {
			t.Fatalf("overwrite: %v", err)
		}
		info, err = os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("overwritten export mode: %v", info.Mode().Perm())
		}
	}
}

func writeDataDrivenWorkspace(t *testing.T, baseURL string) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	write("kurlo.yml", "version: 1\nformat: kurlo.workspace.yaml.v1\nworkspaceOrder:\n  - ws\n")
	write("workspaces/Demo/workspace.yml", "version: 1\nworkspace:\n  id: ws\n  name: Demo\n  filesystemName: Demo\n  collectionOrder:\n    - col\n")
	write("workspaces/Demo/collections/Smoke/collection.yml", strings.Join([]string{
		"version: 1",
		"collection:",
		"  id: col",
		"  workspaceId: ws",
		"  name: Smoke",
		"  filesystemName: Smoke",
		"  requestOrder: [req]",
		"  defaults:",
		"    settings: {}",
		"",
	}, "\n"))
	write("workspaces/Demo/environments/Local.yml", strings.Join([]string{
		"version: 1",
		"environment:",
		"  id: env",
		"  workspaceId: ws",
		"  name: Local",
		"  filesystemName: Local",
		"  values:",
		"    - id: 1",
		"      enabled: true",
		"      key: baseUrl",
		"      value: " + baseURL,
		"",
	}, "\n"))
	write("workspaces/Demo/collections/Smoke/requests/GET-user.yml", strings.Join([]string{
		"version: 1",
		"request:",
		"  id: req",
		"  name: User",
		"  filesystemName: GET-user",
		"  requestType: http",
		"  isDraft: false",
		"  collectionId: col",
		"  collection: Smoke",
		"  folderPath: []",
		"  method: GET",
		"  url: \"{{baseUrl}}/u?name={{user}}\"",
		"  auth:",
		"    type: none",
		"  bodyType: none",
		"  bodyContent: \"\"",
		"  testScriptJs: |",
		"    pm.test(\"url carries the row value\", () => pm.expect(pm.request.url).to.include(\"name=\"))",
		"    pm.test(\"iterationData is readable\", () => pm.expect(pm.iterationData.get(\"user\")).to.not.equal(undefined))",
		"  settings: {}",
		"",
	}, "\n"))
	return root
}

func TestRunCLIDataDrivenIterations(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Query().Get("name"))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	root := writeDataDrivenWorkspace(t, server.URL)
	dataPath := filepath.Join(t.TempDir(), "users.csv")
	os.WriteFile(dataPath, []byte("user\nada\ngrace\nlinus\n"), 0o644)

	var out bytes.Buffer
	code := runCLI(cliOptions{
		workspace: root, env: "Local", reporters: []string{"json"},
		dataFile: dataPath, iterations: 1, stdout: &out, stderr: &out,
	})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d\n%s", code, out.String())
	}
	if strings.Join(seen, ",") != "ada,grace,linus" {
		t.Fatalf("expected one request per row with its value, got %v", seen)
	}

	var payload struct {
		Summary struct {
			Requests   int `json:"requests"`
			Assertions int `json:"assertions"`
		} `json:"summary"`
	}
	json.Unmarshal(out.Bytes(), &payload)
	if payload.Summary.Requests != 3 || payload.Summary.Assertions != 6 {
		t.Fatalf("unexpected summary: %+v", payload.Summary)
	}
}

func TestRunCLIReporterFileExports(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	root := writeDataDrivenWorkspace(t, server.URL)
	dataPath := filepath.Join(t.TempDir(), "u.csv")
	os.WriteFile(dataPath, []byte("user\nada\n"), 0o644)

	outDir := t.TempDir()
	jsonPath := filepath.Join(outDir, "report.json")
	junitPath := filepath.Join(outDir, "report.xml")
	envPath := filepath.Join(outDir, "env.json")

	var out bytes.Buffer
	code := runCLI(cliOptions{
		workspace: root, env: "Local", reporters: []string{"cli", "json", "junit"},
		reporterJSONExport: jsonPath, reporterJUnitExport: junitPath, exportEnvironment: envPath,
		dataFile: dataPath, iterations: 1, stdout: &out, stderr: &out,
	})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "1 requests, 1 passed") {
		t.Fatalf("expected the cli summary on stdout, got:\n%s", out.String())
	}
	jsonReport, err := os.ReadFile(jsonPath)
	if err != nil || !strings.Contains(string(jsonReport), `"ok": true`) {
		t.Fatalf("json export missing or wrong: %v\n%s", err, jsonReport)
	}
	junitReport, err := os.ReadFile(junitPath)
	if err != nil || !strings.Contains(string(junitReport), "<testsuite ") {
		t.Fatalf("junit export missing or wrong: %v\n%s", err, junitReport)
	}
	envExport, err := os.ReadFile(envPath)
	if err != nil || !strings.Contains(string(envExport), "baseUrl") {
		t.Fatalf("environment export missing or wrong: %v\n%s", err, envExport)
	}
}

func TestRunCLIInsecureFlagDisablesVerification(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	root := writeDataDrivenWorkspace(t, server.URL)
	dataPath := filepath.Join(t.TempDir(), "u.csv")
	os.WriteFile(dataPath, []byte("user\nada\n"), 0o644)

	var out bytes.Buffer
	code := runCLI(cliOptions{
		workspace: root, env: "Local", reporters: []string{"cli"},
		insecure: true, dataFile: dataPath, iterations: 1, stdout: &out, stderr: &out,
	})
	if code != 0 {
		t.Fatalf("expected --insecure to let the self-signed request through, got exit %d\n%s", code, out.String())
	}
}

func writeScriptWorkspace(t *testing.T, baseURL, preScript, testScript string) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	indent := func(src string) string {
		lines := strings.Split(strings.TrimRight(src, "\n"), "\n")
		for i, line := range lines {
			lines[i] = "    " + line
		}
		return strings.Join(lines, "\n")
	}
	write("kurlo.yml", "version: 1\nformat: kurlo.workspace.yaml.v1\nworkspaceOrder:\n  - ws\n")
	write("workspaces/Demo/workspace.yml", "version: 1\nworkspace:\n  id: ws\n  name: Demo\n  filesystemName: Demo\n  collectionOrder:\n    - col\n")
	write("workspaces/Demo/collections/Smoke/collection.yml", strings.Join([]string{
		"version: 1",
		"collection:",
		"  id: col",
		"  workspaceId: ws",
		"  name: Smoke",
		"  filesystemName: Smoke",
		"  requestOrder: [req]",
		"  defaults:",
		"    settings: {}",
		"",
	}, "\n"))
	write("workspaces/Demo/environments/Local.yml", strings.Join([]string{
		"version: 1",
		"environment:",
		"  id: env",
		"  workspaceId: ws",
		"  name: Local",
		"  filesystemName: Local",
		"  values:",
		"    - id: 1",
		"      enabled: true",
		"      key: baseUrl",
		"      value: " + baseURL,
		"",
	}, "\n"))
	lines := []string{
		"version: 1",
		"request:",
		"  id: req",
		"  name: Scripted",
		"  filesystemName: GET-scripted",
		"  requestType: http",
		"  isDraft: false",
		"  collectionId: col",
		"  collection: Smoke",
		"  folderPath: []",
		"  method: GET",
		"  url: \"{{baseUrl}}/target\"",
		"  auth:",
		"    type: none",
		"  bodyType: none",
		"  bodyContent: \"\"",
	}
	if strings.TrimSpace(preScript) != "" {
		lines = append(lines, "  preRequestScriptJs: |", indent(preScript))
	}
	if strings.TrimSpace(testScript) != "" {
		lines = append(lines, "  testScriptJs: |", indent(testScript))
	}
	lines = append(lines, "  settings: {}", "")
	write("workspaces/Demo/collections/Smoke/requests/GET-scripted.yml", strings.Join(lines, "\n"))
	return root
}

func TestRunCLIAllowSendRequestFlag(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	var helperHits int
	helper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		helperHits++
		_, _ = w.Write([]byte(`{"token":"cli-tok"}`))
	}))
	defer helper.Close()

	var sawAuth string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte("{}"))
	}))
	defer target.Close()

	pre := `const res = pm.sendRequest("` + helper.URL + `/token")
pm.request.headers.set("Authorization", "Bearer " + res.json().token)`
	root := writeScriptWorkspace(t, target.URL, pre, "")

	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, env: "Local", reporters: []string{"cli"}, iterations: 1, stdout: &out, stderr: &out})
	if code == 0 {
		t.Fatalf("expected a non-zero exit without --allow-send-request\n%s", out.String())
	}
	if helperHits != 0 {
		t.Errorf("helper endpoint was called %d times without the flag", helperHits)
	}

	out.Reset()
	code = runCLI(cliOptions{
		workspace: root, env: "Local", reporters: []string{"cli"}, iterations: 1,
		allowSendRequest: true, stdout: &out, stderr: &out,
	})
	if code != 0 {
		t.Fatalf("expected exit 0 with --allow-send-request, got %d\n%s", code, out.String())
	}
	if sawAuth != "Bearer cli-tok" {
		t.Errorf("Authorization = %q, want the token pm.sendRequest fetched", sawAuth)
	}
}

func TestRunCLIScriptTimeoutFlag(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	pre := `const start = Date.now()
while (Date.now() - start < 2400) { }`
	root := writeScriptWorkspace(t, server.URL, pre, "")

	var out bytes.Buffer
	if code := runCLI(cliOptions{workspace: root, env: "Local", reporters: []string{"cli"}, iterations: 1, stdout: &out, stderr: &out}); code == 0 {
		t.Fatalf("expected the default 2s script cap to fail the run\n%s", out.String())
	}

	out.Reset()
	code := runCLI(cliOptions{
		workspace: root, env: "Local", reporters: []string{"cli"}, iterations: 1,
		scriptTimeoutMs: 10_000, stdout: &out, stderr: &out,
	})
	if code != 0 {
		t.Fatalf("expected exit 0 with --script-timeout, got %d\n%s", code, out.String())
	}
}

func TestRunCLISkipRequestIsNotAFailure(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	var hits int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
	}))
	defer server.Close()

	root := writeScriptWorkspace(t, server.URL, `pm.execution.skipRequest()`, "")

	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, env: "Local", reporters: []string{"json"}, iterations: 1, stdout: &out, stderr: &out})
	if code != 0 {
		t.Fatalf("a skipped request must not fail the run, got exit %d\n%s", code, out.String())
	}
	if hits != 0 {
		t.Errorf("the request was sent %d times despite skipRequest()", hits)
	}

	var payload struct {
		Results []struct {
			Skipped    bool   `json:"skipped"`
			SkipReason string `json:"skipReason"`
		} `json:"results"`
	}
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatalf("json report: %v\n%s", err, out.String())
	}
	if len(payload.Results) != 1 || !payload.Results[0].Skipped {
		t.Errorf("report should mark the request skipped: %s", out.String())
	}
	if payload.Results[0].SkipReason == "" {
		t.Error("report should carry a skip reason")
	}
}

func TestRunCLIPmInfoIterationCount(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	test := `pm.test("request name", () => pm.expect(pm.info.requestName).to.equal("Scripted"))
pm.test("iteration count", () => pm.expect(pm.info.iterationCount).to.equal(3))
pm.test("iteration in range", () => pm.expect(pm.info.iteration).to.be.within(1, 3))`
	root := writeScriptWorkspace(t, server.URL, "", test)

	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, env: "Local", reporters: []string{"json"}, iterations: 3, stdout: &out, stderr: &out})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d\n%s", code, out.String())
	}
	var payload struct {
		Summary struct {
			Assertions int `json:"assertions"`
			Failed     int `json:"failed"`
		} `json:"summary"`
	}
	json.Unmarshal(out.Bytes(), &payload)
	if payload.Summary.Assertions != 9 {
		t.Errorf("expected 9 assertions across 3 iterations, got %d\n%s", payload.Summary.Assertions, out.String())
	}
}

func TestRunCLICryptoAvailable(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	var sawSig string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawSig = r.Header.Get("X-Signature")
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	pre := `pm.request.headers.set("X-Signature", CryptoJS.HmacSHA256("payload", "key").toString())`
	root := writeScriptWorkspace(t, server.URL, pre, "")

	var out bytes.Buffer
	if code := runCLI(cliOptions{workspace: root, env: "Local", reporters: []string{"cli"}, iterations: 1, stdout: &out, stderr: &out}); code != 0 {
		t.Fatalf("expected exit 0, got %d\n%s", code, out.String())
	}
	mac := hmac.New(sha256.New, []byte("key"))
	mac.Write([]byte("payload"))
	want := hex.EncodeToString(mac.Sum(nil))
	if sawSig != want {
		t.Errorf("signature = %q, want %q", sawSig, want)
	}
}

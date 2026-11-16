package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunCLIUsesTheEnvironmentOfEachRequestsWorkspace(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	var alphaHits, betaHits int
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		alphaHits++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"workspace":"alpha"}`))
	}))
	defer alpha.Close()
	beta := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		betaHits++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"workspace":"beta"}`))
	}))
	defer beta.Close()

	root := writeYAMLWorkspace(t, alpha.URL)
	kurloPath := filepath.Join(root, "kurlo.yml")
	kurlo, err := os.ReadFile(kurloPath)
	if err != nil {
		t.Fatal(err)
	}
	kurlo = []byte(strings.Replace(string(kurlo), "  - ws-demo\n", "  - ws-demo\n  - ws-beta\n", 1))
	if err := os.WriteFile(kurloPath, kurlo, 0o644); err != nil {
		t.Fatal(err)
	}

	write := func(path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	betaRoot := filepath.Join(root, "workspaces", "Beta")
	write(filepath.Join(betaRoot, "workspace.yml"), strings.Join([]string{
		"version: 1",
		"workspace:",
		"  id: ws-beta",
		"  name: Beta",
		"  filesystemName: Beta",
		"  collectionOrder:",
		"    - col-beta",
		"",
	}, "\n"))
	write(filepath.Join(betaRoot, "environments", "Local.yml"), strings.Join([]string{
		"version: 1",
		"environment:",
		"  id: env-beta",
		"  workspaceId: ws-beta",
		"  name: Local",
		"  filesystemName: Local",
		"  values:",
		"    - id: 1",
		"      enabled: true",
		"      key: baseUrl",
		"      value: " + beta.URL,
		"",
	}, "\n"))
	write(filepath.Join(betaRoot, "collections", "Beta", "collection.yml"), strings.Join([]string{
		"version: 1",
		"collection:",
		"  id: col-beta",
		"  workspaceId: ws-beta",
		"  name: Beta",
		"  filesystemName: Beta",
		"  requestOrder:",
		"    - req-beta",
		"  defaults:",
		"    variables: []",
		"    settings: {}",
		"",
	}, "\n"))
	write(filepath.Join(betaRoot, "collections", "Beta", "requests", "GET-1-beta.yml"), strings.Join([]string{
		"version: 1",
		"request:",
		"  id: req-beta",
		"  name: Beta request",
		"  filesystemName: GET-1-beta",
		"  requestType: http",
		"  isDraft: false",
		"  collectionId: col-beta",
		"  collection: Beta",
		"  folderPath: []",
		"  method: GET",
		"  url: \"{{baseUrl}}/ok\"",
		"  auth:",
		"    type: none",
		"  bodyType: none",
		"  bodyContent: \"\"",
		"  testScriptJs: |",
		"    pm.test(\"right workspace\", () => pm.expect(pm.response.json().workspace).to.equal(\"beta\"));",
		"  settings: {}",
		"",
	}, "\n"))

	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, env: "Local", collection: "Beta", reporters: []string{"json"}, iterations: 1, stdout: &out, stderr: &out})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d:\n%s", code, out.String())
	}
	if betaHits == 0 {
		t.Fatalf("the Beta workspace's environment was not used:\n%s", out.String())
	}
	if alphaHits != 0 {
		t.Fatalf("the Beta run used the Alpha workspace's environment: alpha=%d beta=%d\n%s", alphaHits, betaHits, out.String())
	}

	out.Reset()
	code = runCLI(cliOptions{
		workspace: root, env: "Local", reporters: []string{"cli"}, iterations: 1,
		exportEnvironment: filepath.Join(t.TempDir(), "env.json"), stdout: &out, stderr: &out,
	})
	if code != 2 || !strings.Contains(out.String(), "one workspace") {
		t.Fatalf("a multi-workspace run should not export one environment: code %d\n%s", code, out.String())
	}
}

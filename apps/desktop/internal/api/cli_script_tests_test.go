package api

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunCLIReportsAPreRequestTestThatFails(t *testing.T) {
	httpTransports.closeAll()
	t.Cleanup(httpTransports.closeAll)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "{}")
	}))
	defer server.Close()

	root := writeDefaultsWorkspace(t, server.URL, strings.Join([]string{
		"    headers: []",
		"    settings: {}",
	}, "\n"), strings.Join([]string{
		"  preRequestScriptJs: |",
		`    pm.test("pre-request check", () => pm.expect(1).to.equal(2))`,
		"  settings: {}",
	}, "\n"))

	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, reporters: []string{"json"}, iterations: 1, stdout: &out, stderr: &out})
	if code != 1 {
		t.Fatalf("exit code = %d, want 1\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "pre-request check") {
		t.Fatalf("the failed pre-request test is missing from the report:\n%s", out.String())
	}
}

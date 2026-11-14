package script

import (
	"strings"
	"testing"
	"time"
)

func TestRunPreRequestRejectsTengoImports(t *testing.T) {
	t.Parallel()

	result := RunPreRequest(string(EngineTengo), `mod := import("os")`, NewContext(nil, nil))
	if !strings.Contains(result.Error, "imports are disabled") {
		t.Fatalf("expected import sandbox error, got %q", result.Error)
	}
}

func TestRunPreRequestAllowsImportTextInStringsAndComments(t *testing.T) {
	t.Parallel()

	ctx := NewContext(nil, nil)
	result := RunPreRequest(string(EngineTengo), `
// import("os")
message := "import(\"os\")"
pm.variables.set("message", message)
`, ctx)
	if result.Error != "" {
		t.Fatalf("unexpected script error: %s", result.Error)
	}
	if got := ctx.Variables["message"]; got != `import("os")` {
		t.Fatalf("expected string value to survive, got %q", got)
	}
}

func TestRunPreRequestTimesOut(t *testing.T) {
	t.Parallel()

	ctx := NewContext(nil, nil)
	ctx.Timeout = 10 * time.Millisecond

	start := time.Now()
	result := RunPreRequest(string(EngineTengo), `for true {}`, ctx)
	if !strings.Contains(result.Error, "script timed out after 10ms") {
		t.Fatalf("expected timeout error, got %q", result.Error)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("script timeout took too long: %s", elapsed)
	}
}

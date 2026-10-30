package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunWithoutArgumentsPrintsUsage(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run(nil, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "kurlo mcp [workspace]") {
		t.Fatalf("usage missing from stderr: %q", stderr.String())
	}
}

func TestRunPrintsVersion(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"--version"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if !strings.HasPrefix(stdout.String(), "Kurlo ") {
		t.Fatalf("version line = %q", stdout.String())
	}
}

func TestRunRejectsUnknownCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"serve"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), `unknown command "serve"`) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestRunLoadHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"load", "run", "--help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if !strings.Contains(stderr.String(), "--json") && !strings.Contains(stderr.String(), "-json") {
		t.Fatalf("load help missing: %q", stderr.String())
	}
}

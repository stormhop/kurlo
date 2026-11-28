package api

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func withoutGit(t *testing.T) {
	t.Helper()
	original := lookupGitExecutable
	lookupGitExecutable = func() (string, error) {
		return "", &gitUnavailableError{message: gitNotInstalledMessage}
	}
	t.Cleanup(func() { lookupGitExecutable = original })
}

func TestGitUnavailableMessageRecognisesAMissingBinary(t *testing.T) {
	err := &gitUnavailableError{message: gitNotInstalledMessage}
	if got := gitUnavailableMessage("", err); got != gitNotInstalledMessage {
		t.Fatalf("expected the install message, got %q", got)
	}

	wrapped := fmt.Errorf("git status failed: %w", err)
	if got := gitUnavailableMessage("", wrapped); got != gitNotInstalledMessage {
		t.Fatalf("expected the install message through a wrap, got %q", got)
	}

	execErr := &exec.Error{Name: "git", Err: exec.ErrNotFound}
	if got := gitUnavailableMessage("", execErr); got != gitNotInstalledMessage {
		t.Fatalf("expected the install message for exec.ErrNotFound, got %q", got)
	}
}

func TestGitUnavailableMessageIgnoresOrdinaryGitFailures(t *testing.T) {
	err := errors.New("exit status 128")
	output := "fatal: not a git repository (or any of the parent directories): .git"
	if got := gitUnavailableMessage(output, err); got != "" {
		t.Fatalf("expected no unavailability message, got %q", got)
	}
	if got := gitUnavailableMessage("", nil); got != "" {
		t.Fatalf("expected no message without an error, got %q", got)
	}
}

func TestGitUnavailableMessageRecognisesTheMacOSStub(t *testing.T) {
	output := "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)"
	got := gitUnavailableMessage(output, errors.New("exit status 1"))
	if runtime.GOOS != "darwin" {
		if got != "" {
			t.Fatalf("the Command Line Tools message belongs to macOS only, got %q", got)
		}
		return
	}
	if got != gitDeveloperToolsMessage {
		t.Fatalf("expected the Command Line Tools message, got %q", got)
	}
	if !strings.Contains(got, "xcode-select --install") {
		t.Fatalf("the message should name the command that fixes it, got %q", got)
	}
}

func TestGitStatusReportsAMissingGitInsteadOfPretendingItIsNotARepository(t *testing.T) {
	root := t.TempDir()
	withoutGit(t)

	status := gitStatusForWorkspace(root)

	if status.IsRepo {
		t.Fatal("no Git means Kurlo cannot know it is a repository")
	}
	if !status.GitMissing {
		t.Fatal("expected gitMissing to be set so the interface can explain itself")
	}
	if status.Error != gitNotInstalledMessage {
		t.Fatalf("expected the install message, got %q", status.Error)
	}
}

func TestGitStatusOnAPlainFolderStaysQuiet(t *testing.T) {
	requireGitBinary(t)
	root := t.TempDir()

	status := gitStatusForWorkspace(root)

	if status.IsRepo {
		t.Fatal("a plain folder is not a repository")
	}
	if status.GitMissing {
		t.Fatal("Git is installed here; gitMissing must stay false")
	}
	if status.Error != "" {
		t.Fatalf("a plain folder is a normal state, not an error: %q", status.Error)
	}
}

func TestGitOperationsExplainAMissingGitBinary(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "kurlo.yml"), []byte("version: 1\nformat: kurlo.workspace.yaml.v1\n"), 0644); err != nil {
		t.Fatalf("could not write the workspace file: %v", err)
	}
	withoutGit(t)

	result := gitInitWorkspaceForRoot(root)

	if result.Ok {
		t.Fatal("git init cannot succeed without Git")
	}
	if result.Error != gitNotInstalledMessage {
		t.Fatalf("expected the install message, got %q", result.Error)
	}
}

func TestGitRunFailsFastWhenGitIsMissing(t *testing.T) {
	root := t.TempDir()
	withoutGit(t)

	output, err := gitOutput(root, "status")

	if err == nil {
		t.Fatal("expected an error when Git cannot be run")
	}
	if output != "" {
		t.Fatalf("nothing ran, so there is no output to report: %q", output)
	}
	var unavailable *gitUnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("expected a gitUnavailableError, got %T: %v", err, err)
	}
}

func requireGitBinary(t *testing.T) {
	t.Helper()
	requireGitForTest(t)
}

func TestLookupGitExecutableResolvesAnAbsolutePath(t *testing.T) {
	requireGitBinary(t)

	path, err := lookupGitExecutable()
	if err != nil {
		t.Fatalf("expected to find git: %v", err)
	}
	if !filepath.IsAbs(path) {
		t.Fatalf("expected an absolute path, got %q", path)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("resolved path does not exist: %v", err)
	}
}

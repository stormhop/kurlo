package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if len(os.Args) >= 2 && os.Args[1] == "git-credential" {
		os.Exit(RunGitCredentialHelper(os.Args[2:]))
	}
	if err := os.Setenv(requestStoreDisableKeychain, "1"); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func requireSymlinks(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("probe"), 0644); err != nil {
		t.Fatalf("write symlink probe target: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "link")); err != nil {
		t.Skipf("symlinks are not available on this machine: %v", err)
	}
}

func useTempConfigDir(t *testing.T, dir string) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("APPDATA", dir)
	t.Setenv("LOCALAPPDATA", dir)
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
}

func useTempHomeDir(t *testing.T, dir string) {
	t.Helper()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
}

func normalizeNewlines(value string) string {
	return strings.ReplaceAll(value, "\r\n", "\n")
}

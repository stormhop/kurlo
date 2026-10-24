package api

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeGitHost(t *testing.T) {
	cases := map[string]string{
		"https://github.com/org/repo.git":                "github.com",
		"https://gitlab.com/group/sub/repo.git":          "gitlab.com",
		"https://gitlab.example.com:8443/group/repo.git": "gitlab.example.com",
		"git@github.com:org/repo.git":                    "github.com",
		"git@gitlab.example.com:group/repo.git":          "gitlab.example.com",
		"ssh://git@gitlab.example.com:2222/group/repo":   "gitlab.example.com",
		"GitHub.com": "github.com",
		"":           "",
	}
	for in, want := range cases {
		if got := normalizeGitHost(in); got != want {
			t.Errorf("normalizeGitHost(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAnnotateGitAuthFailure(t *testing.T) {
	t.Run("ssh publickey", func(t *testing.T) {
		var s GitWorkspaceStatus
		annotateGitAuthFailure(&s, "git@github.com: Permission denied (publickey).", "git@github.com:org/repo.git")
		if !s.AuthRequired || s.AuthScheme != "ssh" || s.AuthHost != "github.com" {
			t.Fatalf("got %+v", s)
		}
	})
	t.Run("https no creds", func(t *testing.T) {
		var s GitWorkspaceStatus
		annotateGitAuthFailure(&s, "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled", "https://gitlab.com/g/r.git")
		if !s.AuthRequired || s.AuthScheme != "https" || s.AuthHost != "gitlab.com" || s.TokenRejected {
			t.Fatalf("got %+v", s)
		}
	})
	t.Run("non-auth error untouched", func(t *testing.T) {
		var s GitWorkspaceStatus
		annotateGitAuthFailure(&s, "fatal: not a git repository", "https://github.com/o/r.git")
		if s.AuthRequired {
			t.Fatalf("should not be auth: %+v", s)
		}
	})
}

func withIsolatedStore(t *testing.T) {
	t.Helper()
	tmp := t.TempDir()
	useTempConfigDir(t, tmp)
	key := make([]byte, requestStoreKeySize)
	for i := range key {
		key[i] = byte(i + 1)
	}
	prevProvider := requestStoreKeyProvider
	prevLoader := requestStoreKeyLoader
	requestStoreKeyProvider = func() ([]byte, error) { return key, nil }
	requestStoreKeyLoader = requestStoreKeyProvider
	t.Cleanup(func() {
		requestStoreKeyProvider = prevProvider
		requestStoreKeyLoader = prevLoader
	})
}

func TestGitCredentialRoundtrip(t *testing.T) {
	withIsolatedStore(t)

	if _, ok := gitCredentialLookup("gitlab.com"); ok {
		t.Fatal("expected no credential before set")
	}
	if err := gitCredentialSet("https://gitlab.com/g/r.git", "oauth2", "glpat-xxx"); err != nil {
		t.Fatalf("set: %v", err)
	}
	cred, ok := gitCredentialLookup("gitlab.com")
	if !ok || cred.Username != "oauth2" || cred.Token != "glpat-xxx" {
		t.Fatalf("lookup mismatch: %+v ok=%v", cred, ok)
	}

	if _, ok := gitCredentialLookup("github.com"); ok {
		t.Fatal("github.com should not resolve to gitlab token")
	}

	gitCredentialErase("gitlab.com")
	if _, ok := gitCredentialLookup("gitlab.com"); ok {
		t.Fatal("credential should be gone after erase")
	}
}

func TestTokenRejectedWhenStoredTokenFails(t *testing.T) {
	withIsolatedStore(t)
	if err := gitCredentialSet("github.com", "x-access-token", "ghp_dead"); err != nil {
		t.Fatalf("set: %v", err)
	}
	var s GitWorkspaceStatus
	annotateGitAuthFailure(&s, "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://github.com/o/r.git/'", "https://github.com/o/r.git")
	if !s.AuthRequired || s.AuthScheme != "https" || !s.TokenRejected {
		t.Fatalf("expected tokenRejected, got %+v", s)
	}
}

func TestHttpsToSSHRemoteURL(t *testing.T) {
	ok := map[string]string{
		"https://github.com/org/repo.git":                "git@github.com:org/repo.git",
		"https://gitlab.com/group/sub/repo.git":          "git@gitlab.com:group/sub/repo.git",
		"https://gitlab.example.com:8443/group/repo.git": "git@gitlab.example.com:group/repo.git",
		"http://gitlab.local/g/r":                        "git@gitlab.local:g/r",
		"git@github.com:org/repo.git":                    "git@github.com:org/repo.git",
	}
	for in, want := range ok {
		got, valid := httpsToSSHRemoteURL(in)
		if !valid || got != want {
			t.Errorf("httpsToSSHRemoteURL(%q) = %q,%v want %q,true", in, got, valid, want)
		}
	}
	for _, bad := range []string{"", "   ", "ftp://x/y", "not a url"} {
		if got, valid := httpsToSSHRemoteURL(bad); valid {
			t.Errorf("httpsToSSHRemoteURL(%q) should be invalid, got %q", bad, got)
		}
	}
}

func TestGitAuthGlobalArgsShape(t *testing.T) {
	args := gitAuthGlobalArgs()

	if len(args) != 2 || args[0] != "-c" {
		t.Fatalf("unexpected args: %v", args)
	}
	if got := args[1]; got[:18] != "credential.helper=" {
		t.Fatalf("unexpected helper arg: %q", got)
	}
}

func TestShellQuoteDoesNotAllowShellExpansion(t *testing.T) {
	got := shellQuote(`/tmp/key-$(touch /tmp/kurlo-pwn)-'quoted'`)
	want := `'/tmp/key-$(touch /tmp/kurlo-pwn)-'\''quoted'\'''`
	if got != want {
		t.Fatalf("shellQuote mismatch:\n got %q\nwant %q", got, want)
	}
	if strings.HasPrefix(got, "\"") {
		t.Fatalf("shellQuote must not use double quotes for shell-controlled values: %q", got)
	}
}

func TestGitSSHCommandEnvQuotesKeyPath(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, `id_$(touch kurlo-pwn)`)
	if err := os.WriteFile(keyPath, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed key: %v", err)
	}
	env := gitSSHCommandEnv(keyPath)
	if len(env) != 1 {
		t.Fatalf("unexpected env: %v", env)
	}
	quoted := "'" + strings.ReplaceAll(filepath.ToSlash(keyPath), "'", `'\''`) + "'"
	if !strings.Contains(env[0], quoted) {
		t.Fatalf("key path was not safely single-quoted: %q (want substring %q)", env[0], quoted)
	}
	if strings.Contains(env[0], `"`+filepath.ToSlash(keyPath)) {
		t.Fatalf("key path used unsafe double quotes: %q", env[0])
	}
}

func TestGitSSHCommandEnvRejectsMissingKeyFile(t *testing.T) {
	if env := gitSSHCommandEnv("/does/not/exist/kurlo-key"); env != nil {
		t.Fatalf("expected nil env for missing key file, got %v", env)
	}
}

func TestGitCredentialSetPreservesOnLoadError(t *testing.T) {
	withIsolatedStore(t)
	workingProvider := requestStoreKeyProvider
	workingLoader := requestStoreKeyLoader

	if err := gitCredentialSet("gitlab.com", "oauth2", "glpat-1"); err != nil {
		t.Fatalf("seed gitlab: %v", err)
	}
	if err := gitCredentialSet("github.com", "x-access-token", "ghp-2"); err != nil {
		t.Fatalf("seed github: %v", err)
	}

	requestStoreKeyProvider = func() ([]byte, error) {
		return nil, errors.New("keychain temporarily unavailable")
	}
	requestStoreKeyLoader = requestStoreKeyProvider
	if err := gitCredentialSet("example.com", "user", "tok-3"); err == nil {
		t.Fatal("expected gitCredentialSet to fail when the store is unreadable")
	}

	requestStoreKeyProvider = workingProvider
	requestStoreKeyLoader = workingLoader
	if cred, ok := gitCredentialLookup("gitlab.com"); !ok || cred.Token != "glpat-1" {
		t.Fatalf("gitlab credential lost: %+v ok=%v", cred, ok)
	}
	if cred, ok := gitCredentialLookup("github.com"); !ok || cred.Token != "ghp-2" {
		t.Fatalf("github credential lost: %+v ok=%v", cred, ok)
	}
	if _, ok := gitCredentialLookup("example.com"); ok {
		t.Fatal("example.com should not have been persisted after a failed set")
	}
}

func TestGitClearTokenReportsStoreFailure(t *testing.T) {
	withIsolatedStore(t)
	if err := gitCredentialSet("github.com", "x-access-token", "ghp-1"); err != nil {
		t.Fatalf("seed github token: %v", err)
	}

	workingProvider := requestStoreKeyProvider
	workingLoader := requestStoreKeyLoader
	requestStoreKeyProvider = func() ([]byte, error) {
		return nil, errors.New("credential store unavailable")
	}
	requestStoreKeyLoader = requestStoreKeyProvider
	t.Cleanup(func() {
		requestStoreKeyProvider = workingProvider
		requestStoreKeyLoader = workingLoader
	})

	result := NewApp().GitClearToken("github.com")
	if result.Ok || !strings.Contains(result.Error, "could not clear token") {
		t.Fatalf("expected token clear failure, got %+v", result)
	}
}

func TestGitCredentialLookupReportsAnUnreadableStore(t *testing.T) {
	withIsolatedStore(t)
	if err := gitCredentialSet("https://gitlab.com/g/r.git", "oauth2", "glpat-xxx"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if err := os.WriteFile(gitCredentialsPath(), []byte("not an encrypted store"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := gitCredentialLookupErr("gitlab.com"); ok || err == nil {
		t.Fatalf("ok=%v err=%v, want the read error", ok, err)
	}
	if _, ok := gitCredentialLookup("gitlab.com"); ok {
		t.Fatal("an unreadable store has no token")
	}
}

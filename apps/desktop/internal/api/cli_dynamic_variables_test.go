package api

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"testing"
)

func TestISOTimestampMatchesTheAppFormat(t *testing.T) {
	got := dynamicGenerators["$isoTimestamp"]()
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`).MatchString(got) {
		t.Fatalf("$isoTimestamp = %q, want the toISOString form", got)
	}
}

func TestCLIMasksSecretNamedValuesFromEnvFilesAndVars(t *testing.T) {
	envFile := filepath.Join(t.TempDir(), "ci.env")
	if err := os.WriteFile(envFile, []byte("API_TOKEN=tok-from-file\nbaseUrl=http://localhost\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	opts := cliOptions{envFile: envFile, vars: map[string]string{"db_password": "pw-from-flag", "verbose": "true"}}
	values, secrets, err := resolveCLIValuesForWorkspace(opts, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if values["API_TOKEN"] != "tok-from-file" || values["db_password"] != "pw-from-flag" {
		t.Fatalf("values = %v", values)
	}
	slices.Sort(secrets)
	if !slices.Equal(secrets, []string{"pw-from-flag", "tok-from-file"}) {
		t.Fatalf("secrets = %q, want only the token and password", secrets)
	}
	if got := redactSecrets("token tok-from-file at http://localhost", secrets); got != "token [secret] at http://localhost" {
		t.Fatalf("redacted = %q", got)
	}
}

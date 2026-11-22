package api

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestExportSecretProviderEnvForCI(t *testing.T) {
	f := newLinkedFixture(t)
	target := filepath.Join(t.TempDir(), "vault.ci.env")
	previous := secretEnvSaveDialog
	secretEnvSaveDialog = func(_ *App, defaultName string) (string, error) {
		if defaultName != "vault-prod.ci.env" {
			t.Errorf("default name = %q", defaultName)
		}
		return target, nil
	}
	defer func() { secretEnvSaveDialog = previous }()

	preview := f.app.PreviewSecretProviderEnv(f.workspace, "vault-prod")
	if !preview.Ok || len(preview.Variables) != 1 || preview.Variables[0].Name != "VAULT_TOKEN" || preview.Variables[0].Saved {
		t.Fatalf("preview before saving = %+v", preview)
	}
	if result := f.app.SetSecretProviderCredential(f.workspace, "vault-prod", "token", "hvs.test"); !result.Ok {
		t.Fatal(result.Error)
	}
	exported := f.app.ExportSecretProviderEnv(f.workspace, "vault-prod")
	if !exported.Ok || exported.Path != target || !exported.Variables[0].Saved {
		t.Fatalf("export = %+v", exported)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "VAULT_TOKEN=hvs.test\n" {
		t.Fatalf("file = %q, %v", data, err)
	}
	if info, _ := os.Stat(target); runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}

	key := "{\n  \"type\": \"service_account\",\n  \"client_email\": \"ci@p.iam.gserviceaccount.com\",\n  \"private_key\": \"-----BEGIN PRIVATE KEY-----\\nAB$C'D\\n-----END PRIVATE KEY-----\\n\"\n}"
	if result := f.app.SaveSecretProvider(f.workspace, map[string]any{"id": "gcp", "type": "gcp-secret-manager", "project": "my-project-1"}); !result.Ok {
		t.Fatal(result.Error)
	}
	if result := f.app.SetSecretProviderCredential(f.workspace, "gcp", "serviceAccountKey", key); !result.Ok {
		t.Fatal(result.Error)
	}
	secretEnvSaveDialog = func(*App, string) (string, error) { return target, nil }
	if exported := f.app.ExportSecretProviderEnv(f.workspace, "gcp"); !exported.Ok || exported.Variables[0].Name != "KURLO_GCP_SERVICE_ACCOUNT_KEY" {
		t.Fatalf("gcp export = %+v", exported)
	}
	if runtime.GOOS != "windows" {
		out, err := exec.Command("sh", "-c", `set -a; . "$1"; printf %s "$KURLO_GCP_SERVICE_ACCOUNT_KEY"`, "sh", target).Output()
		if err != nil {
			t.Fatalf("source: %v", err)
		}
		var got, want map[string]string
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatalf("sourced value is not JSON: %q", out)
		}
		_ = json.Unmarshal([]byte(key), &want)
		if got["private_key"] != want["private_key"] {
			t.Fatalf("private_key = %q", got["private_key"])
		}
	}

	if result := f.app.SaveSecretProvider(f.workspace, map[string]any{"id": "local", "type": "env"}); !result.Ok {
		t.Fatal(result.Error)
	}
	if result := f.app.PreviewSecretProviderEnv(f.workspace, "local"); result.Ok || !strings.Contains(result.Error, "needs no credentials") {
		t.Fatalf("env provider = %+v", result)
	}
}

func TestDotenvValue(t *testing.T) {
	for in, want := range map[string]string{
		"hvs.abc":     "hvs.abc",
		"a b":         "'a b'",
		"x$HOME":      "'x$HOME'",
		"it's":        `"it's"`,
		"it's $x \\ ": `"it's \$x \\ "`,
	} {
		if got := dotenvValue(in); got != want {
			t.Errorf("dotenvValue(%q) = %s, want %s", in, got, want)
		}
	}
}

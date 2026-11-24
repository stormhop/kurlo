package api

import (
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestRedactSecretsLongestFirst(t *testing.T) {
	got := redactSecrets("authorization: token-12345 (tok)", []string{"tok", "token-12345", ""})
	want := "authorization: [secret] ([secret])"
	if got != want {
		t.Fatalf("redactSecrets = %q, want %q", got, want)
	}
	if got == "authorization: token-12345 (tok)" {
		t.Fatal("secret was not redacted at all")
	}
}

func TestRedactSecretsFindsJSONEscapedValues(t *testing.T) {
	secret := `Tr1"ck\y&<pw>`
	for _, text := range []string{
		`{"body": "{\"pw\": \"Tr1\"ck\\y&<pw>\"}"}`,
		`{"pw":"Tr1\"ck\\y&<pw>"}`,
	} {
		got := redactSecrets(text, []string{secret})
		if strings.Contains(got, "Tr1") {
			t.Fatalf("redactSecrets(%q) = %q", text, got)
		}
	}
}

func TestRequestAuthSecretsCoverBasicCredentials(t *testing.T) {
	text := "Authorization: Basic c3ZjOmJhc2ljUFctOXo5eg== and client Y2xpZW50OmNsaWVudC1zZWNyZXQ="
	got := redactSecrets(text, requestAuthSecrets(model.AuthConfig{Type: "basic", Username: "svc", Password: "basicPW-9z9z", OAuth2ClientID: "client", OAuth2Secret: "client-secret"}))
	if got != "Authorization: Basic [secret] and client [secret]" {
		t.Fatalf("redactSecrets = %q", got)
	}
}

func TestRedactSecretsNoSecrets(t *testing.T) {
	if got := redactSecrets("nothing to hide", nil); got != "nothing to hide" {
		t.Fatalf("expected passthrough, got %q", got)
	}
}

func TestRedactScriptResultMasksTestNames(t *testing.T) {
	result := redactScriptResult(model.ScriptResult{
		Error: "failed with secret-1",
		Logs:  []string{"log secret-1"},
		Tests: []model.TestResult{{
			Name:  "uses secret-1",
			Error: "expected secret-1",
		}},
	}, []string{"secret-1"})

	if strings.Contains(result.Error, "secret-1") {
		t.Errorf("script error leaked the secret: %q", result.Error)
	}
	if strings.Contains(result.Logs[0], "secret-1") {
		t.Errorf("script log leaked the secret: %q", result.Logs[0])
	}
	if strings.Contains(result.Tests[0].Name, "secret-1") {
		t.Errorf("test name leaked the secret: %q", result.Tests[0].Name)
	}
	if strings.Contains(result.Tests[0].Error, "secret-1") {
		t.Errorf("test error leaked the secret: %q", result.Tests[0].Error)
	}
}

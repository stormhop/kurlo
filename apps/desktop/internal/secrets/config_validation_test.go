package secrets

import (
	"strings"
	"testing"
	"time"
)

func TestParseProviderRejectsUnreasonableValues(t *testing.T) {
	cases := []struct {
		name string
		item map[string]any
		want string
	}{
		{"bare scheme", map[string]any{"id": "v", "type": "vault", "address": "https://"}, "with a host"},
		{"spaces in url", map[string]any{"id": "v", "type": "vault", "address": "https://vault example.com"}, "must not contain spaces"},
		{"credentials in url", map[string]any{"id": "v", "type": "vault", "address": "https://root:pw@vault.example.com"}, "user name or password"},
		{"query in url", map[string]any{"id": "v", "type": "vault", "address": "https://vault.example.com/?token=x"}, "must not contain ? or #"},
		{"bad port", map[string]any{"id": "v", "type": "vault", "address": "https://vault.example.com:70000"}, "port"},
		{"ftp endpoint", map[string]any{"id": "a", "type": "aws-ssm", "region": "eu-west-1", "endpoint": "ftp://x"}, "https:// or http://"},
		{"zero timeout", map[string]any{"id": "e", "type": "env", "timeout": "0s"}, "between 1s and 10m"},
		{"huge timeout", map[string]any{"id": "e", "type": "env", "timeout": "2h"}, "between 1s and 10m"},
		{"session timeout", map[string]any{"id": "e", "type": "env", "timeout": "session"}, "duration like 10s"},
		{"negative ttl", map[string]any{"id": "e", "type": "env", "cacheTtl": -5}, "negative"},
		{"negative ttl text", map[string]any{"id": "e", "type": "env", "cacheTtl": "-5"}, "negative"},
		{"week ttl", map[string]any{"id": "e", "type": "env", "cacheTtl": "168h"}, "longer than 24h"},
		{"garbage ttl", map[string]any{"id": "e", "type": "env", "cacheTtl": "soon"}, "not a duration"},
		{"long name", map[string]any{"id": "e", "type": "env", "name": strings.Repeat("x", 81)}, "longer than 80"},
		{"multiline name", map[string]any{"id": "e", "type": "env", "name": "a\nb"}, "one line"},
		{"profile with space", map[string]any{"id": "a", "type": "aws-ssm", "region": "eu-west-1", "profile": "my profile"}, "profile must not contain spaces"},
		{"namespace slash", map[string]any{"id": "v", "type": "vault", "address": "https://v.example.com", "namespace": "/team/"}, "start or end with /"},
		{"bad mount", map[string]any{"id": "v", "type": "vault", "address": "https://v.example.com", "auth": map[string]any{"method": "approle", "roleId": "r", "mount": "app role!"}}, "auth.mount"},
		{"azure client id", map[string]any{"id": "z", "type": "azure-key-vault", "address": "https://k.vault.azure.net", "auth": map[string]any{"method": "client-secret", "tenantId": "contoso.onmicrosoft.com", "clientId": "my-app"}}, "application (client) ID"},
		{"azure tenant", map[string]any{"id": "z", "type": "azure-key-vault", "address": "https://k.vault.azure.net", "auth": map[string]any{"tenantId": "not a tenant"}}, "auth.tenantId"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseProvider(tc.item)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestParseProviderAcceptsReasonableValues(t *testing.T) {
	items := []map[string]any{
		{"id": "v", "type": "vault", "address": "http://127.0.0.1:8200", "namespace": "admin/team", "timeout": "30", "cacheTtl": "0"},
		{"id": "v2", "type": "vault", "address": "https://vault.example.com/proxy", "auth": map[string]any{"method": "approle", "roleId": "r", "mount": "auth-team/approle"}},
		{"id": "a", "type": "aws-secrets-manager", "region": "us-gov-west-1", "endpoint": "http://localhost:4566", "timeout": "10m"},
		{"id": "z", "type": "azure-key-vault", "address": "https://k.vault.azure.net", "auth": map[string]any{"method": "client-secret", "tenantId": "contoso.onmicrosoft.com", "clientId": "0b8e2f7a-0c5d-4b8e-9a3f-1f2e3d4c5b6a"}},
		{"id": "z2", "type": "azure-key-vault", "address": "https://k.vault.azure.net", "auth": map[string]any{"tenantId": "72f988bf-86f1-41af-91ab-2d7cd011db47"}},
		{"id": "e", "type": "env", "cacheTtl": "24h", "timeout": "1s"},
	}
	for _, item := range items {
		config, err := ParseProvider(item)
		if err != nil {
			t.Fatalf("%v: %v", item["id"], err)
		}
		if item["id"] == "e" && (config.CacheTTL != 24*time.Hour || config.Timeout != time.Second) {
			t.Fatalf("durations = %v %v", config.CacheTTL, config.Timeout)
		}
	}
}

func TestCredentialProblem(t *testing.T) {
	cases := []struct {
		name, value, want string
	}{
		{"token", "hvs.abc", ""},
		{"token", "  hvs.abc\n", ""},
		{"token", "", ""},
		{"token", "hvs abc", "spaces"},
		{"accessKeyId", "AKIA\nXYZ", "line breaks"},
		{"serviceAccountKey", "not json", "JSON key file"},
		{"serviceAccountKey", `{"type":"external_account"}`, "service_account or authorized_user"},
		{"serviceAccountKey", `{"type":"service_account","client_email":"a@b"}`, "private_key"},
		{"serviceAccountKey", `{"type":"service_account","client_email":"a@b","private_key":"-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n"}`, ""},
		{"serviceAccountKey", `{"type":"authorized_user","refresh_token":"r"}`, ""},
	}
	for _, tc := range cases {
		got := CredentialProblem(tc.name, tc.value)
		if (tc.want == "" && got != "") || (tc.want != "" && !strings.Contains(got, tc.want)) {
			t.Errorf("CredentialProblem(%s, %q) = %q, want %q", tc.name, tc.value, got, tc.want)
		}
	}
}

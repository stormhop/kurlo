package secrets

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestVaultPasswordLogins(t *testing.T) {
	for _, method := range []string{"ldap", "userpass"} {
		t.Run(method, func(t *testing.T) {
			var mu sync.Mutex
			var logins []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/v1/auth/") {
					var body map[string]string
					_ = json.NewDecoder(r.Body).Decode(&body)
					mu.Lock()
					logins = append(logins, r.URL.Path+" "+body["password"])
					mu.Unlock()
					if body["password"] != "pa ss" {
						w.WriteHeader(http.StatusBadRequest)
						_, _ = w.Write([]byte(`{"errors":["invalid username or password"]}`))
						return
					}
					_, _ = w.Write([]byte(`{"auth":{"client_token":"hvs.login","lease_duration":3600}}`))
					return
				}
				if r.Header.Get("X-Vault-Token") != "hvs.login" {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				_, _ = w.Write([]byte(`{"data":{"data":{"password":"db"},"metadata":{"version":1}}}`))
			}))
			defer server.Close()
			c := &clock{now: time.Unix(1_800_000_000, 0)}
			config := mustProvider(t, map[string]any{"id": "v", "type": "vault", "address": server.URL, "auth": map[string]any{"method": method}})
			if config.Auth.Mount != method {
				t.Fatalf("mount = %q", config.Auth.Mount)
			}
			missing := NewManager(&fakeSource{configs: []ProviderConfig{config}}, testEnv(nil, c))
			if _, err := missing.Value(context.Background(), "ws", Ref{Provider: "v", Path: "secret/data/app", Field: "password"}); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "VAULT_USERNAME") {
				t.Fatalf("no user name: %v", err)
			}
			manager := NewManager(&fakeSource{configs: []ProviderConfig{config}, credentials: map[string]string{"v.username": "ada@example.com", "v.password": "pa ss"}}, testEnv(nil, c))
			if value, err := manager.Value(context.Background(), "ws", Ref{Provider: "v", Path: "secret/data/app", Field: "password"}); err != nil || value != "db" {
				t.Fatalf("Value = %q, %v", value, err)
			}
			fromEnv := NewManager(&fakeSource{configs: []ProviderConfig{config}}, testEnv(map[string]string{"VAULT_USERNAME": "ci", "VAULT_PASSWORD": "wrong"}, c))
			if _, err := fromEnv.Value(context.Background(), "ws", Ref{Provider: "v", Path: "secret/data/app"}); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "invalid username or password") {
				t.Fatalf("wrong password: %v", err)
			}
			mu.Lock()
			defer mu.Unlock()
			want := "/v1/auth/" + method + "/login/" + url.PathEscape("ada@example.com") + " pa ss"
			if logins[0] != want || !strings.HasPrefix(logins[1], "/v1/auth/"+method+"/login/ci ") {
				t.Fatalf("logins = %q", logins)
			}
		})
	}
}

func TestAWSAssumeRoleWithMFA(t *testing.T) {
	var mu sync.Mutex
	var assumed []url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Amz-Target") == "" {
			_ = r.ParseForm()
			if r.PostForm.Get("Action") == "GetCallerIdentity" {
				_, _ = w.Write([]byte(`{"GetCallerIdentityResponse":{"GetCallerIdentityResult":{"Arn":"arn:aws:sts::123456789012:assumed-role/payments-read/kurlo"}}}`))
				return
			}
			mu.Lock()
			assumed = append(assumed, r.PostForm)
			mu.Unlock()
			if r.PostForm.Get("TokenCode") != "123456" {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"Error":{"Code":"AccessDenied","Message":"MultiFactorAuthentication failed with invalid MFA one time pass code."}}`))
				return
			}
			_, _ = w.Write([]byte(`{"AssumeRoleResponse":{"AssumeRoleResult":{"Credentials":{"AccessKeyId":"ASIAROLE","SecretAccessKey":"role-secret","SessionToken":"role-token","Expiration":1800003600}}}}`))
			return
		}
		if !strings.Contains(r.Header.Get("Authorization"), "Credential=ASIAROLE/") || r.Header.Get("X-Amz-Security-Token") != "role-token" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"__type":"AccessDeniedException","message":"signed with the base keys"}`))
			return
		}
		_, _ = w.Write([]byte(`{"SecretString":"from-role"}`))
	}))
	defer server.Close()
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "aws", "type": "aws-secrets-manager", "region": "eu-central-1", "endpoint": server.URL,
		"roleArn": "arn:aws:iam::123456789012:role/payments-read", "externalId": "kurlo-ext", "mfaSerial": "arn:aws:iam::123456789012:mfa/ada"})
	base := map[string]string{"AWS_ACCESS_KEY_ID": "AKIABASE", "AWS_SECRET_ACCESS_KEY": "base-secret"}

	noCode := NewManager(&fakeSource{configs: []ProviderConfig{config}}, (&fakeTool{}).env(base, nil, c))
	if _, err := noCode.Value(context.Background(), "ws", Ref{Provider: "aws", Path: "prod/db"}); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "MFA code") {
		t.Fatalf("without a code: %v", err)
	}
	wrong := NewManager(&fakeSource{configs: []ProviderConfig{config}, credentials: map[string]string{"aws.mfaCode": "000000"}}, (&fakeTool{}).env(base, nil, c))
	if _, err := wrong.Value(context.Background(), "ws", Ref{Provider: "aws", Path: "prod/db"}); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "cannot assume") {
		t.Fatalf("wrong code: %v", err)
	}
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}, credentials: map[string]string{"aws.mfaCode": "123456"}}, (&fakeTool{}).env(base, nil, c))
	for _, path := range []string{"prod/db", "prod/api"} {
		if value, err := manager.Value(context.Background(), "ws", Ref{Provider: "aws", Path: path}); err != nil || value != "from-role" {
			t.Fatalf("Value = %q, %v", value, err)
		}
	}
	status, err := manager.Check(context.Background(), "ws", "aws")
	if err != nil || !strings.Contains(status.Detail, "assumed-role/payments-read") || !strings.Contains(status.Detail, "role arn:aws:iam::123456789012:role/payments-read via AWS_ACCESS_KEY_ID") {
		t.Fatalf("Check = %+v, %v", status, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(assumed) != 2 {
		t.Fatalf("AssumeRole calls = %d, want 2: the wrong code, then one session reused", len(assumed))
	}
	last := assumed[1]
	if last.Get("RoleArn") != "arn:aws:iam::123456789012:role/payments-read" || last.Get("ExternalId") != "kurlo-ext" || last.Get("SerialNumber") != "arn:aws:iam::123456789012:mfa/ada" || last.Get("RoleSessionName") != "kurlo" {
		t.Fatalf("AssumeRole form = %v", last)
	}
}

func TestAWSRoleFieldsValidation(t *testing.T) {
	for _, tc := range []struct {
		item map[string]any
		want string
	}{
		{map[string]any{"id": "a", "type": "aws-ssm", "region": "eu-west-1", "roleArn": "payments"}, "IAM role ARN"},
		{map[string]any{"id": "a", "type": "aws-ssm", "region": "eu-west-1", "externalId": "x1"}, "needs roleArn"},
		{map[string]any{"id": "a", "type": "aws-ssm", "region": "eu-west-1", "mfaSerial": "my phone"}, "MFA device ARN"},
		{map[string]any{"id": "v", "type": "vault", "address": "https://v.example.com", "auth": map[string]any{"method": "ldap", "username": "ada lovelace"}}, "auth.username"},
	} {
		if _, err := ParseProvider(tc.item); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%v: err = %v, want %q", tc.item, err, tc.want)
		}
	}
	if CredentialProblem("password", "with spaces ok") != "" || CredentialProblem("mfaCode", "12345") == "" || CredentialProblem("mfaCode", "123456") != "" {
		t.Fatal("password and MFA code rules")
	}
}

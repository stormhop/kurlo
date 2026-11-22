package secrets

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParseNewProviderTypes(t *testing.T) {
	valid := []map[string]any{
		{"id": "gcp", "type": "gcp-secret-manager", "project": "my-project-1"},
		{"id": "az", "type": "azure-key-vault", "address": "https://team.vault.azure.net"},
		{"id": "az-sp", "type": "azure-key-vault", "address": "https://team.vault.azure.net", "auth": map[string]any{"method": "client-secret", "tenantId": "11111111-1111-1111-1111-111111111111", "clientId": "22222222-2222-2222-2222-222222222222"}},
		{"id": "bw", "type": "bitwarden"},
		{"id": "dp", "type": "doppler"},
		{"id": "inf", "type": "infisical", "project": "6512aa", "auth": map[string]any{"method": "universal", "clientId": "c"}},
		{"id": "pass", "type": "command", "command": []any{"pass", "show", "{path}"}},
		{"id": "k8s", "type": "vault", "address": "https://vault.test", "auth": map[string]any{"method": "kubernetes", "role": "web"}},
		{"id": "sso", "type": "vault", "address": "https://vault.test", "auth": map[string]any{"method": "oidc"}},
	}
	for _, raw := range valid {
		if _, err := ParseProvider(raw); err != nil {
			t.Errorf("%v: %v", raw["id"], err)
		}
	}
	k8s, _ := ParseProvider(valid[7])
	if k8s.Auth.Mount != "kubernetes" || k8s.Auth.TokenPath != defaultKubernetesTokenPath {
		t.Errorf("kubernetes defaults = %+v", k8s.Auth)
	}
	sso, _ := ParseProvider(valid[8])
	if sso.Auth.Mount != "oidc" || sso.Auth.RedirectURI != defaultOIDCRedirectURI || sso.CallTimeout() <= sso.Timeout {
		t.Errorf("oidc defaults = %+v, call timeout %v", sso.Auth, sso.CallTimeout())
	}
	az, _ := ParseProvider(valid[1])
	if az.Auth.Method != "cli" {
		t.Errorf("azure default auth = %q", az.Auth.Method)
	}
	command, _ := ParseProvider(map[string]any{"id": "c", "type": "command", "command": "pass show"})
	if strings.Join(command.Command, "|") != "pass|show" {
		t.Errorf("string command = %q", command.Command)
	}

	invalid := map[string]map[string]any{
		"project is required":           {"id": "gcp", "type": "gcp-secret-manager"},
		"not a Google Cloud project":    {"id": "gcp", "type": "gcp-secret-manager", "project": "Bad Project"},
		"address is required":           {"id": "az", "type": "azure-key-vault"},
		"tenantId and auth.clientId":    {"id": "az", "type": "azure-key-vault", "address": "https://a.vault.azure.net", "auth": map[string]any{"method": "client-secret"}},
		"address must start with https": {"id": "dp", "type": "doppler", "address": "api.doppler.com"},
		"auth.clientId is required":     {"id": "inf", "type": "infisical", "project": "p", "auth": map[string]any{"method": "universal"}},
		"command is required":           {"id": "c", "type": "command"},
		"auth.role is required":         {"id": "k8s", "type": "vault", "address": "https://vault.test", "auth": map[string]any{"method": "kubernetes"}},
		"must point to localhost":       {"id": "sso", "type": "vault", "address": "https://vault.test", "auth": map[string]any{"method": "oidc", "redirectUri": "http://evil.test:8250/cb"}},
	}
	for want, raw := range invalid {
		if _, err := ParseProvider(raw); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%v: err = %v, want %q", raw, err, want)
		}
	}

	base := mustProvider(t, map[string]any{"id": "c", "type": "command", "command": []any{"pass", "show"}})
	changed := mustProvider(t, map[string]any{"id": "c", "type": "command", "command": []any{"sh", "-c", "curl evil"}})
	if base.Hash() == changed.Hash() {
		t.Error("changing the command must ask for trust again")
	}
	projectA := mustProvider(t, map[string]any{"id": "g", "type": "gcp-secret-manager", "project": "project-a1"})
	projectB := mustProvider(t, map[string]any{"id": "g", "type": "gcp-secret-manager", "project": "project-b1"})
	if projectA.Hash() == projectB.Hash() {
		t.Error("changing the project must ask for trust again")
	}
}

func testRSAKey(t *testing.T) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func TestGCPSecretManagerWithServiceAccountKey(t *testing.T) {
	var mu sync.Mutex
	var tokenCalls int
	var seenAuth []string
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		mu.Lock()
		tokenCalls++
		mu.Unlock()
		assertion := r.Form.Get("assertion")
		parts := strings.Split(assertion, ".")
		if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" || len(parts) != 3 {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"bad assertion"}`))
			return
		}
		claims, _ := base64.RawURLEncoding.DecodeString(parts[1])
		var decoded map[string]any
		_ = json.Unmarshal(claims, &decoded)
		if decoded["iss"] != "sa@proj.iam.gserviceaccount.com" || decoded["scope"] != gcpScope {
			t.Errorf("claims = %v", decoded)
		}
		_, _ = w.Write([]byte(`{"access_token":"ya29.test","expires_in":3600,"token_type":"Bearer"}`))
	})
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seenAuth = append(seenAuth, r.Header.Get("Authorization"))
		mu.Unlock()
		switch r.URL.Path {
		case "/v1/projects/my-project-1/secrets/db/versions/latest:access":
			_, _ = w.Write([]byte(`{"payload":{"data":"` + base64.StdEncoding.EncodeToString([]byte(`{"user":"app","password":"gcp-pw"}`)) + `"}}`))
		case "/v1/projects/other-proj/secrets/api/versions/3:access":
			_, _ = w.Write([]byte(`{"payload":{"data":"` + base64.StdEncoding.EncodeToString([]byte("v3")) + `"}}`))
		case "/v1/projects/my-project-1/secrets":
			if r.URL.Query().Get("pageSize") == "1" {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"error":{"code":403,"message":"Permission denied","status":"PERMISSION_DENIED"}}`))
				return
			}
			if r.URL.Query().Get("pageToken") == "" {
				_, _ = w.Write([]byte(`{"secrets":[{"name":"projects/my-project-1/secrets/db"}],"nextPageToken":"p2"}`))
				return
			}
			_, _ = w.Write([]byte(`{"secrets":[{"name":"projects/my-project-1/secrets/api"}]}`))
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":{"code":404,"message":"Secret not found","status":"NOT_FOUND"}}`))
		}
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	key, _ := json.Marshal(map[string]string{"type": "service_account", "client_email": "sa@proj.iam.gserviceaccount.com", "private_key": testRSAKey(t), "private_key_id": "k1", "token_uri": server.URL + "/token"})

	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "gcp", "type": "gcp-secret-manager", "project": "my-project-1", "endpoint": server.URL})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}, credentials: map[string]string{"gcp.serviceAccountKey": string(key)}}, (&fakeTool{}).env(nil, nil, c))
	ctx := context.Background()

	if value, err := manager.Value(ctx, "ws", Ref{Provider: "gcp", Path: "db", Field: "password"}); err != nil || value != "gcp-pw" {
		t.Fatalf("value = %q, %v", value, err)
	}
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "gcp", Path: "projects/other-proj/secrets/api", Version: "3"}); err != nil || value != "v3" {
		t.Fatalf("full name = %q, %v", value, err)
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "gcp", Path: "gone"}); KindOf(err) != KindNotFound {
		t.Fatalf("missing = %v", err)
	}
	entries, err := manager.List(ctx, "ws", "gcp", "")
	if err != nil || len(entries) != 2 || entries[0].Path != "db" || entries[1].Path != "api" {
		t.Fatalf("list = %+v, %v", entries, err)
	}
	status, err := manager.Check(ctx, "ws", "gcp")
	if err == nil || KindOf(err) != KindForbidden || !strings.Contains(err.Error(), "known secret may still be readable") || status.Detail != "" {
		t.Fatalf("check should report list-only denial: %+v, %v", status, err)
	}
	if tokenCalls != 1 {
		t.Errorf("token endpoint called %d times, want 1", tokenCalls)
	}
	for _, header := range seenAuth {
		if header != "Bearer ya29.test" {
			t.Errorf("authorization = %q", header)
		}
	}
}

func TestGCPFallsBackToGcloud(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gcloud-token" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":{"message":"Request had invalid authentication credentials."}}`))
			return
		}
		_, _ = w.Write([]byte(`{"payload":{"data":"` + base64.StdEncoding.EncodeToString([]byte("plain")) + `"}}`))
	}))
	defer server.Close()
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "gcp", "type": "gcp-secret-manager", "project": "my-project-1", "endpoint": server.URL})
	tool := &fakeTool{reply: func(args []string) ([]byte, []byte, error) {
		if strings.Join(args, " ") != "auth print-access-token" {
			return nil, nil, errors.New("unexpected")
		}
		return []byte("gcloud-token\n"), nil, nil
	}}
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, tool.env(nil, nil, c, "gcloud"))
	if value, err := manager.Value(context.Background(), "ws", Ref{Provider: "gcp", Path: "api"}); err != nil || value != "plain" {
		t.Fatalf("value = %q, %v", value, err)
	}
	none := NewManager(&fakeSource{configs: []ProviderConfig{config}}, (&fakeTool{}).env(nil, nil, c))
	if _, err := none.Value(context.Background(), "ws", Ref{Provider: "gcp", Path: "api"}); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "GOOGLE_APPLICATION_CREDENTIALS") {
		t.Fatalf("no credentials = %v", err)
	}
}

func TestAzureKeyVaultClientSecretAndCLI(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/contoso.onmicrosoft.com/oauth2/v2.0/token" {
			_ = r.ParseForm()
			if r.Form.Get("client_secret") != "sp-secret" || r.Form.Get("scope") != "https://vault.azure.net/.default" || r.Form.Get("client_id") != "0b8e2f7a-0c5d-4b8e-9a3f-1f2e3d4c5b6a" {
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"error":"invalid_client","error_description":"AADSTS7000215: Invalid client secret provided."}`))
				return
			}
			_, _ = w.Write([]byte(`{"access_token":"az-token","expires_in":3599}`))
			return
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer az-") || r.URL.Query().Get("api-version") != azureAPIVersion {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":{"code":"Unauthorized","message":"AKV10000: Request is missing a Bearer token."}}`))
			return
		}
		switch r.URL.Path {
		case "/secrets/db-password":
			_, _ = w.Write([]byte(`{"value":"az-pw","id":"x"}`))
		case "/secrets/db-password/v1":
			_, _ = w.Write([]byte(`{"value":"az-old"}`))
		case "/secrets":
			if r.URL.Query().Get("maxresults") == "1" {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"error":{"code":"Forbidden","message":"Caller is not authorized to list secrets."}}`))
				return
			}
			if r.URL.Query().Get("page") == "" {
				_, _ = w.Write([]byte(`{"value":[{"id":"` + server.URL + `/secrets/db-password","attributes":{"enabled":true}}],"nextLink":"` + server.URL + `/secrets?api-version=7.4&page=2"}`))
				return
			}
			_, _ = w.Write([]byte(`{"value":[{"id":"` + server.URL + `/secrets/old","attributes":{"enabled":false}}],"nextLink":"https://evil.test/secrets"}`))
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":{"code":"SecretNotFound","message":"A secret with (name/id) gone was not found in this key vault."}}`))
		}
	}))
	defer server.Close()
	previous := azureAuthorityHost
	azureAuthorityHost = server.URL
	defer func() { azureAuthorityHost = previous }()

	c := &clock{now: time.Unix(1_800_000_000, 0)}
	ctx := context.Background()
	sp := mustProvider(t, map[string]any{"id": "az", "type": "azure-key-vault", "address": server.URL, "auth": map[string]any{"method": "client-secret", "tenantId": "contoso.onmicrosoft.com", "clientId": "0b8e2f7a-0c5d-4b8e-9a3f-1f2e3d4c5b6a"}})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{sp}, credentials: map[string]string{"az.clientSecret": "sp-secret"}}, (&fakeTool{}).env(nil, nil, c))
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "az", Path: "db-password"}); err != nil || value != "az-pw" {
		t.Fatalf("value = %q, %v", value, err)
	}
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "az", Path: "db-password", Version: "v1"}); err != nil || value != "az-old" {
		t.Fatalf("version = %q, %v", value, err)
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "az", Path: "gone"}); KindOf(err) != KindNotFound {
		t.Fatalf("missing = %v", err)
	}
	if _, err := manager.List(ctx, "ws", "az", ""); err == nil || !strings.Contains(err.Error(), "another host") {
		t.Fatalf("a nextLink to another host must not get the token: %v", err)
	}
	wrong := NewManager(&fakeSource{configs: []ProviderConfig{sp}, credentials: map[string]string{"az.clientSecret": "nope"}}, (&fakeTool{}).env(nil, nil, c))
	if _, err := wrong.Value(ctx, "ws", Ref{Provider: "az", Path: "db-password"}); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "AADSTS7000215") {
		t.Fatalf("bad secret = %v", err)
	}

	cliConfig := mustProvider(t, map[string]any{"id": "az", "type": "azure-key-vault", "address": server.URL, "auth": map[string]any{"tenantId": "contoso.onmicrosoft.com"}})
	tool := &fakeTool{reply: func(args []string) ([]byte, []byte, error) {
		if strings.Join(args, " ") != "account get-access-token --resource https://vault.azure.net --output json --tenant contoso.onmicrosoft.com" {
			return nil, []byte("ERROR: Please run 'az login' to setup account."), errors.New("exit 1")
		}
		return []byte(`{"accessToken":"az-cli","expires_on":1800003600}`), nil, nil
	}}
	cli := NewManager(&fakeSource{configs: []ProviderConfig{cliConfig}}, tool.env(nil, nil, c, "az"))
	if value, err := cli.Value(ctx, "ws", Ref{Provider: "az", Path: "db-password"}); err != nil || value != "az-pw" {
		t.Fatalf("cli value = %q, %v", value, err)
	}
	if status, err := cli.Check(ctx, "ws", "az"); err == nil || KindOf(err) != KindForbidden || !strings.Contains(err.Error(), "known secret may still be readable") || status.Detail != "" {
		t.Fatalf("check should report list-only denial: %+v, %v", status, err)
	}
	missing := NewManager(&fakeSource{configs: []ProviderConfig{cliConfig}}, (&fakeTool{}).env(nil, nil, c))
	if _, err := missing.Value(ctx, "ws", Ref{Provider: "az", Path: "db-password"}); KindOf(err) != KindToolMissing {
		t.Fatalf("no az = %v", err)
	}
}

func TestBitwardenSecretsManager(t *testing.T) {
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	const secretID = "0d0b8d3a-5f7e-4a51-9a0f-1c2d3e4f5a6b"
	const projectID = "a1b2c3d4-0000-4000-8000-000000000001"
	tool := &fakeTool{reply: func(args []string) ([]byte, []byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.HasPrefix(joined, "secret get "+secretID):
			return []byte(`{"id":"` + secretID + `","key":"STRIPE_KEY","value":"sk_bw"}`), nil, nil
		case strings.HasPrefix(joined, "secret list "+projectID):
			return []byte(`[{"id":"1","key":"DB_USER","value":"app"},{"id":"2","key":"DB_PASS","value":"bw-pw"}]`), nil, nil
		case strings.HasPrefix(joined, "secret list"):
			return []byte(`[{"id":"` + secretID + `","key":"STRIPE_KEY","value":"sk_bw"},{"id":"3","key":"DUP","value":"a"},{"id":"4","key":"DUP","value":"b"}]`), nil, nil
		case strings.HasPrefix(joined, "project list"):
			return []byte(`[{"id":"` + projectID + `","name":"Backend"}]`), nil, nil
		}
		return nil, []byte("Error: 404 Resource not found"), errors.New("exit 1")
	}}
	config := mustProvider(t, map[string]any{"id": "bw", "type": "bitwarden", "address": "https://vault.bitwarden.eu"})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}, credentials: map[string]string{"bw.token": "0.machine-token"}}, tool.env(nil, nil, c, "bws"))
	ctx := context.Background()

	cases := map[Ref]string{
		{Provider: "bw", Path: secretID}:                                  "sk_bw",
		{Provider: "bw", Path: "STRIPE_KEY"}:                              "sk_bw",
		{Provider: "bw", Path: "projects/" + projectID, Field: "DB_PASS"}: "bw-pw",
	}
	for ref, want := range cases {
		if value, err := manager.Value(ctx, "ws", ref); err != nil || value != want {
			t.Errorf("%s = %q, %v", ref, value, err)
		}
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "bw", Path: "DUP"}); KindOf(err) != KindInvalidRef {
		t.Errorf("duplicate key = %v", err)
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "bw", Path: "NOPE"}); KindOf(err) != KindNotFound {
		t.Errorf("unknown key = %v", err)
	}
	for _, call := range tool.calls {
		if !contains(call, "--server-url") || !contains(call, "https://vault.bitwarden.eu") || !contains(call, "json") {
			t.Errorf("call = %v", call)
		}
	}
	for _, env := range tool.envs {
		if len(env) != 1 || env[0] != "BWS_ACCESS_TOKEN=0.machine-token" {
			t.Errorf("env = %v", env)
		}
	}
	projects, err := manager.List(ctx, "ws", "bw", "")
	if err != nil || len(projects) != 1 || projects[0].Browse != "projects/"+projectID || projects[0].Path != "projects/"+projectID {
		t.Fatalf("projects = %+v, %v", projects, err)
	}
	secrets, err := manager.List(ctx, "ws", "bw", projects[0].Browse)
	if err != nil || len(secrets) != 2 || secrets[1].Name != "DB_PASS" || secrets[1].Path != "2" {
		t.Fatalf("secrets = %+v, %v", secrets, err)
	}
	noToken := NewManager(&fakeSource{configs: []ProviderConfig{config}}, tool.env(nil, nil, c, "bws"))
	if _, err := noToken.Value(ctx, "ws", Ref{Provider: "bw", Path: secretID}); KindOf(err) != KindNotAuthenticated {
		t.Errorf("no token = %v", err)
	}
	fromEnv := NewManager(&fakeSource{configs: []ProviderConfig{config}}, tool.env(map[string]string{"BWS_ACCESS_TOKEN": "env"}, nil, c, "bws"))
	if _, err := fromEnv.Value(ctx, "ws", Ref{Provider: "bw", Path: secretID}); err != nil {
		t.Errorf("token from the environment = %v", err)
	}
}

func TestDopplerConfigsAndSecrets(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer dp.st.test" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"messages":["Invalid Service token"],"success":false}`))
			return
		}
		query := r.URL.Query()
		switch r.URL.Path {
		case "/v3/configs/config/secrets/download":
			if query.Get("project") != "backend" || query.Get("config") != "prd" || query.Get("format") != "json" {
				w.WriteHeader(404)
				_, _ = w.Write([]byte(`{"messages":["Could not find requested config"]}`))
				return
			}
			_, _ = w.Write([]byte(`{"DB_URL":"postgres://dp","PORT":"5432"}`))
		case "/v3/configs/config/secret":
			if query.Get("name") == "payments/stripe.api_key" {
				_, _ = w.Write([]byte(`{"name":"payments/stripe.api_key","value":{"computed":"slash-value"}}`))
				return
			}
			_, _ = w.Write([]byte(`{"name":"` + query.Get("name") + `","value":{"raw":"${X}","computed":"single-` + query.Get("name") + `"}}`))
		case "/v3/me":
			_, _ = w.Write([]byte(`{"name":"ci","type":"service_token","workplace":{"name":"Acme"}}`))
		case "/v3/projects":
			_, _ = w.Write([]byte(`{"projects":[{"slug":"backend","name":"Backend"}]}`))
		case "/v3/configs":
			_, _ = w.Write([]byte(`{"configs":[{"name":"prd","environment":"production"}]}`))
		case "/v3/configs/config/secrets/names":
			_, _ = w.Write([]byte(`{"names":["DB_URL","PORT"]}`))
		}
	}))
	defer server.Close()
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "dp", "type": "doppler", "address": server.URL})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, (&fakeTool{}).env(map[string]string{"DOPPLER_TOKEN": "dp.st.test"}, nil, c))
	ctx := context.Background()
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "dp", Path: "backend/prd", Field: "DB_URL"}); err != nil || value != "postgres://dp" {
		t.Fatalf("field = %q, %v", value, err)
	}
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "dp", Path: "backend/prd/API_KEY"}); err != nil || value != "single-API_KEY" {
		t.Fatalf("single = %q, %v", value, err)
	}
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "dp", Path: "backend/prd/payments/stripe.api_key"}); err != nil || value != "slash-value" {
		t.Fatalf("slash name = %q, %v", value, err)
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "dp", Path: "backend/dev", Field: "X"}); KindOf(err) != KindNotFound {
		t.Fatalf("missing config = %v", err)
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "dp", Path: "backend"}); KindOf(err) != KindInvalidRef {
		t.Fatalf("short path = %v", err)
	}
	status, err := manager.Check(ctx, "ws", "dp")
	if err != nil || status.Detail != "Workplace Acme · service token · token from DOPPLER_TOKEN" {
		t.Fatalf("check = %+v, %v", status, err)
	}
	projects, _ := manager.List(ctx, "ws", "dp", "")
	configs, _ := manager.List(ctx, "ws", "dp", "backend")
	names, err := manager.List(ctx, "ws", "dp", "backend/prd")
	if err != nil || len(projects) != 1 || projects[0].Browse != "backend" || len(configs) != 1 || configs[0].Path != "backend/prd" || len(names) != 2 || names[0].Path != "backend/prd" || names[0].Field != "DB_URL" {
		t.Fatalf("list = %+v %+v %+v, %v", projects, configs, names, err)
	}
	wrong := NewManager(&fakeSource{configs: []ProviderConfig{config}, credentials: map[string]string{"dp.token": "dp.st.old"}}, (&fakeTool{}).env(map[string]string{"DOPPLER_TOKEN": "dp.st.test"}, nil, c))
	if _, err := wrong.Value(ctx, "ws", Ref{Provider: "dp", Path: "backend/prd", Field: "PORT"}); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "Invalid Service token") {
		t.Fatalf("a saved token must win over DOPPLER_TOKEN: %v", err)
	}
}

func TestDopplerProjectPagination(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/projects" || r.URL.Query().Get("per_page") != "100" {
			t.Errorf("request = %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		projects := make([]map[string]string, 0, 100)
		if page == 1 {
			for i := range 100 {
				projects = append(projects, map[string]string{"slug": fmt.Sprintf("p-%03d", i), "name": fmt.Sprintf("Project %03d", i)})
			}
		} else if page == 2 {
			projects = append(projects, map[string]string{"slug": "last", "name": "Last"})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"projects": projects})
	}))
	defer server.Close()
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "dp", "type": "doppler", "address": server.URL})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, (&fakeTool{}).env(map[string]string{"DOPPLER_TOKEN": "dp.st.test"}, nil, c))
	entries, err := manager.List(context.Background(), "ws", "dp", "")
	if err != nil || len(entries) != 101 || entries[len(entries)-1].Browse != "last" {
		t.Fatalf("entries=%d last=%+v err=%v", len(entries), entries[len(entries)-1], err)
	}
}

func TestInfisicalUniversalAuth(t *testing.T) {
	var logins int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/universal-auth/login" {
			logins++
			body, _ := io.ReadAll(r.Body)
			var decoded map[string]string
			_ = json.Unmarshal(body, &decoded)
			if decoded["clientId"] != "client-1" || decoded["clientSecret"] != "cs-1" {
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"message":"Invalid credentials"}`))
				return
			}
			_, _ = w.Write([]byte(`{"accessToken":"inf-token","expiresIn":7200}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer inf-token" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"message":"Token expired"}`))
			return
		}
		query := r.URL.Query()
		switch r.URL.Path {
		case "/api/v3/secrets/raw":
			if query.Get("workspaceId") != "proj-1" || query.Get("environment") != "prod" {
				w.WriteHeader(404)
				_, _ = w.Write([]byte(`{"message":"Environment not found"}`))
				return
			}
			if query.Get("secretPath") == "/backend" {
				_, _ = w.Write([]byte(`{"secrets":[{"secretKey":"DB_PASSWORD","secretValue":"inf-pw"}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"secrets":[{"secretKey":"API_URL","secretValue":"https://api"}]}`))
		case "/api/v1/workspace/proj-1":
			_, _ = w.Write([]byte(`{"workspace":{"name":"Shop","environments":[{"name":"Production","slug":"prod"}]}}`))
		case "/api/v1/folders":
			_, _ = w.Write([]byte(`{"folders":[{"name":"backend"}]}`))
		}
	}))
	defer server.Close()
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "inf", "type": "infisical", "project": "proj-1", "address": server.URL, "auth": map[string]any{"method": "universal", "clientId": "client-1"}})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, (&fakeTool{}).env(map[string]string{"INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET": "cs-1"}, nil, c))
	ctx := context.Background()
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "inf", Path: "prod/backend", Field: "DB_PASSWORD"}); err != nil || value != "inf-pw" {
		t.Fatalf("value = %q, %v", value, err)
	}
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "inf", Path: "prod"}); err != nil || value != "https://api" {
		t.Fatalf("single key folder = %q, %v", value, err)
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "inf", Path: "staging", Field: "X"}); KindOf(err) != KindNotFound {
		t.Fatalf("missing environment = %v", err)
	}
	environments, _ := manager.List(ctx, "ws", "inf", "")
	folder, err := manager.List(ctx, "ws", "inf", "prod")
	if err != nil || len(environments) != 1 || environments[0].Browse != "prod" || len(folder) != 2 || folder[0].Browse != "prod/backend" || folder[1].Field != "API_URL" || folder[1].Path != "prod" {
		t.Fatalf("list = %+v %+v, %v", environments, folder, err)
	}
	if status, err := manager.Check(ctx, "ws", "inf"); err != nil || status.Detail != "Project Shop · machine identity client-1" {
		t.Fatalf("check = %+v, %v", status, err)
	}
	if logins != 1 {
		t.Errorf("logins = %d, want 1", logins)
	}
	tokenConfig := mustProvider(t, map[string]any{"id": "inf", "type": "infisical", "project": "proj-1", "address": server.URL})
	withToken := NewManager(&fakeSource{configs: []ProviderConfig{tokenConfig}, credentials: map[string]string{"inf.token": "inf-token"}}, (&fakeTool{}).env(nil, nil, c))
	if value, err := withToken.Value(ctx, "ws", Ref{Provider: "inf", Path: "prod/backend", Field: "DB_PASSWORD"}); err != nil || value != "inf-pw" {
		t.Fatalf("token value = %q, %v", value, err)
	}
}

func TestCommandProvider(t *testing.T) {
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	tool := &fakeTool{reply: func(args []string) ([]byte, []byte, error) {
		if strings.Join(args, " ") == "show team/db" {
			return []byte("pass-value\n"), nil, nil
		}
		if strings.Join(args, " ") == "get --version 7 api" {
			return []byte(`{"token":"t7"}`), nil, nil
		}
		return nil, []byte("Error: team/missing is not in the password store."), errors.New("exit 1")
	}}
	pass := mustProvider(t, map[string]any{"id": "pass", "type": "command", "command": []any{"pass", "show", "{path}"}})
	custom := mustProvider(t, map[string]any{"id": "custom", "type": "command", "command": []any{"vault-helper", "get", "--version", "{version}"}})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{pass, custom}}, tool.env(nil, nil, c, "pass", "vault-helper"))
	ctx := context.Background()
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "pass", Path: "team/db"}); err != nil || value != "pass-value" {
		t.Fatalf("value = %q, %v", value, err)
	}
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "custom", Path: "api", Field: "token", Version: "7"}); err != nil || value != "t7" {
		t.Fatalf("json value = %q, %v", value, err)
	}
	if tool.calls[1][0] != "/usr/local/bin/vault-helper" {
		t.Errorf("command lookup = %v", tool.calls[1])
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "pass", Path: "team/missing"}); KindOf(err) != KindUnavailable || !strings.Contains(err.Error(), "not in the password store") {
		t.Fatalf("failure = %v", err)
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "pass", Path: "--help"}); KindOf(err) != KindInvalidRef {
		t.Fatalf("option-like path = %v", err)
	}
	if status, err := manager.Check(ctx, "ws", "pass"); err != nil || status.Detail != "Runs /usr/local/bin/pass show {path}" {
		t.Fatalf("check = %+v, %v", status, err)
	}
	if _, err := manager.List(ctx, "ws", "pass", ""); KindOf(err) != KindInvalidRef {
		t.Fatalf("command providers cannot list: %v", err)
	}
	untrusted := NewManager(&fakeSource{configs: []ProviderConfig{pass}, untrusted: map[string]bool{"pass": true}}, tool.env(nil, nil, c, "pass"))
	calls := len(tool.calls)
	if _, err := untrusted.Value(ctx, "ws", Ref{Provider: "pass", Path: "team/db"}); KindOf(err) != KindUntrusted || !strings.Contains(err.Error(), "--allow-secret-commands") {
		t.Fatalf("untrusted = %v", err)
	}
	if len(tool.calls) != calls {
		t.Fatal("an untrusted command must not run")
	}
	if got := strings.Join(CommandArgs([]string{"op", "read"}, "op://a/b", ""), " "); got != "read op://a/b" {
		t.Errorf("path is appended when there is no placeholder: %q", got)
	}
}

func TestCommandPreservesArgumentBoundariesAndChecksBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture requires Unix")
	}
	dir := t.TempDir()
	program := filepath.Join(dir, "capture")
	if err := os.WriteFile(program, []byte("#!/bin/sh\nprintf '%s|<%s>|<%s>|<%s>|<%s>' \"$#\" \"$1\" \"$2\" \"$3\" \"$4\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "cmd", "type": "command", "command": []any{program, "", "  ", "label", "{path}"}})
	env := (&fakeTool{}).env(nil, nil, c)
	env.LookPath = exec.LookPath
	env.Run = func(ctx context.Context, path string, args []string, _ []string) ([]byte, []byte, error) {
		output, err := exec.CommandContext(ctx, path, args...).Output()
		return output, nil, err
	}
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, env)
	value, err := manager.Value(context.Background(), "ws", Ref{Provider: "cmd", Path: "demo"})
	if err != nil || value != "4|<>|<  >|<label>|<demo>" {
		t.Fatalf("value=%q err=%v", value, err)
	}
	missing := mustProvider(t, map[string]any{"id": "missing", "type": "command", "command": []any{filepath.Join(dir, "absent")}})
	missingManager := NewManager(&fakeSource{configs: []ProviderConfig{missing}}, env)
	if _, err := missingManager.Check(context.Background(), "ws", "missing"); KindOf(err) != KindToolMissing {
		t.Fatalf("missing binary Check = %v", err)
	}
}

func TestVaultKubernetesAuth(t *testing.T) {
	fake, server := newVaultFixture(t)
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "v", "type": "vault", "address": server.URL, "auth": map[string]any{"method": "kubernetes", "role": "web"}})
	files := map[string]string{defaultKubernetesTokenPath: "k8s-jwt\n"}
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, (&fakeTool{}).env(nil, files, c))
	ctx := context.Background()
	for range 3 {
		if value, err := manager.Value(ctx, "ws", Ref{Provider: "v", Path: "secret/data/app", Field: "password"}); err != nil || value != "s3cr3t" {
			t.Fatalf("value = %q, %v", value, err)
		}
		manager.ClearCache()
		manager = NewManager(&fakeSource{configs: []ProviderConfig{config}}, (&fakeTool{}).env(nil, files, c))
	}
	if fake.logins.Load() != 3 {
		t.Errorf("logins = %d", fake.logins.Load())
	}
	outside := NewManager(&fakeSource{configs: []ProviderConfig{config}}, (&fakeTool{}).env(nil, nil, c))
	if _, err := outside.Value(ctx, "ws", Ref{Provider: "v", Path: "secret/data/app", Field: "password"}); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "inside a pod") {
		t.Fatalf("no token file = %v", err)
	}
}

func freeLoopbackPort(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	return port
}

func TestVaultOIDCSignsInThroughTheBrowser(t *testing.T) {
	fake, server := newVaultFixture(t)
	redirect := "http://localhost:" + freeLoopbackPort(t) + "/oidc/callback"
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "v", "type": "vault", "address": server.URL, "auth": map[string]any{"method": "oidc", "role": "dev", "redirectUri": redirect}})
	var opened []string
	env := (&fakeTool{}).env(nil, nil, c)
	env.OpenBrowser = func(target string) error {
		opened = append(opened, target)
		parsed, _ := url.Parse(target)
		callback := parsed.Query().Get("redirect_uri") + "?code=code-1&state=" + parsed.Query().Get("state")
		go func() {
			resp, err := http.Get(callback)
			if err == nil {
				body, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				if !strings.Contains(string(body), "Signed in to Vault") {
					t.Errorf("callback page = %s", body)
				}
			}
		}()
		return nil
	}
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, env)
	ctx := context.Background()
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "v", Path: "secret/data/app", Field: "username"}); err != nil || value != "app" {
		t.Fatalf("value = %q, %v", value, err)
	}
	if _, err := manager.Check(ctx, "ws", "v"); err != nil {
		t.Fatalf("check after login = %v", err)
	}
	if len(opened) != 1 || fake.logins.Load() != 1 {
		t.Fatalf("browser opened %d times, logins %d", len(opened), fake.logins.Load())
	}
	if seen, _ := fake.seen.Load("oidc-redirect"); seen != redirect {
		t.Errorf("redirect_uri = %v", seen)
	}
	headless := NewManager(&fakeSource{configs: []ProviderConfig{config}}, (&fakeTool{}).env(nil, nil, c))
	if _, err := headless.Value(ctx, "ws", Ref{Provider: "v", Path: "secret/data/app", Field: "username"}); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "needs a browser") {
		t.Fatalf("without a browser = %v", err)
	}
}

func TestVaultListsMountsAndKeys(t *testing.T) {
	_, server := newVaultFixture(t)
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "v", "type": "vault", "address": server.URL})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}, credentials: map[string]string{"v.token": "hvs.test"}}, testEnv(nil, c))
	ctx := context.Background()
	mounts, err := manager.List(ctx, "ws", "v", "")
	if err != nil || len(mounts) != 2 || mounts[0].Browse != "kv1/" || mounts[1].Name != "secret/" || mounts[1].Detail != "KV v2" {
		t.Fatalf("mounts = %+v, %v", mounts, err)
	}
	root, err := manager.List(ctx, "ws", "v", "secret/")
	if err != nil || len(root) != 2 || root[0].Path != "secret/data/app" || root[1].Browse != "secret/team/" {
		t.Fatalf("secret/ = %+v, %v", root, err)
	}
	team, err := manager.List(ctx, "ws", "v", "secret/data/team/")
	if err != nil || len(team) != 1 || team[0].Path != "secret/data/team/billing" {
		t.Fatalf("secret/team = %+v, %v", team, err)
	}
	kv1, err := manager.List(ctx, "ws", "v", "kv1")
	if err != nil || len(kv1) != 1 || kv1[0].Path != "kv1/app" {
		t.Fatalf("kv1 = %+v, %v", kv1, err)
	}
}

func TestOnePasswordAndAWSList(t *testing.T) {
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	tool := &fakeTool{reply: func(args []string) ([]byte, []byte, error) {
		switch {
		case contains(args, "vault"):
			return []byte(`[{"id":"v1","name":"Payments"}]`), nil, nil
		case contains(args, "list"):
			return []byte(`[{"title":"Stripe","category":"API_CREDENTIAL"},{"title":"a/b","category":"LOGIN"}]`), nil, nil
		case contains(args, "get"):
			return []byte(`{"fields":[{"label":"credential","value":"sk"},{"label":"username","value":"u"}]}`), nil, nil
		}
		return nil, nil, errors.New("unexpected")
	}}
	op := mustProvider(t, map[string]any{"id": "op", "type": "1password"})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{op}}, tool.env(nil, nil, c, "op"))
	ctx := context.Background()
	vaults, _ := manager.List(ctx, "ws", "op", "")
	items, _ := manager.List(ctx, "ws", "op", "op://Payments/")
	fields, err := manager.List(ctx, "ws", "op", "op://Payments/Stripe/")
	if err != nil || len(vaults) != 1 || vaults[0].Browse != "op://Payments/" || len(items) != 1 || items[0].Path != "op://Payments/Stripe" || items[0].Detail != "api credential" || len(fields) != 2 || fields[0].Path != "op://Payments/Stripe" || fields[0].Field == "" {
		t.Fatalf("1password list = %+v %+v %+v, %v", vaults, items, fields, err)
	}

	var mu sync.Mutex
	var tokens []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var request map[string]any
		_ = json.Unmarshal(body, &request)
		mu.Lock()
		tokens = append(tokens, stringFromAnyTest(request["NextToken"]))
		mu.Unlock()
		switch r.Header.Get("X-Amz-Target") {
		case "secretsmanager.ListSecrets":
			if request["NextToken"] == nil {
				_, _ = w.Write([]byte(`{"SecretList":[{"Name":"prod/db"}],"NextToken":"n2"}`))
				return
			}
			_, _ = w.Write([]byte(`{"SecretList":[{"Name":"prod/api","Description":"API key"}]}`))
		case "AmazonSSM.DescribeParameters":
			_, _ = w.Write([]byte(`{"Parameters":[{"Name":"/prod/api-key","Type":"SecureString"}]}`))
		}
	}))
	defer server.Close()
	sm := mustProvider(t, map[string]any{"id": "sm", "type": "aws-secrets-manager", "region": "eu-central-1", "endpoint": server.URL})
	ssm := mustProvider(t, map[string]any{"id": "ssm", "type": "aws-ssm", "region": "eu-central-1", "endpoint": server.URL})
	aws := NewManager(&fakeSource{configs: []ProviderConfig{sm, ssm}}, (&fakeTool{}).env(map[string]string{"AWS_ACCESS_KEY_ID": "AKIDEXAMPLE", "AWS_SECRET_ACCESS_KEY": "secret"}, nil, c))
	secrets, err := aws.List(ctx, "ws", "sm", "")
	if err != nil || len(secrets) != 2 || secrets[0].Path != "prod/api" || secrets[0].Detail != "API key" || secrets[1].Path != "prod/db" {
		t.Fatalf("secrets manager list = %+v, %v", secrets, err)
	}
	parameters, err := aws.List(ctx, "ws", "ssm", "")
	if err != nil || len(parameters) != 1 || parameters[0].Detail != "SecureString" {
		t.Fatalf("ssm list = %+v, %v", parameters, err)
	}
	if strings.Join(tokens, ",") != ",n2," {
		t.Errorf("pagination tokens = %v", tokens)
	}
	env := mustProvider(t, map[string]any{"id": "env", "type": "env"})
	if _, err := NewManager(&fakeSource{configs: []ProviderConfig{env}}, testEnv(nil, c)).List(ctx, "ws", "env", ""); KindOf(err) != KindInvalidRef {
		t.Fatalf("env cannot list: %v", err)
	}
	untrusted := NewManager(&fakeSource{configs: []ProviderConfig{op}, untrusted: map[string]bool{"op": true}}, tool.env(nil, nil, c, "op"))
	if _, err := untrusted.List(ctx, "ws", "op", ""); KindOf(err) != KindUntrusted {
		t.Fatalf("untrusted list = %v", err)
	}
}

func stringFromAnyTest(value any) string {
	text, _ := value.(string)
	return text
}

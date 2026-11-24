package secrets

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeSource struct {
	configs     []ProviderConfig
	untrusted   map[string]bool
	credentials map[string]string
}

func (s *fakeSource) Providers(string) ([]ProviderConfig, error) { return s.configs, nil }

func (s *fakeSource) Trusted(_ string, config ProviderConfig) bool { return !s.untrusted[config.ID] }

func (s *fakeSource) Credentials(_, providerID string) Credentials {
	return func(name string) (string, bool) {
		value, ok := s.credentials[providerID+"."+name]
		return value, ok
	}
}

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func testEnv(vars map[string]string, c *clock) Environment {
	return Environment{
		Getenv:   func(key string) (string, bool) { value, ok := vars[key]; return value, ok },
		HomeDir:  func() (string, error) { return "/nonexistent-home", nil },
		ReadFile: func(string) ([]byte, error) { return nil, os.ErrNotExist },
		Now:      c.Now,
	}
}

func mustProvider(t *testing.T, raw map[string]any) ProviderConfig {
	t.Helper()
	config, err := ParseProvider(raw)
	if err != nil {
		t.Fatalf("ParseProvider: %v", err)
	}
	return config
}

func TestParseProviders(t *testing.T) {
	configs, problems := ParseProviders([]map[string]any{
		{"id": "vault-prod", "type": "vault", "address": "https://vault.example.com", "cacheTtl": "1m"},
		{"id": "ci", "type": "env"},
		{"id": "ci", "type": "env"},
		{"id": "Bad ID", "type": "env"},
		{"id": "nohost", "type": "vault"},
		{"id": "role", "type": "vault", "address": "https://v", "auth": map[string]any{"method": "approle"}},
		{"id": "odd", "type": "lastpass"},
		{"id": "session", "type": "env", "cacheTtl": "session"},
	})
	if len(configs) != 3 {
		t.Fatalf("configs = %d, want 3: %+v", len(configs), configs)
	}
	if configs[0].CacheTTL != time.Minute || configs[0].Auth.Method != "token" || configs[0].Timeout != DefaultTimeout {
		t.Fatalf("vault config = %+v", configs[0])
	}
	if configs[2].CacheTTL != -1 {
		t.Fatalf("session ttl = %v", configs[2].CacheTTL)
	}
	if len(problems) != 5 {
		t.Fatalf("problems = %v", problems)
	}
	for _, want := range []string{"duplicate id", "must be lowercase", "address is required", "roleId is required", "unsupported type"} {
		found := false
		for _, problem := range problems {
			if strings.Contains(problem.Error(), want) {
				found = true
			}
		}
		if !found {
			t.Errorf("no problem mentions %q: %v", want, problems)
		}
	}
}

func TestConfigHashFollowsWhereCredentialsGo(t *testing.T) {
	base := mustProvider(t, map[string]any{"id": "v", "type": "vault", "address": "https://vault.example.com", "name": "Vault"})
	renamed := mustProvider(t, map[string]any{"id": "v", "type": "vault", "address": "https://vault.example.com/", "name": "Other", "cacheTtl": "1m"})
	moved := mustProvider(t, map[string]any{"id": "v", "type": "vault", "address": "https://evil.example.net"})
	if base.Hash() != renamed.Hash() {
		t.Fatal("name, cache time and a trailing slash must not change the trust hash")
	}
	if base.Hash() == moved.Hash() {
		t.Fatal("a new address must change the trust hash")
	}
}

func TestMarkerRoundTrip(t *testing.T) {
	ref := Ref{Provider: "op", Path: "op://Payments/Stripe/api key", Field: "credential", Version: "3"}
	marker := Marker(ref)
	if strings.ContainsAny(strings.TrimSuffix(strings.TrimPrefix(marker, "{{"), "}}"), "{} ") {
		t.Fatalf("marker leaks braces or spaces: %s", marker)
	}
	decoded, err := DecodeMarker(marker)
	if err != nil || decoded != ref {
		t.Fatalf("DecodeMarker = %+v, %v", decoded, err)
	}
	text := "Bearer " + marker + " and " + Marker(Ref{Provider: "ci", Path: "TOKEN"}) + " {{plain}}"
	refs := FindMarkers(text)
	if len(refs) != 2 {
		t.Fatalf("FindMarkers = %+v", refs)
	}
	replaced := ReplaceMarkers(text, map[Ref]string{ref: "sk_live"})
	if !strings.HasPrefix(replaced, "Bearer sk_live and {{kurloRef:") || !strings.HasSuffix(replaced, "{{plain}}") {
		t.Fatalf("ReplaceMarkers = %q", replaced)
	}
	if _, err := DecodeMarker("{{kurloRef:not-json}}"); err == nil {
		t.Fatal("garbage marker decoded")
	}
}

func TestSecretValueFieldSelection(t *testing.T) {
	single := Secret{Fields: map[string]string{"password": "p"}}
	if value, err := single.Value("v", Ref{Path: "kv/app"}); err != nil || value != "p" {
		t.Fatalf("single field = %q, %v", value, err)
	}
	multi := Secret{Fields: map[string]string{"password": "p", "username": "u"}}
	if _, err := multi.Value("v", Ref{Path: "kv/app"}); KindOf(err) != KindInvalidRef || !strings.Contains(err.Error(), "password, username") {
		t.Fatalf("multi without field err = %v", err)
	}
	if _, err := multi.Value("v", Ref{Path: "kv/app", Field: "token"}); KindOf(err) != KindNotFound {
		t.Fatalf("missing field err = %v", err)
	}
	raw := Secret{Raw: `{"key":"abc","port":5432}`}
	if value, err := raw.Value("aws", Ref{Path: "s", Field: "port"}); err != nil || value != "5432" {
		t.Fatalf("json field = %q, %v", value, err)
	}
	if value, err := raw.Value("aws", Ref{Path: "s"}); err != nil || value != raw.Raw {
		t.Fatalf("raw = %q, %v", value, err)
	}
	if _, err := (Secret{Raw: "plain"}).Value("env", Ref{Path: "s", Field: "x"}); KindOf(err) != KindInvalidRef {
		t.Fatalf("field on plain err = %v", err)
	}
}

type fakeVault struct {
	t        *testing.T
	token    string
	requests atomic.Int32
	logins   atomic.Int32
	seen     sync.Map
}

func (f *fakeVault) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests.Add(1)
		f.seen.Store(r.URL.Path, r.Header.Get("X-Vault-Namespace"))
		writeJSON := func(status int, body any) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(body)
		}
		if r.URL.Path == "/v1/auth/approle/login" {
			f.logins.Add(1)
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["role_id"] != "role-1" || body["secret_id"] != "sid" {
				writeJSON(400, map[string]any{"errors": []string{"invalid role or secret ID"}})
				return
			}
			writeJSON(200, map[string]any{"auth": map[string]any{"client_token": f.token, "lease_duration": 3600}})
			return
		}
		switch r.URL.Path {
		case "/v1/auth/kubernetes/login":
			f.logins.Add(1)
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["role"] != "web" || body["jwt"] != "k8s-jwt" {
				writeJSON(400, map[string]any{"errors": []string{"invalid role or jwt"}})
				return
			}
			writeJSON(200, map[string]any{"auth": map[string]any{"client_token": f.token, "lease_duration": 3600}})
			return
		case "/v1/auth/oidc/oidc/auth_url":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.seen.Store("oidc-nonce", body["client_nonce"])
			f.seen.Store("oidc-redirect", body["redirect_uri"])
			writeJSON(200, map[string]any{"data": map[string]any{"auth_url": "https://idp.test/authorize?state=st-1&redirect_uri=" + body["redirect_uri"]}})
			return
		case "/v1/auth/oidc/oidc/callback":
			f.logins.Add(1)
			query := r.URL.Query()
			nonce, _ := f.seen.Load("oidc-nonce")
			if query.Get("code") != "code-1" || query.Get("state") != "st-1" || query.Get("client_nonce") != nonce {
				writeJSON(400, map[string]any{"errors": []string{"invalid callback"}})
				return
			}
			writeJSON(200, map[string]any{"auth": map[string]any{"client_token": f.token, "lease_duration": 3600}})
			return
		}
		if r.Header.Get("X-Vault-Token") != f.token {
			writeJSON(403, map[string]any{"errors": []string{"permission denied"}})
			return
		}
		switch r.URL.Path {
		case "/v1/sys/internal/ui/mounts":
			writeJSON(200, map[string]any{"data": map[string]any{"secret": map[string]any{
				"secret/":   map[string]any{"type": "kv", "options": map[string]any{"version": "2"}},
				"kv1/":      map[string]any{"type": "kv", "options": map[string]any{"version": "1"}},
				"database/": map[string]any{"type": "database"},
			}}})
		case "/v1/sys/internal/ui/mounts/secret/team", "/v1/sys/internal/ui/mounts/secret", "/v1/sys/internal/ui/mounts/secret/data/team":
			writeJSON(200, map[string]any{"data": map[string]any{"path": "secret/", "type": "kv", "options": map[string]any{"version": "2"}}})
		case "/v1/sys/internal/ui/mounts/kv1":
			writeJSON(200, map[string]any{"data": map[string]any{"path": "kv1/", "type": "kv", "options": map[string]any{"version": "1"}}})
		case "/v1/secret/metadata":
			writeJSON(200, map[string]any{"data": map[string]any{"keys": []string{"app", "team/"}}})
		case "/v1/secret/metadata/team":
			writeJSON(200, map[string]any{"data": map[string]any{"keys": []string{"billing"}}})
		case "/v1/kv1":
			if r.URL.Query().Get("list") != "true" {
				writeJSON(405, map[string]any{"errors": []string{}})
				return
			}
			writeJSON(200, map[string]any{"data": map[string]any{"keys": []string{"app"}}})
		case "/v1/auth/token/lookup-self":
			writeJSON(200, map[string]any{"data": map[string]any{"ttl": 27720, "policies": []string{"app-read", "default"}}})
		case "/v1/secret/data/app":
			if r.URL.Query().Get("version") == "1" {
				writeJSON(200, map[string]any{"data": map[string]any{"data": map[string]any{"password": "old"}, "metadata": map[string]any{"version": 1}}})
				return
			}
			writeJSON(200, map[string]any{"data": map[string]any{"data": map[string]any{"password": "s3cr3t", "username": "app", "port": 5432}, "metadata": map[string]any{"version": 2}}})
		case "/v1/kv1/app":
			writeJSON(200, map[string]any{"data": map[string]any{"token": "kv1-token", "metadata": map[string]any{"version": 1}, "data": map[string]any{"nested": "demo"}}})
		case "/v1/kv1/ambiguous":
			writeJSON(200, map[string]any{"data": map[string]any{"metadata": map[string]any{"version": 1}, "data": map[string]any{"nested": "demo"}}})
		case "/v1/database/creds/ro":
			writeJSON(200, map[string]any{"lease_duration": 60, "data": map[string]any{"username": "v-ro-1", "password": "dyn"}})
		case "/v1/secret/data/locked":
			writeJSON(403, map[string]any{"errors": []string{"1 error occurred:\n\t* permission denied\n\n"}})
		default:
			writeJSON(404, map[string]any{"errors": []string{}})
		}
	})
}

func newVaultFixture(t *testing.T) (*fakeVault, *httptest.Server) {
	t.Helper()
	fake := &fakeVault{t: t, token: "hvs.test"}
	server := httptest.NewServer(fake.handler())
	t.Cleanup(server.Close)
	return fake, server
}

func TestVaultFetchesKVAndDynamicSecrets(t *testing.T) {
	fake, server := newVaultFixture(t)
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "vault-prod", "type": "vault", "address": server.URL, "namespace": "team-a"})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, testEnv(map[string]string{"VAULT_TOKEN": "hvs.test"}, c))
	ctx := context.Background()

	values, err := manager.Resolve(ctx, "ws", []Ref{
		{Provider: "vault-prod", Path: "secret/data/app", Field: "password"},
		{Provider: "vault-prod", Path: "secret/data/app", Field: "port"},
		{Provider: "vault-prod", Path: "secret/data/app", Field: "password", Version: "1"},
		{Provider: "vault-prod", Path: "kv1/app", Field: "token"},
		{Provider: "vault-prod", Path: "kv1/app", Field: "metadata"},
		{Provider: "vault-prod", Path: "kv1/app", Field: "data"},
		{Provider: "vault-prod", Path: "kv1/ambiguous", Field: "metadata"},
		{Provider: "vault-prod", Path: "kv1/ambiguous", Field: "data"},
		{Provider: "vault-prod", Path: "database/creds/ro", Field: "password"},
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	want := map[string]string{"secret/data/app#password": "s3cr3t", "secret/data/app#port": "5432", "secret/data/app#password@1": "old", "kv1/app#token": "kv1-token", "kv1/app#metadata": `{"version":1}`, "kv1/app#data": `{"nested":"demo"}`, "kv1/ambiguous#metadata": `{"version":1}`, "kv1/ambiguous#data": `{"nested":"demo"}`, "database/creds/ro#password": "dyn"}
	for ref, value := range values {
		key := strings.TrimPrefix(ref.String(), "vault-prod:")
		if want[key] != value {
			t.Errorf("%s = %q, want %q", key, value, want[key])
		}
	}
	if namespace, _ := fake.seen.Load("/v1/secret/data/app"); namespace != "team-a" {
		t.Errorf("namespace header = %v", namespace)
	}
	if got := fake.requests.Load(); got != 5 {
		t.Errorf("requests = %d, want 5 (one per path and version)", got)
	}
	c.Advance(2 * time.Minute)
	if _, err := manager.Resolve(ctx, "ws", []Ref{{Provider: "vault-prod", Path: "secret/data/app", Field: "username"}, {Provider: "vault-prod", Path: "database/creds/ro", Field: "username"}}); err != nil {
		t.Fatal(err)
	}
	if got := fake.requests.Load(); got != 6 {
		t.Errorf("requests after 2 min = %d, want 6: the lease of database/creds/ro expired, KV stays cached", got)
	}
	if manager.ClearCache() == 0 {
		t.Error("ClearCache reported an empty cache")
	}
}

func TestVaultErrorsAreTyped(t *testing.T) {
	_, server := newVaultFixture(t)
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "v", "type": "vault", "address": server.URL})
	ctx := context.Background()

	withToken := NewManager(&fakeSource{configs: []ProviderConfig{config}}, testEnv(map[string]string{"VAULT_TOKEN": "hvs.test"}, c))
	cases := []struct {
		ref  Ref
		kind Kind
	}{
		{Ref{Provider: "v", Path: "secret/data/locked"}, KindForbidden},
		{Ref{Provider: "v", Path: "secret/data/missing"}, KindNotFound},
		{Ref{Provider: "v", Path: "secret/data/app"}, KindInvalidRef},
		{Ref{Provider: "nope", Path: "x"}, KindInvalidRef},
	}
	for _, tc := range cases {
		if _, err := withToken.Value(ctx, "ws", tc.ref); KindOf(err) != tc.kind {
			t.Errorf("%s: kind = %s (%v), want %s", tc.ref, KindOf(err), err, tc.kind)
		}
	}

	_, err := withToken.Value(ctx, "ws", Ref{Provider: "v", Path: "secret/team", Field: "password"})
	if KindOf(err) != KindNotFound || !strings.Contains(err.Error(), "secret/data/team") {
		t.Errorf("a KV v2 path without data/ should name the right path: %v", err)
	}
	if _, err := withToken.Value(ctx, "ws", Ref{Provider: "v", Path: "kv1/missing", Field: "password"}); err == nil || strings.Contains(err.Error(), "data/") {
		t.Errorf("a KV v1 path must not suggest data/: %v", err)
	}

	noToken := NewManager(&fakeSource{configs: []ProviderConfig{config}}, testEnv(nil, c))
	if _, err := noToken.Value(ctx, "ws", Ref{Provider: "v", Path: "secret/data/app", Field: "password"}); KindOf(err) != KindNotAuthenticated {
		t.Errorf("no token: %v", err)
	}
	badToken := NewManager(&fakeSource{configs: []ProviderConfig{config}}, testEnv(map[string]string{"VAULT_TOKEN": "expired"}, c))
	if _, err := badToken.Check(ctx, "ws", "v"); KindOf(err) != KindNotAuthenticated {
		t.Errorf("bad token check: %v", err)
	}
	status, err := withToken.Check(ctx, "ws", "v")
	if err != nil || status.ExpiresIn != 27720 || len(status.Policies) != 2 {
		t.Errorf("Check = %+v, %v", status, err)
	}

	stored := NewManager(&fakeSource{configs: []ProviderConfig{config}, credentials: map[string]string{"v.token": "hvs.test"}}, testEnv(map[string]string{"VAULT_TOKEN": "expired"}, c))
	if value, err := stored.Value(ctx, "ws", Ref{Provider: "v", Path: "secret/data/app", Field: "username"}); err != nil || value != "app" {
		t.Errorf("a token saved on the device must win over VAULT_TOKEN: %q, %v", value, err)
	}

	unreachable := mustProvider(t, map[string]any{"id": "down", "type": "vault", "address": "http://127.0.0.1:1", "timeout": "1s"})
	down := NewManager(&fakeSource{configs: []ProviderConfig{unreachable}}, testEnv(map[string]string{"VAULT_TOKEN": "x"}, c))
	if _, err := down.Value(ctx, "ws", Ref{Provider: "down", Path: "a"}); err == nil || KindOf(err) == KindNotFound {
		t.Errorf("unreachable vault: %v", err)
	}
}

func TestVaultAppRoleLogsInOnce(t *testing.T) {
	fake, server := newVaultFixture(t)
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "v", "type": "vault", "address": server.URL, "cacheTtl": "0", "auth": map[string]any{"method": "approle", "roleId": "role-1"}})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}, credentials: map[string]string{"v.secretId": "sid"}}, testEnv(nil, c))
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if value, err := manager.Value(ctx, "ws", Ref{Provider: "v", Path: "secret/data/app", Field: "password"}); err != nil || value != "s3cr3t" {
			t.Fatalf("Value = %q, %v", value, err)
		}
	}
	if fake.logins.Load() != 1 {
		t.Fatalf("logins = %d, want 1", fake.logins.Load())
	}
	c.Advance(2 * time.Hour)
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "v", Path: "secret/data/app", Field: "password"}); err != nil {
		t.Fatal(err)
	}
	if fake.logins.Load() != 2 {
		t.Fatalf("logins after the lease = %d, want 2", fake.logins.Load())
	}
	wrong := NewManager(&fakeSource{configs: []ProviderConfig{config}, credentials: map[string]string{"v.secretId": "nope"}}, testEnv(nil, c))
	if _, err := wrong.Value(ctx, "ws", Ref{Provider: "v", Path: "secret/data/app"}); KindOf(err) != KindNotAuthenticated {
		t.Fatalf("wrong secret id: %v", err)
	}
}

func TestUntrustedProviderGetsNoRequest(t *testing.T) {
	fake, server := newVaultFixture(t)
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "v", "type": "vault", "address": server.URL})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}, untrusted: map[string]bool{"v": true}}, testEnv(map[string]string{"VAULT_TOKEN": "hvs.test"}, c))
	_, err := manager.Resolve(context.Background(), "ws", []Ref{{Provider: "v", Path: "secret/data/app", Field: "password"}})
	var resolveErr *ResolveError
	if !errors.As(err, &resolveErr) || len(resolveErr.Failures) != 1 || KindOf(resolveErr.Failures[0].Err) != KindUntrusted {
		t.Fatalf("err = %v", err)
	}
	if _, err := manager.Check(context.Background(), "ws", "v"); KindOf(err) != KindUntrusted {
		t.Fatalf("check err = %v", err)
	}
	if fake.requests.Load() != 0 {
		t.Fatalf("an untrusted provider received %d requests", fake.requests.Load())
	}
}

func TestConcurrentFetchesShareOneRequest(t *testing.T) {
	var hits atomic.Int32
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		<-release
		_, _ = w.Write([]byte(`{"data":{"data":{"password":"p"},"metadata":{"version":1}}}`))
	}))
	defer server.Close()
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "v", "type": "vault", "address": server.URL})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, testEnv(map[string]string{"VAULT_TOKEN": "t"}, c))
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if value, err := manager.Value(context.Background(), "ws", Ref{Provider: "v", Path: "secret/data/app", Field: "password"}); err != nil || value != "p" {
				t.Errorf("Value = %q, %v", value, err)
			}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if hits.Load() != 1 {
		t.Fatalf("hits = %d, want 1", hits.Load())
	}
}

func TestEnvProvider(t *testing.T) {
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "ci", "type": "env"})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, testEnv(map[string]string{"KURLO_CI_TOKEN": "ci-token"}, c))
	if value, err := manager.Value(context.Background(), "ws", Ref{Provider: "ci", Path: "KURLO_CI_TOKEN"}); err != nil || value != "ci-token" {
		t.Fatalf("Value = %q, %v", value, err)
	}
	if _, err := manager.Value(context.Background(), "ws", Ref{Provider: "ci", Path: "MISSING"}); KindOf(err) != KindNotFound {
		t.Fatalf("missing = %v", err)
	}
}

func TestMarkerMatchesTheFrontendEncoding(t *testing.T) {
	cases := map[string]Ref{
		"{{kurloRef:eyJwIjoidmF1bHQtcHJvZCIsInBhdGgiOiJzZWNyZXQvZGF0YS9hcHAiLCJmIjoicGFzc3dvcmQifQ}}":                      {Provider: "vault-prod", Path: "secret/data/app", Field: "password"},
		"{{kurloRef:eyJwIjoib3AiLCJwYXRoIjoib3A6Ly9QYXltZW50cy9TdHJpcGUvYXBpIGtleSIsImYiOiJjcsOpZGVudGlhbCIsInYiOiIzIn0}}": {Provider: "op", Path: "op://Payments/Stripe/api key", Field: "crédential", Version: "3"},
	}
	for marker, ref := range cases {
		if got := Marker(ref); got != marker {
			t.Errorf("Marker(%+v) = %s, want %s", ref, got, marker)
		}
		if decoded, err := DecodeMarker(marker); err != nil || decoded != ref {
			t.Errorf("DecodeMarker(%s) = %+v, %v", marker, decoded, err)
		}
	}
}

func TestGCPADCPathHonorsCloudSDKConfigOnEveryOS(t *testing.T) {
	c := &clock{now: time.Now()}
	for _, goos := range []string{"windows", "linux", "darwin"} {
		env := testEnv(map[string]string{"CLOUDSDK_CONFIG": filepath.Join("cfg", "gcloud"), "APPDATA": filepath.Join("roaming")}, c)
		if got, want := gcpADCPath(goos, env), filepath.Join("cfg", "gcloud", "application_default_credentials.json"); got != want {
			t.Fatalf("%s: got %q, want %q", goos, got, want)
		}
	}
	env := testEnv(map[string]string{"APPDATA": "roaming"}, c)
	if got, want := gcpADCPath("windows", env), filepath.Join("roaming", "gcloud", "application_default_credentials.json"); got != want {
		t.Fatalf("windows without CLOUDSDK_CONFIG: got %q, want %q", got, want)
	}
	if got := gcpADCPath("windows", testEnv(nil, c)); got != "" {
		t.Fatalf("windows without APPDATA: got %q", got)
	}
	if got, want := gcpADCPath("linux", testEnv(nil, c)), filepath.Join("/nonexistent-home", ".config", "gcloud", "application_default_credentials.json"); got != want {
		t.Fatalf("linux: got %q, want %q", got, want)
	}
}

func TestExpandHomeAcceptsBothSeparators(t *testing.T) {
	env := testEnv(nil, &clock{now: time.Now()})
	for _, input := range []string{"~/certs/ca.pem", `~\certs\ca.pem`} {
		got, err := expandHome(input, env)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(got, filepath.Clean("/nonexistent-home")) || strings.HasPrefix(got, "~") {
			t.Fatalf("%q expanded to %q", input, got)
		}
	}
	for _, input := range []string{"~user/ca.pem", "/etc/ca.pem", `C:\certs\ca.pem`} {
		if got, _ := expandHome(input, env); got != input {
			t.Fatalf("%q changed to %q", input, got)
		}
	}
}

func TestWindowsToolCandidatesCoverDefaultInstallFolders(t *testing.T) {
	env := map[string]string{"ProgramFiles": `C:\Program Files`, "ProgramFiles(x86)": `C:\Program Files (x86)`, "LOCALAPPDATA": `C:\Users\me\AppData\Local`}
	getenv := func(key string) string { return env[key] }
	want := map[string]string{
		"op":     filepath.Join(`C:\Program Files`, "1Password CLI", "op.exe"),
		"aws":    filepath.Join(`C:\Program Files`, "Amazon", "AWSCLIV2", "aws.exe"),
		"az":     filepath.Join(`C:\Program Files (x86)`, "Microsoft SDKs", "Azure", "CLI2", "wbin", "az.cmd"),
		"gcloud": filepath.Join(`C:\Users\me\AppData\Local`, "Google", "Cloud SDK", "google-cloud-sdk", "bin", "gcloud.cmd"),
		"bws":    filepath.Join(`C:\Users\me\AppData\Local`, "Microsoft", "WinGet", "Links", "bws.exe"),
	}
	for name, path := range want {
		found := false
		for _, candidate := range toolCandidatesFor("windows", getenv, name) {
			found = found || candidate == path
		}
		if !found {
			t.Fatalf("%s: %q is not among %q", name, path, toolCandidatesFor("windows", getenv, name))
		}
	}
	if got := toolCandidatesFor("windows", func(string) string { return "" }, "op"); len(got) != 0 {
		t.Fatalf("no install folders should give no candidates, got %q", got)
	}
	if got := toolCandidatesFor("linux", getenv, "op"); got[0] != "/opt/homebrew/bin/op" {
		t.Fatalf("linux candidates changed: %q", got)
	}
}

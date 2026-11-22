package secrets

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeTool struct {
	mu    sync.Mutex
	calls [][]string
	envs  [][]string
	reply func(args []string) ([]byte, []byte, error)
}

func (f *fakeTool) env(vars map[string]string, files map[string]string, c *clock, tools ...string) Environment {
	return Environment{
		Getenv:  func(key string) (string, bool) { value, ok := vars[key]; return value, ok },
		HomeDir: func() (string, error) { return "/home/test", nil },
		ReadFile: func(path string) ([]byte, error) {
			if data, ok := files[path]; ok {
				return []byte(data), nil
			}
			return nil, os.ErrNotExist
		},
		Now: c.Now,
		LookPath: func(name string) (string, error) {
			for _, tool := range tools {
				if tool == name {
					return "/usr/local/bin/" + name, nil
				}
			}
			return "", errors.New("not found")
		},
		Run: func(_ context.Context, path string, args []string, env []string) ([]byte, []byte, error) {
			f.mu.Lock()
			f.calls = append(f.calls, append([]string{path}, args...))
			f.envs = append(f.envs, env)
			f.mu.Unlock()
			return f.reply(args)
		},
	}
}

func TestOnePasswordReadsFieldsAndItems(t *testing.T) {
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	tool := &fakeTool{reply: func(args []string) ([]byte, []byte, error) {
		switch {
		case contains(args, "read") && contains(args, "op://Payments/Stripe/credential"):
			return []byte("sk_live_123"), nil, nil
		case contains(args, "read"):
			return nil, []byte(`[ERROR] 2026/11/21 could not read secret: "Gone" isn't an item in the "Payments" vault`), errors.New("exit 1")
		case contains(args, "item"):
			return []byte(`{"fields":[{"id":"username","label":"username","value":"svc"},{"id":"password","label":"password","value":"pw","section":{"id":"login","label":"Login"}},{"id":"notes","label":"notesPlain"}]}`), nil, nil
		case contains(args, "whoami"):
			return []byte(`{"url":"my.1password.com","email":"dev@example.test"}`), nil, nil
		}
		return nil, nil, errors.New("unexpected")
	}}
	config := mustProvider(t, map[string]any{"id": "op", "type": "1password", "account": "my.1password.com"})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}, credentials: map[string]string{"op.token": "ops_service"}}, tool.env(nil, nil, c, "op"))
	ctx := context.Background()

	if value, err := manager.Value(ctx, "ws", Ref{Provider: "op", Path: "op://Payments/Stripe/credential"}); err != nil || value != "sk_live_123" {
		t.Fatalf("read = %q, %v", value, err)
	}
	if value, err := manager.Value(ctx, "ws", Ref{Provider: "op", Path: "op://Infra/Postgres", Field: "password"}); err != nil || value != "pw" {
		t.Fatalf("item field = %q, %v", value, err)
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "op", Path: "op://Infra/Postgres"}); KindOf(err) != KindInvalidRef || !strings.Contains(err.Error(), "password, username") {
		t.Fatalf("item without field = %v", err)
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "op", Path: "op://Payments/Gone/credential"}); KindOf(err) != KindNotFound || strings.Contains(err.Error(), "[ERROR]") {
		t.Fatalf("missing item = %v", err)
	}
	if _, err := manager.Value(ctx, "ws", Ref{Provider: "op", Path: "Payments"}); KindOf(err) != KindInvalidRef {
		t.Fatalf("short path = %v", err)
	}
	status, err := manager.Check(ctx, "ws", "op")
	if err != nil || status.Detail != "Signed in as dev@example.test on my.1password.com" {
		t.Fatalf("Check = %+v, %v", status, err)
	}
	for i, call := range tool.calls {
		if call[1] != "--account" || call[2] != "my.1password.com" {
			t.Errorf("call %d does not pass the account: %v", i, call)
		}
		if len(tool.envs[i]) != 1 || tool.envs[i][0] != "OP_SERVICE_ACCOUNT_TOKEN=ops_service" {
			t.Errorf("call %d env = %v", i, tool.envs[i])
		}
	}
}

func TestOnePasswordSectionFields(t *testing.T) {
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	tool := &fakeTool{reply: func(args []string) ([]byte, []byte, error) {
		if contains(args, "item") {
			return []byte(`{"fields":[{"id":"password","label":"password","value":"first-value","section":{"id":"s1","label":"First"}},{"id":"password","label":"password","value":"second-value","section":{"id":"s2","label":"Second"}}]}`), nil, nil
		}
		return nil, nil, errors.New("unexpected")
	}}
	config := mustProvider(t, map[string]any{"id": "op", "type": "1password"})
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, tool.env(nil, nil, c, "op"))
	ctx := context.Background()
	entries, err := manager.List(ctx, "ws", "op", "op://Vault/Database/")
	if err != nil || len(entries) != 2 {
		t.Fatalf("entries = %+v, %v", entries, err)
	}
	want := map[string]string{"First/password": "first-value", "Second/password": "second-value"}
	for _, entry := range entries {
		if entry.Path != "op://Vault/Database" || want[entry.Field] == "" {
			t.Errorf("entry = %+v", entry)
			continue
		}
		value, err := manager.Value(ctx, "ws", Ref{Provider: "op", Path: entry.Path, Field: entry.Field})
		if err != nil || value != want[entry.Field] {
			t.Errorf("%s = %q, %v; want %q", entry.Field, value, err, want[entry.Field])
		}
		delete(want, entry.Field)
	}
	if len(want) != 0 {
		t.Errorf("missing fields: %v", want)
	}
}

func TestOnePasswordErrors(t *testing.T) {
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "op", "type": "1password"})
	missing := NewManager(&fakeSource{configs: []ProviderConfig{config}}, (&fakeTool{}).env(nil, nil, c))
	if _, err := missing.Value(context.Background(), "ws", Ref{Provider: "op", Path: "op://a/b/c"}); KindOf(err) != KindToolMissing {
		t.Fatalf("no op = %v", err)
	}
	locked := &fakeTool{reply: func([]string) ([]byte, []byte, error) {
		return nil, []byte("[ERROR] 2026/11/21 You are not currently signed in. Please run `op signin --help` for instructions"), errors.New("exit 1")
	}}
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, locked.env(nil, nil, c, "op"))
	if _, err := manager.Value(context.Background(), "ws", Ref{Provider: "op", Path: "op://a/b/c"}); KindOf(err) != KindNotAuthenticated {
		t.Fatalf("signed out = %v", err)
	}
	if len(locked.envs[0]) != 0 {
		t.Fatalf("a service account token was passed without one being saved: %v", locked.envs[0])
	}
}

type fakeAWS struct {
	mu       sync.Mutex
	targets  []string
	auth     []string
	tokens   []string
	requests []map[string]any
}

func (f *fakeAWS) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		target := r.Header.Get("X-Amz-Target")
		f.mu.Lock()
		f.targets = append(f.targets, target)
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		f.tokens = append(f.tokens, r.Header.Get("X-Amz-Security-Token"))
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/x-amz-json-1.1")
		if !strings.Contains(r.Header.Get("Authorization"), "Credential=AKIDEXAMPLE/") {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"__type":"UnrecognizedClientException","message":"The security token included in the request is invalid."}`))
			return
		}
		var request map[string]any
		_ = json.Unmarshal(body, &request)
		f.mu.Lock()
		f.requests = append(f.requests, request)
		f.mu.Unlock()
		switch target {
		case "secretsmanager.GetSecretValue":
			switch request["SecretId"] {
			case "prod/db":
				if request["VersionStage"] == "AWSPREVIOUS" {
					_, _ = w.Write([]byte(`{"SecretString":"{\"password\":\"old\"}"}`))
					return
				}
				_, _ = w.Write([]byte(`{"Name":"prod/db","SecretString":"{\"username\":\"app\",\"password\":\"s3cr3t\"}"}`))
			case "prod/cert":
				_, _ = w.Write([]byte(`{"SecretBinary":"YmluYXJ5LXZhbHVl"}`))
			case "prod/denied":
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"__type":"com.amazon.coral.service#AccessDeniedException","Message":"User is not authorized to perform secretsmanager:GetSecretValue"}`))
			default:
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"__type":"ResourceNotFoundException","message":"Secrets Manager can't find the specified secret."}`))
			}
		case "AmazonSSM.GetParameter":
			if request["Name"] == "/prod/api-key:3" && request["WithDecryption"] == true {
				_, _ = w.Write([]byte(`{"Parameter":{"Name":"/prod/api-key","Value":"ssm-v3"}}`))
				return
			}
			if request["Name"] == "/prod/api-key" {
				_, _ = w.Write([]byte(`{"Parameter":{"Name":"/prod/api-key","Value":"ssm-latest"}}`))
				return
			}
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"__type":"ParameterNotFound"}`))
		case "":
			if string(body) != "Action=GetCallerIdentity&Version=2011-06-15" {
				t.Errorf("sts body = %s", body)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"GetCallerIdentityResponse":{"GetCallerIdentityResult":{"Arn":"arn:aws:iam::123456789012:user/dev"}}}`))
		}
	})
}

func TestAWSVersionStageAndVersionID(t *testing.T) {
	var mu sync.Mutex
	var requests []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		_ = json.NewDecoder(r.Body).Decode(&request)
		mu.Lock()
		requests = append(requests, request)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/x-amz-json-1.1")
		if request["VersionId"] == "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"__type":"ResourceNotFoundException","message":"version missing"}`))
			return
		}
		_, _ = w.Write([]byte(`{"SecretString":"value"}`))
	}))
	defer server.Close()
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	config := mustProvider(t, map[string]any{"id": "aws", "type": "aws-secrets-manager", "region": "eu-central-1", "endpoint": server.URL})
	env := (&fakeTool{}).env(map[string]string{"AWS_ACCESS_KEY_ID": "AKIDEXAMPLE", "AWS_SECRET_ACCESS_KEY": "secret"}, nil, c)
	manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, env)
	versions := []string{"blue-green", "123e4567-e89b-12d3-a456-426614174000", "abcdefghijklmnopqrstuvwx12345678", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}
	for _, version := range versions {
		if _, err := manager.Value(context.Background(), "ws", Ref{Provider: "aws", Path: "prod/db", Version: version}); err != nil {
			t.Fatalf("version %q: %v", version, err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 5 {
		t.Fatalf("requests = %+v", requests)
	}
	if requests[0]["VersionStage"] != "blue-green" || requests[0]["VersionId"] != nil {
		t.Errorf("stage request = %+v", requests[0])
	}
	for _, index := range []int{1, 2} {
		if requests[index]["VersionId"] != versions[index] || requests[index]["VersionStage"] != nil {
			t.Errorf("ID request = %+v", requests[index])
		}
	}
	if requests[3]["VersionId"] != versions[3] || requests[4]["VersionStage"] != versions[3] {
		t.Errorf("ambiguous selector retry = %+v %+v", requests[3], requests[4])
	}
}

func TestAWSSecretsManagerAndParameterStore(t *testing.T) {
	fake := &fakeAWS{}
	server := httptest.NewServer(fake.handler(t))
	defer server.Close()
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	sm := mustProvider(t, map[string]any{"id": "aws-dev", "type": "aws-secrets-manager", "region": "eu-central-1", "endpoint": server.URL})
	ssm := mustProvider(t, map[string]any{"id": "params", "type": "aws-ssm", "region": "eu-central-1", "endpoint": server.URL})
	env := (&fakeTool{}).env(map[string]string{"AWS_ACCESS_KEY_ID": "AKIDEXAMPLE", "AWS_SECRET_ACCESS_KEY": "secret", "AWS_SESSION_TOKEN": "session"}, nil, c)
	manager := NewManager(&fakeSource{configs: []ProviderConfig{sm, ssm}}, env)
	ctx := context.Background()

	values, err := manager.Resolve(ctx, "ws", []Ref{
		{Provider: "aws-dev", Path: "prod/db", Field: "password"},
		{Provider: "aws-dev", Path: "prod/db", Field: "username"},
		{Provider: "aws-dev", Path: "prod/db", Field: "password", Version: "AWSPREVIOUS"},
		{Provider: "aws-dev", Path: "prod/cert"},
		{Provider: "params", Path: "/prod/api-key"},
		{Provider: "params", Path: "/prod/api-key", Version: "3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"aws-dev:prod/db#password": "s3cr3t", "aws-dev:prod/db#username": "app", "aws-dev:prod/db#password@AWSPREVIOUS": "old", "aws-dev:prod/cert": "binary-value", "params:/prod/api-key": "ssm-latest", "params:/prod/api-key@3": "ssm-v3"}
	for ref, value := range values {
		if want[ref.String()] != value {
			t.Errorf("%s = %q, want %q", ref, value, want[ref.String()])
		}
	}
	for i, header := range fake.auth {
		if !strings.HasPrefix(header, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/") || fake.tokens[i] != "session" {
			t.Errorf("request %d auth = %q token = %q", i, header, fake.tokens[i])
		}
	}
	if !strings.Contains(strings.Join(fake.auth, " "), "/eu-central-1/secretsmanager/aws4_request") || !strings.Contains(strings.Join(fake.auth, " "), "/eu-central-1/ssm/aws4_request") {
		t.Errorf("service scopes = %v", fake.auth)
	}
	cases := map[string]Kind{"prod/denied": KindForbidden, "prod/missing": KindNotFound}
	for path, kind := range cases {
		if _, err := manager.Value(ctx, "ws", Ref{Provider: "aws-dev", Path: path}); KindOf(err) != kind {
			t.Errorf("%s = %v, want %s", path, err, kind)
		}
	}
	status, err := manager.Check(ctx, "ws", "aws-dev")
	if err != nil || !strings.Contains(status.Detail, "arn:aws:iam::123456789012:user/dev") || !strings.Contains(status.Detail, "AWS_ACCESS_KEY_ID") {
		t.Fatalf("Check = %+v, %v", status, err)
	}
}

func TestAWSCredentialChain(t *testing.T) {
	fake := &fakeAWS{}
	server := httptest.NewServer(fake.handler(t))
	defer server.Close()
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	ctx := context.Background()
	ref := Ref{Provider: "aws", Path: "prod/db", Field: "password"}

	profile := mustProvider(t, map[string]any{"id": "aws", "type": "aws-secrets-manager", "region": "eu-central-1", "endpoint": server.URL, "profile": "dev"})
	files := map[string]string{filepath.Join("/home/test", ".aws", "credentials"): "[default]\naws_access_key_id = WRONG\naws_secret_access_key = x\n\n[dev]\naws_access_key_id = AKIDEXAMPLE\naws_secret_access_key = secret\n"}
	fromFile := NewManager(&fakeSource{configs: []ProviderConfig{profile}}, (&fakeTool{}).env(map[string]string{"AWS_ACCESS_KEY_ID": "WRONG", "AWS_SECRET_ACCESS_KEY": "x"}, files, c))
	if value, err := fromFile.Value(ctx, "ws", ref); err != nil || value != "s3cr3t" {
		t.Fatalf("a configured profile must win over AWS_ACCESS_KEY_ID: %q, %v", value, err)
	}

	sso := mustProvider(t, map[string]any{"id": "aws", "type": "aws-secrets-manager", "region": "eu-central-1", "endpoint": server.URL, "profile": "sso-dev"})
	cli := &fakeTool{reply: func(args []string) ([]byte, []byte, error) {
		if strings.Join(args, " ") != "configure export-credentials --format process --profile sso-dev" {
			return nil, []byte("bad args"), errors.New("exit 2")
		}
		return []byte(`{"Version":1,"AccessKeyId":"AKIDEXAMPLE","SecretAccessKey":"secret","SessionToken":"sso-token","Expiration":"2027-01-15T08:00:00Z"}`), nil, nil
	}}
	fromCLI := NewManager(&fakeSource{configs: []ProviderConfig{sso}}, cli.env(nil, nil, c, "aws"))
	if value, err := fromCLI.Value(ctx, "ws", ref); err != nil || value != "s3cr3t" {
		t.Fatalf("SSO via the AWS CLI: %q, %v", value, err)
	}
	if fake.tokens[len(fake.tokens)-1] != "sso-token" {
		t.Fatalf("session token = %q", fake.tokens[len(fake.tokens)-1])
	}

	expired := &fakeTool{reply: func([]string) ([]byte, []byte, error) {
		return nil, []byte("Error when retrieving token from sso: Token has expired and refresh failed"), errors.New("exit 255")
	}}
	ssoExpired := NewManager(&fakeSource{configs: []ProviderConfig{sso}}, expired.env(nil, nil, c, "aws"))
	if _, err := ssoExpired.Value(ctx, "ws", ref); KindOf(err) != KindNotAuthenticated || !strings.Contains(err.Error(), "Token has expired") {
		t.Fatalf("expired SSO = %v", err)
	}
	nothing := NewManager(&fakeSource{configs: []ProviderConfig{sso}}, (&fakeTool{}).env(nil, nil, c))
	if _, err := nothing.Value(ctx, "ws", ref); KindOf(err) != KindNotAuthenticated {
		t.Fatalf("no credentials = %v", err)
	}
	wrongKeys := NewManager(&fakeSource{configs: []ProviderConfig{mustProvider(t, map[string]any{"id": "aws", "type": "aws-secrets-manager", "region": "eu-central-1", "endpoint": server.URL})}}, (&fakeTool{}).env(map[string]string{"AWS_ACCESS_KEY_ID": "WRONG", "AWS_SECRET_ACCESS_KEY": "x"}, nil, c))
	if _, err := wrongKeys.Value(ctx, "ws", ref); KindOf(err) != KindNotAuthenticated {
		t.Fatalf("rejected keys = %v", err)
	}
	saved := NewManager(&fakeSource{configs: []ProviderConfig{profile}, credentials: map[string]string{"aws.accessKeyId": "AKIDEXAMPLE", "aws.secretAccessKey": "secret"}}, (&fakeTool{}).env(nil, nil, c))
	if value, err := saved.Value(ctx, "ws", ref); err != nil || value != "s3cr3t" {
		t.Fatalf("keys saved on the device: %q, %v", value, err)
	}
}

func TestAWSConfigValidation(t *testing.T) {
	for _, raw := range []map[string]any{
		{"id": "a", "type": "aws-ssm"},
		{"id": "a", "type": "aws-ssm", "region": "Frankfurt"},
		{"id": "a", "type": "aws-ssm", "region": "eu-central-1", "endpoint": "localstack:4566"},
	} {
		if _, err := ParseProvider(raw); err == nil {
			t.Errorf("accepted %v", raw)
		}
	}
	a := mustProvider(t, map[string]any{"id": "a", "type": "aws-ssm", "region": "eu-central-1"})
	b := mustProvider(t, map[string]any{"id": "a", "type": "aws-ssm", "region": "eu-central-1", "profile": "prod"})
	if a.Hash() == b.Hash() {
		t.Fatal("a new profile must ask for trust again")
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

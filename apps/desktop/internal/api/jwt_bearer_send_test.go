package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	authpkg "github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func verifiedHS256Claims(t *testing.T, token, secret string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %q", token)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(mac.Sum(nil), signature) {
		t.Fatalf("signature of %q does not verify with the secret", token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	claims := map[string]any{}
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}

func TestSendRequestSignsJWTBearerInHeaderAndQuery(t *testing.T) {
	var mu sync.Mutex
	var got *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = r
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	send := func(auth model.AuthConfig) model.HttpResponse {
		return NewApp().SendRequest(model.HttpRequest{
			Method:                http.MethodGet,
			URL:                   server.URL + "/items?page=2",
			Auth:                  auth,
			FollowRedirects:       true,
			TimeoutMs:             5000,
			HTTPVersion:           "auto",
			EnableSSLVerification: true,
			MaxRedirects:          10,
		})
	}

	if resp := send(model.AuthConfig{Type: "jwt", JWTSecret: "k", JWTPayload: `{"sub":"42"}`, JWTExpiresIn: "60"}); resp.Error != "" {
		t.Fatalf("header: %s", resp.Error)
	}
	header := got.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		t.Fatalf("Authorization = %q", header)
	}
	claims := verifiedHS256Claims(t, strings.TrimPrefix(header, "Bearer "), "k")
	if claims["sub"] != "42" || claims["exp"] == nil {
		t.Fatalf("claims = %v", claims)
	}

	if resp := send(model.AuthConfig{Type: "jwt", JWTSecret: "k", JWTAddTo: "query", JWTQueryParam: "jwt"}); resp.Error != "" {
		t.Fatalf("query: %s", resp.Error)
	}
	if got.URL.Query().Get("page") != "2" || got.Header.Get("Authorization") != "" {
		t.Fatalf("query = %q, header = %q", got.URL.RawQuery, got.Header.Get("Authorization"))
	}
	verifiedHS256Claims(t, got.URL.Query().Get("jwt"), "k")

	resp := send(model.AuthConfig{Type: "jwt", JWTSecret: "k", JWTPayload: `{"sub":`})
	if !strings.Contains(resp.Error, "auth error") || !strings.Contains(resp.Error, "payload is not valid JSON") {
		t.Fatalf("a broken payload must stop the send with a clear error, got %q", resp.Error)
	}
}

func TestPreviewJWTBearer(t *testing.T) {
	preview := NewApp().PreviewJWTBearer(model.AuthConfig{Type: "jwt", JWTSecret: "k", JWTPayload: `{"role":"admin"}`})
	if preview.Error != "" {
		t.Fatal(preview.Error)
	}
	if claims := verifiedHS256Claims(t, preview.Token, "k"); claims["role"] != "admin" {
		t.Fatalf("claims = %v", claims)
	}
	if bad := NewApp().PreviewJWTBearer(model.AuthConfig{Type: "jwt"}); bad.Token != "" || !strings.Contains(bad.Error, "secret") {
		t.Fatalf("preview = %+v", bad)
	}
}

func TestJWTBearerSurvivesWorkspaceRoundTripWithoutDefaults(t *testing.T) {
	root := t.TempDir()
	workspaces := []map[string]any{{"id": "w1", "name": "WS"}}
	collections := []map[string]any{{"id": "c1", "workspaceId": "w1", "name": "Col"}}
	requests := []map[string]any{
		{
			"id": "r1", "workspaceId": "w1", "collectionId": "c1", "name": "Signed",
			"method": "GET", "url": "https://example.com",
			"auth": map[string]any{
				"type": "jwt", "jwtAlgorithm": "RS256", "jwtPrivateKey": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
				"jwtSecret": "", "jwtSecretBase64": false, "jwtPayload": `{"sub":"{{userId}}"}`, "jwtHeaders": "",
				"jwtExpiresIn": "300", "jwtAddTo": "query", "jwtHeaderPrefix": "Bearer", "jwtQueryParam": "token",
				"bearerToken": "stale",
			},
		},
		{
			"id": "r2", "workspaceId": "w1", "collectionId": "c1", "name": "Blank",
			"method": "GET", "url": "https://example.com",
			"auth": map[string]any{
				"type": "jwt", "jwtAlgorithm": "HS256", "jwtSecretBase64": false, "jwtAddTo": "header",
				"jwtHeaderPrefix": "Bearer", "jwtQueryParam": "token", "jwtSecret": "",
			},
		},
	}

	secrets := map[string]string{}
	sanitized := sanitizeRequestsForFilesystem(requests, map[string]string{}, secrets)
	if err := writeYAMLWorkspaceStore(root, workspaces, collections, sanitized, nil, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	var yamlText strings.Builder
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && strings.HasSuffix(path, ".yml") {
			data, _ := os.ReadFile(path)
			yamlText.Write(data)
		}
		return nil
	})
	text := yamlText.String()
	for _, absent := range []string{"BEGIN PRIVATE KEY", "jwtHeaderPrefix", "jwtQueryParam", "jwtSecretBase64", "bearerToken", "stale", "HS256"} {
		if strings.Contains(text, absent) {
			t.Errorf("workspace YAML should not contain %q:\n%s", absent, text)
		}
	}

	_, _, loaded, _, _, _, err := loadYAMLWorkspaceStoreWithDiagnostics(root, secrets)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	byID := map[string]map[string]any{}
	for _, request := range loaded {
		byID[stringValue(request, "id")] = request
	}
	signed, _ := byID["r1"]["auth"].(map[string]any)
	if signed["type"] != "jwt" || signed["jwtAlgorithm"] != "RS256" || signed["jwtAddTo"] != "query" ||
		signed["jwtExpiresIn"] != "300" || signed["jwtPayload"] != `{"sub":"{{userId}}"}` ||
		!strings.Contains(stringValue(signed, "jwtPrivateKey"), "BEGIN PRIVATE KEY") {
		t.Fatalf("signed auth = %v", signed)
	}
	blank, _ := byID["r2"]["auth"].(map[string]any)
	if blank["type"] != "jwt" {
		t.Fatalf("a JWT request with only defaults must keep its auth type, got %v", byID["r2"]["auth"])
	}
}

func TestBuildHTTPRequestCarriesJWTSettingsWithoutStaleBearer(t *testing.T) {
	req := cliSavedRequest{Method: "GET", URL: "https://api.example.test", RequestType: "http"}
	req.Auth.Type = "jwt"
	req.Auth.BearerToken = "stale"
	req.Auth.JWTAlgorithm = "HS512"
	req.Auth.JWTSecret = "{{jwtKey}}"
	req.Auth.JWTSecretBase64 = true
	req.Auth.JWTPayload = `{"v":"{{apiVersion}}"}`
	req.Auth.JWTHeaders = `{"kid":"1"}`
	req.Auth.JWTExpiresIn = "30"
	req.Auth.JWTAddTo = "query"
	req.Auth.JWTHeaderPrefix = "JWT"
	req.Auth.JWTQueryParam = "t"
	auth := buildHTTPRequest(req, map[string]string{}, nil, 0).Auth
	if auth.Token != "" || auth.JWTAlgorithm != "HS512" || auth.JWTSecret != "{{jwtKey}}" || !auth.JWTSecretBase64 ||
		auth.JWTPayload != `{"v":"{{apiVersion}}"}` || auth.JWTHeaders != `{"kid":"1"}` || auth.JWTExpiresIn != "30" ||
		auth.JWTAddTo != "query" || auth.JWTHeaderPrefix != "JWT" || auth.JWTQueryParam != "t" {
		t.Fatalf("jwt settings were not carried over: %+v", auth)
	}
	resolved := resolveAuthTemplates(auth, map[string]string{"jwtKey": "a2V5", "apiVersion": "v9"})
	if resolved.JWTSecret != "a2V5" || resolved.JWTPayload != `{"v":"v9"}` {
		t.Fatalf("templates were not resolved: %+v", resolved)
	}
}

func TestCLIRunSignsJWTBearerAndMasksTheSecret(t *testing.T) {
	var mu sync.Mutex
	var tokens []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		tokens = append(tokens, r.Header.Get("Authorization"))
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	root := writeYAMLWorkspace(t, server.URL)
	path := filepath.Join(root, "workspaces", "Demo", "collections", "Smoke", "requests", "GET-1-ok.yml")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	jwtAuth := strings.Join([]string{
		"  auth:",
		"    type: jwt",
		"    jwtSecret: super-secret-signing-key",
		"    jwtPayload: '{\"api\":\"{{apiVersion}}\"}'",
		"    jwtHeaderPrefix: JWT",
	}, "\n")
	updated := strings.Replace(string(data), "  auth:\n    type: none", jwtAuth, 1)
	if updated == string(data) {
		t.Fatal("could not set JWT auth on the request")
	}
	if err := os.WriteFile(path, []byte(updated), 0o644); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, env: "Local", reporters: []string{"json"}, iterations: 1, stdout: &out, stderr: &out})
	if code != 0 {
		t.Fatalf("exit %d:\n%s", code, out.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(tokens) == 0 || !strings.HasPrefix(tokens[0], "JWT ") {
		t.Fatalf("tokens = %v", tokens)
	}
	if claims := verifiedHS256Claims(t, strings.TrimPrefix(tokens[0], "JWT "), "super-secret-signing-key"); claims["api"] != "v1" {
		t.Fatalf("claims = %v", claims)
	}
	if strings.Contains(out.String(), "super-secret-signing-key") {
		t.Fatalf("the signing secret leaked into the CLI output:\n%s", out.String())
	}
}

func TestGrpcMetadataHeadersCarrySignedJWT(t *testing.T) {
	req := model.GrpcRequest{Auth: model.AuthConfig{Type: "jwt", JWTSecret: "k", JWTHeaderPrefix: "JWT"}}
	if headers := grpcMetadataHeaders(req); len(headers) != 0 {
		t.Fatalf("unsigned JWT config must not add metadata, got %v", headers)
	}
	if err := authpkg.PrepareJWTBearer(&req.Auth); err != nil {
		t.Fatal(err)
	}
	headers := grpcMetadataHeaders(req)
	if len(headers) != 1 || !strings.HasPrefix(headers[0], "authorization: JWT ") {
		t.Fatalf("headers = %v", headers)
	}
	verifiedHS256Claims(t, strings.TrimPrefix(headers[0], "authorization: JWT "), "k")
}

func TestImportAuthMapsPostmanJWTBearer(t *testing.T) {
	out := importAuth("jwt", map[string]any{
		"algorithm": "rs256", "privateKey": "{{key}}", "payload": `{"sub":"1"}`, "header": `{"kid":"a"}`,
		"addTokenTo": "queryParam", "queryParamKey": "access_token", "headerPrefix": "Bearer", "isSecretBase64Encoded": true,
	})
	want := map[string]any{
		"type": "jwt", "jwtAlgorithm": "RS256", "jwtPrivateKey": "{{key}}", "jwtPayload": `{"sub":"1"}`, "jwtHeaders": `{"kid":"a"}`,
		"jwtAddTo": "query", "jwtQueryParam": "access_token", "jwtHeaderPrefix": "Bearer", "jwtSecretBase64": true,
	}
	for key, value := range want {
		if out[key] != value {
			t.Errorf("%s = %v, want %v", key, out[key], value)
		}
	}
}

func TestMCPCodeSnippetUsesJWTPlaceholder(t *testing.T) {
	header, warnings, err := buildMCPCodeSnippet("curl", model.HttpRequest{Method: "GET", URL: "https://api.example.test/items", Auth: model.AuthConfig{Type: "jwt", JWTSecret: "real-secret", JWTHeaderPrefix: "JWT"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(header, "Authorization: JWT {{jwtToken}}") || strings.Contains(header, "real-secret") {
		t.Fatalf("snippet = %s", header)
	}
	if !strings.Contains(strings.Join(warnings, "\n"), "signs the JWT on every send") {
		t.Fatalf("warnings = %v", warnings)
	}
	query, _, err := buildMCPCodeSnippet("curl", model.HttpRequest{Method: "GET", URL: "https://api.example.test/items", Auth: model.AuthConfig{Type: "jwt", JWTSecret: "k", JWTAddTo: "query", JWTQueryParam: "jwt"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(query, "jwt={{jwtToken}}") || strings.Contains(query, "Authorization") {
		t.Fatalf("snippet = %s", query)
	}
}

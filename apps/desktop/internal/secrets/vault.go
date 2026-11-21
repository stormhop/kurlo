package secrets

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const maxVaultResponseBytes = 1 << 20

type vaultProvider struct {
	config      ProviderConfig
	credentials Credentials
	env         Environment
	client      *http.Client

	mu          sync.Mutex
	loginMu     sync.Mutex
	loginToken  string
	loginExpiry time.Time
}

type vaultResponse struct {
	Data          map[string]any `json:"data"`
	LeaseDuration int64          `json:"lease_duration"`
	Auth          *struct {
		ClientToken   string `json:"client_token"`
		LeaseDuration int64  `json:"lease_duration"`
	} `json:"auth"`
	Errors []string `json:"errors"`
}

func newVaultProvider(config ProviderConfig, credentials Credentials, env Environment) (*vaultProvider, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if config.SkipTLSVerify {
		tlsConfig.InsecureSkipVerify = true
	}
	if config.CACert != "" {
		path, err := expandHome(config.CACert, env)
		if err != nil {
			return nil, newError(KindUnavailable, config.ID, "cannot read CA certificate: %v", err)
		}
		pem, err := env.ReadFile(path)
		if err != nil {
			return nil, newError(KindUnavailable, config.ID, "cannot read CA certificate: %v", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, newError(KindUnavailable, config.ID, "CA certificate %s has no PEM certificates", config.CACert)
		}
		tlsConfig.RootCAs = pool
	}
	transport.TLSClientConfig = tlsConfig
	transport.Proxy = http.ProxyFromEnvironment
	return &vaultProvider{
		config:      config,
		credentials: credentials,
		env:         env,
		client:      &http.Client{Transport: transport, Timeout: config.Timeout},
	}, nil
}

func expandHome(path string, env Environment) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := env.HomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, strings.TrimPrefix(path, "~")), nil
	}
	return path, nil
}

func (p *vaultProvider) Fetch(ctx context.Context, path, version string) (Secret, error) {
	path = strings.Trim(strings.TrimSpace(path), "/")
	if path == "" {
		return Secret{}, newError(KindInvalidRef, p.config.ID, "path is empty")
	}
	query := url.Values{}
	if version != "" && version != "latest" {
		query.Set("version", version)
	}
	token, err := p.token(ctx)
	if err != nil {
		return Secret{}, err
	}
	body, status, err := p.do(ctx, http.MethodGet, path, query, nil, token)
	if err != nil {
		return Secret{}, err
	}
	if status == http.StatusForbidden && p.config.Auth.Method != "token" {
		p.forgetLogin()
	}
	if err := p.statusError(status, body, path); err != nil {
		return Secret{}, err
	}
	var decoded vaultResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return Secret{}, newError(KindUnavailable, p.config.ID, "unexpected answer for %s", path)
	}
	if decoded.Data == nil {
		return Secret{}, newError(KindNotFound, p.config.ID, "%s has no data", path)
	}
	data := decoded.Data
	if inner, ok := data["data"].(map[string]any); ok && len(data) == 2 && vaultKV2Metadata(data["metadata"]) && vaultKV2Path(path) {
		data = inner
	}
	secret := Secret{Fields: stringifyFields(data)}
	if decoded.LeaseDuration > 0 {
		secret.ExpiresAt = p.env.Now().Add(time.Duration(decoded.LeaseDuration) * time.Second)
	}
	return secret, nil
}

func vaultKV2Path(path string) bool {
	segments := strings.Split(strings.Trim(path, "/"), "/")
	for i := 1; i < len(segments)-1; i++ {
		if segments[i] == "data" {
			return true
		}
	}
	return false
}

func vaultKV2Metadata(value any) bool {
	metadata, ok := value.(map[string]any)
	if !ok {
		return false
	}
	if version, ok := metadata["version"].(float64); ok && version >= 0 {
		return true
	}
	for _, key := range []string{"created_time", "deletion_time"} {
		if value, ok := metadata[key].(string); ok && value != "" {
			return true
		}
	}
	if _, ok := metadata["destroyed"].(bool); ok {
		return true
	}
	_, ok = metadata["custom_metadata"].(map[string]any)
	return ok
}

func (p *vaultProvider) Check(ctx context.Context) (Status, error) {
	token, err := p.token(ctx)
	if err != nil {
		return Status{}, err
	}
	body, status, err := p.do(ctx, http.MethodGet, "auth/token/lookup-self", nil, nil, token)
	if err != nil {
		return Status{}, err
	}
	if status == http.StatusForbidden || status == http.StatusUnauthorized {
		p.forgetLogin()
		return Status{}, newError(KindNotAuthenticated, p.config.ID, "the token is invalid or expired")
	}
	if err := p.statusError(status, body, "auth/token/lookup-self"); err != nil {
		return Status{}, err
	}
	var decoded vaultResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return Status{}, newError(KindUnavailable, p.config.ID, "unexpected answer from auth/token/lookup-self")
	}
	out := Status{}
	if ttl, ok := decoded.Data["ttl"].(float64); ok {
		out.ExpiresIn = int64(ttl)
	}
	if policies, ok := decoded.Data["policies"].([]any); ok {
		for _, policy := range policies {
			if name, ok := policy.(string); ok {
				out.Policies = append(out.Policies, name)
			}
		}
	}
	return out, nil
}

func (p *vaultProvider) token(ctx context.Context) (string, error) {
	switch p.config.Auth.Method {
	case "approle", "kubernetes", "oidc":
		return p.login(ctx)
	}
	if token, ok := p.credentials("token"); ok && strings.TrimSpace(token) != "" {
		return strings.TrimSpace(token), nil
	}
	if token, ok := p.env.Getenv("VAULT_TOKEN"); ok && strings.TrimSpace(token) != "" {
		return strings.TrimSpace(token), nil
	}
	if home, err := p.env.HomeDir(); err == nil {
		if data, err := p.env.ReadFile(filepath.Join(home, ".vault-token")); err == nil && strings.TrimSpace(string(data)) != "" {
			return strings.TrimSpace(string(data)), nil
		}
	}
	return "", newError(KindNotAuthenticated, p.config.ID, "no Vault token: set VAULT_TOKEN, run vault login, or save a token for this provider")
}

func (p *vaultProvider) cachedLogin() (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.loginToken != "" && (p.loginExpiry.IsZero() || p.env.Now().Before(p.loginExpiry)) {
		return p.loginToken, true
	}
	return "", false
}

func (p *vaultProvider) login(ctx context.Context) (string, error) {
	if token, ok := p.cachedLogin(); ok {
		return token, nil
	}
	p.loginMu.Lock()
	defer p.loginMu.Unlock()
	if token, ok := p.cachedLogin(); ok {
		return token, nil
	}
	var body []byte
	var err error
	switch p.config.Auth.Method {
	case "approle":
		body, err = p.appRoleLogin(ctx)
	case "kubernetes":
		body, err = p.kubernetesLogin(ctx)
	case "oidc":
		body, err = p.oidcLogin(ctx)
	}
	if err != nil {
		return "", err
	}
	var decoded vaultResponse
	if err := json.Unmarshal(body, &decoded); err != nil || decoded.Auth == nil || decoded.Auth.ClientToken == "" {
		return "", newError(KindNotAuthenticated, p.config.ID, "%s login returned no token", p.loginName())
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.loginToken = decoded.Auth.ClientToken
	p.loginExpiry = time.Time{}
	if decoded.Auth.LeaseDuration > 0 {
		margin := time.Duration(decoded.Auth.LeaseDuration) * time.Second / 10
		if margin > 30*time.Second {
			margin = 30 * time.Second
		}
		p.loginExpiry = p.env.Now().Add(time.Duration(decoded.Auth.LeaseDuration)*time.Second - margin)
	}
	return p.loginToken, nil
}

func (p *vaultProvider) loginName() string {
	switch p.config.Auth.Method {
	case "approle":
		return "AppRole"
	case "kubernetes":
		return "Kubernetes"
	case "oidc":
		return "OIDC"
	}
	return "Vault"
}

func (p *vaultProvider) postLogin(ctx context.Context, path string, payload map[string]string) ([]byte, error) {
	encoded, _ := json.Marshal(payload)
	body, status, err := p.do(ctx, http.MethodPost, path, nil, encoded, "")
	if err != nil {
		return nil, err
	}
	if status == http.StatusBadRequest || status == http.StatusForbidden || status == http.StatusUnauthorized {
		return nil, newError(KindNotAuthenticated, p.config.ID, "%s login failed: %s", p.loginName(), vaultErrors(body, status))
	}
	if err := p.statusError(status, body, path); err != nil {
		return nil, err
	}
	return body, nil
}

func (p *vaultProvider) appRoleLogin(ctx context.Context) ([]byte, error) {
	secretID, ok := p.credentials("secretId")
	if !ok || strings.TrimSpace(secretID) == "" {
		secretID, ok = p.env.Getenv("VAULT_SECRET_ID")
	}
	if !ok || strings.TrimSpace(secretID) == "" {
		return nil, newError(KindNotAuthenticated, p.config.ID, "no AppRole secret_id: set VAULT_SECRET_ID or save it for this provider")
	}
	return p.postLogin(ctx, "auth/"+p.config.Auth.Mount+"/login", map[string]string{"role_id": p.config.Auth.RoleID, "secret_id": strings.TrimSpace(secretID)})
}

func (p *vaultProvider) kubernetesLogin(ctx context.Context) ([]byte, error) {
	path, err := expandHome(p.config.Auth.TokenPath, p.env)
	if err != nil {
		return nil, newError(KindNotAuthenticated, p.config.ID, "cannot read the service account token: %v", err)
	}
	jwt, err := p.env.ReadFile(path)
	if err != nil || strings.TrimSpace(string(jwt)) == "" {
		return nil, newError(KindNotAuthenticated, p.config.ID, "no service account token at %s; Kubernetes auth works inside a pod", p.config.Auth.TokenPath)
	}
	return p.postLogin(ctx, "auth/"+p.config.Auth.Mount+"/login", map[string]string{"role": p.config.Auth.Role, "jwt": strings.TrimSpace(string(jwt))})
}

func (p *vaultProvider) forgetLogin() {
	p.mu.Lock()
	p.loginToken = ""
	p.loginExpiry = time.Time{}
	p.mu.Unlock()
}

func (p *vaultProvider) do(ctx context.Context, method, path string, query url.Values, payload []byte, token string) ([]byte, int, error) {
	endpoint := strings.TrimRight(p.config.Address, "/") + "/v1/" + escapeVaultPath(path)
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, 0, newError(KindInvalidRef, p.config.ID, "invalid address or path")
	}
	if token != "" {
		req.Header.Set("X-Vault-Token", token)
	}
	if p.config.Namespace != "" {
		req.Header.Set("X-Vault-Namespace", p.config.Namespace)
	}
	req.Header.Set("X-Vault-Request", "true")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, 0, transportError(p.config.ID, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxVaultResponseBytes))
	if err != nil {
		return nil, 0, transportError(p.config.ID, err)
	}
	return body, resp.StatusCode, nil
}

func escapeVaultPath(path string) string {
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return strings.Join(segments, "/")
}

func (p *vaultProvider) statusError(status int, body []byte, path string) error {
	switch {
	case status >= 200 && status < 300:
		return nil
	case status == http.StatusUnauthorized:
		return newError(KindNotAuthenticated, p.config.ID, "%s", vaultErrors(body, status))
	case status == http.StatusForbidden:
		return newError(KindForbidden, p.config.ID, "403 %s on %s", vaultErrors(body, status), path)
	case status == http.StatusNotFound:
		return newError(KindNotFound, p.config.ID, "no secret at %s", path)
	default:
		return newError(KindUnavailable, p.config.ID, "%d %s", status, vaultErrors(body, status))
	}
}

func vaultErrors(body []byte, status int) string {
	var decoded vaultResponse
	if err := json.Unmarshal(body, &decoded); err == nil && len(decoded.Errors) > 0 {
		return strings.Join(decoded.Errors, "; ")
	}
	return fmt.Sprintf("HTTP %d", status)
}

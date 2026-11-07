package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	agentMcpAuthOAuth          = "oauth"
	agentMcpOAuthCancelPrefix  = "agent-mcp-oauth:"
	agentMcpOAuthDiscoveryBody = 1 << 20
	agentMcpOAuthRefreshMargin = time.Minute
)

var agentMcpOpenBrowser = func(a *App, target string) error { return a.openAuthorizeURL(target) }

var agentMcpOAuthHTTP = &http.Client{Timeout: 15 * time.Second}

var (
	agentMcpResourceMetadataRe = regexp.MustCompile(`resource_metadata="([^"]+)"`)
	agentMcpScopeRe            = regexp.MustCompile(`scope="([^"]+)"`)
)

type savedAgentMcpOAuth struct {
	ClientID              string `json:"clientId"`
	ClientSecretEncrypted string `json:"clientSecretEncrypted,omitempty"`
	AuthURL               string `json:"authUrl"`
	TokenURL              string `json:"tokenUrl"`
	Resource              string `json:"resource,omitempty"`
	Scope                 string `json:"scope,omitempty"`
	AccessTokenEncrypted  string `json:"accessTokenEncrypted,omitempty"`
	RefreshTokenEncrypted string `json:"refreshTokenEncrypted,omitempty"`
	ExpiresAt             int64  `json:"expiresAt,omitempty"`
}

type agentMcpOAuthMetadata struct {
	authURL      string
	tokenURL     string
	registerURL  string
	resource     string
	scope        string
	codeMethods  []string
	authServerID string
}

func agentMcpOAuthGetJSON(ctx context.Context, target string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := agentMcpOAuthHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", target, resp.Status)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, agentMcpOAuthDiscoveryBody)).Decode(out)
}

func agentMcpWellKnown(base *url.URL, name string) []string {
	origin := base.Scheme + "://" + base.Host
	path := strings.TrimRight(base.EscapedPath(), "/")
	var out []string
	if path != "" {
		out = append(out, origin+"/.well-known/"+name+path)
	}
	return append(out, origin+"/.well-known/"+name)
}

func agentMcpProbeChallenge(ctx context.Context, serverURL string) (string, string) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{
		"protocolVersion": mcpStdioProtocolVersion, "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "Kurlo agent", "version": appVersion},
	}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, serverURL, bytes.NewReader(body))
	if err != nil {
		return "", ""
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := agentMcpOAuthHTTP.Do(req)
	if err != nil {
		return "", ""
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, agentMcpOAuthDiscoveryBody))
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden {
		return "", ""
	}
	header := strings.Join(resp.Header.Values("WWW-Authenticate"), ", ")
	var metadata, scope string
	if match := agentMcpResourceMetadataRe.FindStringSubmatch(header); match != nil {
		metadata = match[1]
	}
	if match := agentMcpScopeRe.FindStringSubmatch(header); match != nil {
		scope = match[1]
	}
	return metadata, scope
}

func discoverAgentMcpOAuth(ctx context.Context, serverURL string) (agentMcpOAuthMetadata, error) {
	server, err := url.Parse(serverURL)
	if err != nil || server.Host == "" {
		return agentMcpOAuthMetadata{}, errors.New("the server URL is not valid")
	}
	server.Fragment = ""
	meta := agentMcpOAuthMetadata{resource: server.String()}
	metadataURL, challengeScope := agentMcpProbeChallenge(ctx, serverURL)
	candidates := agentMcpWellKnown(server, "oauth-protected-resource")
	if metadataURL != "" {
		candidates = append([]string{metadataURL}, candidates...)
	}
	var prm struct {
		Resource             string   `json:"resource"`
		AuthorizationServers []string `json:"authorization_servers"`
		ScopesSupported      []string `json:"scopes_supported"`
	}
	issuer := server.Scheme + "://" + server.Host
	for _, candidate := range candidates {
		if agentMcpOAuthGetJSON(ctx, candidate, &prm) == nil && len(prm.AuthorizationServers) > 0 {
			issuer = strings.TrimSpace(prm.AuthorizationServers[0])
			if strings.TrimSpace(prm.Resource) != "" {
				meta.resource = strings.TrimSpace(prm.Resource)
			}
			break
		}
	}
	meta.scope = challengeScope
	if meta.scope == "" && len(prm.ScopesSupported) > 0 {
		meta.scope = strings.Join(prm.ScopesSupported, " ")
	}
	issuerURL, err := url.Parse(issuer)
	if err != nil || issuerURL.Host == "" {
		return meta, fmt.Errorf("the authorization server %q is not a valid URL", issuer)
	}
	meta.authServerID = issuer
	metadataCandidates := append(agentMcpWellKnown(issuerURL, "oauth-authorization-server"), agentMcpWellKnown(issuerURL, "openid-configuration")...)
	if path := strings.TrimRight(issuerURL.EscapedPath(), "/"); path != "" {
		metadataCandidates = append(metadataCandidates, strings.TrimRight(issuer, "/")+"/.well-known/openid-configuration")
	}
	var as struct {
		AuthorizationEndpoint         string   `json:"authorization_endpoint"`
		TokenEndpoint                 string   `json:"token_endpoint"`
		RegistrationEndpoint          string   `json:"registration_endpoint"`
		CodeChallengeMethodsSupported []string `json:"code_challenge_methods_supported"`
	}
	found := false
	for _, candidate := range metadataCandidates {
		if agentMcpOAuthGetJSON(ctx, candidate, &as) == nil && as.AuthorizationEndpoint != "" && as.TokenEndpoint != "" {
			found = true
			break
		}
	}
	origin := issuerURL.Scheme + "://" + issuerURL.Host
	if !found {
		as.AuthorizationEndpoint, as.TokenEndpoint, as.RegistrationEndpoint = origin+"/authorize", origin+"/token", origin+"/register"
	}
	if len(as.CodeChallengeMethodsSupported) > 0 {
		s256 := false
		for _, method := range as.CodeChallengeMethodsSupported {
			s256 = s256 || method == "S256"
		}
		if !s256 {
			return meta, errors.New("the authorization server does not support PKCE with S256, which MCP requires")
		}
	}
	meta.authURL, meta.tokenURL, meta.registerURL, meta.codeMethods = as.AuthorizationEndpoint, as.TokenEndpoint, as.RegistrationEndpoint, as.CodeChallengeMethodsSupported
	return meta, nil
}

func registerAgentMcpClient(ctx context.Context, registerURL, redirect string) (string, string, error) {
	if registerURL == "" {
		return "", "", errors.New("the authorization server does not register clients itself; enter a client ID for this server")
	}
	body, _ := json.Marshal(map[string]any{
		"client_name":                "Kurlo",
		"redirect_uris":              []string{redirect},
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, registerURL, bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := agentMcpOAuthHTTP.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("could not register Kurlo with the authorization server: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
		Error        string `json:"error"`
		Description  string `json:"error_description"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, agentMcpOAuthDiscoveryBody)).Decode(&out)
	if resp.StatusCode >= 300 || out.ClientID == "" {
		detail := strings.TrimSpace(out.Error + " " + out.Description)
		if detail == "" {
			detail = resp.Status
		}
		return "", "", fmt.Errorf("the authorization server refused to register Kurlo: %s", detail)
	}
	return out.ClientID, out.ClientSecret, nil
}

func agentMcpLoopbackRedirect() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("could not start the local sign-in page: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return fmt.Sprintf("http://127.0.0.1:%d/callback", port), nil
}

func sealAgentMcpSecret(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	sealed, err := encryptRequestStorePayload([]byte(value))
	if err != nil {
		return "", err
	}
	return string(sealed), nil
}

func openAgentMcpSecret(sealed string) string {
	if sealed == "" {
		return ""
	}
	plaintext, err := decryptRequestStorePayload([]byte(sealed))
	if err != nil {
		return ""
	}
	return string(plaintext)
}

func (o *savedAgentMcpOAuth) storeToken(token model.OAuth2TokenResponse, now time.Time) error {
	access, err := sealAgentMcpSecret(token.AccessToken)
	if err != nil {
		return err
	}
	o.AccessTokenEncrypted = access
	if token.RefreshToken != "" {
		refresh, err := sealAgentMcpSecret(token.RefreshToken)
		if err != nil {
			return err
		}
		o.RefreshTokenEncrypted = refresh
	}
	o.ExpiresAt = 0
	if token.ExpiresIn > 0 {
		o.ExpiresAt = now.Add(time.Duration(token.ExpiresIn) * time.Second).UnixMilli()
	}
	return nil
}

func (o savedAgentMcpOAuth) config() model.AuthConfig {
	return model.AuthConfig{
		Type:              "oauth2",
		OAuth2GrantType:   "authorization_code",
		OAuth2AuthURL:     o.AuthURL,
		OAuth2TokenURL:    o.TokenURL,
		OAuth2ClientID:    o.ClientID,
		OAuth2Secret:      openAgentMcpSecret(o.ClientSecretEncrypted),
		OAuth2Scope:       o.Scope,
		OAuth2UsePKCE:     true,
		OAuth2ClientAuth:  "",
		OAuth2RedirectURL: "",
	}
}

func (o savedAgentMcpOAuth) params() url.Values {
	if o.Resource == "" {
		return nil
	}
	return url.Values{"resource": {o.Resource}}
}

func updateAgentMcpServer(id string, change func(server *savedAgentMcpServer) error) (appPreferences, error) {
	agentMcpServersMu.Lock()
	defer agentMcpServersMu.Unlock()
	preferences, err := loadAppPreferences()
	if err != nil {
		return preferences, err
	}
	for i := range preferences.AgentMcpServers {
		if preferences.AgentMcpServers[i].ID != id {
			continue
		}
		if err := change(&preferences.AgentMcpServers[i]); err != nil {
			return preferences, err
		}
		return preferences, saveAppPreferences(preferences)
	}
	return preferences, errors.New("This MCP server no longer exists.")
}

func findAgentMcpServer(id string) (savedAgentMcpServer, error) {
	preferences, err := loadAppPreferences()
	if err != nil {
		return savedAgentMcpServer{}, err
	}
	for _, server := range preferences.AgentMcpServers {
		if server.ID == id {
			return server, nil
		}
	}
	return savedAgentMcpServer{}, errors.New("This MCP server no longer exists.")
}

func (a *App) SignInAgentMcpServer(id string) model.AgentMcpServersState {
	server, err := findAgentMcpServer(id)
	if err == nil && (server.Kind != agentMcpKindHTTP || server.Auth != agentMcpAuthOAuth) {
		err = errors.New("Turn on OAuth sign-in for this HTTP server first.")
	}
	if err != nil {
		preferences, _ := loadAppPreferences()
		return agentMcpServersState(preferences, err)
	}
	ctx, cancel := context.WithCancel(a.appContext())
	seq := a.registerRequestCancel(agentMcpOAuthCancelPrefix+id, cancel)
	defer func() {
		cancel()
		a.unregisterRequestCancel(agentMcpOAuthCancelPrefix+id, seq)
	}()
	oauth, err := a.authorizeAgentMcpServer(ctx, server)
	if err != nil {
		preferences, _ := loadAppPreferences()
		return agentMcpServersState(preferences, fmt.Errorf("Could not sign in to %s: %v", server.Name, err))
	}
	preferences, err := updateAgentMcpServer(id, func(saved *savedAgentMcpServer) error {
		if saved.URL != server.URL {
			return errors.New("The server's URL changed during sign-in. Sign in again.")
		}
		saved.OAuth = &oauth
		return nil
	})
	a.agentRuntime().dropMcpClient(id)
	return agentMcpServersState(preferences, err)
}

func (a *App) authorizeAgentMcpServer(ctx context.Context, server savedAgentMcpServer) (savedAgentMcpOAuth, error) {
	meta, err := discoverAgentMcpOAuth(ctx, server.URL)
	if err != nil {
		return savedAgentMcpOAuth{}, err
	}
	redirect, err := agentMcpLoopbackRedirect()
	if err != nil {
		return savedAgentMcpOAuth{}, err
	}
	oauth := savedAgentMcpOAuth{AuthURL: meta.authURL, TokenURL: meta.tokenURL, Resource: meta.resource, Scope: meta.scope}
	if id := strings.TrimSpace(server.OAuthClientID); id != "" {
		oauth.ClientID = id
	} else {
		clientID, secret, err := registerAgentMcpClient(ctx, meta.registerURL, redirect)
		if err != nil {
			return savedAgentMcpOAuth{}, err
		}
		oauth.ClientID = clientID
		if oauth.ClientSecretEncrypted, err = sealAgentMcpSecret(secret); err != nil {
			return savedAgentMcpOAuth{}, err
		}
	}
	cfg := oauth.config()
	cfg.OAuth2RedirectURL = redirect
	token := auth.AuthorizeCodeWithParams(ctx, cfg, func(target string) error { return agentMcpOpenBrowser(a, target) }, oauth.params())
	if token.Error != "" {
		return savedAgentMcpOAuth{}, errors.New(strings.TrimSpace(token.Error + " " + token.ErrorDesc))
	}
	if token.AccessToken == "" {
		return savedAgentMcpOAuth{}, errors.New("the authorization server returned no access token")
	}
	if err := oauth.storeToken(token, time.Now()); err != nil {
		return savedAgentMcpOAuth{}, err
	}
	return oauth, nil
}

func (a *App) CancelAgentMcpSignIn(id string) {
	a.CancelRequest(agentMcpOAuthCancelPrefix + id)
}

func (a *App) SignOutAgentMcpServer(id string) model.AgentMcpServersState {
	preferences, err := updateAgentMcpServer(id, func(saved *savedAgentMcpServer) error {
		saved.OAuth = nil
		return nil
	})
	a.agentRuntime().dropMcpClient(id)
	return agentMcpServersState(preferences, err)
}

func agentMcpAccessToken(id string, now time.Time) (string, error) {
	server, err := findAgentMcpServer(id)
	if err != nil {
		return "", err
	}
	if server.OAuth == nil || server.OAuth.AccessTokenEncrypted == "" {
		return "", fmt.Errorf("Sign in to %s in Settings → AI → MCP servers first.", server.Name)
	}
	oauth := *server.OAuth
	if oauth.ExpiresAt == 0 || now.Add(agentMcpOAuthRefreshMargin).UnixMilli() < oauth.ExpiresAt {
		return openAgentMcpSecret(oauth.AccessTokenEncrypted), nil
	}
	refresh := openAgentMcpSecret(oauth.RefreshTokenEncrypted)
	if refresh == "" {
		return "", fmt.Errorf("The sign-in to %s expired. Sign in again in Settings → AI → MCP servers.", server.Name)
	}
	cfg := oauth.config()
	cfg.OAuth2RefreshToken = refresh
	token := auth.RefreshTokenWithParams(cfg, oauth.params())
	if token.Error != "" || token.AccessToken == "" {
		return "", fmt.Errorf("The sign-in to %s expired and could not be renewed. Sign in again in Settings → AI → MCP servers.", server.Name)
	}
	if err := oauth.storeToken(token, now); err != nil {
		return "", err
	}
	if _, err := updateAgentMcpServer(id, func(saved *savedAgentMcpServer) error {
		if saved.OAuth != nil {
			saved.OAuth.AccessTokenEncrypted = oauth.AccessTokenEncrypted
			saved.OAuth.RefreshTokenEncrypted = oauth.RefreshTokenEncrypted
			saved.OAuth.ExpiresAt = oauth.ExpiresAt
		}
		return nil
	}); err != nil {
		return "", err
	}
	return token.AccessToken, nil
}

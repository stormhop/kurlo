package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func (s *mcpServer) toolAuthorizeOAuth2(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Request     string `json:"request"`
		Environment string `json:"environment"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	req, err := mcpFindRequest(ws.requests, args.Request)
	if err != nil {
		return nil, err
	}
	for i := range ws.collections {
		if ws.collections[i].ID == req.CollectionID {
			req = applyCollectionDefaults(req, &ws.collections[i])
			break
		}
	}
	run, err := s.prepareRun(ws.forRequest(req), args.Environment, nil)
	if err != nil {
		return nil, err
	}
	values := cliRequestValues(req, run.sm)
	cfg := resolveAuthTemplates(buildHTTPRequest(req, values, run.secrets, 0).Auth, values)
	if cfg.Type != "oauth2" {
		return nil, fmt.Errorf("the saved request must use OAuth 2.0")
	}
	token, _ := ctx.Value(mcpProgressTokenKey{}).(json.RawMessage)
	if (cfg.OAuth2GrantType == "authorization_code" || cfg.OAuth2GrantType == "device_code") && s.openOAuthBrowser == nil && len(token) == 0 {
		return nil, fmt.Errorf("interactive OAuth requires an MCP progress token or Agent Mode so you can receive the sign-in instructions")
	}
	open := func(target string) error {
		address, err := url.Parse(target)
		if err != nil || address.Hostname() == "" || (address.Scheme != "http" && address.Scheme != "https") {
			return fmt.Errorf("OAuth sign-in needs an HTTP or HTTPS URL")
		}
		if s.openOAuthBrowser != nil {
			return s.openOAuthBrowser(target)
		}
		if cfg.OAuth2GrantType == "authorization_code" {
			s.progress(ctx, 1, 2, "Open this URL to authorize the request: "+target)
		}
		return nil
	}
	var response model.OAuth2TokenResponse
	switch cfg.OAuth2GrantType {
	case "authorization_code":
		response = auth.AuthorizeCode(ctx, cfg, open)
	case "device_code":
		response = auth.AuthorizeDevice(ctx, cfg, func(prompt model.OAuth2DevicePrompt) {
			if s.onOAuthDevicePrompt != nil {
				s.onOAuthDevicePrompt(prompt)
			}
			s.progress(ctx, 1, 2, fmt.Sprintf("Open %s and enter code %s", prompt.VerificationURI, prompt.UserCode))
		}, open)
	case "", "client_credentials", "password":
		response, _ = fetchCLIOAuth2Token(cfg)
	default:
		return nil, fmt.Errorf("unsupported OAuth 2.0 grant")
	}
	if response.Error != "" || response.AccessToken == "" {
		return nil, fmt.Errorf("OAuth 2.0 authorization failed: %s", redactSecrets(defaultString(response.Error, "no access token was returned"), append(run.secrets, cfg.OAuth2Secret, cfg.OAuth2Password, cfg.OAuth2RefreshToken)))
	}
	s.tokens.rememberOAuth2Token(oauth2CacheKey(cfg), response)
	return map[string]any{"request": mcpRequestPath(req), "grant": defaultString(strings.TrimSpace(cfg.OAuth2GrantType), "client_credentials"), "authorized": true}, nil
}

package api

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type oauth2TokenCache struct {
	mu      sync.Mutex
	tokens  map[string]cachedOAuth2Token
	flights sync.Map
}

type cachedOAuth2Token struct {
	accessToken string
	expiresAt   time.Time
}

func newOAuth2TokenCache() *oauth2TokenCache {
	return &oauth2TokenCache{tokens: make(map[string]cachedOAuth2Token)}
}

func (c *oauth2TokenCache) resolveOAuth2Token(cfg *model.AuthConfig) error {
	if c == nil || cfg == nil || !strings.EqualFold(cfg.Type, "oauth2") {
		return nil
	}

	key := oauth2CacheKey(*cfg)
	flight, _ := c.flights.LoadOrStore(key, &sync.Mutex{})
	lock := flight.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	c.mu.Lock()
	if cached, ok := c.tokens[key]; ok && cached.accessToken != "" && !oauth2TokenExpired(cached.expiresAt) {
		cfg.Token = cached.accessToken
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()

	response, attempted := fetchCLIOAuth2Token(*cfg)
	if !attempted {
		if cfg.Token != "" {
			return nil
		}
		return fmt.Errorf(
			"auth error: the %s grant needs a browser sign-in, and this workspace carries no access token. "+
				"Sign in once in the app, or use a grant a run can complete on its own "+
				"(client credentials, password, or a stored refresh token)",
			oauth2GrantLabel(cfg.OAuth2GrantType))
	}
	if response.Error != "" {
		if cfg.Token != "" {
			return nil
		}
		message := response.Error
		if response.ErrorDesc != "" {
			message += " — " + response.ErrorDesc
		}
		return fmt.Errorf("auth error: could not obtain an OAuth 2.0 access token: %s", message)
	}
	if response.AccessToken == "" {
		if cfg.Token != "" {
			return nil
		}
		return fmt.Errorf("auth error: the token endpoint returned no access token")
	}

	expiresAt := time.Time{}
	if response.ExpiresIn > 0 {
		expiresAt = time.Now().Add(time.Duration(response.ExpiresIn) * time.Second)
	}
	c.mu.Lock()
	c.tokens[key] = cachedOAuth2Token{accessToken: response.AccessToken, expiresAt: expiresAt}
	c.mu.Unlock()

	cfg.Token = response.AccessToken
	return nil
}

func fetchCLIOAuth2Token(cfg model.AuthConfig) (model.OAuth2TokenResponse, bool) {
	switch strings.ToLower(strings.TrimSpace(cfg.OAuth2GrantType)) {
	case "password":
		if cfg.OAuth2TokenURL != "" && cfg.OAuth2Username != "" {
			return auth.FetchTokenPassword(cfg), true
		}
	case "authorization_code", "device_code":
		if cfg.OAuth2RefreshToken != "" && cfg.OAuth2TokenURL != "" {
			return auth.RefreshToken(cfg), true
		}
	default:
		if cfg.OAuth2TokenURL != "" && cfg.OAuth2ClientID != "" {
			return auth.FetchToken(cfg), true
		}
		if cfg.OAuth2RefreshToken != "" && cfg.OAuth2TokenURL != "" {
			return auth.RefreshToken(cfg), true
		}
	}
	return model.OAuth2TokenResponse{}, false
}

func oauth2CacheKey(cfg model.AuthConfig) string {
	return strings.Join([]string{
		cfg.OAuth2GrantType, cfg.OAuth2TokenURL, cfg.OAuth2ClientID, cfg.OAuth2Secret,
		cfg.OAuth2Scope, cfg.OAuth2Audience, cfg.OAuth2Username, cfg.OAuth2Password,
		cfg.OAuth2RefreshToken, cfg.OAuth2ClientAuth, cfg.OAuth2AssertionKeyID,
	}, "\x00")
}

func oauth2TokenExpired(expiresAt time.Time) bool {
	if expiresAt.IsZero() {
		return false
	}
	return time.Now().After(expiresAt.Add(-30 * time.Second))
}

func oauth2GrantLabel(grant string) string {
	switch strings.ToLower(strings.TrimSpace(grant)) {
	case "device_code":
		return "Device Code"
	case "authorization_code":
		return "Authorization Code"
	default:
		return grant
	}
}

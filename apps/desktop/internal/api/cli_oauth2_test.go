package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func oauth2TokenServer(t *testing.T, hits *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		if err := r.ParseForm(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "issued-for-" + r.Form.Get("grant_type"),
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	}))
}

func TestCLIRunFetchesItsOwnClientCredentialsToken(t *testing.T) {
	var hits int32
	server := oauth2TokenServer(t, &hits)
	defer server.Close()

	cfg := model.AuthConfig{
		Type:            "oauth2",
		OAuth2GrantType: "client_credentials",
		OAuth2TokenURL:  server.URL,
		OAuth2ClientID:  "cid",
		OAuth2Secret:    "secret",
	}
	cache := newOAuth2TokenCache()
	if err := cache.resolveOAuth2Token(&cfg); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Token != "issued-for-client_credentials" {
		t.Fatalf("token = %q, want the one the endpoint issued", cfg.Token)
	}
}

func TestCLIRunReusesOneTokenAcrossRequests(t *testing.T) {
	var hits int32
	server := oauth2TokenServer(t, &hits)
	defer server.Close()

	base := model.AuthConfig{
		Type:            "oauth2",
		OAuth2GrantType: "client_credentials",
		OAuth2TokenURL:  server.URL,
		OAuth2ClientID:  "cid",
	}
	cache := newOAuth2TokenCache()
	for i := 0; i < 5; i++ {
		cfg := base
		if err := cache.resolveOAuth2Token(&cfg); err != nil {
			t.Fatalf("resolve %d: %v", i, err)
		}
		if cfg.Token == "" {
			t.Fatalf("request %d went out with no token", i)
		}
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("token endpoint hit %d times, want 1", got)
	}
}

func TestCLIRunUsesTheRefreshTokenForInteractiveGrants(t *testing.T) {
	var hits int32
	server := oauth2TokenServer(t, &hits)
	defer server.Close()

	cfg := model.AuthConfig{
		Type:               "oauth2",
		OAuth2GrantType:    "authorization_code",
		OAuth2TokenURL:     server.URL,
		OAuth2ClientID:     "cid",
		OAuth2RefreshToken: "RT",
	}
	cache := newOAuth2TokenCache()
	if err := cache.resolveOAuth2Token(&cfg); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Token != "issued-for-refresh_token" {
		t.Fatalf("token = %q, want one obtained with the refresh token", cfg.Token)
	}
}

func TestCLIRunExplainsWhenAGrantNeedsABrowser(t *testing.T) {
	cfg := model.AuthConfig{
		Type:                "oauth2",
		OAuth2GrantType:     "device_code",
		OAuth2TokenURL:      "https://auth.example.com/token",
		OAuth2DeviceAuthURL: "https://auth.example.com/device",
		OAuth2ClientID:      "cid",
	}
	err := newOAuth2TokenCache().resolveOAuth2Token(&cfg)
	if err == nil {
		t.Fatal("expected an error naming the grant that cannot run unattended")
	}
	if !strings.Contains(err.Error(), "Device Code") {
		t.Errorf("error should name the grant, got: %v", err)
	}
}

func TestCLIRunKeepsAnExistingTokenWhenRenewalFails(t *testing.T) {
	cfg := model.AuthConfig{
		Type:            "oauth2",
		OAuth2GrantType: "client_credentials",
		OAuth2TokenURL:  "http://127.0.0.1:1/token",
		OAuth2ClientID:  "cid",
		Token:           "already-have-one",
	}
	if err := newOAuth2TokenCache().resolveOAuth2Token(&cfg); err != nil {
		t.Fatalf("a run holding a token should not be stopped by a failed renewal: %v", err)
	}
	if cfg.Token != "already-have-one" {
		t.Errorf("token = %q, want the existing one preserved", cfg.Token)
	}
}

func TestCLIRunLeavesOtherAuthTypesAlone(t *testing.T) {
	cfg := model.AuthConfig{Type: "bearer", Token: "static"}
	if err := newOAuth2TokenCache().resolveOAuth2Token(&cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Token != "static" {
		t.Errorf("token = %q, want it untouched", cfg.Token)
	}
}

func TestCLIOAuth2ConcurrentRefreshUsesOneRequest(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		time.Sleep(20 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"fresh","expires_in":3600}`))
	}))
	defer server.Close()
	cache := newOAuth2TokenCache()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cfg := model.AuthConfig{Type: "oauth2", OAuth2GrantType: "authorization_code", OAuth2TokenURL: server.URL, OAuth2RefreshToken: "rotating"}
			if err := cache.resolveOAuth2Token(&cfg); err != nil || cfg.Token != "fresh" {
				t.Errorf("token=%q err=%v", cfg.Token, err)
			}
		}()
	}
	wg.Wait()
	if hits.Load() != 1 {
		t.Fatalf("refresh requests=%d, want 1", hits.Load())
	}
}

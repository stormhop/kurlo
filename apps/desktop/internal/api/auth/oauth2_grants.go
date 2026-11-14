package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	deviceCodeGrant = "urn:ietf:params:oauth:grant-type:device_code"

	defaultDevicePollInterval = 5 * time.Second

	maxDeviceFlowDuration = 15 * time.Minute
)

func FetchTokenPassword(cfg model.AuthConfig) model.OAuth2TokenResponse {
	if cfg.OAuth2TokenURL == "" {
		return model.OAuth2TokenResponse{Error: "token URL is required"}
	}
	if cfg.OAuth2Username == "" {
		return model.OAuth2TokenResponse{Error: "username is required for the password grant"}
	}
	form := url.Values{}
	form.Set("grant_type", "password")
	form.Set("username", cfg.OAuth2Username)
	form.Set("password", cfg.OAuth2Password)
	if cfg.OAuth2Scope != "" {
		form.Set("scope", cfg.OAuth2Scope)
	}
	return postTokenRequest(cfg, form)
}

type deviceAuthorizationResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
	Error                   string `json:"error"`
	ErrorDesc               string `json:"error_description"`

	VerificationURL string `json:"verification_url"`
}

type deviceAuthorizationClock struct {
	now   func() time.Time
	after func(time.Duration) <-chan time.Time
}

func AuthorizeDevice(ctx context.Context, cfg model.AuthConfig, onPrompt func(model.OAuth2DevicePrompt), openBrowser func(string) error) model.OAuth2TokenResponse {
	return authorizeDevice(ctx, cfg, onPrompt, openBrowser, deviceAuthorizationClock{now: time.Now, after: time.After})
}

func authorizeDevice(ctx context.Context, cfg model.AuthConfig, onPrompt func(model.OAuth2DevicePrompt), openBrowser func(string) error, clock deviceAuthorizationClock) model.OAuth2TokenResponse {
	if cfg.OAuth2DeviceAuthURL == "" {
		return model.OAuth2TokenResponse{Error: "device authorization URL is required"}
	}
	if cfg.OAuth2TokenURL == "" {
		return model.OAuth2TokenResponse{Error: "token URL is required"}
	}
	if cfg.OAuth2ClientID == "" {
		return model.OAuth2TokenResponse{Error: "client ID is required"}
	}

	device, err := requestDeviceCode(cfg)
	if err != nil {
		return model.OAuth2TokenResponse{Error: err.Error()}
	}

	verificationURI := device.VerificationURI
	if verificationURI == "" {
		verificationURI = device.VerificationURL
	}

	interval := defaultDevicePollInterval
	if device.Interval > 0 {
		interval = time.Duration(device.Interval) * time.Second
	}

	if onPrompt != nil {
		onPrompt(model.OAuth2DevicePrompt{
			UserCode:                device.UserCode,
			VerificationURI:         verificationURI,
			VerificationURIComplete: device.VerificationURIComplete,
			ExpiresIn:               device.ExpiresIn,
			Interval:                int(interval / time.Second),
		})
	}
	if openBrowser != nil {
		target := device.VerificationURIComplete
		if target == "" {
			target = verificationURI
		}
		if target != "" {
			_ = openBrowser(target)
		}
	}

	deadline := clock.now().Add(maxDeviceFlowDuration)
	if device.ExpiresIn > 0 {
		if expiry := clock.now().Add(time.Duration(device.ExpiresIn) * time.Second); expiry.Before(deadline) {
			deadline = expiry
		}
	}

	for {
		select {
		case <-ctx.Done():
			return model.OAuth2TokenResponse{Error: "device authorization cancelled"}
		case <-clock.after(interval):
		}

		if clock.now().After(deadline) {
			return model.OAuth2TokenResponse{Error: "device authorization expired — the code timed out before it was approved"}
		}

		form := url.Values{}
		form.Set("grant_type", deviceCodeGrant)
		form.Set("device_code", device.DeviceCode)
		resp := postTokenRequest(cfg, form)

		if resp.AccessToken != "" {
			return resp
		}
		switch resp.Error {
		case "authorization_pending":
		case "slow_down":
			interval += 5 * time.Second
		case "access_denied":
			return model.OAuth2TokenResponse{Error: "device authorization denied by the user"}
		case "expired_token":
			return model.OAuth2TokenResponse{Error: "device code expired — start the authorization again"}
		case "":
			return model.OAuth2TokenResponse{Error: "token endpoint returned no access token"}
		default:
			return resp
		}
	}
}

func requestDeviceCode(cfg model.AuthConfig) (deviceAuthorizationResponse, error) {
	form := url.Values{}
	form.Set("client_id", cfg.OAuth2ClientID)
	if cfg.OAuth2Scope != "" {
		form.Set("scope", cfg.OAuth2Scope)
	}
	if cfg.OAuth2Audience != "" {
		form.Set("audience", cfg.OAuth2Audience)
	}

	useBasicAuth, err := applyClientAuth(form, cfg, cfg.OAuth2TokenURL)
	if err != nil {
		return deviceAuthorizationResponse{}, err
	}
	req, err := newTokenFormRequest(cfg.OAuth2DeviceAuthURL, form)
	if err != nil {
		return deviceAuthorizationResponse{}, err
	}
	if useBasicAuth {
		req.SetBasicAuth(cfg.OAuth2ClientID, cfg.OAuth2Secret)
	}

	resp, err := oauth2HTTPClient(cfg).Do(req)
	if err != nil {
		return deviceAuthorizationResponse{}, err
	}
	defer resp.Body.Close()

	var device deviceAuthorizationResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, oauth2MaxResponseBodySize)).Decode(&device); err != nil {
		return deviceAuthorizationResponse{}, fmt.Errorf("device authorization endpoint returned %s", resp.Status)
	}
	if device.Error != "" {
		msg := device.Error
		if device.ErrorDesc != "" {
			msg += ": " + device.ErrorDesc
		}
		return deviceAuthorizationResponse{}, fmt.Errorf("%s", msg)
	}
	if device.DeviceCode == "" {
		return deviceAuthorizationResponse{}, fmt.Errorf("device authorization endpoint returned no device_code (%s)", resp.Status)
	}
	if strings.TrimSpace(device.VerificationURI) == "" && strings.TrimSpace(device.VerificationURL) == "" {
		return deviceAuthorizationResponse{}, fmt.Errorf("device authorization endpoint returned no verification URI")
	}
	return device, nil
}

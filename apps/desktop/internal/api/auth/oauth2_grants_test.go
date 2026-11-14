package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type deviceFlowTestClock struct {
	current time.Time
	waits   []time.Duration
}

func newDeviceFlowTestClock() *deviceFlowTestClock {
	return &deviceFlowTestClock{current: time.Unix(1700000000, 0)}
}

func (c *deviceFlowTestClock) clock() deviceAuthorizationClock {
	return deviceAuthorizationClock{
		now: func() time.Time { return c.current },
		after: func(interval time.Duration) <-chan time.Time {
			c.waits = append(c.waits, interval)
			c.current = c.current.Add(interval)
			timer := make(chan time.Time, 1)
			timer <- c.current
			return timer
		},
	}
}

func TestFetchTokenPassword(t *testing.T) {
	var gotForm url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotForm = r.PostForm
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"access_token":"tok-pw","token_type":"Bearer","expires_in":3600}`)
	}))
	defer server.Close()

	resp := FetchTokenPassword(model.AuthConfig{
		OAuth2TokenURL: server.URL,
		OAuth2ClientID: "cid",
		OAuth2Username: "alice",
		OAuth2Password: "pw",
		OAuth2Scope:    "read write",
	})
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if resp.AccessToken != "tok-pw" {
		t.Errorf("access token = %q, want tok-pw", resp.AccessToken)
	}
	if gotForm.Get("grant_type") != "password" {
		t.Errorf("grant_type = %q, want password", gotForm.Get("grant_type"))
	}
	if gotForm.Get("username") != "alice" || gotForm.Get("password") != "pw" {
		t.Errorf("credentials not sent: %#v", gotForm)
	}
	if gotForm.Get("scope") != "read write" {
		t.Errorf("scope = %q", gotForm.Get("scope"))
	}
}

func TestFetchTokenPasswordRequiresUsername(t *testing.T) {
	resp := FetchTokenPassword(model.AuthConfig{OAuth2TokenURL: "https://example.com/token"})
	if resp.Error == "" {
		t.Fatal("expected an error when the username is missing")
	}
}

func TestAuthorizeDeviceHappyPath(t *testing.T) {
	clock := newDeviceFlowTestClock()
	var polls int32
	var prompt model.OAuth2DevicePrompt
	var openedURL string

	mux := http.NewServeMux()
	mux.HandleFunc("/device", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.PostForm.Get("client_id") != "cid" {
			t.Errorf("device endpoint did not receive client_id: %#v", r.PostForm)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"device_code":"dev-1","user_code":"WXYZ-1234",
			"verification_uri":"https://example.com/activate",
			"verification_uri_complete":"https://example.com/activate?user_code=WXYZ-1234",
			"expires_in":600,"interval":1}`)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if got := r.PostForm.Get("grant_type"); got != deviceCodeGrant {
			t.Errorf("grant_type = %q, want %q", got, deviceCodeGrant)
		}
		if got := r.PostForm.Get("device_code"); got != "dev-1" {
			t.Errorf("device_code = %q, want dev-1", got)
		}
		w.Header().Set("Content-Type", "application/json")
		if atomic.AddInt32(&polls, 1) == 1 {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":"authorization_pending"}`)
			return
		}
		fmt.Fprint(w, `{"access_token":"tok-dev","token_type":"Bearer","expires_in":3600,"refresh_token":"r1"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	resp := authorizeDevice(context.Background(), model.AuthConfig{
		OAuth2DeviceAuthURL: server.URL + "/device",
		OAuth2TokenURL:      server.URL + "/token",
		OAuth2ClientID:      "cid",
	}, func(p model.OAuth2DevicePrompt) { prompt = p }, func(target string) error {
		openedURL = target
		return nil
	}, clock.clock())

	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if resp.AccessToken != "tok-dev" || resp.RefreshToken != "r1" {
		t.Errorf("unexpected token response: %#v", resp)
	}
	if atomic.LoadInt32(&polls) != 2 {
		t.Errorf("expected 2 polls (one pending, one success), got %d", polls)
	}
	if prompt.UserCode != "WXYZ-1234" || prompt.VerificationURI != "https://example.com/activate" {
		t.Errorf("user was not shown the code/URI: %#v", prompt)
	}
	if prompt.Interval != 1 {
		t.Errorf("prompt interval = %d, want 1", prompt.Interval)
	}
	if openedURL != "https://example.com/activate?user_code=WXYZ-1234" {
		t.Errorf("opened %q, want the verification_uri_complete", openedURL)
	}
	if !slices.Equal(clock.waits, []time.Duration{time.Second, time.Second}) {
		t.Errorf("poll intervals = %v, want [1s 1s]", clock.waits)
	}
}

func TestAuthorizeDeviceSlowDownBacksOff(t *testing.T) {
	clock := newDeviceFlowTestClock()
	var polls int32
	mux := http.NewServeMux()
	mux.HandleFunc("/device", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"device_code":"d","user_code":"U","verification_uri":"https://e/x","expires_in":600,"interval":1}`)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&polls, 1) == 1 {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":"slow_down"}`)
			return
		}
		fmt.Fprint(w, `{"access_token":"ok"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	resp := authorizeDevice(context.Background(), model.AuthConfig{
		OAuth2DeviceAuthURL: server.URL + "/device",
		OAuth2TokenURL:      server.URL + "/token",
		OAuth2ClientID:      "cid",
	}, nil, nil, clock.clock())
	if resp.AccessToken != "ok" {
		t.Fatalf("unexpected response: %#v", resp)
	}
	if !slices.Equal(clock.waits, []time.Duration{time.Second, 6 * time.Second}) {
		t.Errorf("poll intervals = %v, want [1s 6s]", clock.waits)
	}
}

func TestAuthorizeDeviceAccessDenied(t *testing.T) {
	clock := newDeviceFlowTestClock()
	mux := http.NewServeMux()
	mux.HandleFunc("/device", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"device_code":"d","user_code":"U","verification_uri":"https://e/x","expires_in":600,"interval":1}`)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":"access_denied"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	resp := authorizeDevice(context.Background(), model.AuthConfig{
		OAuth2DeviceAuthURL: server.URL + "/device",
		OAuth2TokenURL:      server.URL + "/token",
		OAuth2ClientID:      "cid",
	}, nil, nil, clock.clock())
	if resp.AccessToken != "" {
		t.Fatal("denied authorization must not yield a token")
	}
	if !strings.Contains(resp.Error, "denied") {
		t.Errorf("error = %q, want it to mention denial", resp.Error)
	}
}

func TestAuthorizeDeviceCancellation(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/device", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"device_code":"d","user_code":"U","verification_uri":"https://e/x","expires_in":600,"interval":30}`)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		t.Error("token endpoint should not be reached after cancellation")
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	waiting := make(chan struct{})
	clock := deviceAuthorizationClock{
		now: time.Now,
		after: func(interval time.Duration) <-chan time.Time {
			if interval != 30*time.Second {
				t.Errorf("poll interval = %s, want 30s", interval)
			}
			close(waiting)
			return nil
		},
	}
	go func() {
		select {
		case <-waiting:
			cancel()
		case <-ctx.Done():
		}
	}()

	resp := authorizeDevice(ctx, model.AuthConfig{
		OAuth2DeviceAuthURL: server.URL + "/device",
		OAuth2TokenURL:      server.URL + "/token",
		OAuth2ClientID:      "cid",
	}, nil, nil, clock)
	if !strings.Contains(resp.Error, "cancelled") {
		t.Errorf("error = %q, want a cancellation message", resp.Error)
	}
}

func TestAuthorizeDeviceDefaultIntervalAndRepeatedSlowDown(t *testing.T) {
	clock := newDeviceFlowTestClock()
	var polls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/device", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"device_code":"d","verification_uri":"https://e/x","expires_in":600}`)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if polls.Add(1) <= 2 {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":"slow_down"}`)
			return
		}
		fmt.Fprint(w, `{"access_token":"ok"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	resp := authorizeDevice(t.Context(), model.AuthConfig{
		OAuth2DeviceAuthURL: server.URL + "/device",
		OAuth2TokenURL:      server.URL + "/token",
		OAuth2ClientID:      "cid",
	}, nil, nil, clock.clock())
	if resp.AccessToken != "ok" {
		t.Fatalf("unexpected response: %#v", resp)
	}
	if !slices.Equal(clock.waits, []time.Duration{5 * time.Second, 10 * time.Second, 15 * time.Second}) {
		t.Errorf("poll intervals = %v, want [5s 10s 15s]", clock.waits)
	}
}

func TestAuthorizeDeviceExpiryStopsBeforePolling(t *testing.T) {
	for _, tc := range []struct {
		name, response string
	}{
		{name: "device expiry", response: `{"device_code":"d","verification_uri":"https://e/x","expires_in":1,"interval":2}`},
		{name: "maximum flow duration", response: `{"device_code":"d","verification_uri":"https://e/x","interval":901}`},
		{name: "device expiry above maximum", response: `{"device_code":"d","verification_uri":"https://e/x","expires_in":1800,"interval":901}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clock := newDeviceFlowTestClock()
			mux := http.NewServeMux()
			mux.HandleFunc("/device", func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, tc.response)
			})
			mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
				t.Error("expired authorization must not reach the token endpoint")
				fmt.Fprint(w, `{"access_token":"unexpected"}`)
			})
			server := httptest.NewServer(mux)
			defer server.Close()

			resp := authorizeDevice(t.Context(), model.AuthConfig{
				OAuth2DeviceAuthURL: server.URL + "/device",
				OAuth2TokenURL:      server.URL + "/token",
				OAuth2ClientID:      "cid",
			}, nil, nil, clock.clock())
			if resp.AccessToken != "" || !strings.Contains(resp.Error, "expired") {
				t.Fatalf("expected an expiry error without a token, got %#v", resp)
			}
		})
	}
}

func TestAuthorizeDeviceMissingDeviceURL(t *testing.T) {
	resp := AuthorizeDevice(context.Background(), model.AuthConfig{OAuth2TokenURL: "https://e/token", OAuth2ClientID: "c"}, nil, nil)
	if resp.Error == "" {
		t.Fatal("expected an error when the device authorization URL is missing")
	}
}

func TestAuthorizeDeviceVerificationURLAlias(t *testing.T) {
	var prompt model.OAuth2DevicePrompt
	mux := http.NewServeMux()
	mux.HandleFunc("/device", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"device_code":"d","user_code":"U","verification_url":"https://google/device","expires_in":600,"interval":1}`)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"access_token":"ok"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	resp := AuthorizeDevice(context.Background(), model.AuthConfig{
		OAuth2DeviceAuthURL: server.URL + "/device",
		OAuth2TokenURL:      server.URL + "/token",
		OAuth2ClientID:      "cid",
	}, func(p model.OAuth2DevicePrompt) { prompt = p }, nil)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if prompt.VerificationURI != "https://google/device" {
		t.Errorf("verification_url alias not honored: %#v", prompt)
	}
}

func TestClientSecretJWTAssertion(t *testing.T) {
	var gotForm url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotForm = r.PostForm
		if _, _, hasBasic := r.BasicAuth(); hasBasic {
			t.Error("assertion-based client auth must not also send HTTP Basic")
		}
		fmt.Fprint(w, `{"access_token":"tok"}`)
	}))
	defer server.Close()

	resp := FetchToken(model.AuthConfig{
		OAuth2TokenURL:   server.URL,
		OAuth2ClientID:   "cid",
		OAuth2Secret:     "shhh-this-is-a-long-enough-secret",
		OAuth2ClientAuth: ClientAuthClientSecretJWT,
	})
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if got := gotForm.Get("client_assertion_type"); got != clientAssertionType {
		t.Errorf("client_assertion_type = %q, want %q", got, clientAssertionType)
	}
	assertion := gotForm.Get("client_assertion")
	if assertion == "" {
		t.Fatal("no client_assertion was sent")
	}
	header, claims := decodeJWT(t, assertion)
	if header["alg"] != "HS256" {
		t.Errorf("alg = %v, want HS256", header["alg"])
	}
	if claims["iss"] != "cid" || claims["sub"] != "cid" {
		t.Errorf("iss/sub should be the client ID: %#v", claims)
	}
	if claims["aud"] != server.URL {
		t.Errorf("aud = %v, want the token URL %q", claims["aud"], server.URL)
	}
	if claims["jti"] == nil || claims["jti"] == "" {
		t.Error("assertion must carry a jti")
	}
	exp, ok := claims["exp"].(float64)
	if !ok || int64(exp) <= time.Now().Unix() {
		t.Errorf("exp must be in the future, got %v", claims["exp"])
	}
}

func TestPrivateKeyJWTAssertionRSA(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})

	var assertion string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		assertion = r.PostForm.Get("client_assertion")
		if r.PostForm.Get("client_id") != "cid" {
			t.Errorf("client_id should accompany the assertion: %#v", r.PostForm)
		}
		fmt.Fprint(w, `{"access_token":"tok"}`)
	}))
	defer server.Close()

	resp := FetchToken(model.AuthConfig{
		OAuth2TokenURL:            server.URL,
		OAuth2ClientID:            "cid",
		OAuth2ClientAuth:          ClientAuthPrivateKeyJWT,
		OAuth2AssertionPrivateKey: string(pemKey),
		OAuth2AssertionKeyID:      "key-1",
	})
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	header, claims := decodeJWT(t, assertion)
	if header["alg"] != "RS256" {
		t.Errorf("alg = %v, want RS256 inferred from the RSA key", header["alg"])
	}
	if header["kid"] != "key-1" {
		t.Errorf("kid = %v, want key-1", header["kid"])
	}
	if claims["iss"] != "cid" {
		t.Errorf("iss = %v", claims["iss"])
	}

	parts := strings.Split(assertion, ".")
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	hashFn, cryptoHash, err := jwtHash("RS256")
	if err != nil {
		t.Fatal(err)
	}
	h := hashFn()
	h.Write([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, cryptoHash, h.Sum(nil), sig); err != nil {
		t.Errorf("assertion signature does not verify: %v", err)
	}
}

func TestPrivateKeyJWTAssertionECDSA(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})

	assertion, err := buildClientAssertion("cid", "https://as/token", "", "", "", string(pemKey), ClientAuthPrivateKeyJWT)
	if err != nil {
		t.Fatalf("buildClientAssertion: %v", err)
	}
	header, _ := decodeJWT(t, assertion)
	if header["alg"] != "ES256" {
		t.Errorf("alg = %v, want ES256 inferred from a P-256 key", header["alg"])
	}
	parts := strings.Split(assertion, ".")
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	if len(sig) != 64 {
		t.Errorf("ES256 signature should be 64 bytes (R||S), got %d", len(sig))
	}
}

func TestBuildClientAssertionErrors(t *testing.T) {
	cases := []struct {
		name                            string
		clientID, audience, alg, secret string
		privateKey, method              string
	}{
		{name: "no client id", audience: "https://as", method: ClientAuthPrivateKeyJWT, privateKey: "x"},
		{name: "no audience", clientID: "c", method: ClientAuthPrivateKeyJWT, privateKey: "x"},
		{name: "secret jwt without secret", clientID: "c", audience: "https://as", method: ClientAuthClientSecretJWT},
		{name: "secret jwt with RS alg", clientID: "c", audience: "https://as", secret: "s", alg: "RS256", method: ClientAuthClientSecretJWT},
		{name: "private key jwt without key", clientID: "c", audience: "https://as", method: ClientAuthPrivateKeyJWT},
		{name: "unparseable key", clientID: "c", audience: "https://as", privateKey: "not a pem", method: ClientAuthPrivateKeyJWT},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := buildClientAssertion(tc.clientID, tc.audience, tc.alg, "", tc.secret, tc.privateKey, tc.method); err == nil {
				t.Error("expected an error")
			}
		})
	}
}

func TestResolveClientAuthDefaults(t *testing.T) {
	if got := resolveClientAuth("", "secret"); got != ClientAuthBasic {
		t.Errorf("a configured secret should default to Basic, got %q", got)
	}
	if got := resolveClientAuth("", ""); got != ClientAuthBody {
		t.Errorf("a public client should default to the body form, got %q", got)
	}
	if got := resolveClientAuth("PRIVATE_KEY_JWT", ""); got != ClientAuthPrivateKeyJWT {
		t.Errorf("explicit method should win regardless of case, got %q", got)
	}
}

func TestClientAuthBodySendsSecret(t *testing.T) {
	var gotForm url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotForm = r.PostForm
		if _, _, hasBasic := r.BasicAuth(); hasBasic {
			t.Error("body client auth must not send HTTP Basic")
		}
		fmt.Fprint(w, `{"access_token":"tok"}`)
	}))
	defer server.Close()

	FetchToken(model.AuthConfig{
		OAuth2TokenURL:   server.URL,
		OAuth2ClientID:   "cid",
		OAuth2Secret:     "sec",
		OAuth2ClientAuth: ClientAuthBody,
	})
	if gotForm.Get("client_secret") != "sec" {
		t.Errorf("client_secret not in body: %#v", gotForm)
	}
}

func TestAudienceParameter(t *testing.T) {
	var gotForm url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotForm = r.PostForm
		fmt.Fprint(w, `{"access_token":"tok"}`)
	}))
	defer server.Close()

	FetchToken(model.AuthConfig{
		OAuth2TokenURL: server.URL,
		OAuth2ClientID: "cid",
		OAuth2Audience: "https://api.example.com",
	})
	if gotForm.Get("audience") != "https://api.example.com" {
		t.Errorf("audience not forwarded: %#v", gotForm)
	}
}

func decodeJWT(t *testing.T, token string) (header, claims map[string]any) {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("not a compact JWS: %q", token)
	}
	header = map[string]any{}
	claims = map[string]any{}
	for i, target := range []*map[string]any{&header, &claims} {
		raw, err := base64.RawURLEncoding.DecodeString(parts[i])
		if err != nil {
			t.Fatalf("segment %d is not base64url: %v", i, err)
		}
		if err := json.Unmarshal(raw, target); err != nil {
			t.Fatalf("segment %d is not JSON: %v", i, err)
		}
	}
	return header, claims
}

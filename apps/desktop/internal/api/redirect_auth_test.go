package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func authorizationAfterRedirect(t *testing.T, from func(target string) *httptest.Server, target *httptest.Server, follow bool) string {
	t.Helper()
	var got string
	target.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
	})
	source := from(target.URL)
	defer source.Close()
	req := traceTestRequest(source.URL + "/start")
	req.EnableSSLVerification = false
	req.Auth = model.AuthConfig{Type: "bearer", Token: "SECRET"}
	req.FollowAuthorizationHeader = follow
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	return got
}

func redirectingServer(tls bool) func(target string) *httptest.Server {
	return func(target string) *httptest.Server {
		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, target+"/end", http.StatusFound)
		})
		if tls {
			return httptest.NewTLSServer(handler)
		}
		return httptest.NewServer(handler)
	}
}

func TestRedirectKeepsAuthorizationOnTheSameHost(t *testing.T) {
	for _, follow := range []bool{false, true} {
		var got string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/start" {
				http.Redirect(w, r, "/end", http.StatusFound)
				return
			}
			got = r.Header.Get("Authorization")
		}))
		req := traceTestRequest(server.URL + "/start")
		req.Auth = model.AuthConfig{Type: "bearer", Token: "SECRET"}
		req.FollowAuthorizationHeader = follow
		sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
		server.Close()
		if got != "Bearer SECRET" {
			t.Fatalf("follow=%v: expected a same-host redirect to keep the header, got %q", follow, got)
		}
	}
}

func TestRedirectToAnotherHostDropsAuthorizationUnlessFollowed(t *testing.T) {
	newTarget := func() *httptest.Server {
		target := httptest.NewServer(nil)
		target.URL = strings.Replace(target.URL, "127.0.0.1", "localhost", 1)
		return target
	}
	target := newTarget()
	defer target.Close()
	if got := authorizationAfterRedirect(t, redirectingServer(false), target, false); got != "" {
		t.Fatalf("expected the header to be dropped on a cross-host redirect, got %q", got)
	}
	if got := authorizationAfterRedirect(t, redirectingServer(false), target, true); got != "Bearer SECRET" {
		t.Fatalf("expected Follow Authorization header to keep it across hosts, got %q", got)
	}
}

func TestRedirectFromHTTPSToHTTPDropsAuthorizationEvenWhenFollowed(t *testing.T) {
	target := httptest.NewServer(nil)
	defer target.Close()
	if got := authorizationAfterRedirect(t, redirectingServer(true), target, true); got != "" {
		t.Fatalf("expected a downgrade to plain HTTP to drop the header, got %q", got)
	}
}

func TestRedirectFromHTTPToHTTPSOnTheSameHostKeepsAuthorization(t *testing.T) {
	target := httptest.NewTLSServer(nil)
	defer target.Close()
	if got := authorizationAfterRedirect(t, redirectingServer(false), target, false); got != "Bearer SECRET" {
		t.Fatalf("expected an upgrade on the same host to keep the header, got %q", got)
	}
}

func TestDigestRedirectRespectsAuthorizationPolicy(t *testing.T) {
	for _, tc := range []struct {
		name      string
		crossHost bool
		tlsSource bool
		follow    bool
		wantAuth  bool
	}{
		{name: "same host", wantAuth: true},
		{name: "foreign host", crossHost: true},
		{name: "foreign host allowed", crossHost: true, follow: true, wantAuth: true},
		{name: "TLS downgrade", tlsSource: true},
		{name: "TLS downgrade with forwarding", tlsSource: true, follow: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var received string
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				received = r.Header.Get("Authorization")
				if received == "" {
					w.Header().Set("WWW-Authenticate", `Digest realm="target", nonce="redirect-nonce", qop="auth", algorithm=MD5`)
					w.WriteHeader(http.StatusUnauthorized)
				}
			}))
			defer target.Close()
			targetURL := target.URL
			if tc.crossHost {
				targetURL = strings.Replace(targetURL, "127.0.0.1", "localhost", 1)
			}
			source := redirectingServer(tc.tlsSource)(targetURL)
			defer source.Close()
			req := traceTestRequest(source.URL)
			req.EnableSSLVerification = false
			req.Auth = model.AuthConfig{Type: "digest", Username: "user", Password: "password"}
			req.FollowAuthorizationHeader = tc.follow
			resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
			if resp.Error != "" {
				t.Fatal(resp.Error)
			}
			if got := strings.HasPrefix(received, "Digest "); got != tc.wantAuth {
				t.Fatalf("authenticated=%v, want %v; header=%q", got, tc.wantAuth, received)
			}
		})
	}
}

func TestZeroTimeoutWaitsIndefinitely(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(150 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := traceTestRequest(server.URL)
	req.TimeoutMs = 0
	if timeout := effectiveRequestTimeout(req); timeout != 0 {
		t.Fatalf("expected no timeout, got %s", timeout)
	}
	if resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache()); resp.Error != "" || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected the slow response to arrive, got status=%d error=%q", resp.StatusCode, resp.Error)
	}

	req.TimeoutMs = 20
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if !strings.Contains(resp.Error, "timed out after 20 ms") {
		t.Fatalf("expected a positive timeout to still apply, got %q", resp.Error)
	}
}

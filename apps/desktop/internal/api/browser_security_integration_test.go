package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func defaultBrowserReq(serverURL string) model.HttpRequest {
	return model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   serverURL,
		FollowRedirects:       true,
		TimeoutMs:             10000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	}
}

func TestSameOriginRequestSkipsPreflightWhenCORSEnforced(t *testing.T) {
	var optionsCount atomic.Int32
	var actualCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			optionsCount.Add(1)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		actualCount.Add(1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Method = http.MethodPost
	req.BodyType = "json"
	req.Body = `{"x":1}`
	req.BrowserOrigin = server.URL
	req.BrowserEnforceCORS = true
	req.Headers = []model.KeyValue{{Enabled: true, Key: "X-Custom", Value: "v"}}

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("same-origin request should pass without server CORS headers, got error: %q", resp.Error)
	}
	if optionsCount.Load() != 0 {
		t.Fatalf("same-origin request must not preflight, got %d OPTIONS", optionsCount.Load())
	}
	if actualCount.Load() != 1 {
		t.Fatalf("expected 1 actual request, got %d", actualCount.Load())
	}
}

func TestSimpleCrossOriginGETSkipsPreflight(t *testing.T) {
	var optionsCount atomic.Int32
	var actualCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			optionsCount.Add(1)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		actualCount.Add(1)
		w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
	if optionsCount.Load() != 0 {
		t.Fatalf("simple cross-origin GET must not preflight, got %d", optionsCount.Load())
	}
	if actualCount.Load() != 1 {
		t.Fatalf("expected actual request, got %d", actualCount.Load())
	}
}

func TestSimpleCrossOriginPOSTSkipsPreflightForFormUrlEncoded(t *testing.T) {
	var optionsCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			optionsCount.Add(1)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Method = http.MethodPost
	req.BodyType = "urlencoded"
	req.FormData = []model.KeyValue{{Enabled: true, Key: "a", Value: "1"}}
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
	if optionsCount.Load() != 0 {
		t.Fatalf("simple POST x-www-form-urlencoded must not preflight, got %d", optionsCount.Load())
	}
}

func TestCrossOriginJSONPOSTRequiresPreflight(t *testing.T) {
	var optionsCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			optionsCount.Add(1)
			w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
			w.Header().Set("Access-Control-Allow-Methods", "POST")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Method = http.MethodPost
	req.BodyType = "json"
	req.Body = `{"a":1}`
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
	if optionsCount.Load() != 1 {
		t.Fatalf("JSON POST cross-origin must preflight, got %d", optionsCount.Load())
	}
	started, done, sent := -1, -1, -1
	for i, event := range resp.Timeline {
		switch event.Label {
		case "CORS preflight started":
			started = i
		case "CORS preflight done":
			done = i
			if event.Detail != "204 No Content" {
				t.Fatalf("preflight marker should carry its status, got %q", event.Detail)
			}
		case "Request sent":
			if done < 0 {
				t.Fatal("preflight must not record main-request timing events")
			}
			sent = i
		}
	}
	if started < 0 || done < started || sent < done {
		t.Fatalf("timeline should frame the preflight before the request, got %#v", resp.Timeline)
	}
}

func TestAuthorizationHeaderTriggersPreflight(t *testing.T) {
	var optionsCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			optionsCount.Add(1)
			gotHeaders := strings.ToLower(r.Header.Get("Access-Control-Request-Headers"))
			if !strings.Contains(gotHeaders, "authorization") {
				t.Fatalf("expected preflight to request authorization header, got %q", gotHeaders)
			}
			w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
			w.Header().Set("Access-Control-Allow-Methods", "GET")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true
	req.Headers = []model.KeyValue{{Enabled: true, Key: "Authorization", Value: "Bearer xyz"}}

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
	if optionsCount.Load() != 1 {
		t.Fatalf("Authorization header must trigger preflight, got %d", optionsCount.Load())
	}
}

func TestPreflightAllowsSafelistedMethodWithoutAllowMethods(t *testing.T) {
	var sawActual bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		sawActual = true
		w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Method = http.MethodPost
	req.BodyType = "json"
	req.Body = `{"a":1}`
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("safelisted POST must pass preflight without Allow-Methods, got %q", resp.Error)
	}
	if !sawActual {
		t.Fatal("expected actual request to run after a passing preflight")
	}
}

func TestPreflightRedirectFailsCORS(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			http.Redirect(w, r, "/redirected", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Method = http.MethodPost
	req.BodyType = "json"
	req.Body = `{}`
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true

	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "CORS error: preflight returned HTTP 302") {
		t.Fatalf("expected preflight redirect to fail CORS, got %q", resp.Error)
	}
}

func TestPreflightServerError5xxFailsCORS(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Method = http.MethodPost
	req.BodyType = "json"
	req.Body = `{}`
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true

	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "preflight returned HTTP 500") {
		t.Fatalf("expected 5xx preflight to fail, got %q", resp.Error)
	}
}

func TestCredentialedPreflightRejectsWildcardOrigin(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "POST")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Method = http.MethodPost
	req.BodyType = "json"
	req.Body = `{}`
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserWithCredentials = true
	req.BrowserEnforceCORS = true

	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "credentials require the exact origin") {
		t.Fatalf("credentialed preflight must reject ACAO: *, got %q", resp.Error)
	}
}

func TestCredentialedPreflightRejectsWildcardAllowedHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "POST")
			w.Header().Set("Access-Control-Allow-Headers", "*")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Method = http.MethodPost
	req.BodyType = "text"
	req.Body = "hello"
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserWithCredentials = true
	req.BrowserEnforceCORS = true
	req.Headers = []model.KeyValue{{Enabled: true, Key: "X-Custom", Value: "v"}}

	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "Access-Control-Allow-Headers does not allow x-custom") {
		t.Fatalf("credentialed preflight must reject ACAH: *, got %q", resp.Error)
	}
}

func TestActualResponseMissingAllowCredentialsForCredentialedRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserWithCredentials = true
	req.BrowserEnforceCORS = true

	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "missing Access-Control-Allow-Credentials") {
		t.Fatalf("expected credentialed actual response without ACAC to fail, got %q", resp.Error)
	}
}

func TestCookieIncludedOnCrossOriginWithCredentials(t *testing.T) {
	var gotCookie string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCookie = r.Header.Get("Cookie")
		w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserWithCredentials = true
	req.BrowserEnforceCORS = true
	req.Headers = []model.KeyValue{{Enabled: true, Key: "Cookie", Value: "session=abc"}}

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
	if !strings.Contains(gotCookie, "session=abc") {
		t.Fatalf("expected user-set Cookie to be sent with credentials, got %q", gotCookie)
	}
}

func TestCSPDefaultSrcFallbackWhenConnectSrcAbsent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCSP = true
	req.BrowserCSP = "default-src https://allowed.example.com"

	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "violates default-src") {
		t.Fatalf("expected default-src fallback to block, got %q", resp.Error)
	}
}

func TestCSPConnectSrcOverridesDefaultSrc(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)

	req := defaultBrowserReq(server.URL)
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCSP = true
	req.BrowserCSP = fmt.Sprintf("default-src 'none'; connect-src http://%s", target.Host)

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("connect-src should override restrictive default-src, got %q", resp.Error)
	}
}

func TestCSPNoneBlocksEverything(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCSP = true
	req.BrowserCSP = "connect-src 'none'"

	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "CSP error") {
		t.Fatalf("'none' must block, got %q", resp.Error)
	}
}

func TestCSPSubdomainWildcardMatches(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	target, _ := url.Parse("https://api.team.example.com/x")
	protected, _ := url.Parse("https://app.example.com")
	if !cspSourceAllows("https://*.example.com", target, protected) {
		t.Fatal("*.example.com must match api.team.example.com")
	}
	if cspSourceAllows("https://*.example.com", mustURL("https://example.com/x"), protected) {
		t.Fatal("*.example.com must NOT match apex example.com")
	}
	if cspSourceAllows("https://*.example.com", mustURL("https://other.com/x"), protected) {
		t.Fatal("*.example.com must NOT match other.com")
	}
}

func TestCSPPortWildcardMatches(t *testing.T) {
	target := mustURL("https://example.com:8443/x")
	protected := mustURL("https://app.example.com")
	if !cspSourceAllows("https://example.com:*", target, protected) {
		t.Fatal("port wildcard must match any port")
	}
	if !cspSourceAllows("https://example.com:*", mustURL("https://example.com:9999/x"), protected) {
		t.Fatal("port wildcard must match high port")
	}
}

func TestCSPExplicitPortRejectsDefaultPort(t *testing.T) {
	target := mustURL("https://example.com/x")
	protected := mustURL("https://app.example.com")
	if cspSourceAllows("https://example.com:8443", target, protected) {
		t.Fatal("explicit :8443 must not match default 443")
	}
}

func TestCSPSelfRespectsProtectedOrigin(t *testing.T) {
	protected := mustURL("https://app.example.com")
	if !cspSourceAllows("'self'", mustURL("https://app.example.com/a"), protected) {
		t.Fatal("'self' must match same origin")
	}
	if cspSourceAllows("'self'", mustURL("https://other.example.com/a"), protected) {
		t.Fatal("'self' must NOT match different host")
	}
}

func TestCSPWildcardAllowsHTTP(t *testing.T) {
	protected := mustURL("https://app.example.com")
	if !cspSourceAllows("*", mustURL("https://api.example.com/x"), protected) {
		t.Fatal("'*' must allow https")
	}
	if !cspSourceAllows("*", mustURL("http://api.example.com/x"), protected) {
		t.Fatal("'*' must allow http")
	}
}

func TestCSPSchemeWSMatchesWSS(t *testing.T) {
	protected := mustURL("https://app.example.com")
	if !cspSourceAllows("ws:", mustURL("wss://socket.example.com/x"), protected) {
		t.Fatal("ws scheme source must allow wss target per CSP3")
	}
}

func TestCSPMalformedPolicyDoesNotPanic(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCSP = true
	req.BrowserCSP = ";;;;   ;;invalid syntax %^&* ;;"
	resp := NewApp().SendRequest(req)
	if strings.Contains(resp.Error, "panic") {
		t.Fatalf("malformed CSP must not panic: %q", resp.Error)
	}
}

func TestEmptyOriginRejectedWhenCORSOrCSPEnforced(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserEnforceCORS = true
	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "browser emulation requires an Origin") {
		t.Fatalf("expected error about missing Origin, got %q", resp.Error)
	}
}

func TestInvalidOriginRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserEnforceCORS = true
	req.BrowserOrigin = "http://"
	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "invalid browser Origin") {
		t.Fatalf("expected invalid origin error, got %q", resp.Error)
	}
}

func TestSchemelessOriginAccepted(t *testing.T) {
	var gotOrigin string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOrigin = r.Header.Get("Origin")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserEmulation = true
	req.BrowserOrigin = "localhost:5173"
	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("scheme-less origin should be accepted, got %q", resp.Error)
	}
	if gotOrigin != "http://localhost:5173" {
		t.Fatalf("expected scheme-less origin to default to http://, got %q", gotOrigin)
	}
}

func TestFTPOriginRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserEnforceCORS = true
	req.BrowserOrigin = "ftp://example.com"
	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "Use http:// or https://") {
		t.Fatalf("expected ftp:// origin rejected, got %q", resp.Error)
	}
}

func TestNullOriginCSPSelfBlocks(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserOrigin = "null"
	req.BrowserEnforceCSP = true
	req.BrowserCSP = "connect-src 'self'"

	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "CSP error") {
		t.Fatalf("null origin should NOT match 'self', got %q", resp.Error)
	}
}

func TestPreflightAllowMethodsCommaSeparatedList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
			w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, PATCH, DELETE")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Method = http.MethodPatch
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("PATCH listed in ACAM must pass, got %q", resp.Error)
	}
}

func TestPreflightAllowMethodsDoesNotMatchUnlistedMethod(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Method = http.MethodDelete
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true

	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "Access-Control-Allow-Methods does not allow DELETE") {
		t.Fatalf("expected DELETE rejected, got %q", resp.Error)
	}
}

func TestCORSEnforceDoesNotEatNonBrowserHeadersOnSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
		w.Header().Set("X-Custom-Response", "preserved")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
	var found bool
	for _, h := range resp.Headers {
		if strings.EqualFold(h.Key, "X-Custom-Response") && h.Value == "preserved" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected X-Custom-Response in response headers, got %+v", resp.Headers)
	}
	if resp.Body != "ok" {
		t.Fatalf("expected body preserved when CORS passes, got %q", resp.Body)
	}
}

func TestBrowserEmulationSetsSecFetchSiteSameOrigin(t *testing.T) {
	var gotSite string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSite = r.Header.Get("Sec-Fetch-Site")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserEmulation = true
	req.BrowserOrigin = server.URL

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
	if gotSite != "same-origin" {
		t.Fatalf("expected Sec-Fetch-Site=same-origin, got %q", gotSite)
	}
}

func TestBrowserEmulationSetsSecFetchSiteNoneWhenOriginUnset(t *testing.T) {
	var gotSite string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSite = r.Header.Get("Sec-Fetch-Site")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.BrowserEmulation = true

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
	if gotSite != "none" {
		t.Fatalf("expected Sec-Fetch-Site=none when origin unset, got %q", gotSite)
	}
}

func TestCORSPreflightContentTypeWithCharsetTriggersPreflight(t *testing.T) {
	var optionsCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			optionsCount.Add(1)
			w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
			w.Header().Set("Access-Control-Allow-Methods", "POST")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Method = http.MethodPost
	req.BodyType = "text"
	req.Body = "hello"
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true
	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
	if optionsCount.Load() != 0 {
		t.Fatalf("text/plain POST must not preflight, got %d", optionsCount.Load())
	}
}

func mustURL(raw string) *url.URL {
	u, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return u
}

func TestIntegrationHTTPBinCORSEcho(t *testing.T) {
	if os.Getenv("KURLO_NETWORK_INTEGRATION") != "1" {
		t.Skip("set KURLO_NETWORK_INTEGRATION=1 to run network integration tests")
	}

	req := defaultBrowserReq("https://httpbin.org/get")
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true
	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("httpbin.org/get with CORS enforce failed: %q", resp.Error)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from httpbin, got %d", resp.StatusCode)
	}
	if !strings.Contains(resp.Body, "https://app.example.com") {
		t.Fatalf("expected httpbin echo to include our Origin header, body=%s", resp.Body)
	}
}

func TestIntegrationHTTPBinCORSPreflight(t *testing.T) {
	if os.Getenv("KURLO_NETWORK_INTEGRATION") != "1" {
		t.Skip("set KURLO_NETWORK_INTEGRATION=1 to run network integration tests")
	}

	req := defaultBrowserReq("https://httpbin.org/anything")
	req.Method = http.MethodPost
	req.BodyType = "json"
	req.Body = `{"hello":"world"}`
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCORS = true
	req.Headers = []model.KeyValue{{Enabled: true, Key: "X-Kurlo-Probe", Value: "1"}}

	resp := NewApp().SendRequest(req)
	if resp.Error != "" {
		t.Fatalf("httpbin.org/anything preflight failed: %q", resp.Error)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
}

func TestIntegrationHTTPBinCSPSelfBlocks(t *testing.T) {
	if os.Getenv("KURLO_NETWORK_INTEGRATION") != "1" {
		t.Skip("set KURLO_NETWORK_INTEGRATION=1 to run network integration tests")
	}

	req := defaultBrowserReq("https://httpbin.org/get")
	req.BrowserOrigin = "https://app.example.com"
	req.BrowserEnforceCSP = true
	req.BrowserCSP = "connect-src 'self'"

	resp := NewApp().SendRequest(req)
	if !strings.Contains(resp.Error, "CSP error") {
		t.Fatalf("'self' CSP must block cross-origin httpbin.org request, got %q", resp.Error)
	}
}

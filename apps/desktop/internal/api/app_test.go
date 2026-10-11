package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestSendRequestDoesNotAutoSendEmptyRawBody(t *testing.T) {
	var gotBody string
	var gotContentType string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		gotBody = string(body)
		gotContentType = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   server.URL,
		BodyType:              "json",
		Body:                  "",
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotBody != "" {
		t.Fatalf("expected no request body, got %q", gotBody)
	}
	if gotContentType != "" {
		t.Fatalf("expected no auto Content-Type for empty raw body, got %q", gotContentType)
	}
}

func TestSendRequestDoesNotRedactJSONBodySecrets(t *testing.T) {
	payload := `{"carts":[{"productId":"4448cf41-7f4d-49c5-88fc-5f6e848537bf","count":1}],"catalogItemId":"c62aa06c-3041-4cbc-b16a-cca549e130ae","paymentSystemId":"077bdf4e-1377-4a4e-9942-92a66059f81c","accountUid":"https://s.team/p/gcqf-jdhf/jmdtqmcm","server":"test","region":"UA"}`
	var gotBody string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		gotBody = string(body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:                  http.MethodPost,
		URL:                     server.URL,
		BodyType:                "json",
		Body:                    payload,
		SecretEnvironmentKeys:   []string{"accountUid", "server", "region"},
		SecretEnvironmentValues: []string{"https://s.team/p/gcqf-jdhf/jmdtqmcm", "test", "UA"},
		FollowRedirects:         true,
		TimeoutMs:               5000,
		HTTPVersion:             "auto",
		EnableSSLVerification:   true,
		MaxRedirects:            10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotBody != payload {
		t.Fatalf("expected raw body to be sent unchanged\nwant: %s\n got: %s", payload, gotBody)
	}
	if strings.Contains(gotBody, "[REDACTED]") {
		t.Fatalf("request body was redacted before sending: %s", gotBody)
	}
}

func TestSendRequestUsesKurloUserAgentByDefault(t *testing.T) {
	var gotUserAgent string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUserAgent = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   server.URL,
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotUserAgent != "Kurlo/"+appVersion {
		t.Fatalf("expected Kurlo user agent, got %q", gotUserAgent)
	}
}

func TestReadResponseBodyWithLimitStopsAtLimit(t *testing.T) {
	body := strings.NewReader("0123456789abcdef")

	gotBody, truncated, err := readResponseBodyWithLimit(body, 10)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}
	if !truncated {
		t.Fatalf("expected response body to be truncated")
	}
	if string(gotBody) != "0123456789" {
		t.Fatalf("expected truncated body %q, got %q", "0123456789", string(gotBody))
	}
	if len(gotBody) != 10 {
		t.Fatalf("expected body capped to exactly 10 bytes, got %d", len(gotBody))
	}
}

func TestSendRequestExecutesGraphQLQuery(t *testing.T) {
	var gotMethod string
	var gotContentType string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotContentType = r.Header.Get("Content-Type")
		var payload struct {
			Query     string            `json:"query"`
			Variables map[string]string `json:"variables"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode graphql body: %v", err)
		}
		if !strings.Contains(payload.Query, "hero") {
			t.Fatalf("expected hero query, got %q", payload.Query)
		}
		if payload.Variables["episode"] != "NEWHOPE" {
			t.Fatalf("expected episode variable, got %#v", payload.Variables)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{"hero":{"name":"Luke Skywalker","episode":"NEWHOPE"}}}`))
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:                http.MethodPost,
		URL:                   server.URL,
		BodyType:              "graphql",
		Body:                  `{"query":"query Hero($episode: String!) { hero(episode: $episode) { name episode } }","variables":{"episode":"NEWHOPE"}}`,
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("expected POST, got %s", gotMethod)
	}
	if !strings.Contains(gotContentType, "application/json") {
		t.Fatalf("expected application/json content type, got %q", gotContentType)
	}
	if !strings.Contains(resp.Body, `"Luke Skywalker"`) {
		t.Fatalf("expected GraphQL response body, got %s", resp.Body)
	}
}

func TestSendGraphQLRequestAppliesAuthModes(t *testing.T) {
	graphqlBody := `{"query":"query Viewer { viewer { id } }","variables":{}}`
	bodyHashBytes := sha256.Sum256([]byte(graphqlBody))
	bodyHash := hex.EncodeToString(bodyHashBytes[:])

	tests := []struct {
		name  string
		auth  model.AuthConfig
		check func(*testing.T, *http.Request, string)
	}{
		{
			name: "bearer",
			auth: model.AuthConfig{Type: "bearer", Token: "bearer-token"},
			check: func(t *testing.T, r *http.Request, _ string) {
				if got := r.Header.Get("Authorization"); got != "Bearer bearer-token" {
					t.Fatalf("expected bearer authorization, got %q", got)
				}
			},
		},
		{
			name: "oauth2 bearer token",
			auth: model.AuthConfig{Type: "oauth2", Token: "oauth-token"},
			check: func(t *testing.T, r *http.Request, _ string) {
				if got := r.Header.Get("Authorization"); got != "Bearer oauth-token" {
					t.Fatalf("expected OAuth2 bearer authorization, got %q", got)
				}
			},
		},
		{
			name: "basic",
			auth: model.AuthConfig{Type: "basic", Username: "kurlo", Password: "secret"},
			check: func(t *testing.T, r *http.Request, _ string) {
				user, pass, ok := r.BasicAuth()
				if !ok || user != "kurlo" || pass != "secret" {
					t.Fatalf("expected basic auth kurlo/secret, got ok=%v user=%q pass=%q", ok, user, pass)
				}
			},
		},
		{
			name: "api key header",
			auth: model.AuthConfig{Type: "apikey", KeyName: "X-API-Key", KeyValue: "api-secret", KeyIn: "header"},
			check: func(t *testing.T, r *http.Request, _ string) {
				if got := r.Header.Get("X-API-Key"); got != "api-secret" {
					t.Fatalf("expected header API key, got %q", got)
				}
			},
		},
		{
			name: "api key query",
			auth: model.AuthConfig{Type: "apikey", KeyName: "api_key", KeyValue: "query-secret", KeyIn: "query"},
			check: func(t *testing.T, r *http.Request, _ string) {
				if got := r.URL.Query().Get("api_key"); got != "query-secret" {
					t.Fatalf("expected query API key, got %q", got)
				}
			},
		},
		{
			name: "aws signature v4",
			auth: model.AuthConfig{Type: "aws", AWSAccessKey: "AKID", AWSSecretKey: "SECRET", AWSRegion: "us-east-1", AWSService: "execute-api"},
			check: func(t *testing.T, r *http.Request, _ string) {
				authHeader := r.Header.Get("Authorization")
				if !strings.HasPrefix(authHeader, "AWS4-HMAC-SHA256 ") || !strings.Contains(authHeader, "Credential=AKID/") {
					t.Fatalf("expected AWS Signature V4 authorization, got %q", authHeader)
				}
				if got := r.Header.Get("X-Amz-Content-Sha256"); got != bodyHash {
					t.Fatalf("expected GraphQL body hash %q, got %q", bodyHash, got)
				}
				if got := r.Header.Get("X-Amz-Date"); got == "" {
					t.Fatal("expected X-Amz-Date to be set")
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Fatalf("read graphql body: %v", err)
				}
				if string(body) != graphqlBody {
					t.Fatalf("expected GraphQL body %s, got %s", graphqlBody, string(body))
				}
				tt.check(t, r, string(body))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"data":{"viewer":{"id":"1"}}}`))
			}))
			defer server.Close()

			resp := NewApp().SendRequest(model.HttpRequest{
				Method:                 http.MethodPost,
				URL:                    server.URL,
				Auth:                   tt.auth,
				BodyType:               "graphql",
				Body:                   graphqlBody,
				FollowRedirects:        true,
				TimeoutMs:              5000,
				HTTPVersion:            "auto",
				EnableSSLVerification:  true,
				EncodeURLAutomatically: true,
				MaxRedirects:           10,
			})
			if resp.Error != "" {
				t.Fatalf("unexpected response error: %s", resp.Error)
			}
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("expected status 200, got %d", resp.StatusCode)
			}
		})
	}
}

func TestSendGraphQLRequestUsesDigestAuth(t *testing.T) {
	const graphqlBody = `{"query":"query Viewer { viewer { id } }","variables":{}}`
	attempts := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read graphql body: %v", err)
		}
		if string(body) != graphqlBody {
			t.Fatalf("expected replayed GraphQL body %s, got %s", graphqlBody, string(body))
		}
		if attempts == 1 {
			w.Header().Set("WWW-Authenticate", `Digest realm="kurlo", nonce="nonce-1", qop="auth"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Digest ") || !strings.Contains(authHeader, `username="kurlo"`) {
			t.Fatalf("expected digest authorization on retry, got %q", authHeader)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{"viewer":{"id":"1"}}}`))
	}))
	defer server.Close()

	resp := NewApp().SendRequest(model.HttpRequest{
		Method:                http.MethodPost,
		URL:                   server.URL,
		Auth:                  model.AuthConfig{Type: "digest", Username: "kurlo", Password: "secret"},
		BodyType:              "graphql",
		Body:                  graphqlBody,
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})
	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if attempts != 2 {
		t.Fatalf("expected digest auth to retry once, got %d attempts", attempts)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}
}

func TestFetchOAuth2TokenUsesClientCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST token request, got %s", r.Method)
		}
		user, pass, ok := r.BasicAuth()
		if !ok || user != "client-id" || pass != "client-secret" {
			t.Fatalf("expected OAuth client credentials, got ok=%v user=%q pass=%q", ok, user, pass)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse token form: %v", err)
		}
		if got := r.Form.Get("grant_type"); got != "client_credentials" {
			t.Fatalf("expected client_credentials grant, got %q", got)
		}
		if got := r.Form.Get("scope"); got != "read write" {
			t.Fatalf("expected requested scope, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"access_token":"token-123","token_type":"Bearer","expires_in":3600}`))
	}))
	defer server.Close()

	result := NewApp().FetchOAuth2Token(model.AuthConfig{
		OAuth2TokenURL: server.URL,
		OAuth2ClientID: "client-id",
		OAuth2Secret:   "client-secret",
		OAuth2Scope:    "read write",
	})
	if result.Error != "" {
		t.Fatalf("unexpected OAuth2 error: %s", result.Error)
	}
	if result.AccessToken != "token-123" || result.TokenType != "Bearer" || result.ExpiresIn != 3600 {
		t.Fatalf("unexpected OAuth2 token response: %#v", result)
	}
}

func TestSendRequestDetectsEventStreamWithoutReadingBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		<-r.Context().Done()
	}))
	defer server.Close()

	app := NewApp()
	start := time.Now()
	resp := app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   server.URL,
		FollowRedirects:       true,
		TimeoutMs:             300,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})

	if time.Since(start) > 250*time.Millisecond {
		t.Fatal("expected event stream response to return before reading the body")
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}
	if resp.Body != "" {
		t.Fatalf("expected empty body for event stream marker, got %q", resp.Body)
	}
	if !strings.Contains(resp.Error, "SSE stream") {
		t.Fatalf("expected SSE stream marker error, got %q", resp.Error)
	}
}

func TestSendRequestAllowsUserAgentOverride(t *testing.T) {
	var gotUserAgent string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUserAgent = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method: http.MethodGet,
		URL:    server.URL,
		Headers: []model.KeyValue{
			{Enabled: true, Key: "User-Agent", Value: "CustomClient/1.0"},
		},
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotUserAgent != "CustomClient/1.0" {
		t.Fatalf("expected custom user agent, got %q", gotUserAgent)
	}
}

func TestSendRequestPreservesDuplicateParamsHeadersAndURLEncodedFields(t *testing.T) {
	var gotQueryValues []string
	var gotHeaderValues []string
	var gotFormValues []string
	var gotUserAgent string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQueryValues = append([]string(nil), r.URL.Query()["tag"]...)
		gotHeaderValues = append([]string(nil), r.Header.Values("X-Trace")...)
		gotUserAgent = r.Header.Get("User-Agent")
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		gotFormValues = append([]string(nil), r.PostForm["scope"]...)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	resp := NewApp().SendRequest(model.HttpRequest{
		Method: http.MethodPost,
		URL:    server.URL + "?tag=base",
		Params: []model.KeyValue{
			{Enabled: true, Key: "tag", Value: "one"},
			{Enabled: true, Key: "tag", Value: "two"},
		},
		Headers: []model.KeyValue{
			{Enabled: true, Key: "User-Agent", Value: "CustomClient/2.0"},
			{Enabled: true, Key: "X-Trace", Value: "first"},
			{Enabled: true, Key: "X-Trace", Value: "second"},
		},
		BodyType: "urlencoded",
		FormData: []model.KeyValue{
			{Enabled: true, Key: "scope", Value: "read"},
			{Enabled: true, Key: "scope", Value: "write"},
		},
		EncodeURLAutomatically: true,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if got := strings.Join(gotQueryValues, ","); got != "base,one,two" {
		t.Fatalf("duplicate query values were not preserved: %q", got)
	}
	if got := strings.Join(gotHeaderValues, ","); got != "first,second" {
		t.Fatalf("duplicate header values were not preserved: %q", got)
	}
	if gotUserAgent != "CustomClient/2.0" {
		t.Fatalf("expected user header to override default User-Agent, got %q", gotUserAgent)
	}
	if got := strings.Join(gotFormValues, ","); got != "read,write" {
		t.Fatalf("duplicate form values were not preserved: %q", got)
	}
}

func TestSendRequestCanBeCanceled(t *testing.T) {
	started := make(chan struct{})
	released := make(chan struct{})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(released)
	}))
	defer server.Close()

	app := NewApp()
	done := make(chan model.HttpResponse, 1)
	go func() {
		done <- app.SendRequest(model.HttpRequest{
			RequestID:             "req-cancel",
			Method:                http.MethodGet,
			URL:                   server.URL,
			FollowRedirects:       true,
			TimeoutMs:             5000,
			HTTPVersion:           "auto",
			EnableSSLVerification: true,
			MaxRedirects:          10,
		})
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("server did not receive request")
	}

	app.CancelRequest("req-cancel")

	select {
	case <-released:
	case <-time.After(2 * time.Second):
		t.Fatal("server request context was not canceled")
	}

	select {
	case resp := <-done:
		if resp.Error != "Request canceled" {
			t.Fatalf("expected canceled error, got %q", resp.Error)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("send request did not return after cancel")
	}
}

func TestPreRequestCanUnsetHeadersAndParams(t *testing.T) {
	var gotRemovedHeader string
	var gotKeptHeader string
	var gotQuery url.Values

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRemovedHeader = r.Header.Get("X-Remove")
		gotKeptHeader = r.Header.Get("X-Keep")
		gotQuery = r.URL.Query()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method: http.MethodGet,
		URL:    server.URL,
		Headers: []model.KeyValue{
			{Enabled: true, Key: "X-Remove", Value: "remove-me"},
			{Enabled: true, Key: "X-Keep", Value: "keep-me"},
		},
		Params: []model.KeyValue{
			{Enabled: true, Key: "remove", Value: "1"},
			{Enabled: true, Key: "keep", Value: "2"},
		},
		PreRequestScript: `
pm.request.headers.unset("x-remove")
pm.request.params.unset("remove")
`,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotRemovedHeader != "" {
		t.Fatalf("expected X-Remove to be unset, got %q", gotRemovedHeader)
	}
	if gotKeptHeader != "keep-me" {
		t.Fatalf("expected X-Keep to remain, got %q", gotKeptHeader)
	}
	if gotQuery.Get("remove") != "" {
		t.Fatalf("expected remove query param to be unset, got %q", gotQuery.Get("remove"))
	}
	if gotQuery.Get("keep") != "2" {
		t.Fatalf("expected keep query param to remain, got %q", gotQuery.Get("keep"))
	}
}

func TestTestScriptReceivesFinalRequestContext(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method: http.MethodGet,
		URL:    server.URL,
		PreRequestScript: `
pm.request.headers.set("X-From-Pre", "yes")
pm.request.params.set("from", "script")
`,
		TestScript: `
pm.test("method is visible", pm.request.method == "GET")
pm.test("header is visible", pm.request.headers.get("x-from-pre") == "yes")
pm.test("param is visible", pm.request.params.get("from") == "script")
`,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if len(resp.TestResult.Tests) != 3 {
		t.Fatalf("expected 3 test results, got %d: %#v", len(resp.TestResult.Tests), resp.TestResult.Tests)
	}
	for _, result := range resp.TestResult.Tests {
		if !result.Passed {
			t.Fatalf("expected test %q to pass: %s", result.Name, result.Error)
		}
	}
}

func TestJSEngineRunsPreRequestAndTestScripts(t *testing.T) {
	var gotHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("X-Token")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":7,"items":["a","b"]}`))
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:       http.MethodGet,
		URL:          server.URL,
		ScriptEngine: "js",
		PreRequestScript: `
const token = "abc-" + (1 + 2);
pm.request.headers.set("X-Token", token);
`,
		TestScript: `
pm.test("status is 200", () => pm.expect(pm.response.code).to.eql(200));
const data = pm.response.json();
pm.test("id is 7", () => pm.expect(data.id).to.equal(7));
pm.test("has two items", () => pm.expect(data.items).to.have.lengthOf(2));
`,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotHeader != "abc-3" {
		t.Fatalf("expected JS pre-request to set X-Token=abc-3, got %q", gotHeader)
	}
	if len(resp.TestResult.Tests) != 3 {
		t.Fatalf("expected 3 test results, got %d: %#v", len(resp.TestResult.Tests), resp.TestResult.Tests)
	}
	for _, result := range resp.TestResult.Tests {
		if !result.Passed {
			t.Fatalf("expected JS test %q to pass: %s", result.Name, result.Error)
		}
	}
}

func TestPreRequestScriptErrorAbortsRequest(t *testing.T) {
	hit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   server.URL,
		PreRequestScript:      "pm.environment.set(\"nonce\", \"123\")\n1 / 0",
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})

	if hit {
		t.Fatal("expected request not to be sent after pre-request script error")
	}
	if !strings.Contains(resp.Error, "pre-request script failed") {
		t.Fatalf("expected pre-request failure response, got %q", resp.Error)
	}
	if resp.PreRequestResult.Error == "" {
		t.Fatal("expected pre-request result error to be preserved")
	}
	if got := app.GetEnvironment()["nonce"]; got != "123" {
		t.Fatalf("expected script environment mutation to persist, got %q", got)
	}
}

func TestGraphQLRequestRunsPreRequestAndTestScripts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-From-Pre"); got != "yes" {
			t.Fatalf("expected pre-request header, got %q", got)
		}
		if got := r.URL.Query().Get("from"); got != "script" {
			t.Fatalf("expected pre-request query param, got %q", got)
		}
		var payload struct {
			Query string `json:"query"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode graphql body: %v", err)
		}
		if !strings.Contains(payload.Query, "viewer") {
			t.Fatalf("expected viewer query, got %q", payload.Query)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{"viewer":{"id":"1"}}}`))
	}))
	defer server.Close()

	resp := NewApp().SendRequest(model.HttpRequest{
		Method:   http.MethodPost,
		URL:      server.URL,
		BodyType: "graphql",
		Body:     `{"query":"query Viewer { viewer { id } }","variables":{}}`,
		PreRequestScript: `
pm.request.headers.set("X-From-Pre", "yes")
pm.request.params.set("from", "script")
`,
		TestScript: `
pm.test("graphql response json is visible", pm.response.json().data.viewer.id == "1")
pm.test("pre-request header is visible", pm.request.headers.get("x-from-pre") == "yes")
pm.test("pre-request param is visible", pm.request.params.get("from") == "script")
`,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if resp.PreRequestResult.Error != "" {
		t.Fatalf("unexpected pre-request script error: %s", resp.PreRequestResult.Error)
	}
	if resp.TestResult.Error != "" {
		t.Fatalf("unexpected test script error: %s", resp.TestResult.Error)
	}
	if len(resp.TestResult.Tests) != 3 {
		t.Fatalf("expected 3 test results, got %d: %#v", len(resp.TestResult.Tests), resp.TestResult.Tests)
	}
	for _, result := range resp.TestResult.Tests {
		if !result.Passed {
			t.Fatalf("expected test %q to pass: %s", result.Name, result.Error)
		}
	}
}

func TestSecretEnvironmentValuesAreRedactedFromScriptLogs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	app := NewApp()
	app.SetEnvironment(map[string]string{"token": "super-secret-token"})
	resp := app.SendRequest(model.HttpRequest{
		Method: http.MethodGet,
		URL:    server.URL,
		PreRequestScript: `
pm.log("pre", pm.environment.get("token"))
`,
		TestScript: `
pm.log("test", pm.environment.get("token"))
`,
		SecretEnvironmentValues: []string{"super-secret-token"},
		FollowRedirects:         true,
		TimeoutMs:               5000,
		HTTPVersion:             "auto",
		EnableSSLVerification:   true,
		MaxRedirects:            10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if got := strings.Join(resp.PreRequestResult.Logs, "\n"); strings.Contains(got, "super-secret-token") || !strings.Contains(got, "[secret]") {
		t.Fatalf("expected pre-request logs to be redacted, got %q", got)
	}
	if got := strings.Join(resp.TestResult.Logs, "\n"); strings.Contains(got, "super-secret-token") || !strings.Contains(got, "[secret]") {
		t.Fatalf("expected test logs to be redacted, got %q", got)
	}
}

func TestCookieJarCanBeListedEditedAndCleared(t *testing.T) {
	var gotCookieHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/set":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "abc123", Path: "/", HttpOnly: true})
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("set"))
		case "/echo":
			gotCookieHeader = r.Header.Get("Cookie")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("echo"))
		case "/manual-set":
			gotCookieHeader = r.Header.Get("Cookie")
			http.SetCookie(w, &http.Cookie{Name: "frommanual", Value: "stored", Path: "/"})
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("manual set"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	serverURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	host := serverURL.Hostname()
	app := NewApp()

	resp := app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   server.URL + "/set",
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})
	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}

	cookies := app.ListCookies("")
	if len(cookies) != 1 {
		t.Fatalf("expected one cookie in jar, got %#v", cookies)
	}
	if cookies[0].Name != "session" || cookies[0].Value != "abc123" || cookies[0].Domain != host || cookies[0].Path != "/" || !cookies[0].HTTPOnly {
		t.Fatalf("unexpected listed cookie: %#v", cookies[0])
	}

	upsertResult := app.UpsertCookie("", model.Cookie{
		Name:     "theme",
		Value:    "dark",
		Domain:   host,
		Path:     "/",
		Session:  true,
		HostOnly: true,
	})
	if upsertResult.Error != "" {
		t.Fatalf("unexpected upsert error: %s", upsertResult.Error)
	}

	gotCookieHeader = ""
	resp = app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   server.URL + "/echo",
		Headers:               []model.KeyValue{{Key: "Cookie", Value: "manual=1", Enabled: true}},
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})
	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotCookieHeader != "manual=1" {
		t.Fatalf("expected explicit Cookie header to override jar cookies, got %q", gotCookieHeader)
	}

	gotCookieHeader = ""
	resp = app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   server.URL + "/manual-set",
		Headers:               []model.KeyValue{{Key: "Cookie", Value: "manual=2", Enabled: true}},
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})
	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotCookieHeader != "manual=2" {
		t.Fatalf("expected explicit Cookie header without jar cookies, got %q", gotCookieHeader)
	}
	storedManualResponseCookie := false
	for _, cookie := range app.ListCookies("") {
		if cookie.Name == "frommanual" && cookie.Value == "stored" {
			storedManualResponseCookie = true
		}
	}
	if !storedManualResponseCookie {
		t.Fatal("expected Set-Cookie response to be stored even when request uses an explicit Cookie header")
	}

	resp = app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   server.URL + "/echo",
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})
	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if !strings.Contains(gotCookieHeader, "session=abc123") || !strings.Contains(gotCookieHeader, "theme=dark") {
		t.Fatalf("expected stored and edited cookies to be sent, got %q", gotCookieHeader)
	}

	app.DeleteCookie("", cookies[0])
	gotCookieHeader = ""
	resp = app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   server.URL + "/echo",
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})
	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if strings.Contains(gotCookieHeader, "session=abc123") || !strings.Contains(gotCookieHeader, "theme=dark") {
		t.Fatalf("expected session cookie deleted and manual cookie kept, got %q", gotCookieHeader)
	}

	app.ClearCookies("")
	gotCookieHeader = ""
	resp = app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   server.URL + "/echo",
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})
	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotCookieHeader != "" {
		t.Fatalf("expected cookie jar to be empty after clear, got %q", gotCookieHeader)
	}
}

func TestSendRequestAcceptsURLWithoutScheme(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   server.URL[len("http://"):],
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})

	if resp.Error != "" {
		t.Fatalf("expected URL without scheme to be normalized, got error %q", resp.Error)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}
}

func TestSendRequestReportsUnsupportedSchemeClearly(t *testing.T) {
	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:                http.MethodGet,
		URL:                   "ftp://example.com/resource",
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})

	if resp.Error != `unsupported URL scheme "ftp". Use http:// or https://.` {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
}

func TestFormatRequestErrorMatchesPostmanStyleConnectionRefused(t *testing.T) {
	target, err := url.Parse("http://localhost:3005/api/public/auth/tg/bind")
	if err != nil {
		t.Fatalf("parse URL: %v", err)
	}

	got := formatRequestError(errors.New(`Post "http://localhost:3005/api/public/auth/tg/bind": dial tcp [::1]:3005: connect: connection refused`), target, 30*time.Second)
	want := "Error: connect ECONNREFUSED 127.0.0.1:3005"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestFormatRequestErrorNetworkReachability(t *testing.T) {
	target, err := url.Parse("http://example.test:80")
	if err != nil {
		t.Fatalf("parse URL: %v", err)
	}

	cases := []struct {
		name string
		err  error
		want string
	}{
		{name: "no route", err: errors.New(`Get "http://example.test": dial tcp 192.0.2.1:80: connect: no route to host`), want: "Error: connect EHOSTUNREACH example.test:80"},
		{name: "network unreachable", err: errors.New(`Get "http://example.test": dial tcp 192.0.2.1:80: connect: network is unreachable`), want: "Error: connect ENETUNREACH example.test:80"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			if got := formatRequestError(tt.err, target, 30*time.Second); got != tt.want {
				t.Fatalf("expected %q, got %q", tt.want, got)
			}
		})
	}
}

func TestSendRequestRejectsBarePortLikeURL(t *testing.T) {
	app := NewApp()
	for _, rawURL := range []string{"23323", "http://23323"} {
		t.Run(rawURL, func(t *testing.T) {
			resp := app.SendRequest(model.HttpRequest{
				Method:                http.MethodGet,
				URL:                   rawURL,
				FollowRedirects:       true,
				TimeoutMs:             5000,
				HTTPVersion:           "auto",
				EnableSSLVerification: true,
				MaxRedirects:          10,
			})

			want := "invalid URL: enter a host. If this is a port, use http://localhost:<port>."
			if resp.Error != want {
				t.Fatalf("expected %q, got %q", want, resp.Error)
			}
		})
	}
}

func TestApplyQueryParamsEscapesKeyAndValue(t *testing.T) {
	u, err := url.Parse("https://example.com/path?existing=1")
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	applyQueryParams(u, model.HttpRequest{
		Params: []model.KeyValue{{Enabled: true, Key: "a key&x", Value: "value with spaces&equals=#"}},
	})

	want := "existing=1&a+key%26x=value+with+spaces%26equals%3D%23"
	if u.RawQuery != want {
		t.Fatalf("expected %q, got %q", want, u.RawQuery)
	}
}

func TestApplyQueryParamsPreservesOrder(t *testing.T) {
	for _, autoEncode := range []bool{true, false} {
		name := "manual encoding"
		if autoEncode {
			name = "automatic encoding"
		}
		t.Run(name, func(t *testing.T) {
			u, err := url.Parse("https://example.com/sign?z_url=0")
			if err != nil {
				t.Fatalf("parse url: %v", err)
			}
			applyQueryParams(u, model.HttpRequest{
				Params: []model.KeyValue{
					{Enabled: true, Key: "z_last", Value: "1"},
					{Enabled: false, Key: "skipped", Value: "x"},
					{Enabled: true, Key: "a_first", Value: "2"},
					{Enabled: true, Key: "m_mid", Value: "3"},
				},
				Auth:                   model.AuthConfig{Type: "apikey", KeyIn: "query", KeyName: "api_key", KeyValue: "k"},
				EncodeURLAutomatically: autoEncode,
			})

			want := "z_url=0&z_last=1&a_first=2&m_mid=3&api_key=k"
			if u.RawQuery != want {
				t.Fatalf("expected %q, got %q", want, u.RawQuery)
			}
		})
	}
}

func TestApplyQueryParamsKeepsRepeatedKeysInOrder(t *testing.T) {
	u, err := url.Parse("https://example.com/list?tag=a&other=1&tag=b")
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	applyQueryParams(u, model.HttpRequest{
		Params:                 []model.KeyValue{{Enabled: true, Key: "tag", Value: "c"}},
		EncodeURLAutomatically: true,
	})

	want := "tag=a&other=1&tag=b&tag=c"
	if u.RawQuery != want {
		t.Fatalf("expected %q, got %q", want, u.RawQuery)
	}
}

func TestApplyQueryParamsKeepsBareFlag(t *testing.T) {
	u, err := url.Parse("https://example.com/search?debug&verbose=")
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	applyQueryParams(u, model.HttpRequest{EncodeURLAutomatically: true})

	want := "debug&verbose="
	if u.RawQuery != want {
		t.Fatalf("expected %q, got %q", want, u.RawQuery)
	}
}

func TestApplyQueryParamsReencodesExistingQueryWhenAutomatic(t *testing.T) {
	u, err := url.Parse("https://example.com/s?q=a b&raw=%zz")
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	applyQueryParams(u, model.HttpRequest{EncodeURLAutomatically: true})

	want := "q=a+b&raw=%25zz"
	if u.RawQuery != want {
		t.Fatalf("expected %q, got %q", want, u.RawQuery)
	}
}

func TestApplyQueryParamsLeavesExistingQueryAloneWhenManual(t *testing.T) {
	u, err := url.Parse("https://example.com/s?q=a%20b&raw=%zz")
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	applyQueryParams(u, model.HttpRequest{EncodeURLAutomatically: false})

	want := "q=a%20b&raw=%zz"
	if u.RawQuery != want {
		t.Fatalf("expected %q, got %q", want, u.RawQuery)
	}
}

func TestRequestStoreSavesEncryptedPayloadAndLoadsPlaintext(t *testing.T) {
	withRequestStoreTestKey(t)
	path := filepath.Join(t.TempDir(), "requests.json")
	payload := `{"auth":{"bearerToken":"secret-token","awsSecretKey":"aws-secret"}}`

	if err := saveRequestStorePayload(path, payload); err != nil {
		t.Fatalf("save request store: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read request store: %v", err)
	}
	if strings.Contains(string(raw), "secret-token") || strings.Contains(string(raw), "aws-secret") {
		t.Fatalf("request store was written in plaintext: %s", string(raw))
	}
	if !isEncryptedRequestStore(raw) {
		t.Fatalf("expected encrypted request store envelope, got %s", string(raw))
	}

	loaded, err := loadRequestStorePayload(path)
	if err != nil {
		t.Fatalf("load request store: %v", err)
	}
	if loaded != payload {
		t.Fatalf("expected %q, got %q", payload, loaded)
	}
}

func TestRequestStoreRejectsPlaintextPayload(t *testing.T) {
	withRequestStoreTestKey(t)
	path := filepath.Join(t.TempDir(), "requests.json")
	payload := `{"requests":[]}`
	if err := os.WriteFile(path, []byte(payload), 0600); err != nil {
		t.Fatalf("write plaintext request store: %v", err)
	}

	if _, err := loadRequestStorePayload(path); err == nil || !strings.Contains(err.Error(), "not encrypted") {
		t.Fatalf("expected plaintext request store to be rejected, got %v", err)
	}
}

func TestSaveRequestStoreWithErrorReportsCause(t *testing.T) {
	withRequestStoreTestKey(t)
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)

	result := NewApp().SaveRequestStoreWithError(`{"requests":`)
	if result.Ok {
		t.Fatal("expected invalid payload save to fail")
	}
	if !strings.Contains(result.Error, "unexpected end of JSON input") {
		t.Fatalf("expected JSON parse error, got %q", result.Error)
	}
	if NewApp().SaveRequestStore(`{"requests":`) {
		t.Fatal("legacy bool save wrapper should report false")
	}
}

func TestRequestStoreSaveReplacesExistingPayload(t *testing.T) {
	withRequestStoreTestKey(t)
	path := filepath.Join(t.TempDir(), "requests.json")

	if err := saveRequestStorePayload(path, `{"requests":["old"]}`); err != nil {
		t.Fatalf("save initial request store: %v", err)
	}
	if err := saveRequestStorePayload(path, `{"requests":["new"]}`); err != nil {
		t.Fatalf("replace request store: %v", err)
	}

	loaded, err := loadRequestStorePayload(path)
	if err != nil {
		t.Fatalf("load request store: %v", err)
	}
	if loaded != `{"requests":["new"]}` {
		t.Fatalf("expected replacement payload, got %q", loaded)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read raw request store: %v", err)
	}
	if strings.Contains(string(raw), "old") || strings.Contains(string(raw), "new") {
		t.Fatalf("request store replacement leaked plaintext: %s", string(raw))
	}
}

func TestRequestStoreDecryptFallsBackToFileKey(t *testing.T) {
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)

	rightKey := bytes.Repeat([]byte{3}, requestStoreKeySize)
	wrongKey := bytes.Repeat([]byte{4}, requestStoreKeySize)
	previousProvider := requestStoreKeyProvider
	previousLoader := requestStoreKeyLoader
	t.Cleanup(func() {
		requestStoreKeyProvider = previousProvider
		requestStoreKeyLoader = previousLoader
		requestStoreKeyMu.Lock()
		requestStoreKeyCache = nil
		requestStoreKeyMu.Unlock()
	})
	setTestRequestStoreKey := func(key []byte) {
		requestStoreKeyMu.Lock()
		requestStoreKeyCache = nil
		requestStoreKeyMu.Unlock()
		requestStoreKeyProvider = func() ([]byte, error) {
			return append([]byte(nil), key...), nil
		}
		requestStoreKeyLoader = requestStoreKeyProvider
	}

	path := filepath.Join(t.TempDir(), "requests.json")
	payload := `{"requests":["saved"]}`
	setTestRequestStoreKey(rightKey)
	if err := saveRequestStorePayload(path, payload); err != nil {
		t.Fatalf("save request store: %v", err)
	}
	if err := os.MkdirAll(requestStoreDir(), 0755); err != nil {
		t.Fatalf("create request store dir: %v", err)
	}
	if err := os.WriteFile(requestStoreKeyPath(), []byte(base64.StdEncoding.EncodeToString(rightKey)), 0600); err != nil {
		t.Fatalf("write fallback key: %v", err)
	}

	setTestRequestStoreKey(wrongKey)
	loaded, err := loadRequestStorePayload(path)
	if err != nil {
		t.Fatalf("load request store with fallback key: %v", err)
	}
	if loaded != payload {
		t.Fatalf("expected %q, got %q", payload, loaded)
	}
}

func TestSaveRequestStoreRecoversUnreadableLocalMetadataForYAMLWorkspace(t *testing.T) {
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)

	oldKey := bytes.Repeat([]byte{5}, requestStoreKeySize)
	newKey := bytes.Repeat([]byte{6}, requestStoreKeySize)
	previousProvider := requestStoreKeyProvider
	previousLoader := requestStoreKeyLoader
	t.Cleanup(func() {
		requestStoreKeyProvider = previousProvider
		requestStoreKeyLoader = previousLoader
		requestStoreKeyMu.Lock()
		requestStoreKeyCache = nil
		requestStoreKeyMu.Unlock()
	})
	setTestRequestStoreKey := func(key []byte) {
		requestStoreKeyMu.Lock()
		requestStoreKeyCache = nil
		requestStoreKeyMu.Unlock()
		requestStoreKeyProvider = func() ([]byte, error) {
			return append([]byte(nil), key...), nil
		}
		requestStoreKeyLoader = requestStoreKeyProvider
	}

	setTestRequestStoreKey(oldKey)
	if err := saveKurloStorePayload(requestStorePath(), defaultFileWorkspaceStorePath(), kurloSaveFlowPayload("/old", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save initial kurlo store: %v", err)
	}
	setTestRequestStoreKey(newKey)
	result := NewApp().SaveRequestStoreWithError(kurloSaveFlowPayload("/new", "token-b", []string{"req-main"}, ""))
	if !result.Ok {
		t.Fatalf("expected recovery save to succeed, got %q", result.Error)
	}
	backups, err := filepath.Glob(requestStorePath() + ".recovery-*.bak")
	if err != nil {
		t.Fatalf("glob recovery backups: %v", err)
	}
	if len(backups) != 1 {
		t.Fatalf("expected one recovery backup, got %d (%v)", len(backups), backups)
	}
	loaded, err := loadKurloStorePayload(requestStorePath(), defaultFileWorkspaceStorePath())
	if err != nil {
		t.Fatalf("load recovered kurlo store: %v", err)
	}
	if !strings.Contains(loaded, "/new") {
		t.Fatalf("recovered store did not contain new payload:\n%s", loaded)
	}
}

func TestRequestStoreDisableKeychainUsesFileKey(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(requestStoreDisableKeychain, "1")
	useTempConfigDir(t, dir)
	path := filepath.Join(dir, "requests.json")
	payload := `{"requests":[]}`

	if err := saveRequestStorePayload(path, payload); err != nil {
		t.Fatalf("save request store with keychain disabled: %v", err)
	}
	if _, err := os.Stat(requestStoreKeyPath()); err != nil {
		t.Fatalf("expected file-based request store key: %v", err)
	}
	loaded, err := loadRequestStorePayload(path)
	if err != nil {
		t.Fatalf("load request store with keychain disabled: %v", err)
	}
	if loaded != payload {
		t.Fatalf("expected %q, got %q", payload, loaded)
	}
}

func TestRequestStoreKeychainDisabledEnvValues(t *testing.T) {
	for _, value := range []string{"1", "true", "TRUE", "yes", "on"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv(requestStoreDisableKeychain, value)
			if !requestStoreKeychainDisabled() {
				t.Fatalf("expected %q to disable keychain", value)
			}
		})
	}
	t.Setenv(requestStoreDisableKeychain, "0")
	if requestStoreKeychainDisabled() {
		t.Fatalf("did not expect 0 to disable keychain")
	}
}

func TestKurloStoreSplitsRequestsIntoWorkspaceYAMLAndLocalEncryptedState(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	payload := `{
  "version": 2,
  "activeId": "req-login-admin",
  "activeWorkspaceId": "workspace-main",
  "openIds": ["req-login-user", "req-login-admin"],
  "folderCollapsed": {"collection-main:Auth": true},
  "workspaces": [
    {"id":"workspace-main","name":"Main Workspace","description":"","createdAt":1,"updatedAt":1}
  ],
  "collections": [
    {"id":"collection-main","workspaceId":"workspace-main","name":"Core API","description":"","collapsed":false,"defaults":{"headers":[{"id":21,"enabled":true,"key":"X-Collection-Secret","value":"collection-header-secret","description":"","secret":true}],"variables":[{"id":22,"enabled":true,"key":"collectionToken","value":"collection-var-secret","description":"","secret":true}],"auth":{"type":"apikey","apiKeyName":"X-Collection-Key","apiKeyValue":"collection-api-secret","apiKeyIn":"header"}},"createdAt":1,"updatedAt":1}
  ],
  "environments": [
    {"id":"environment-local","workspaceId":"workspace-main","name":"Local","values":[
      {"id":1,"enabled":true,"key":"accessToken","value":"env-secret-token","description":"","secret":true},
      {"id":2,"enabled":true,"key":"baseUrl","value":"https://example.test","description":"","secret":false}
    ],"createdAt":1,"updatedAt":1}
  ],
  "requests": [
    {"id":"req-login-user","name":"Login","requestType":"http","isDraft":false,"collectionId":"collection-main","collection":"Core API","folderPath":["Auth"],"method":"POST","url":"{{baseUrl}}/login","requestTab":"params","params":[],"headers":[{"id":11,"enabled":true,"key":"X-Internal-Token","value":"header-secret","description":"","secret":true}],"auth":{"type":"bearer","bearerToken":"user-token","basicUser":"","basicPass":"","apiKeyName":"","apiKeyValue":"","apiKeyIn":"header","oauth2TokenURL":"","oauth2ClientID":"","oauth2Secret":"","oauth2Scope":"","oauth2Token":"","awsAccessKey":"","awsSecretKey":"","awsRegion":"","awsService":""},"bodyType":"none","rawBodyType":"json","bodyContent":"","bodyFilePath":"","bodyFileName":"","formRows":[],"preRequestScript":"","testScript":"","requestNotes":"","settings":{"timeoutMs":30000},"createdAt":1,"updatedAt":1},
    {"id":"req-login-admin","name":"Login","requestType":"http","isDraft":false,"collectionId":"collection-main","collection":"Core API","folderPath":["Auth"],"method":"POST","url":"{{baseUrl}}/admin/login","requestTab":"params","params":[],"headers":[],"auth":{"type":"basic","bearerToken":"","basicUser":"admin","basicPass":"admin-password","apiKeyName":"","apiKeyValue":"","apiKeyIn":"header","oauth2TokenURL":"","oauth2ClientID":"","oauth2Secret":"","oauth2Scope":"","oauth2Token":"","awsAccessKey":"","awsSecretKey":"","awsRegion":"","awsService":""},"bodyType":"none","rawBodyType":"json","bodyContent":"","bodyFilePath":"","bodyFileName":"","formRows":[],"preRequestScript":"","testScript":"","requestNotes":"","settings":{"timeoutMs":30000},"createdAt":2,"updatedAt":2}
  ],
  "history": [{"id":"history-1","statusCode":200}],
  "workspaceCookies": {"workspace-main":[{"name":"scoped","value":"workspace-cookie-secret","domain":"example.test","path":"/","hostOnly":true,"session":true}]}
}`

	if err := saveKurloStorePayload(localPath, workspaceRoot, payload); err != nil {
		t.Fatalf("save kurlo store: %v", err)
	}

	workspaceText := readAllText(t, workspaceRoot)
	if strings.Contains(workspaceText, "theme:") {
		t.Fatalf("workspace YAML should not persist removed workspace theme settings:\n%s", workspaceText)
	}
	for _, secret := range []string{"user-token", "admin-password", "header-secret", "env-secret-token", "collection-header-secret", "collection-var-secret", "collection-api-secret", "workspace-cookie-secret"} {
		if strings.Contains(workspaceText, secret) {
			t.Fatalf("workspace YAML leaked secret %q:\n%s", secret, workspaceText)
		}
	}
	if !strings.Contains(workspaceText, "{{kurloSecret:request.req-login-user.auth.bearerToken}}") {
		t.Fatalf("expected bearer token placeholder in workspace YAML:\n%s", workspaceText)
	}
	if !strings.Contains(workspaceText, "{{kurloSecret:environment.environment-local.row.1.value}}") {
		t.Fatalf("expected environment secret placeholder in workspace YAML:\n%s", workspaceText)
	}
	if !strings.Contains(workspaceText, "{{kurloSecret:request.req-login-user.headers.row.11.value}}") {
		t.Fatalf("expected request row secret placeholder in workspace YAML:\n%s", workspaceText)
	}
	if !strings.Contains(workspaceText, "{{kurloSecret:collection.collection-main.auth.apiKeyValue}}") {
		t.Fatalf("expected collection auth secret placeholder in workspace YAML:\n%s", workspaceText)
	}
	if !strings.Contains(workspaceText, "{{kurloSecret:collection.collection-main.headers.row.21.value}}") {
		t.Fatalf("expected collection header secret placeholder in workspace YAML:\n%s", workspaceText)
	}
	if !strings.Contains(workspaceText, "{{kurloSecret:collection.collection-main.variables.row.22.value}}") {
		t.Fatalf("expected collection variable secret placeholder in workspace YAML:\n%s", workspaceText)
	}
	if !strings.Contains(workspaceText, "cookies:") || !strings.Contains(workspaceText, "{{kurloSecret:workspace.workspace-main.cookies.scoped.") {
		t.Fatalf("expected workspace cookie placeholder in workspace YAML:\n%s", workspaceText)
	}

	rawLocal, err := os.ReadFile(localPath)
	if err != nil {
		t.Fatalf("read local store: %v", err)
	}
	if !isEncryptedRequestStore(rawLocal) {
		t.Fatalf("expected encrypted local store, got %s", string(rawLocal))
	}
	if strings.Contains(string(rawLocal), "user-token") || strings.Contains(string(rawLocal), "admin-password") || strings.Contains(string(rawLocal), "header-secret") {
		t.Fatalf("local store leaked plaintext secret: %s", string(rawLocal))
	}
	localPlain, err := loadRequestStorePayload(localPath)
	if err != nil {
		t.Fatalf("decrypt local store: %v", err)
	}
	localStore, err := decodeJSONMap(localPlain)
	if err != nil {
		t.Fatalf("decode local store: %v", err)
	}
	storage := localStoreStorage(localStore)
	if stringValue(storage, "kind") != workspaceStoreKind || stringValue(storage, "format") != workspaceStoreFormat {
		t.Fatalf("expected workspace YAML storage contract, got %#v", storage)
	}
	for _, sharedField := range []string{`"workspaces"`, `"collections"`, `"requests"`, `"environments"`, `"cookies"`, `"workspaceCookies"`} {
		if strings.Contains(localPlain, sharedField) {
			t.Fatalf("local store should keep shared workspace data in workspace YAML, found %s:\n%s", sharedField, localPlain)
		}
	}

	loaded, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load kurlo store: %v", err)
	}
	for _, expected := range []string{"user-token", "admin-password", "header-secret", "env-secret-token", "collection-header-secret", "collection-var-secret", "collection-api-secret", "workspace-cookie-secret"} {
		if !strings.Contains(loaded, expected) {
			t.Fatalf("loaded payload is missing %q:\n%s", expected, loaded)
		}
	}
	if !strings.Contains(loaded, `"history"`) || !strings.Contains(loaded, `"workspaceCookies"`) || strings.Contains(loaded, `"cookies"`) {
		t.Fatalf("loaded payload did not preserve workspace cookies in the current format:\n%s", loaded)
	}
}

func TestKurloStorePreservesMissingSecretPlaceholdersAfterCloneLoad(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	sourceLocalPath := filepath.Join(dir, "source-requests.json")
	clonedLocalPath := filepath.Join(dir, "clone-requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	payload := `{
  "version": 2,
  "activeWorkspaceId": "workspace-main",
  "workspaces": [{"id":"workspace-main","name":"Main","createdAt":1,"updatedAt":1}],
  "collections": [{"id":"collection-main","workspaceId":"workspace-main","name":"Core","createdAt":1,"updatedAt":1}],
  "requests": [
    {"id":"req-main","name":"Main","requestType":"http","isDraft":false,"collectionId":"collection-main","collection":"Core","folderPath":[],"method":"GET","url":"https://example.test","requestTab":"headers","params":[],"headers":[{"id":7,"enabled":true,"key":"X-Token","value":"header-secret","description":"","secret":true}],"auth":{"type":"bearer","bearerToken":"user-token"},"bodyType":"none","rawBodyType":"json","bodyContent":"","bodyFilePath":"","bodyFileName":"","formRows":[],"settings":{},"createdAt":1,"updatedAt":1}
  ],
  "environments": []
}`
	if err := saveKurloStorePayload(sourceLocalPath, workspaceRoot, payload); err != nil {
		t.Fatalf("save source workspace: %v", err)
	}

	loadedWithoutSecrets, err := loadKurloStorePayload(clonedLocalPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load cloned workspace without local secrets: %v", err)
	}
	for _, placeholder := range []string{
		"{{kurloSecret:request.req-main.auth.bearerToken}}",
		"{{kurloSecret:request.req-main.headers.row.7.value}}",
	} {
		if !strings.Contains(loadedWithoutSecrets, placeholder) {
			t.Fatalf("expected missing secret placeholder %q to remain in loaded payload:\n%s", placeholder, loadedWithoutSecrets)
		}
	}
	if err := saveKurloStorePayload(clonedLocalPath, workspaceRoot, loadedWithoutSecrets); err != nil {
		t.Fatalf("save cloned workspace without local secrets: %v", err)
	}
	workspaceText := readAllText(t, workspaceRoot)
	for _, placeholder := range []string{
		"{{kurloSecret:request.req-main.auth.bearerToken}}",
		"{{kurloSecret:request.req-main.headers.row.7.value}}",
	} {
		if !strings.Contains(workspaceText, placeholder) {
			t.Fatalf("workspace YAML lost missing secret placeholder %q:\n%s", placeholder, workspaceText)
		}
	}
}

func TestKurloStorePersistsCollectionFolderPathsInWorkspaceYAML(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	payload := `{
  "version": 2,
  "activeWorkspaceId": "workspace-main",
  "workspaces": [{"id":"workspace-main","name":"Main","filesystemName":"Main","createdAt":1,"updatedAt":1}],
  "collections": [{
    "id":"collection-main",
    "workspaceId":"workspace-main",
    "name":"Core",
    "filesystemName":"Core",
    "description":"",
    "collapsed":false,
    "folderPaths":[["Empty Folder"],["Parent","Empty Child"],["Parent","With Request"]],
    "defaults":{},
    "createdAt":1,
    "updatedAt":1
  }],
  "requests": [
    {"id":"req-main","name":"Nested","filesystemName":"Nested","requestType":"http","isDraft":false,"collectionId":"collection-main","collection":"Core","folderPath":["Parent","With Request"],"method":"GET","url":"https://example.test","requestTab":"params","params":[],"headers":[],"auth":{},"bodyType":"none","rawBodyType":"json","bodyContent":"","bodyFilePath":"","bodyFileName":"","formRows":[],"settings":{},"createdAt":1,"updatedAt":1}
  ],
  "environments": []
}`

	if err := saveKurloStorePayload(localPath, workspaceRoot, payload); err != nil {
		t.Fatalf("save kurlo store: %v", err)
	}

	collectionPath := filepath.Join(workspaceRoot, "workspaces", "Main", "collections", "Core", "collection.yml")
	collectionText, err := os.ReadFile(collectionPath)
	if err != nil {
		t.Fatalf("read collection.yml: %v", err)
	}
	for _, expected := range []string{"folderPaths:", "Empty Folder", "Parent", "Empty Child", "With Request"} {
		if !strings.Contains(string(collectionText), expected) {
			t.Fatalf("collection.yml is missing persisted folder path %q:\n%s", expected, string(collectionText))
		}
	}

	loaded, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load kurlo store: %v", err)
	}
	for _, expected := range []string{
		`"folderPaths":`,
		`"Empty Folder"`,
		`"Empty Child"`,
		`"With Request"`,
		`"folderPath": [`,
	} {
		if !strings.Contains(loaded, expected) {
			t.Fatalf("loaded payload lost folder hierarchy marker %q:\n%s", expected, loaded)
		}
	}
}

func TestKurloStoreUsesFilesystemNamesForDuplicateRequestNames(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	payload := `{
  "version": 2,
  "workspaces": [{"id":"workspace-main","name":"Main","createdAt":1,"updatedAt":1}],
  "collections": [{"id":"collection-main","workspaceId":"workspace-main","name":"Core","createdAt":1,"updatedAt":1}],
  "requests": [
    {"id":"req-a","name":"Login","collectionId":"collection-main","collection":"Core","folderPath":["Auth"],"method":"POST","url":"/a","auth":{},"params":[],"headers":[],"formRows":[],"settings":{}},
    {"id":"req-b","name":"Login","collectionId":"collection-main","collection":"Core","folderPath":["Auth"],"method":"POST","url":"/b","auth":{},"params":[],"headers":[],"formRows":[],"settings":{}}
  ]
}`

	if err := saveKurloStorePayload(localPath, workspaceRoot, payload); err != nil {
		t.Fatalf("save kurlo store: %v", err)
	}

	var files []string
	err := filepath.WalkDir(workspaceRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && filepath.Ext(entry.Name()) == fileStoreYAMLExt && entry.Name() != fileStoreRootIndex && entry.Name() != fileStoreRootFileName && entry.Name() != fileStoreCollection {
			files = append(files, entry.Name())
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk workspace files: %v", err)
	}
	sort.Strings(files)
	want := []string{"Login-1.yml", "Login.yml"}
	if strings.Join(files, ",") != strings.Join(want, ",") {
		t.Fatalf("expected duplicate request names to produce unique filesystem names %v, got %v", want, files)
	}

	loaded, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load kurlo store: %v", err)
	}
	if strings.Count(loaded, `"name": "Login"`) != 2 {
		t.Fatalf("expected both duplicate request names after load:\n%s", loaded)
	}
}

func TestKurloStorePreservesEmptyFilesystemStoreAsArrays(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	payload := `{"version":2,"workspaces":[],"collections":[],"requests":[],"environments":[]}`

	if err := saveKurloStorePayload(localPath, workspaceRoot, payload); err != nil {
		t.Fatalf("save kurlo store: %v", err)
	}

	loaded, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load kurlo store: %v", err)
	}
	for _, field := range []string{"workspaces", "collections", "requests", "environments"} {
		if !strings.Contains(loaded, `"`+field+`": []`) {
			t.Fatalf("expected %s to stay an empty array:\n%s", field, loaded)
		}
	}
}

func TestKurloStoreLocalOnlySaveDoesNotRewriteWorkspaceYAML(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")

	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/saved", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save initial kurlo store: %v", err)
	}
	before := readAllText(t, workspaceRoot)

	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/saved", "token-a", []string{"req-main", "req-transient"}, "")); err != nil {
		t.Fatalf("save local-only kurlo store: %v", err)
	}
	after := readAllText(t, workspaceRoot)
	if after != before {
		t.Fatalf("local-only save rewrote workspace YAML\nbefore:\n%s\nafter:\n%s", before, after)
	}

	loaded, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load kurlo store: %v", err)
	}
	if !strings.Contains(loaded, `"req-transient"`) {
		t.Fatalf("local-only state was not preserved:\n%s", loaded)
	}
}

func TestKurloStoreManualAndAutosaveUpdatesReachWorkspaceYAML(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")

	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/saved", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save initial kurlo store: %v", err)
	}
	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/manual-save", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save manual kurlo store: %v", err)
	}
	manualText := readAllText(t, workspaceRoot)
	if !strings.Contains(manualText, "/manual-save") || strings.Contains(manualText, "/saved") {
		t.Fatalf("manual save did not update workspace YAML:\n%s", manualText)
	}

	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/autosave", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save autosave kurlo store: %v", err)
	}
	autosaveText := readAllText(t, workspaceRoot)
	if !strings.Contains(autosaveText, "/autosave") || strings.Contains(autosaveText, "/manual-save") {
		t.Fatalf("autosave did not update workspace YAML:\n%s", autosaveText)
	}
}

func TestKurloStoreDerivesFilesystemNameFromPathWhenAbsentInBody(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	workspaceDir := filepath.Join(workspaceRoot, "workspaces", "Main")
	collectionDir := filepath.Join(workspaceDir, "collections", "Core")
	requestsDir := filepath.Join(collectionDir, "requests")
	if err := os.MkdirAll(requestsDir, 0755); err != nil {
		t.Fatalf("create workspace layout: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspaceRoot, "kurlo.yml"), []byte(`version: 1
format: kurlo.workspace.yaml.v1
workspaceOrder:
  - workspace-main
`), 0644); err != nil {
		t.Fatalf("write kurlo index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspaceDir, "workspace.yml"), []byte(`version: 1
workspace:
  id: workspace-main
  name: Main
collectionOrder:
  - collection-main
`), 0644); err != nil {
		t.Fatalf("write workspace: %v", err)
	}
	if err := os.WriteFile(filepath.Join(collectionDir, "collection.yml"), []byte(`version: 1
collection:
  id: collection-main
  workspaceId: workspace-main
  name: Core
requestOrder:
  - req-main
`), 0644); err != nil {
		t.Fatalf("write collection: %v", err)
	}
	if err := os.WriteFile(filepath.Join(requestsDir, "Main-request.yml"), []byte(`version: 1
request:
  id: req-main
  collectionId: collection-main
  name: Main request
  method: GET
  url: /saved
  requestType: http
`), 0644); err != nil {
		t.Fatalf("write request: %v", err)
	}

	payload, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	for _, want := range []string{
		`"filesystemName": "Main"`,
		`"filesystemName": "Core"`,
		`"filesystemName": "Main-request"`,
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("expected payload to contain %s, got: %s", want, payload)
		}
	}
}

func TestKurloStoreLoadsValidDataWithDiagnosticsForInvalidRequestYAML(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/saved", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save kurlo store: %v", err)
	}
	brokenPath := filepath.Join(workspaceRoot, "workspaces", "Main", "collections", "Core", "requests", "Broken.yml")
	if err := os.WriteFile(brokenPath, []byte("version: 1\nrequest:\n  id: req-broken\n  name: \"Broken\n"), 0644); err != nil {
		t.Fatalf("write broken request: %v", err)
	}

	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load with diagnostics: %v", err)
	}
	if !strings.Contains(payload, `"req-main"`) {
		t.Fatalf("valid request disappeared from payload:\n%s", payload)
	}
	if len(diagnostics) != 1 {
		t.Fatalf("expected one diagnostic, got %#v", diagnostics)
	}
	got := diagnostics[0]
	if got.Scope != "request" || got.CollectionID != "collection-main" || got.Blocking {
		t.Fatalf("unexpected request diagnostic: %#v", got)
	}
	if !strings.Contains(got.Path, "Broken.yml") || got.Line == 0 || !strings.Contains(got.Message, "unclosed quote") {
		t.Fatalf("diagnostic did not point at broken YAML: %#v", got)
	}
	if _, err := loadKurloStorePayload(localPath, workspaceRoot); err == nil {
		t.Fatalf("strict load should fail while diagnostics are present")
	}
}

func TestKurloStoreKeepsDiagnosticsWhenWorkspaceYAMLIsInvalid(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/saved", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save kurlo store: %v", err)
	}
	workspacePath := filepath.Join(workspaceRoot, "workspaces", "Main", "workspace.yml")
	if err := os.WriteFile(workspacePath, []byte("version: 1\nworkspace:\n  id: workspace-main\n  name: \"Main\n"), 0644); err != nil {
		t.Fatalf("write broken workspace: %v", err)
	}

	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load with diagnostics: %v", err)
	}
	if strings.Contains(payload, `"workspace-main"`) {
		t.Fatalf("invalid workspace should not be loaded into payload:\n%s", payload)
	}
	if len(diagnostics) != 1 {
		t.Fatalf("expected one diagnostic, got %#v", diagnostics)
	}
	got := diagnostics[0]
	if got.Scope != "workspace" || !got.Blocking || got.WorkspaceID == "" || !strings.Contains(got.Path, "workspace.yml") {
		t.Fatalf("unexpected workspace diagnostic: %#v", got)
	}
	if _, err := loadKurloStorePayload(localPath, workspaceRoot); err == nil {
		t.Fatalf("strict load should fail while blocking diagnostics are present")
	}
}

func TestKurloStoreSavePreservesInvalidWorkspaceDirectory(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/saved", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save kurlo store: %v", err)
	}
	workspacePath := filepath.Join(workspaceRoot, "workspaces", "Main", "workspace.yml")
	collectionPath := filepath.Join(workspaceRoot, "workspaces", "Main", "collections", "Core", "collection.yml")
	if err := os.WriteFile(workspacePath, []byte("version: 1\nworkspace:\n  id: workspace-main\n  name: \"Main\n"), 0644); err != nil {
		t.Fatalf("write broken workspace: %v", err)
	}
	_, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load with diagnostics: %v", err)
	}
	recoveryPayload := `{
  "version": 2,
  "activeWorkspaceId": "workspace-recovery",
  "workspaces": [
    {"id":"workspace-recovery","name":"Recovery","filesystemName":"Recovery","description":""}
  ],
  "collections": [
    {"id":"collection-recovery","workspaceId":"workspace-recovery","name":"Default","filesystemName":"Default","description":"","collapsed":false}
  ],
  "environments": [],
  "requests": [],
  "history": []
}`
	if err := saveKurloStorePayloadPreserving(localPath, workspaceRoot, recoveryPayload, diagnosticPreserveDirs(workspaceRoot, diagnostics)); err != nil {
		t.Fatalf("save recovery workspace: %v", err)
	}
	for _, path := range []string{
		workspacePath,
		collectionPath,
		filepath.Join(workspaceRoot, "workspaces", "Recovery", "workspace.yml"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected %s to remain after save: %v", path, err)
		}
	}
	rootIndex, err := os.ReadFile(filepath.Join(workspaceRoot, "kurlo.yml"))
	if err != nil {
		t.Fatalf("read root index: %v", err)
	}
	for _, want := range []string{"workspace-main", "workspace-recovery"} {
		if !strings.Contains(string(rootIndex), want) {
			t.Fatalf("expected root index to preserve %s, got:\n%s", want, string(rootIndex))
		}
	}
}

func TestKurloStoreSaveKeepsOnlyTheBrokenFile(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	store, err := decodeJSONMap(kurloSaveFlowPayload("/saved", "", []string{"req-main"}, ""))
	if err != nil {
		t.Fatal(err)
	}
	requests := mapSlice(store["requests"])
	second := cloneMap(requests[0])
	second["id"], second["name"], second["filesystemName"] = "req-two", "Second", "Second"
	store["requests"] = append(requests, second)
	initial, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveKurloStorePayload(localPath, workspaceRoot, string(initial)); err != nil {
		t.Fatal(err)
	}
	requestsDir := filepath.Join(workspaceRoot, "workspaces", "Main", "collections", "Core", "requests")
	brokenPath := filepath.Join(requestsDir, "Broken.yml")
	if err := os.WriteFile(brokenPath, []byte("version: 1\nrequest: [\n"), 0644); err != nil {
		t.Fatal(err)
	}
	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localPath, workspaceRoot)
	if err != nil || len(diagnostics) != 1 {
		t.Fatalf("expected one diagnostic: %v %#v", err, diagnostics)
	}
	loaded, err := decodeJSONMap(payload)
	if err != nil {
		t.Fatal(err)
	}
	var kept []map[string]any
	for _, request := range mapSlice(loaded["requests"]) {
		if stringValue(request, "id") != "req-two" {
			kept = append(kept, request)
		}
	}
	loaded["requests"] = kept
	edited, err := json.Marshal(loaded)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveKurloStorePayloadPreserving(localPath, workspaceRoot, string(edited), diagnosticPreserveDirs(workspaceRoot, diagnostics)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(brokenPath); err != nil {
		t.Fatalf("broken file must stay for repair: %v", err)
	}
	if _, err := os.Stat(filepath.Join(requestsDir, "Second.yml")); !os.IsNotExist(err) {
		t.Fatalf("a request deleted in the app must not come back because another file is broken: %v", err)
	}
}

func TestWorkspaceYAMLEditorRepairsBlockingDiagnostic(t *testing.T) {
	withRequestStoreTestKey(t)
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)
	workspaceRoot := filepath.Join(t.TempDir(), "workspace")
	if err := saveKurloStorePayload(requestStorePath(), workspaceRoot, kurloSaveFlowPayload("/saved", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save kurlo store: %v", err)
	}
	app := NewApp()
	if result := app.openWorkspaceRoot(workspaceRoot); !result.Ok {
		t.Fatalf("open workspace: %s", result.Error)
	}
	relPath := "workspaces/Main/workspace.yml"
	workspacePath := filepath.Join(workspaceRoot, filepath.FromSlash(relPath))
	valid, err := os.ReadFile(workspacePath)
	if err != nil {
		t.Fatalf("read valid workspace YAML: %v", err)
	}
	if err := os.WriteFile(workspacePath, []byte("version: 1\nworkspace:\n  id: workspace-main\n  name: \"Main\n"), 0644); err != nil {
		t.Fatalf("write broken workspace: %v", err)
	}
	readResult := app.ReadWorkspaceYAMLFile(relPath)
	if !readResult.Ok || !strings.Contains(readResult.Content, "name: \"Main") {
		t.Fatalf("expected editor to read broken YAML, got %#v", readResult)
	}
	writeResult := app.WriteWorkspaceYAMLFile(relPath, string(valid))
	if !writeResult.Ok {
		t.Fatalf("write repaired YAML: %s", writeResult.Error)
	}
	if len(writeResult.Diagnostics) != 0 {
		t.Fatalf("expected diagnostics to clear, got %#v", writeResult.Diagnostics)
	}
	if escaped := app.WriteWorkspaceYAMLFile("../outside.yml", "version: 1\n"); escaped.Ok || escaped.Error == "" {
		t.Fatalf("expected escaped path to be rejected")
	}
}

func TestKurloStoreIgnoresDanglingOrderEntries(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/saved", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save kurlo store: %v", err)
	}
	collectionPath := filepath.Join(workspaceRoot, "workspaces", "Main", "collections", "Core", "collection.yml")
	workspacePath := filepath.Join(workspaceRoot, "workspaces", "Main", "workspace.yml")
	for path, list := range map[string]string{collectionPath: "requestOrder:\n", workspacePath: "collectionOrder:\n"} {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := strings.Replace(string(data), list, list+"    - deleted-by-hand\n", 1)
		if text == string(data) {
			t.Fatalf("missing %q in %s", list, path)
		}
		if err := os.WriteFile(path, []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}

	_, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load with diagnostics: %v", err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("order entries for deleted files are not issues: %#v", diagnostics)
	}
}

func TestKurloStoreRejectsSymlinkedYAMLFiles(t *testing.T) {
	requireSymlinks(t)
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	workspaceDir := filepath.Join(workspaceRoot, "workspaces", "Main")
	collectionDir := filepath.Join(workspaceDir, "collections", "Core")
	requestsDir := filepath.Join(collectionDir, "requests")
	if err := os.MkdirAll(requestsDir, 0755); err != nil {
		t.Fatalf("create workspace layout: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspaceRoot, "kurlo.yml"), []byte(`version: 1
format: kurlo.workspace.yaml.v1
workspaceOrder:
  - workspace-main
`), 0644); err != nil {
		t.Fatalf("write kurlo index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspaceDir, "workspace.yml"), []byte(`version: 1
workspace:
  id: workspace-main
  name: Main
  filesystemName: Main
collectionOrder:
  - collection-main
`), 0644); err != nil {
		t.Fatalf("write workspace: %v", err)
	}
	if err := os.WriteFile(filepath.Join(collectionDir, "collection.yml"), []byte(`version: 1
collection:
  id: collection-main
  workspaceId: workspace-main
  name: Core
  filesystemName: Core
requestOrder:
  - req-main
`), 0644); err != nil {
		t.Fatalf("write collection: %v", err)
	}
	outside := filepath.Join(dir, "outside-request.yml")
	if err := os.WriteFile(outside, []byte(`version: 1
order: 0
request:
  id: req-main
  collectionId: collection-main
  name: Main request
  filesystemName: Main-request
  method: GET
  url: /symlinked
  requestType: http
`), 0644); err != nil {
		t.Fatalf("write symlink target: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(requestsDir, "Main-request.yml")); err != nil {
		t.Skipf("symlinks are not available: %v", err)
	}

	_, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err == nil || !strings.Contains(err.Error(), "refusing to read symlink") {
		t.Fatalf("expected symlinked YAML file to be rejected, got %v", err)
	}
}

func TestKurloStoreRejectsSymlinkedManagedDirectory(t *testing.T) {
	requireSymlinks(t)
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	if err := os.MkdirAll(workspaceRoot, 0755); err != nil {
		t.Fatalf("create workspace root: %v", err)
	}
	outside := filepath.Join(dir, "outside-workspaces")
	if err := os.MkdirAll(outside, 0755); err != nil {
		t.Fatalf("create symlink target: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(workspaceRoot, fileStoreWorkspacesDir)); err != nil {
		t.Skipf("symlinks are not available: %v", err)
	}

	err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/saved", "token-a", []string{"req-main"}, ""))
	if err == nil || !strings.Contains(err.Error(), "refusing to use symlink directory") {
		t.Fatalf("expected symlinked managed directory to be rejected, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "Main")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("save should not write through symlinked workspaces directory, err=%v", err)
	}
}

func TestEnsureWorkspaceGitignoreRejectsSymlink(t *testing.T) {
	requireSymlinks(t)
	dir := t.TempDir()
	target := filepath.Join(dir, "outside-gitignore")
	if err := os.WriteFile(target, []byte("keep\n"), 0644); err != nil {
		t.Fatalf("write symlink target: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(dir, ".gitignore")); err != nil {
		t.Skipf("symlinks are not available: %v", err)
	}

	err := ensureWorkspaceGitignore(dir)
	if err == nil || !strings.Contains(err.Error(), "refusing to update symlink") {
		t.Fatalf("expected symlinked .gitignore to be rejected, got %v", err)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read symlink target: %v", err)
	}
	if string(data) != "keep\n" {
		t.Fatalf("symlink target should not be modified, got %q", data)
	}
}

func TestFilesystemSegmentsUseNamesAndDisambiguateDuplicates(t *testing.T) {
	items := []map[string]any{
		{"id": "collection-a", "name": "Core API"},
		{"id": "collection-b", "name": "Core API"},
		{"id": "collection-c", "name": ""},
	}
	segments := filesystemSegmentsForItems(items)

	if segments["collection-a"] != "Core-API" {
		t.Fatalf("expected first collection to use name segment, got %q", segments["collection-a"])
	}
	if segments["collection-b"] != "Core-API-1" {
		t.Fatalf("expected duplicate collection name to be disambiguated as Core-API-1, got %q", segments["collection-b"])
	}
	if segments["collection-c"] != "collection-c" {
		t.Fatalf("expected empty collection name to fall back to id, got %q", segments["collection-c"])
	}
	for _, item := range items {
		if stringValue(item, filesystemNameField) == "" {
			t.Fatalf("expected filesystemName to be written back to item %#v", item)
		}
	}
}

func TestKurloStoreSecretOnlySaveUpdatesEncryptedLocalStateWithoutRewritingWorkspaceYAML(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")

	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/saved", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save initial kurlo store: %v", err)
	}
	before := readAllText(t, workspaceRoot)

	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/saved", "token-b", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save secret-only kurlo store: %v", err)
	}
	after := readAllText(t, workspaceRoot)
	if after != before {
		t.Fatalf("secret-only save should not rewrite workspace YAML\nbefore:\n%s\nafter:\n%s", before, after)
	}

	loaded, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load kurlo store: %v", err)
	}
	if !strings.Contains(loaded, "token-b") || strings.Contains(loaded, "token-a") {
		t.Fatalf("secret-only save did not update encrypted local state:\n%s", loaded)
	}
}

func TestKurloStoreImportedCollectionWritesAllRequestsToWorkspaceYAML(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")
	payload := `{
  "version": 2,
  "activeId": "req-import-1",
  "activeWorkspaceId": "workspace-main",
  "openIds": ["req-import-1"],
  "workspaces": [{"id":"workspace-main","name":"Main","createdAt":1,"updatedAt":1}],
  "collections": [{"id":"collection-import","workspaceId":"workspace-main","name":"Postman Import","createdAt":1,"updatedAt":1}],
  "environments": [],
  "requests": [
    {"id":"req-import-1","name":"First request","requestType":"http","isDraft":false,"collectionId":"collection-import","collection":"Postman Import","folderPath":["Folder"],"method":"GET","url":"https://example.test/first","requestTab":"params","params":[],"headers":[],"auth":{},"bodyType":"none","rawBodyType":"json","bodyContent":"","bodyFilePath":"","bodyFileName":"","formRows":[],"settings":{},"createdAt":1,"updatedAt":1},
    {"id":"req-import-2","name":"Second request","requestType":"http","isDraft":false,"collectionId":"collection-import","collection":"Postman Import","folderPath":["Folder"],"method":"POST","url":"https://example.test/second","requestTab":"body","params":[],"headers":[],"auth":{},"bodyType":"json","rawBodyType":"json","bodyContent":"{\"ok\":true}","bodyFilePath":"","bodyFileName":"","formRows":[],"settings":{},"createdAt":2,"updatedAt":2}
  ],
  "history": []
}`

	if err := saveKurloStorePayload(localPath, workspaceRoot, payload); err != nil {
		t.Fatalf("save imported collection payload: %v", err)
	}

	workspaceText := readAllText(t, workspaceRoot)
	for _, expected := range []string{
		"kurlo.workspace.yaml.v1",
		"Postman-Import/collection.yml",
		"First-request.yml",
		"Second-request.yml",
		"https://example.test/first",
		"https://example.test/second",
	} {
		if !strings.Contains(workspaceText, expected) {
			t.Fatalf("imported collection did not write %q to workspace YAML:\n%s", expected, workspaceText)
		}
	}

	loaded, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load imported collection payload: %v", err)
	}
	if strings.Count(loaded, `"collectionId": "collection-import"`) != 2 {
		t.Fatalf("expected both imported requests after reload:\n%s", loaded)
	}
}

func TestKurloStoreConcurrentSavesUseIsolatedTemporaryDirectories(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces")

	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for i := 0; i < 12; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload(fmt.Sprintf("/concurrent-%02d", i), fmt.Sprintf("token-%02d", i), []string{"req-main"}, ""))
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent save failed: %v", err)
		}
	}

	loaded, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load after concurrent saves: %v", err)
	}
	if !strings.Contains(loaded, "/concurrent-") {
		t.Fatalf("expected one concurrent save to win with valid payload:\n%s", loaded)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read temp dir: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "workspaces.tmp-") || strings.HasPrefix(entry.Name(), "workspaces.bak-") {
			t.Fatalf("temporary workspace directory was not cleaned up: %s", entry.Name())
		}
	}
}

func TestSendRequestEncodesParamsWhenAutomaticEncodingIsDisabled(t *testing.T) {
	var gotRawQuery string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRawQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method: http.MethodGet,
		URL:    server.URL,
		Params: []model.KeyValue{
			{Enabled: true, Key: "a key&x", Value: "value with spaces&equals=#"},
		},
		EncodeURLAutomatically: false,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	want := "a+key%26x=value+with+spaces%26equals%3D%23"
	if gotRawQuery != want {
		t.Fatalf("expected raw query %q, got %q", want, gotRawQuery)
	}
}

func TestSignAWSv4HashesAndRestoresNonSeekableBody(t *testing.T) {
	body := "payload"
	req, err := http.NewRequest(http.MethodPost, "https://example.amazonaws.com/resource", io.NopCloser(strings.NewReader(body)))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}

	err = auth.Sign(req, model.AuthConfig{
		AWSAccessKey: "AKID",
		AWSSecretKey: "SECRET",
		AWSRegion:    "us-east-1",
		AWSService:   "execute-api",
	})
	if err != nil {
		t.Fatalf("sign request: %v", err)
	}

	wantHashBytes := sha256.Sum256([]byte(body))
	wantHash := hex.EncodeToString(wantHashBytes[:])
	if got := req.Header.Get("x-amz-content-sha256"); got != wantHash {
		t.Fatalf("expected body hash %q, got %q", wantHash, got)
	}

	restored, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatalf("read restored body: %v", err)
	}
	if string(restored) != body {
		t.Fatalf("expected restored body %q, got %q", body, string(restored))
	}
	if req.GetBody == nil {
		t.Fatal("expected GetBody to be restored")
	}
	bodyCopy, err := req.GetBody()
	if err != nil {
		t.Fatalf("get body copy: %v", err)
	}
	defer bodyCopy.Close()
	copyBytes, err := io.ReadAll(bodyCopy)
	if err != nil {
		t.Fatalf("read body copy: %v", err)
	}
	if string(copyBytes) != body {
		t.Fatalf("expected body copy %q, got %q", body, string(copyBytes))
	}
}

func TestSendRequestReportsMultipartFileErrors(t *testing.T) {
	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:   http.MethodPost,
		URL:      "http://example.com/upload",
		BodyType: "form",
		FormData: []model.KeyValue{
			{Enabled: true, Key: "file", Value: "/path/that/does/not/exist", IsFile: true},
		},
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})

	if !strings.HasPrefix(resp.Error, "failed to read form file:") {
		t.Fatalf("expected form file read error, got %q", resp.Error)
	}
}

func TestVariablesAndEnvironmentAreSafeForConcurrentAccess(t *testing.T) {
	app := NewApp()
	var wg sync.WaitGroup

	for i := 0; i < 50; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			app.SetVariable("token", "abc")
		}()
		go func() {
			defer wg.Done()
			app.SetEnvironment(map[string]string{"baseUrl": "https://example.com"})
		}()
		go func() {
			defer wg.Done()
			_ = app.GetVariables()
			_ = app.GetEnvironment()
		}()
	}

	wg.Wait()
}

type errReader struct{}

func (errReader) Read(_ []byte) (int, error) {
	return 0, errors.New("read failed")
}

func TestRequestBodyBytesReturnsReadErrors(t *testing.T) {
	req, err := http.NewRequest(http.MethodPost, "https://example.com", io.NopCloser(errReader{}))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	_, err = auth.ReadBodyBytes(req)
	if err == nil || !strings.Contains(err.Error(), "read failed") {
		t.Fatalf("expected read error, got %v", err)
	}
}

func TestRequestBodyBytesUsesGetBodyWithoutConsumingRequestBody(t *testing.T) {
	req, err := http.NewRequest(http.MethodPost, "https://example.com", bytes.NewBufferString("payload"))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if req.GetBody == nil {
		t.Fatal("expected test request to have GetBody")
	}

	bodyBytes, err := auth.ReadBodyBytes(req)
	if err != nil {
		t.Fatalf("request body bytes: %v", err)
	}
	if string(bodyBytes) != "payload" {
		t.Fatalf("expected payload bytes, got %q", string(bodyBytes))
	}
	remaining, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatalf("read original body: %v", err)
	}
	if string(remaining) != "payload" {
		t.Fatalf("expected original body to remain readable, got %q", string(remaining))
	}
}

func TestKurloYAMLFormatPublicContractFiles(t *testing.T) {
	repoRoot := filepath.Clean(filepath.Join("..", "..", "..", ".."))
	schemaPath := filepath.Join(repoRoot, "schemas", "kurlo-workspace-yaml-v1.schema.json")
	docPath := filepath.Join(repoRoot, "apps", "web", "src", "content", "docs", "docs", "reference", "kurlo-yaml-format.md")

	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	var schema map[string]any
	if err := json.Unmarshal(schemaBytes, &schema); err != nil {
		t.Fatalf("schema must be valid JSON: %v", err)
	}
	if schema["x-kurlo-format"] != workspaceStoreFormat {
		t.Fatalf("schema format = %q, want %q", schema["x-kurlo-format"], workspaceStoreFormat)
	}
	if schema["x-kurlo-path-layout"] != workspacePathLayout {
		t.Fatalf("schema path layout = %q, want %q", schema["x-kurlo-path-layout"], workspacePathLayout)
	}
	if schema["x-kurlo-storage-kind"] != workspaceStoreKind {
		t.Fatalf("schema storage kind = %q, want %q", schema["x-kurlo-storage-kind"], workspaceStoreKind)
	}
	schemaText := string(schemaBytes)
	for _, token := range []string{
		`"rootFile"`,
		`"workspaceFile"`,
		`"collectionFile"`,
		`"requestFile"`,
		`"environmentFile"`,
		`"exampleFile"`,
		`"filesystemName"`,
		`"kurlo.workspace.yaml.v1"`,
	} {
		if !strings.Contains(schemaText, token) {
			t.Fatalf("schema is missing %s", token)
		}
	}

	docBytes, err := os.ReadFile(docPath)
	if err != nil {
		t.Fatalf("read format docs: %v", err)
	}
	docText := string(docBytes)
	for _, token := range []string{
		workspaceStoreKind,
		workspaceStoreFormat,
		workspacePathLayout,
		fileStoreRootIndex,
		fileStoreExamplesDir,
		"workspaces/**/*.yml",
		"requests.json",
	} {
		if !strings.Contains(docText, token) {
			t.Fatalf("format docs are missing %q", token)
		}
	}
}

func withRequestStoreTestKey(t *testing.T) {
	t.Helper()
	previousProvider := requestStoreKeyProvider
	previousLoader := requestStoreKeyLoader
	requestStoreKeyProvider = func() ([]byte, error) {
		return bytes.Repeat([]byte{7}, requestStoreKeySize), nil
	}
	requestStoreKeyLoader = requestStoreKeyProvider
	t.Cleanup(func() {
		requestStoreKeyProvider = previousProvider
		requestStoreKeyLoader = previousLoader
	})
}

func readAllText(t *testing.T, root string) string {
	t.Helper()
	var builder strings.Builder
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		builder.WriteString(filepath.ToSlash(path))
		builder.WriteByte('\n')
		builder.Write(data)
		builder.WriteByte('\n')
		return nil
	})
	if err != nil {
		t.Fatalf("read workspace tree: %v", err)
	}
	return builder.String()
}

func kurloSaveFlowPayload(url string, bearerToken string, openIDs []string, cookieValue string) string {
	openIDPayload, _ := json.Marshal(openIDs)
	workspaceCookies := "{}"
	if cookieValue != "" {
		workspaceCookies = fmt.Sprintf(`{"workspace-main":[{"name":"sid","value":%q,"domain":"example.test","path":"/","hostOnly":true,"session":true}]}`, cookieValue)
	}
	return fmt.Sprintf(`{
  "version": 2,
  "activeId": "req-main",
  "activeWorkspaceId": "workspace-main",
  "activeEnvironmentId": "environment-local",
  "openIds": %s,
  "folderCollapsed": {"collection-main:Auth": true},
  "workspaces": [
    {"id":"workspace-main","name":"Main","filesystemName":"Main","description":"","createdAt":1,"updatedAt":1}
  ],
  "collections": [
    {"id":"collection-main","workspaceId":"workspace-main","name":"Core","filesystemName":"Core","description":"","collapsed":false,"createdAt":1,"updatedAt":1}
  ],
  "environments": [
    {"id":"environment-local","workspaceId":"workspace-main","name":"Local","filesystemName":"Local","values":[],"createdAt":1,"updatedAt":1}
  ],
  "requests": [
    {"id":"req-main","name":"Main request","filesystemName":"Main-request","requestType":"http","isDraft":false,"collectionId":"collection-main","collection":"Core","folderPath":["Auth"],"method":"GET","url":%q,"requestTab":"params","params":[],"headers":[],"auth":{"type":"bearer","bearerToken":%q,"basicUser":"","basicPass":"","apiKeyName":"","apiKeyValue":"","apiKeyIn":"header","oauth2TokenURL":"","oauth2ClientID":"","oauth2Secret":"","oauth2Scope":"","oauth2Token":"","awsAccessKey":"","awsSecretKey":"","awsRegion":"","awsService":""},"bodyType":"none","rawBodyType":"json","bodyContent":"","bodyFilePath":"","bodyFileName":"","formRows":[],"preRequestScript":"","testScript":"","requestNotes":"","settings":{"timeoutMs":30000},"createdAt":1,"updatedAt":1}
  ],
  "history": [],
  "workspaceCookies": %s
}`, string(openIDPayload), url, bearerToken, workspaceCookies)
}

func TestPreRequestScriptRewritesTheBodyThatIsSent(t *testing.T) {
	var gotBody, gotSignature string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		gotSignature = r.Header.Get("X-Signature")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:       http.MethodPost,
		URL:          server.URL,
		BodyType:     "json",
		Body:         `{"amount":10}`,
		ScriptEngine: "js",
		PreRequestScript: `
const payload = pm.request.body.json()
payload.amount = payload.amount * 2
pm.request.body.update(JSON.stringify(payload))
pm.request.headers.set("X-Signature", pm.crypto.hmacSha256(pm.request.body.raw, "secret"))
`,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotBody != `{"amount":20}` {
		t.Fatalf("server received body %q", gotBody)
	}
	if gotSignature == "" {
		t.Fatal("expected the signature header to be computed over the rewritten body")
	}
}

func TestPreRequestScriptCanAddABodyToARequestThatHadNone(t *testing.T) {
	var gotBody, gotContentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		gotContentType = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:                 http.MethodPost,
		URL:                    server.URL,
		BodyType:               "none",
		ScriptEngine:           "js",
		PreRequestScript:       `pm.request.body.update({ generated: true })`,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotBody != `{"generated":true}` {
		t.Fatalf("server received body %q", gotBody)
	}
	if gotContentType != "application/json" {
		t.Fatalf("content type = %q", gotContentType)
	}
}

func TestScriptBodyWriteDoesNotOverrideAFileBody(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "payload.bin")
	if err := os.WriteFile(path, []byte("from-disk"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:                 http.MethodPost,
		URL:                    server.URL,
		BodyType:               "binary",
		BodyFilePath:           path,
		ScriptEngine:           "js",
		PreRequestScript:       `pm.request.body.update("from-script")`,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotBody != "from-disk" {
		t.Fatalf("server received body %q, expected the file contents", gotBody)
	}
}

func TestScriptEditsUrlencodedBodyFields(t *testing.T) {
	var gotBody, gotContentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		gotContentType = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:       http.MethodPost,
		URL:          server.URL,
		BodyType:     "urlencoded",
		FormData:     []model.KeyValue{{Key: "grant_type", Value: "password", Enabled: true}},
		ScriptEngine: "js",
		PreRequestScript: `
pm.request.body.urlencoded.upsert({ key: "grant_type", value: "client_credentials" })
pm.request.body.urlencoded.add({ key: "scope", value: "read" })
`,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotBody != "grant_type=client_credentials&scope=read" {
		t.Fatalf("server received body %q", gotBody)
	}
	if gotContentType != "application/x-www-form-urlencoded" {
		t.Fatalf("content type = %q", gotContentType)
	}
}

func TestScriptRawWriteOnAFormBodyIsReportedNotDropped(t *testing.T) {
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:                 http.MethodPost,
		URL:                    server.URL,
		BodyType:               "urlencoded",
		FormData:               []model.KeyValue{{Key: "a", Value: "1", Enabled: true}},
		ScriptEngine:           "js",
		PreRequestScript:       `pm.request.body.raw = "b=2"`,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotBody != "a=1" {
		t.Fatalf("server received body %q, expected the form fields", gotBody)
	}
	if len(resp.PreRequestResult.Logs) == 0 || !strings.Contains(resp.PreRequestResult.Logs[0], "pm.request.body.urlencoded") {
		t.Fatalf("expected a log explaining the ignored raw write, got %v", resp.PreRequestResult.Logs)
	}
}

func TestScriptBodyWriteRescuesABinaryRequestWithNoFile(t *testing.T) {
	var gotBody, gotContentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		gotContentType = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	app := NewApp()
	resp := app.SendRequest(model.HttpRequest{
		Method:                 http.MethodPost,
		URL:                    server.URL,
		BodyType:               "binary",
		ScriptEngine:           "js",
		PreRequestScript:       `pm.request.body.update("generated")`,
		FollowRedirects:        true,
		TimeoutMs:              5000,
		HTTPVersion:            "auto",
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		MaxRedirects:           10,
	})

	if resp.Error != "" {
		t.Fatalf("unexpected response error: %s", resp.Error)
	}
	if gotBody != "generated" {
		t.Fatalf("server received body %q", gotBody)
	}
	if gotContentType != "text/plain" {
		t.Fatalf("content type = %q", gotContentType)
	}
}

func TestSendRequestReadsAPostEventStreamAsTheResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for _, chunk := range []string{"data: {\"delta\":\"Hel\"}\n\n", "data: {\"delta\":\"lo\"}\n\n", "data: [DONE]\n\n"} {
			_, _ = io.WriteString(w, chunk)
			flusher.Flush()
		}
		_, _ = io.WriteString(w, ": echo "+string(body)+"\n\n")
	}))
	defer server.Close()

	resp := NewApp().SendRequest(model.HttpRequest{
		Method:                http.MethodPost,
		URL:                   server.URL,
		BodyType:              "json",
		Body:                  `{"stream":true}`,
		FollowRedirects:       true,
		TimeoutMs:             5000,
		HTTPVersion:           "auto",
		EnableSSLVerification: true,
		MaxRedirects:          10,
	})

	if resp.Error != "" {
		t.Fatalf("expected the stream to be read as the response, got error %q", resp.Error)
	}
	if !strings.Contains(resp.Body, `"delta":"lo"`) || !strings.Contains(resp.Body, "[DONE]") || !strings.Contains(resp.Body, `{"stream":true}`) {
		t.Fatalf("expected the whole stream and the posted body to reach the server, got %q", resp.Body)
	}
}

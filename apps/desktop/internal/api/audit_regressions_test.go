package api

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestNetworkErrorsDoNotExposeEnvironmentSecrets(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		conn.Close()
	}))
	defer server.Close()
	for _, secret := range []string{"synthetic-secret-token", "synthetic value/+?"} {
		req := traceTestRequest(server.URL + "/" + url.PathEscape(secret) + "?token=" + url.QueryEscape(secret))
		req.SecretEnvironmentValues = []string{secret}
		resp := sendRequest(context.Background(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
		if resp.Error == "" || strings.Contains(resp.Error, secret) || strings.Contains(resp.Error, url.QueryEscape(secret)) || strings.Contains(resp.Error, url.PathEscape(secret)) {
			t.Fatalf("network error must retain its cause without secrets: %q", resp.Error)
		}
	}
}

func TestRedirectLimitCountsFollowedTransitions(t *testing.T) {
	for _, redirects := range []int{1, 2} {
		t.Run(fmt.Sprint(redirects), func(t *testing.T) {
			var paths []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				paths = append(paths, r.URL.Path)
				if len(paths) <= redirects {
					http.Redirect(w, r, fmt.Sprintf("/%d", len(paths)), http.StatusFound)
					return
				}
				fmt.Fprint(w, "arrived")
			}))
			defer server.Close()
			req := traceTestRequest(server.URL)
			req.MaxRedirects = redirects
			resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
			if resp.StatusCode != 200 || resp.Error != "" || len(paths) != redirects+1 {
				t.Fatalf("limit=%d paths=%v response=%+v", redirects, paths, resp)
			}
		})
	}
}

func TestRedirectLimitReportsExhaustion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, r.URL.Path+"/next", http.StatusFound)
	}))
	defer server.Close()
	req := traceTestRequest(server.URL + "/start")
	req.MaxRedirects = 1
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if !strings.Contains(resp.Error, "redirect") || len(resp.SentRequests) != 2 {
		t.Fatalf("redirect exhaustion must be explicit after one transition: %+v", resp)
	}
}

func TestBodyReadTimeoutKeepsPartialResponseWithFormattedError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "partial")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	req := traceTestRequest(server.URL)
	req.TimeoutMs = 50
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.StatusCode != 200 || resp.Body != "partial" || resp.Error != "Error: request timed out after 50 ms" {
		t.Fatalf("partial HTTP response must retain wire status and a formatted timeout: %+v", resp)
	}
}

func TestProxyDNSErrorNamesFailingProxy(t *testing.T) {
	target, _ := url.Parse("https://api.example.test/private")
	err := &url.Error{Op: "Get", URL: target.String(), Err: &net.OpError{Op: "proxyconnect", Net: "tcp", Err: &net.DNSError{Err: "no such host", Name: "proxy.example.test", IsNotFound: true}}}
	got := formatRequestError(err, target, time.Second)
	if got != "Error: getaddrinfo ENOTFOUND proxy.example.test" {
		t.Fatal(got)
	}
	if got := formatRequestError(errors.New("unrelated"), target, time.Second); got != "Error: unrelated" {
		t.Fatal(got)
	}
}

func TestSaveRefusesUnreadableLocalStoreBeforeChangingYAML(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	local, root := filepath.Join(dir, "local.json"), filepath.Join(dir, "root")
	if err := saveKurloStorePayload(local, root, exampleStorePayload(t, createdExample)); err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(root, "workspaces", "Main", "collections", "Core", "requests", "Create-order.yml")
	before, err := os.ReadFile(requestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(local); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(local, 0700); err != nil {
		t.Fatal(err)
	}
	err = saveKurloStorePayload(local, root, strings.ReplaceAll(exampleStorePayload(t, createdExample), "/orders", "/changed"))
	if err == nil {
		t.Fatal("unreadable local metadata must fail")
	}
	after, err := os.ReadFile(requestPath)
	if err != nil || string(before) != string(after) {
		t.Fatalf("failed local read must not change YAML: %v", err)
	}
}

func TestExamplePrunePreservesUnrelatedFiles(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	local, root := filepath.Join(dir, "local.json"), filepath.Join(dir, "root")
	payload := exampleStorePayload(t, createdExample)
	if err := saveKurloStorePayload(local, root, payload); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(exampleDirFor(root), "notes.txt")
	if err := os.WriteFile(path, []byte("keep me"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := saveKurloStorePayload(local, root, strings.ReplaceAll(payload, "/orders", "/edited")); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "keep me" {
		t.Fatalf("unrelated example file was removed: %v", err)
	}
}

func TestNTLMHandshakeRecordsWireRequestsAndCookies(t *testing.T) {
	challenge := make([]byte, 48)
	copy(challenge, "NTLMSSP\x00")
	binary.LittleEndian.PutUint32(challenge[8:], 2)
	binary.LittleEndian.PutUint32(challenge[20:], 0x00080201)
	copy(challenge[24:], "abcd1234")
	var steps int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		steps++
		authorization := r.Header.Get("Authorization")
		if authorization == "" {
			http.SetCookie(w, &http.Cookie{Name: "challenge", Value: "cookie-marker", Path: "/"})
			w.Header().Set("WWW-Authenticate", "NTLM")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if cookie, err := r.Cookie("challenge"); err != nil || cookie.Value != "cookie-marker" {
			t.Error("handshake cookie did not reach the next wire request")
		}
		message, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(authorization, "NTLM "))
		if err != nil || len(message) < 12 {
			t.Error("invalid NTLM message")
			return
		}
		if binary.LittleEndian.Uint32(message[8:]) == 1 {
			w.Header().Set("WWW-Authenticate", "NTLM "+base64.StdEncoding.EncodeToString(challenge))
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer server.Close()
	req := traceTestRequest(server.URL)
	req.Auth.Type, req.Auth.Username, req.Auth.Password = "ntlm", "DOMAIN\\user", "password"
	resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
	if resp.Error != "" || resp.StatusCode != 200 || steps != 3 || len(resp.SentRequests) != steps {
		t.Fatalf("wire steps=%d recorded=%d status=%d error=%s", steps, len(resp.SentRequests), resp.StatusCode, resp.Error)
	}
}

func TestNTLMKeepsExplicitCookieInBrowserMode(t *testing.T) {
	for _, browserMode := range []bool{false, true} {
		t.Run(fmt.Sprint(browserMode), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, r.Header.Get("Cookie"))
			}))
			defer server.Close()
			req := traceTestRequest(server.URL)
			req.Auth.Type, req.Auth.Username, req.Auth.Password = "ntlm", "user", "password"
			req.Headers = append(req.Headers, model.KeyValue{Key: "Cookie", Value: "manual=cookie-marker", Enabled: true})
			if browserMode {
				req.BrowserEnforceCORS = true
				req.BrowserOrigin = server.URL
			}
			resp := sendRequest(t.Context(), req, state.New(), newCookieJarRegistry(), newPreflightCache())
			if resp.Error != "" || resp.Body != "manual=cookie-marker" {
				t.Fatalf("explicit cookie was lost: body=%q error=%s", resp.Body, resp.Error)
			}
		})
	}
}

func TestBinaryResponseCacheTouchesReadBodies(t *testing.T) {
	cache := newBinaryResponseCache()
	for i := 0; i < binaryResponseCacheSize; i++ {
		cache.put(fmt.Sprint(i), binaryResponseBody{data: []byte{byte(i)}})
	}
	cache.get("0")
	cache.put("new", binaryResponseBody{data: []byte{9}})
	if _, ok := cache.get("0"); !ok {
		t.Fatal("recently read body was evicted")
	}
	if _, ok := cache.get("1"); ok {
		t.Fatal("least recently used body was retained")
	}
}

func TestBinaryResponseCacheBoundsTotalBytes(t *testing.T) {
	cache := newBinaryResponseCache()
	data := make([]byte, binaryResponseCacheBytes/2+1)
	cache.put("a", binaryResponseBody{data: data})
	cache.put("b", binaryResponseBody{data: data})
	if _, ok := cache.get("a"); ok {
		t.Fatal("byte limit must evict the oldest large body")
	}
	cache.put("b", binaryResponseBody{data: []byte{1}})
	cache.drop("b")
	if cache.bytes != 0 || len(cache.bodies) != 0 {
		t.Fatalf("cache accounting after replace/drop: %d bytes, %d bodies", cache.bytes, len(cache.bodies))
	}
}

package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/script"
)

func TestScriptSenderDisabledReturnsNil(t *testing.T) {
	if newScriptSender(context.Background(), false, model.HttpRequest{EnableSSLVerification: true}) != nil {
		t.Fatal("pm.sendRequest must stay unavailable unless the request opts in")
	}
	if newScriptSender(context.Background(), true, model.HttpRequest{EnableSSLVerification: true}) == nil {
		t.Fatal("opting in should produce a sender")
	}
}

func TestPerformScriptSend(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAllString(r)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"method":%q,"auth":%q,"body":%q}`, r.Method, r.Header.Get("Authorization"), body)
	}))
	defer server.Close()

	resp := performScriptSend(context.Background(), script.SendRequest{
		Method:  "post",
		URL:     server.URL + "/token",
		Headers: map[string]string{"Authorization": "Bearer abc"},
		Body:    "grant_type=client_credentials",
	}, model.HttpRequest{EnableSSLVerification: true})

	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if resp.StatusCode != 200 {
		t.Errorf("status = %d", resp.StatusCode)
	}
	if !strings.Contains(resp.Body, `"method":"POST"`) {
		t.Errorf("method not normalized: %s", resp.Body)
	}
	if !strings.Contains(resp.Body, `"auth":"Bearer abc"`) {
		t.Errorf("header not sent: %s", resp.Body)
	}
	if !strings.Contains(resp.Body, "grant_type=client_credentials") {
		t.Errorf("body not sent: %s", resp.Body)
	}
	if resp.Headers["Content-Type"] != "application/json" {
		t.Errorf("response headers missing: %#v", resp.Headers)
	}
	if resp.Size == 0 {
		t.Error("size should be set")
	}
}

func TestPerformScriptSendRejectsBadURLs(t *testing.T) {
	cases := []struct {
		name, url, wantIn string
	}{
		{"unresolved variable", "https://{{host}}/x", "unresolved"},
		{"bad scheme", "ftp://example.com/x", "scheme"},
		{"no host", "http://", "host"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := performScriptSend(context.Background(), script.SendRequest{URL: tc.url}, model.HttpRequest{EnableSSLVerification: true})
			if resp.Error == "" {
				t.Fatalf("expected an error for %q", tc.url)
			}
			if !strings.Contains(strings.ToLower(resp.Error), tc.wantIn) {
				t.Errorf("error %q should mention %q", resp.Error, tc.wantIn)
			}
		})
	}
}

func TestPerformScriptSendNon2xxIsNotAnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		fmt.Fprint(w, `{"nope":true}`)
	}))
	defer server.Close()

	resp := performScriptSend(context.Background(), script.SendRequest{URL: server.URL}, model.HttpRequest{EnableSSLVerification: true})
	if resp.Error != "" {
		t.Fatalf("a 418 must not be reported as an error, got %q", resp.Error)
	}
	if resp.StatusCode != http.StatusTeapot {
		t.Errorf("status = %d, want 418", resp.StatusCode)
	}
}

func TestPerformScriptSendStopsRedirectLoop(t *testing.T) {
	var hops int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops++
		http.Redirect(w, r, "/again", http.StatusFound)
	}))
	defer server.Close()

	resp := performScriptSend(context.Background(), script.SendRequest{URL: server.URL}, model.HttpRequest{EnableSSLVerification: true})
	if resp.Error == "" {
		t.Fatal("an endless redirect chain must be stopped")
	}
	if hops > scriptSendMaxRedirects+1 {
		t.Errorf("followed %d hops, cap is %d", hops, scriptSendMaxRedirects)
	}
}

func TestSendRequestPreScriptFetchesToken(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"access_token":"tok-from-script"}`)
	}))
	defer tokenServer.Close()

	var sawAuth string
	apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer apiServer.Close()

	req := model.HttpRequest{
		Method:                "GET",
		URL:                   apiServer.URL + "/data",
		EnableSSLVerification: true,
		AllowSendRequest:      true,
		ScriptEngine:          "js",
		PreRequestScript: fmt.Sprintf(`
			const res = pm.sendRequest({ method: "POST", url: %q, body: "grant_type=client_credentials" })
			pm.request.headers.set("Authorization", "Bearer " + res.json().access_token)
		`, tokenServer.URL),
	}

	resp := sendRequest(context.Background(), req, state.New(), newCookieJarRegistry(), nil)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if sawAuth != "Bearer tok-from-script" {
		t.Errorf("Authorization header = %q, want the token the script fetched", sawAuth)
	}
}

func TestSendRequestPmSendRequestBlockedWithoutOptIn(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the request should not have been sent — the pre-request script must fail first")
	}))
	defer server.Close()

	req := model.HttpRequest{
		Method:                "GET",
		URL:                   server.URL,
		EnableSSLVerification: true,
		ScriptEngine:          "js",
		PreRequestScript:      `pm.sendRequest("` + server.URL + `/other")`,
	}
	resp := sendRequest(context.Background(), req, state.New(), newCookieJarRegistry(), nil)
	if resp.Error == "" {
		t.Fatal("expected the pre-request script to fail")
	}
	if !strings.Contains(resp.Error, "disabled") {
		t.Errorf("error should explain that pm.sendRequest is disabled, got %q", resp.Error)
	}
}

func TestSendRequestSkipRequest(t *testing.T) {
	var hits int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
	}))
	defer server.Close()

	req := model.HttpRequest{
		Method:                "GET",
		URL:                   server.URL,
		EnableSSLVerification: true,
		ScriptEngine:          "js",
		PreRequestScript:      `pm.execution.skipRequest()`,
	}
	resp := sendRequest(context.Background(), req, state.New(), newCookieJarRegistry(), nil)
	if hits != 0 {
		t.Errorf("the request was sent %d times despite skipRequest()", hits)
	}
	if !resp.Skipped {
		t.Error("response should be marked as skipped")
	}
	if resp.Error != "" {
		t.Errorf("a skip is not a failure, got error %q", resp.Error)
	}
	if resp.SkipReason == "" {
		t.Error("a skip should carry a reason")
	}
}

func TestSendRequestCollectionVariablesRoundTrip(t *testing.T) {
	var gotURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURL = r.URL.String()
		fmt.Fprint(w, `{"id":"abc"}`)
	}))
	defer server.Close()

	req := model.HttpRequest{
		Method:                "GET",
		URL:                   server.URL + "/things",
		EnableSSLVerification: true,
		ScriptEngine:          "js",
		CollectionVariables:   map[string]string{"apiVersion": "v2", "stale": "remove-me"},
		PreRequestScript:      `pm.request.set_url(pm.request.url + "?v=" + pm.collectionVariables.get("apiVersion"))`,
		TestScript: `
			pm.collectionVariables.set("lastId", pm.response.json().id)
			pm.collectionVariables.unset("stale")
		`,
	}
	sm := state.New()
	resp := sendRequest(context.Background(), req, sm, newCookieJarRegistry(), nil)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if !strings.Contains(gotURL, "v=v2") {
		t.Errorf("pre-request script did not read the collection variable: %q", gotURL)
	}
	if resp.CollectionVariableUpdates["lastId"] != "abc" {
		t.Errorf("collection variable write not reported: %#v", resp.CollectionVariableUpdates)
	}
	if len(resp.CollectionVariablesRemoved) != 1 || resp.CollectionVariablesRemoved[0] != "stale" {
		t.Errorf("removal not reported: %#v", resp.CollectionVariablesRemoved)
	}
	if vars := sm.GetVariables(); len(vars) != 0 {
		t.Errorf("collection variables leaked into session state: %#v", vars)
	}
}

func TestSendRequestScriptTimeoutOverride(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "ok")
	}))
	defer server.Close()

	src := `
		const start = Date.now()
		while (Date.now() - start < 2400) { }
		pm.request.headers.set("X-Slow", "done")
	`
	req := model.HttpRequest{
		Method:                "GET",
		URL:                   server.URL,
		EnableSSLVerification: true,
		ScriptEngine:          "js",
		PreRequestScript:      src,
	}

	resp := sendRequest(context.Background(), req, state.New(), newCookieJarRegistry(), nil)
	if resp.Error == "" {
		t.Error("expected the default 2s script timeout to trip")
	}

	req.ScriptTimeoutMs = 10_000
	resp = sendRequest(context.Background(), req, state.New(), newCookieJarRegistry(), nil)
	if resp.Error != "" {
		t.Errorf("override should have allowed the script to finish, got %q", resp.Error)
	}
}

func TestSendRequestPmInfoRequestName(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "{}")
	}))
	defer server.Close()

	req := model.HttpRequest{
		Method:                "GET",
		URL:                   server.URL,
		EnableSSLVerification: true,
		ScriptEngine:          "js",
		Name:                  "Fetch widgets",
		Iteration:             3,
		IterationCount:        10,
		TestScript: `
			pm.test("name", () => pm.expect(pm.info.requestName).to.equal("Fetch widgets"))
			pm.test("iteration", () => pm.expect(pm.info.iteration).to.equal(3))
			pm.test("count", () => pm.expect(pm.info.iterationCount).to.equal(10))
		`,
	}
	resp := sendRequest(context.Background(), req, state.New(), newCookieJarRegistry(), nil)
	if len(resp.TestResult.Tests) != 3 {
		t.Fatalf("expected 3 assertions, got %#v", resp.TestResult.Tests)
	}
	for _, test := range resp.TestResult.Tests {
		if !test.Passed {
			t.Errorf("test %q failed: %s", test.Name, test.Error)
		}
	}
}

func TestSendRequestPmCookies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "s-42", Path: "/"})
		fmt.Fprint(w, "{}")
	}))
	defer server.Close()

	jars := newCookieJarRegistry()
	req := model.HttpRequest{
		Method:                "GET",
		URL:                   server.URL,
		EnableSSLVerification: true,
		ScriptEngine:          "js",
		WorkspaceID:           "ws-1",
	}
	if resp := sendRequest(context.Background(), req, state.New(), jars, nil); resp.Error != "" {
		t.Fatalf("first send failed: %s", resp.Error)
	}

	req.TestScript = `
		pm.test("cookie visible", () => pm.expect(pm.cookies.get("session")).to.equal("s-42"))
		pm.test("has", () => pm.expect(pm.cookies.has("session")).to.be.true)
	`
	resp := sendRequest(context.Background(), req, state.New(), jars, nil)
	if len(resp.TestResult.Tests) == 0 {
		t.Fatal("no assertions ran")
	}
	for _, test := range resp.TestResult.Tests {
		if !test.Passed {
			t.Errorf("test %q failed: %s", test.Name, test.Error)
		}
	}
}

func TestTestScriptSeesCollectionVariablesThePreRequestScriptSet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{}`)
	}))
	defer server.Close()

	req := model.HttpRequest{
		Method:                "GET",
		URL:                   server.URL,
		EnableSSLVerification: true,
		ScriptEngine:          "js",
		CollectionVariables:   map[string]string{"token": "old", "stale": "x"},
		PreRequestScript: `
			pm.collectionVariables.set("token", "fresh")
			pm.collectionVariables.unset("stale")
		`,
		TestScript: `
			pm.test("token", () => pm.expect(pm.collectionVariables.get("token")).to.eql("fresh"))
			pm.test("stale", () => pm.expect(pm.collectionVariables.get("stale")).to.not.eql("x"))
		`,
	}
	resp := sendRequest(context.Background(), req, state.New(), newCookieJarRegistry(), nil)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if len(resp.TestResult.Tests) != 2 {
		t.Fatalf("expected two tests, got %#v", resp.TestResult)
	}
	for _, test := range resp.TestResult.Tests {
		if !test.Passed {
			t.Errorf("test %q failed: %s", test.Name, test.Error)
		}
	}
	if resp.CollectionVariableUpdates["token"] != "fresh" {
		t.Errorf("pre-request update not reported: %#v", resp.CollectionVariableUpdates)
	}
}

func TestMergeCollectionVariableResults(t *testing.T) {
	pre := model.ScriptResult{
		CollectionVariables:        map[string]string{"a": "1", "shared": "from-pre"},
		CollectionVariablesRemoved: []string{"gone"},
	}
	test := model.ScriptResult{
		CollectionVariables:        map[string]string{"b": "2", "shared": "from-test"},
		CollectionVariablesRemoved: []string{"a"},
	}
	updates, removed := mergeCollectionVariableResults(pre, test)

	if updates["shared"] != "from-test" {
		t.Errorf("shared = %q, want from-test", updates["shared"])
	}
	if updates["b"] != "2" {
		t.Errorf("b missing: %#v", updates)
	}
	if _, stillSet := updates["a"]; stillSet {
		t.Errorf("a was unset later and must not be reported as a write: %#v", updates)
	}
	if len(removed) != 2 || removed[0] != "a" || removed[1] != "gone" {
		t.Errorf("removed = %#v, want [a gone]", removed)
	}
}

func readAllString(r *http.Request) (string, error) {
	if r.Body == nil {
		return "", nil
	}
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := r.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			return sb.String(), nil
		}
	}
}

package proxycapture

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestRulePatterns(t *testing.T) {
	cases := []struct {
		pattern, method, requestMethod, target string
		want                                   bool
	}{
		{"https://api.shop.test/orders/*", "", "GET", "https://api.shop.test/orders/184", true},
		{"https://api.shop.test/orders/*", "", "GET", "https://api.shop.test/orders", false},
		{"https://api.shop.test/orders/*", "", "GET", "https://api.shop.test/orders/184?expand=items", true},
		{"https://api.shop.test/orders/*", "POST", "GET", "https://api.shop.test/orders/184", false},
		{"https://API.Shop.test/orders", "", "GET", "https://api.shop.test/orders", true},
		{"https://api.shop.test/Orders", "", "GET", "https://api.shop.test/orders", false},
		{"https://api.shop.test", "", "GET", "https://api.shop.test/anything/here", true},
		{"https://api.shop.test", "", "GET", "http://api.shop.test/", false},
		{"*://api.shop.test/*", "", "GET", "http://api.shop.test/x", true},
		{"https://*.shop.test/*", "", "GET", "https://cdn.shop.test/app.js", true},
		{"http://localhost:*/api/*", "", "GET", "http://localhost:3000/api/users", true},
		{"https://api.shop.test/search?q=*", "", "GET", "https://api.shop.test/search?q=boots", true},
		{"https://api.shop.test/search?q=*", "", "GET", "https://api.shop.test/search", false},
		{"https://api.shop.test/a.b", "", "GET", "https://api.shop.test/aXb", false},
	}
	for _, c := range cases {
		rule, err := compileRule(Rule{ID: "x", Kind: RuleLocal, Method: c.method, URL: c.pattern, Local: LocalAnswer{Status: 200}})
		if err != nil {
			t.Fatal(c.pattern, err)
		}
		u, _ := url.Parse(c.target)
		if got := rule.matches(&http.Request{Method: c.requestMethod, URL: u}); got != c.want {
			t.Fatalf("%s %s matched %s: %v", c.method, c.pattern, c.target, got)
		}
	}
}

func TestRuleValidation(t *testing.T) {
	ok := LocalAnswer{Status: 200}
	bad := []Rule{
		{ID: "", Kind: RuleLocal, URL: "https://a.test/", Local: ok},
		{ID: "a", Kind: "block", URL: "https://a.test/", Local: ok},
		{ID: "a", Kind: RuleLocal, URL: "a.test/x", Local: ok},
		{ID: "a", Kind: RuleLocal, URL: "ftp://a.test/x", Local: ok},
		{ID: "a", Kind: RuleLocal, URL: "https:///x", Local: ok},
		{ID: "a", Kind: RuleLocal, URL: "https://a.test/ x", Local: ok},
		{ID: "a", Kind: RuleLocal, Method: "get me", URL: "https://a.test/", Local: ok},
		{ID: "a", Kind: RuleLocal, URL: "https://a.test/", Local: LocalAnswer{Status: 99}},
		{ID: "a", Kind: RuleLocal, URL: "https://a.test/", Local: LocalAnswer{Status: 200, DelayMs: 40000}},
		{ID: "a", Kind: RuleLocal, URL: "https://a.test/", Local: LocalAnswer{Status: 200, ContentType: "text/plain\r\nX: y"}},
		{ID: "a", Kind: RuleRewrite, URL: "https://a.test/"},
		{ID: "a", Kind: RuleRewrite, URL: "https://a.test/", Rewrite: RewriteAction{Target: "localhost:3000"}},
		{ID: "a", Kind: RuleRewrite, URL: "https://a.test/", Rewrite: RewriteAction{Target: "http://localhost:3000/api"}},
		{ID: "a", Kind: RuleRewrite, URL: "https://a.test/", Rewrite: RewriteAction{PathTo: "/v2"}},
		{ID: "a", Kind: RuleRewrite, URL: "https://a.test/", Rewrite: RewriteAction{SetRequestHeaders: []HeaderValue{{Name: "Bad Name", Value: "x"}}}},
		{ID: "a", Kind: RuleRewrite, URL: "https://a.test/", Rewrite: RewriteAction{SetResponseHeaders: []HeaderValue{{Name: "X", Value: "a\nb"}}}},
	}
	var r Recorder
	for i, rule := range bad {
		if err := r.SetRules([]Rule{rule}); err == nil {
			t.Fatalf("case %d accepted %+v", i, rule)
		}
	}
	good := Rule{ID: "a", Name: " Staging ", Enabled: true, Kind: RuleRewrite, Method: "get", URL: " https://a.test/* ", Rewrite: RewriteAction{Target: "http://localhost:3000/"}}
	if err := r.SetRules([]Rule{good, good}); err == nil || !strings.Contains(err.Error(), "twice") {
		t.Fatal(err)
	}
	many := make([]Rule, maxRules+1)
	for i := range many {
		many[i] = Rule{ID: fmt.Sprint(i), Kind: RuleLocal, URL: "https://a.test/", Local: ok}
	}
	if err := r.SetRules(many); err == nil {
		t.Fatal("accepted too many rules")
	}
	if err := r.SetRules([]Rule{good}); err != nil {
		t.Fatal(err)
	}
	stored := r.Rules()[0]
	if stored.Name != "Staging" || stored.Method != "GET" || stored.URL != "https://a.test/*" || stored.Rewrite.Target != "http://localhost:3000" || stored.Local != (LocalAnswer{}) {
		t.Fatalf("%+v", stored)
	}
	if r.Status().Rules != 1 {
		t.Fatal(r.Status())
	}
}

func TestRewriteRequestAndResponse(t *testing.T) {
	original := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("request reached the original server")
	}))
	defer original.Close()
	var seen *http.Request
	replacement := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Clone(r.Context())
		w.Header().Set("X-Secret", "hidden")
		io.WriteString(w, "from replacement "+r.URL.Path)
	}))
	defer replacement.Close()
	r, client := startRecorder(t, Config{})
	rules := []Rule{
		{ID: "move", Name: "Use local API", Enabled: true, Kind: RuleRewrite, URL: original.URL + "/v1/*", Rewrite: RewriteAction{
			Target: replacement.URL, PathFrom: "/v1/", PathTo: "/v2/",
			SetRequestHeaders: []HeaderValue{{Name: "X-Env", Value: "staging"}}, RemoveRequestHeaders: []string{"X-Remove"},
			SetResponseHeaders: []HeaderValue{{Name: "X-Rewritten", Value: "yes"}}, RemoveResponseHeaders: []string{"X-Secret"},
		}},
		{ID: "off", Name: "Disabled", Enabled: false, Kind: RuleLocal, URL: original.URL + "/*", Local: LocalAnswer{Status: 418}},
	}
	if err := r.SetRules(rules); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", original.URL+"/v1/orders?id=7", nil)
	req.Header.Set("X-Remove", "1")
	resp, err := client.Do(req)
	if body := responseText(t, resp, err); body != "from replacement /v2/orders" || resp.Header.Get("X-Rewritten") != "yes" || resp.Header.Get("X-Secret") != "" {
		t.Fatal(body, resp.Header)
	}
	if seen == nil || seen.Header.Get("X-Env") != "staging" || seen.Header.Get("X-Remove") != "" || seen.URL.RawQuery != "id=7" {
		t.Fatal(seen)
	}
	rows := r.Entries()
	if len(rows) != 1 || rows[0].Rule != "Use local API" || rows[0].Rewritten != replacement.URL+"/v2/orders?id=7" || rows[0].URL != original.URL+"/v1/orders?id=7" || rows[0].Local {
		t.Fatal(rows)
	}
	x, _ := r.Get(rows[0].ID)
	if x.Response.Headers["X-Rewritten"] == nil || x.Response.Headers["X-Secret"] != nil || x.Request.Headers["X-Env"] == nil {
		t.Fatal(x.Request.Headers, x.Response.Headers)
	}
	stored := r.Rules()
	if stored[0].Hits != 1 || stored[1].Hits != 0 {
		t.Fatal(stored)
	}
	if err := r.SetRules(rules); err != nil || r.Rules()[0].Hits != 1 {
		t.Fatal("hits were not kept for an unchanged rule ID", err)
	}
}

func TestLocalRuleWinsOverRewriteAndFirstLocalWins(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("request reached upstream") }))
	defer target.Close()
	r, client := startRecorder(t, Config{})
	err := r.SetRules([]Rule{
		{ID: "rewrite", Enabled: true, Kind: RuleRewrite, URL: target.URL + "/*", Rewrite: RewriteAction{Target: "http://127.0.0.1:1"}},
		{ID: "first", Name: "First", Enabled: true, Kind: RuleLocal, Method: "GET", URL: target.URL + "/items/*", Local: LocalAnswer{Status: 201, Body: "first", ContentType: "text/plain"}},
		{ID: "second", Name: "Second", Enabled: true, Kind: RuleLocal, URL: target.URL + "/*", Local: LocalAnswer{Status: 202, Body: "second"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Get(target.URL + "/items/9")
	if body := responseText(t, resp, err); body != "first" || resp.StatusCode != 201 {
		t.Fatal(body, resp.StatusCode)
	}
	resp, err = client.Post(target.URL+"/items/9", "text/plain", nil)
	if body := responseText(t, resp, err); body != "second" {
		t.Fatal(body)
	}
	rows := r.Entries()
	if rows[0].Rule != "First" || !rows[0].Local || rows[1].Rule != "Second" || rows[0].Rewritten != "" {
		t.Fatal(rows)
	}
	hits := r.Rules()
	if hits[0].Hits != 0 || hits[1].Hits != 1 || hits[2].Hits != 1 {
		t.Fatal(hits)
	}
}

func TestDeleteEntries(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, r.URL.Path) }))
	defer target.Close()
	r, client := startRecorder(t, Config{})
	for _, path := range []string{"/a", "/b", "/c"} {
		resp, err := client.Get(target.URL + path)
		responseText(t, resp, err)
	}
	rows := r.Entries()
	status := r.Delete([]int64{rows[0].ID, rows[2].ID, 999})
	if status.Count != 1 {
		t.Fatal(status)
	}
	left := r.Entries()
	if len(left) != 1 || left[0].Path != "/b" {
		t.Fatal(left)
	}
	if _, err := r.Get(rows[0].ID); err == nil {
		t.Fatal("deleted entry is still available")
	}
	if hits := r.Search("/a", nil); len(hits) != 0 {
		t.Fatal(hits)
	}
	resp, err := client.Get(target.URL + "/d")
	responseText(t, resp, err)
	if got := r.Entries(); len(got) != 2 || got[1].Path != "/d" {
		t.Fatal(got)
	}
	har, err := r.HAR(nil)
	if err != nil || strings.Contains(har, target.URL+"/a") || !strings.Contains(har, target.URL+"/d") {
		t.Fatal(har, err)
	}
}

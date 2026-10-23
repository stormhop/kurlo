package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/script"
)

func pathRow(key, value string, enabled bool) model.KeyValue {
	return model.KeyValue{Key: key, Value: value, Enabled: enabled}
}

func TestApplyPathParams(t *testing.T) {
	cases := []struct {
		name string
		url  string
		rows []model.KeyValue
		want string
	}{
		{"fills segments", "https://api.test/users/:id/posts/:postId", []model.KeyValue{pathRow("id", "42", true), pathRow("postId", "7", true)}, "https://api.test/users/42/posts/7"},
		{"leaves host port alone", "http://localhost:8080/users/:id", []model.KeyValue{pathRow("8080", "x", true), pathRow("id", "1", true)}, "http://localhost:8080/users/1"},
		{"without scheme", "localhost:3000/items/:id", []model.KeyValue{pathRow("id", "5", true)}, "localhost:3000/items/5"},
		{"keeps query and fragment", "https://api.test/u/:id?sort=:id#:id", []model.KeyValue{pathRow("id", "9", true)}, "https://api.test/u/9?sort=:id#:id"},
		{"disabled row stays literal", "https://api.test/u/:id", []model.KeyValue{pathRow("id", "9", false)}, "https://api.test/u/:id"},
		{"empty value stays literal", "https://api.test/u/:id", []model.KeyValue{pathRow("id", "", true)}, "https://api.test/u/:id"},
		{"only whole segments", "https://api.test/u/a:id/:id.json", []model.KeyValue{pathRow("id", "1", true), pathRow("id.json", "2.json", true)}, "https://api.test/u/a:id/2.json"},
		{"escapes path breakers", "https://api.test/f/:name", []model.KeyValue{pathRow("name", "a b/c?d#e", true)}, "https://api.test/f/a%20b%2Fc%3Fd%23e"},
		{"keeps percent escapes", "https://api.test/f/:name", []model.KeyValue{pathRow("name", "a%2Fb%zz", true)}, "https://api.test/f/a%2Fb%25zz"},
		{"ipv6 host", "http://[::1]:9000/u/:id", []model.KeyValue{pathRow("id", "3", true)}, "http://[::1]:9000/u/3"},
		{"no path", "https://api.test", []model.KeyValue{pathRow("id", "3", true)}, "https://api.test"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := applyPathParams(tc.url, tc.rows); got != tc.want {
				t.Fatalf("applyPathParams(%q) = %q, want %q", tc.url, got, tc.want)
			}
		})
	}
}

func TestSendRequestFillsPathVariables(t *testing.T) {
	var gotPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotQuery = r.URL.RawQuery
	}))
	defer srv.Close()

	req := model.HttpRequest{
		Method:           "GET",
		URL:              "{{base}}/users/:userId/files/:file",
		Params:           []model.KeyValue{pathRow("v", "1", true)},
		PathParams:       []model.KeyValue{pathRow("userId", "{{user}}", true), pathRow("file", "report 1.pdf", true)},
		ResolveTemplates: true,
		TemplateValues:   map[string]string{"base": srv.URL, "user": "u-7"},
		PreRequestScript: `pm.request.pathVariables.set("userId", pm.request.pathVariables.get("userId") + "x")`,
		ScriptEngine:     "js",
	}
	resp := sendRequest(context.Background(), req, state.New(), newCookieJarRegistry(), nil)
	if resp.Error != "" {
		t.Fatalf("send failed: %s", resp.Error)
	}
	if gotPath != "/users/u-7x/files/report%201.pdf" {
		t.Fatalf("server saw path %q", gotPath)
	}
	if gotQuery != "v=1" {
		t.Fatalf("server saw query %q", gotQuery)
	}
}

func TestScriptReadsPathVariables(t *testing.T) {
	req := model.HttpRequest{
		URL:        "https://api.test/users/:id",
		PathParams: []model.KeyValue{pathRow("id", "42", true), pathRow("off", "x", false)},
	}
	for _, engine := range []string{"js", "tengo"} {
		ctx := script.NewContext(nil, nil)
		populateScriptRequestContext(ctx, req)
		src := `pm.test("reads", function () {
  pm.expect(pm.request.pathVariables.get("id")).to.equal("42");
  pm.expect(pm.request.pathVariables.has("off")).to.equal(false);
  pm.expect(pm.request.pathVariables.toObject()).to.eql({ id: "42" });
  pm.expect(pm.request.url).to.equal("https://api.test/users/:id");
});`
		if engine == "tengo" {
			src = `pm.request.pathVariables.set("id", pm.request.pathVariables.get("id") + "0")`
		}
		result := script.RunPreRequest(engine, src, ctx)
		if result.Error != "" {
			t.Fatalf("%s script error: %s", engine, result.Error)
		}
		for _, test := range result.Tests {
			if !test.Passed {
				t.Fatalf("%s test %q failed: %s", engine, test.Name, test.Error)
			}
		}
		next := req
		next.PathParams = append([]model.KeyValue(nil), req.PathParams...)
		mergeScriptPathParams(ctx, &next)
		want := "42"
		if engine == "tengo" {
			want = "420"
		}
		if next.PathParams[0].Value != want {
			t.Fatalf("%s: id = %q, want %q", engine, next.PathParams[0].Value, want)
		}
	}
}

func TestCLIRequestCarriesPathVariables(t *testing.T) {
	req := buildHTTPRequest(cliSavedRequest{
		Method: "GET",
		URL:    "{{base}}/users/:id",
		PathParams: []cliKV{
			{Key: " id ", Value: "{{user}}", Enabled: true},
			{Key: "off", Value: "x", Enabled: false},
		},
	}, nil, nil, 0)
	if len(req.PathParams) != 1 || req.PathParams[0].Key != "id" || req.PathParams[0].Value != "{{user}}" {
		t.Fatalf("path params = %+v", req.PathParams)
	}
	resolved, err := resolveHTTPRequestTemplates(req, map[string]string{"base": "https://api.test", "user": "7"})
	if err != nil {
		t.Fatal(err)
	}
	if got := applyPathParams(resolved.URL, resolved.PathParams); got != "https://api.test/users/7" {
		t.Fatalf("resolved URL = %q", got)
	}
}

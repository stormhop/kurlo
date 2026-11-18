package script

import (
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestScriptEnginesSharePreRequestContract(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		engine Engine
		source string
	}{
		{
			name:   "javascript",
			engine: EngineJS,
			source: `
pm.variables.set("tokenCopy", pm.environment.get("token"));
pm.environment.set("added", "yes");
pm.environment.unset("removeMe");
pm.request.set_url("https://changed.example.test/v2");
pm.request.headers.set("X-Trace", "trace-js");
pm.request.headers.unset("X-Remove");
pm.request.params.set("page", "2");
pm.log("pre", pm.request.method);
`,
		},
		{
			name:   "tengo",
			engine: EngineTengo,
			source: `
pm.variables.set("tokenCopy", pm.environment.get("token"))
pm.environment.set("added", "yes")
pm.environment.unset("removeMe")
pm.request.set_url("https://changed.example.test/v2")
pm.request.headers.set("X-Trace", "trace-tengo")
pm.request.headers.unset("X-Remove")
pm.request.params.set("page", "2")
pm.log("pre", pm.request.method)
`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := NewContext(nil, map[string]string{"token": "secret", "removeMe": "old"})
			ctx.RequestURL = "https://api.example.test/v1"
			ctx.RequestMethod = "POST"
			ctx.RequestHeaders["X-Remove"] = "delete"

			result := RunPreRequest(string(tc.engine), tc.source, ctx)
			if result.Error != "" {
				t.Fatalf("unexpected pre-request error: %s", result.Error)
			}
			if ctx.Variables["tokenCopy"] != "secret" {
				t.Fatalf("tokenCopy = %q", ctx.Variables["tokenCopy"])
			}
			if ctx.Environment["added"] != "yes" {
				t.Fatalf("environment mutation missing: %+v", ctx.Environment)
			}
			if _, ok := ctx.Environment["removeMe"]; ok {
				t.Fatalf("environment unset failed: %+v", ctx.Environment)
			}
			if ctx.RequestURL != "https://changed.example.test/v2" {
				t.Fatalf("request URL mutation failed: %q", ctx.RequestURL)
			}
			if ctx.RequestParams["page"] != "2" {
				t.Fatalf("request param mutation failed: %+v", ctx.RequestParams)
			}
			if _, removed := ctx.RemovedHeaders["x-remove"]; !removed {
				t.Fatalf("header unset should mark x-remove removed: %+v", ctx.RemovedHeaders)
			}
			if got := ctx.RequestHeaders["X-Trace"]; !strings.HasPrefix(got, "trace-") {
				t.Fatalf("request header mutation failed: %+v", ctx.RequestHeaders)
			}
			if len(result.Logs) != 1 || result.Logs[0] != "pre POST" {
				t.Fatalf("expected shared log output, got %+v", result.Logs)
			}
		})
	}
}

func TestScriptEnginesShareTestScriptContract(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		engine Engine
		source string
	}{
		{
			name:   "javascript",
			engine: EngineJS,
			source: `
const body = pm.response.json();
pm.variables.set("id", body.id);
pm.variables.set("contentType", pm.response.headers.get("content-type"));
pm.test("status ok", () => pm.response.to.have.status(200));
pm.test("has id", () => pm.expect(body).to.have.property("id"));
pm.test("fast", () => pm.expect(pm.response.responseTime).to.be.below(500));
pm.log("test", body.name);
`,
		},
		{
			name:   "tengo",
			engine: EngineTengo,
			source: `
body := pm.response.json()
pm.variables.set("id", body["id"])
pm.variables.set("contentType", pm.response.headers.get("content-type"))
pm.test("status ok", pm.response.code == 200)
pm.test("has id", pm.expect(body).has_key("id"))
pm.test("fast", pm.expect(pm.response.time).less_than(500))
pm.log("test", body["name"])
`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := NewContext(nil, nil)
			ctx.Response = &model.HttpResponse{
				StatusCode: 200,
				Status:     "200 OK",
				Duration:   42,
				Size:       32,
				Body:       `{"id": "fixture-1", "name": "Ada"}`,
				Headers:    []model.KeyValue{{Key: "Content-Type", Value: "application/json"}},
			}

			result := RunTests(string(tc.engine), tc.source, ctx)
			if result.Error != "" {
				t.Fatalf("unexpected test script error: %s", result.Error)
			}
			if ctx.Variables["id"] != "fixture-1" {
				t.Fatalf("id variable = %q", ctx.Variables["id"])
			}
			if ctx.Variables["contentType"] != "application/json" {
				t.Fatalf("contentType variable = %q", ctx.Variables["contentType"])
			}
			if len(result.Tests) != 3 {
				t.Fatalf("expected 3 tests, got %+v", result.Tests)
			}
			for _, test := range result.Tests {
				if !test.Passed {
					t.Fatalf("expected %q to pass: %s", test.Name, test.Error)
				}
			}
			if len(result.Logs) != 1 || result.Logs[0] != "test Ada" {
				t.Fatalf("expected shared log output, got %+v", result.Logs)
			}
		})
	}
}

func TestJavaScriptRequestAuthParameters(t *testing.T) {
	for _, tc := range []struct {
		config model.AuthConfig
		check  string
	}{
		{model.AuthConfig{}, `pm.expect(auth.type).to.eql("noauth"); pm.expect(params.count()).to.eql(0);`},
		{model.AuthConfig{Type: "apikey", KeyName: "api_key", KeyIn: "query"}, `pm.expect(auth.apikey.one("key").value).to.eql("api_key"); pm.expect(params.get("in")).to.eql("query");`},
		{model.AuthConfig{Type: "digest", Username: "alice"}, `pm.expect(auth.digest.get("username")).to.eql("alice");`},
		{model.AuthConfig{Type: "ntlm", Username: "bob"}, `pm.expect(auth.ntlm.get("username")).to.eql("bob");`},
		{model.AuthConfig{Type: "aws", AWSSessionToken: "temp"}, `pm.expect(auth.awsv4.get("sessionToken")).to.eql("temp");`},
		{model.AuthConfig{Type: "oauth2", Token: "access", OAuth2GrantType: "authorization_code", OAuth2UsePKCE: true}, `pm.expect(params.get("grant_type")).to.eql("authorization_code_with_pkce"); pm.expect(auth.oauth2.get("accessToken")).to.eql("access");`},
		{model.AuthConfig{Type: "oauth1", OAuth1IncludeBodyHash: true}, `pm.expect(auth.oauth1.get("includeBodyHash")).to.eql(true);`},
		{model.AuthConfig{Type: "jwt", JWTAddTo: "query"}, `pm.expect(auth.jwt.get("addTokenTo")).to.eql("queryParam");`},
	} {
		t.Run(tc.config.Type, func(t *testing.T) {
			ctx := NewContext(nil, nil)
			ctx.RequestAuth = tc.config
			source := `const auth = pm.request.auth, params = auth.parameters(); pm.expect(params.has("missing")).to.eql(false); pm.expect(params.get("missing")).to.eql(undefined);`
			if result := RunPreRequest("js", source+tc.check, ctx); result.Error != "" {
				t.Fatal(result.Error)
			}
		})
	}
}

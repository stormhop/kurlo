package script

import (
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestJSJetBrainsResponseHandlerRuns(t *testing.T) {
	t.Parallel()

	ctx := NewContext(nil, nil)
	ctx.Response = &model.HttpResponse{
		StatusCode: 201,
		Status:     "201 Created",
		Body:       `{"token":"abc","items":[1,2]}`,
		Headers:    []model.KeyValue{{Key: "Content-Type", Value: "application/json; charset=utf-8"}, {Key: "X-Trace", Value: "t-1"}},
	}
	res := jsTests(`
client.global.set("token", response.body.token);
client.test("created", function () {
  client.assert(response.status === 201, "expected 201");
});
client.test("json", () => client.assert(response.contentType.mimeType === "application/json"));
client.test("charset", () => client.assert(response.contentType.charset === "utf-8"));
client.test("trace", () => client.assert(response.headers.valueOf("x-trace") === "t-1"));
client.test("missing header", () => client.assert(response.headers.valueOf("nope") === null));
client.test("items", () => client.assert(response.body.items.length === 3, "expected three items"));
client.log("status", response.status);
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["token"] != "abc" {
		t.Fatalf("token = %q", ctx.Variables["token"])
	}
	got := map[string]model.TestResult{}
	for _, test := range res.Tests {
		got[test.Name] = test
	}
	for _, name := range []string{"created", "json", "charset", "trace", "missing header"} {
		if !got[name].Passed {
			t.Errorf("%s failed: %+v", name, got[name])
		}
	}
	if got["items"].Passed || got["items"].Error != "expected three items" {
		t.Errorf("items = %+v", got["items"])
	}
	if len(res.Logs) == 0 || res.Logs[0] != "status 201" {
		t.Errorf("logs = %+v", res.Logs)
	}
}

func TestJSJetBrainsPreRequestScriptRuns(t *testing.T) {
	t.Parallel()

	ctx := NewContext(nil, map[string]string{"host": "api.test"})
	ctx.RequestURL = "https://{{host}}/users"
	ctx.RequestMethod = "POST"
	ctx.RequestHeaders = map[string]string{"Authorization": "Bearer {{host}}"}
	res := jsPre(`
request.variables.set("stamp", "s-" + request.method);
request.variables.set("env", request.environment.get("host"));
request.variables.set("url", request.url.tryGetSubstituted());
request.variables.set("auth", request.headers.findByName("authorization").getRawValue());
request.variables.set("missing", String(request.headers.findByName("nope")));
request.variables.set("empty", String(client.global.isEmpty()));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	want := map[string]string{
		"stamp":   "s-POST",
		"env":     "api.test",
		"url":     "https://api.test/users",
		"auth":    "Bearer {{host}}",
		"missing": "null",
		"empty":   "false",
	}
	for key, value := range want {
		if ctx.Variables[key] != value {
			t.Errorf("%s = %q, want %q", key, ctx.Variables[key], value)
		}
	}
}

func TestJSPostmanScriptsMayStillDeclareRequestAndResponse(t *testing.T) {
	t.Parallel()

	ctx := NewContext(nil, nil)
	ctx.Response = &model.HttpResponse{StatusCode: 200, Status: "200 OK", Body: `{"id":7}`}
	res := jsTests(`
const response = pm.response.json();
let request = { id: response.id };
var client = "mine";
pm.test("own names", () => pm.expect(request.id + client).to.eql("7mine"));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if len(res.Tests) != 1 || !res.Tests[0].Passed {
		t.Fatalf("tests = %+v", res.Tests)
	}
}

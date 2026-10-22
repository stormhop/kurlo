package script

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func jsPre(src string, ctx *Context) model.ScriptResult {
	return RunPreRequest(string(EngineJS), src, ctx)
}

func jsTests(src string, ctx *Context) model.ScriptResult {
	return RunTests(string(EngineJS), src, ctx)
}

func TestJSModernSyntaxAndVariables(t *testing.T) {
	ctx := NewContext(nil, nil)
	res := jsPre(`
const base = "https://api.example.com";
let parts = ["v", "2"];
const joined = parts.map(p => p.toUpperCase()).join("-");
pm.variables.set("base", base);
pm.variables.set("joined", joined);
pm.variables.set("count", 42);
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["base"] != "https://api.example.com" {
		t.Fatalf("base = %q", ctx.Variables["base"])
	}
	if ctx.Variables["joined"] != "V-2" {
		t.Fatalf("joined = %q", ctx.Variables["joined"])
	}
	if ctx.Variables["count"] != "42" {
		t.Fatalf("count = %q (numbers should be stringified)", ctx.Variables["count"])
	}
}

func TestJSEnvironmentGetSetUnsetClear(t *testing.T) {
	ctx := NewContext(nil, map[string]string{"token": "secret", "keep": "yes"})
	res := jsPre(`
pm.variables.set("echo", pm.environment.get("token"));
pm.environment.set("added", "new");
pm.environment.unset("keep");
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["echo"] != "secret" {
		t.Fatalf("echo = %q", ctx.Variables["echo"])
	}
	if ctx.Environment["added"] != "new" {
		t.Fatalf("added missing: %+v", ctx.Environment)
	}
	if _, ok := ctx.Environment["keep"]; ok {
		t.Fatalf("keep should have been unset: %+v", ctx.Environment)
	}
}

func TestJSIterationDataIsReadable(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.IterationData = map[string]string{"user": "ada", "role": "admin"}
	res := jsPre(`
pm.variables.set("who", pm.iterationData.get("user"));
pm.variables.set("missing", String(pm.iterationData.get("nope") === undefined));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["who"] != "ada" {
		t.Fatalf("who = %q", ctx.Variables["who"])
	}
	if ctx.Variables["missing"] != "true" {
		t.Fatalf("expected undefined for a missing iterationData key, got %q", ctx.Variables["missing"])
	}
}

func TestJSMissingValueIsUndefined(t *testing.T) {
	ctx := NewContext(nil, nil)
	res := jsPre(`
pm.variables.set("missingIsUndefined", String(pm.environment.get("nope") === undefined));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["missingIsUndefined"] != "true" {
		t.Fatalf("expected undefined for missing key, got %q", ctx.Variables["missingIsUndefined"])
	}
}

func TestJSRequestMutation(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.RequestURL = "https://old.example.com"
	ctx.RequestMethod = "GET"
	ctx.RequestHeaders["X-Existing"] = "1"

	res := jsPre(`
pm.variables.set("origUrl", pm.request.url);
pm.variables.set("method", pm.request.method);
pm.request.set_url("https://new.example.com");
pm.request.headers.set("X-Token", "abc");
pm.request.headers.unset("X-Existing");
pm.request.params.set("page", "2");
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["origUrl"] != "https://old.example.com" {
		t.Fatalf("origUrl = %q", ctx.Variables["origUrl"])
	}
	if ctx.Variables["method"] != "GET" {
		t.Fatalf("method = %q", ctx.Variables["method"])
	}
	if ctx.RequestURL != "https://new.example.com" {
		t.Fatalf("url not updated: %q", ctx.RequestURL)
	}
	if ctx.RequestHeaders["X-Token"] != "abc" {
		t.Fatalf("header not set: %+v", ctx.RequestHeaders)
	}
	if _, removed := ctx.RemovedHeaders["x-existing"]; !removed {
		t.Fatalf("X-Existing should be marked removed: %+v", ctx.RemovedHeaders)
	}
	if ctx.RequestParams["page"] != "2" {
		t.Fatalf("param not set: %+v", ctx.RequestParams)
	}
}

func TestJSResponseJSONAndDotAccess(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.Response = &model.HttpResponse{
		StatusCode: 200,
		Status:     "200 OK",
		Duration:   123,
		Size:       456,
		Body:       `{"id": 7, "user": {"name": "ann"}, "tags": ["a", "b"]}`,
		Headers:    []model.KeyValue{{Key: "Content-Type", Value: "application/json"}},
	}

	res := jsTests(`
const data = pm.response.json();
pm.variables.set("id", String(data.id));
pm.variables.set("name", data.user.name);
pm.variables.set("tag0", data.tags[0]);
pm.variables.set("code", String(pm.response.code));
pm.variables.set("rt", String(pm.response.responseTime));
pm.variables.set("ct", pm.response.headers.get("content-type"));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	checks := map[string]string{"id": "7", "name": "ann", "tag0": "a", "code": "200", "rt": "123", "ct": "application/json"}
	for k, want := range checks {
		if ctx.Variables[k] != want {
			t.Fatalf("%s = %q, want %q", k, ctx.Variables[k], want)
		}
	}
}

func TestJSTestCallbackPassAndFail(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.Response = &model.HttpResponse{StatusCode: 200, Body: `{"ok": true}`, Duration: 10}

	res := jsTests(`
pm.test("status is 200", function () {
  pm.response.to.have.status(200);
  pm.expect(pm.response.code).to.eql(200);
});
pm.test("response time ok", () => pm.expect(pm.response.responseTime).to.be.below(1000));
pm.test("deliberately fails", function () {
  pm.expect(pm.response.code).to.equal(404);
});
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected script error: %s", res.Error)
	}
	if len(res.Tests) != 3 {
		t.Fatalf("expected 3 tests, got %d: %+v", len(res.Tests), res.Tests)
	}
	if !res.Tests[0].Passed || !res.Tests[1].Passed {
		t.Fatalf("tests 0/1 should pass: %+v", res.Tests)
	}
	if res.Tests[2].Passed {
		t.Fatalf("test 2 should fail")
	}
	if !strings.Contains(res.Tests[2].Error, "404") {
		t.Fatalf("failure message should mention expected value: %q", res.Tests[2].Error)
	}
}

func TestJSTestBooleanFormParity(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.Response = &model.HttpResponse{StatusCode: 201}
	res := jsTests(`
pm.test("bool pass", pm.response.code === 201);
pm.test("bool fail", pm.response.code === 200);
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if len(res.Tests) != 2 || !res.Tests[0].Passed || res.Tests[1].Passed {
		t.Fatalf("boolean form parity broken: %+v", res.Tests)
	}
}

func TestJSChaiMatchers(t *testing.T) {
	ctx := NewContext(nil, nil)
	res := jsTests(`
pm.test("deep eql", () => pm.expect({a: [1, 2], b: "x"}).to.eql({a: [1, 2], b: "x"}));
pm.test("a type", () => pm.expect([1]).to.be.an("array"));
pm.test("include array", () => pm.expect([1, 2, 3]).to.include(2));
pm.test("include string", () => pm.expect("hello world").to.include("world"));
pm.test("have property", () => pm.expect({id: 1}).to.have.property("id"));
pm.test("above/below", () => { pm.expect(5).to.be.above(3); pm.expect(5).to.be.below(9); });
pm.test("not negation", () => pm.expect(1).to.not.equal(2));
pm.test("lengthOf", () => pm.expect([1, 2, 3]).to.have.lengthOf(3));
pm.test("oneOf", () => pm.expect("b").to.be.oneOf(["a", "b", "c"]));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	for _, tr := range res.Tests {
		if !tr.Passed {
			t.Fatalf("matcher test failed: %s -> %s", tr.Name, tr.Error)
		}
	}
	if len(res.Tests) != 9 {
		t.Fatalf("expected 9 matcher tests, got %d", len(res.Tests))
	}
}

func TestJSChaiKeys(t *testing.T) {
	ctx := NewContext(nil, nil)
	res := jsTests(`
const order = {id: "ord_1", status: "confirmed", total: 228};
pm.test("all keys", () => pm.expect(order).to.have.all.keys("id", "status", "total"));
pm.test("keys array", () => pm.expect(order).to.have.keys(["total", "id", "status"]));
pm.test("any keys", () => pm.expect(order).to.have.any.keys("missing", "id"));
pm.test("key", () => pm.expect({id: 1}).to.have.key("id"));
pm.test("not all keys", () => pm.expect(order).to.not.have.all.keys("id", "status"));
pm.test("extra key fails", () => pm.expect(order).to.have.all.keys("id", "status"));
pm.test("no key fails", () => pm.expect(order).to.have.any.keys("missing"));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if len(res.Tests) != 7 {
		t.Fatalf("expected 7 tests, got %d", len(res.Tests))
	}
	for _, tr := range res.Tests[:5] {
		if !tr.Passed {
			t.Fatalf("%s failed: %s", tr.Name, tr.Error)
		}
	}
	for _, tr := range res.Tests[5:] {
		if tr.Passed {
			t.Fatalf("%s passed but should fail", tr.Name)
		}
	}
}

func TestJSLogging(t *testing.T) {
	ctx := NewContext(nil, nil)
	res := jsPre(`
console.log("hello", 42, {a: 1});
pm.log("via pm.log");
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if len(ctx.Logs) != 2 {
		t.Fatalf("expected 2 logs, got %d: %+v", len(ctx.Logs), ctx.Logs)
	}
	if ctx.Logs[0] != `hello 42 {"a":1}` {
		t.Fatalf("log0 = %q", ctx.Logs[0])
	}
	if ctx.Logs[1] != "via pm.log" {
		t.Fatalf("log1 = %q", ctx.Logs[1])
	}
}

func TestJSTimesOut(t *testing.T) {
	previous := scriptExecutionTimeout
	scriptExecutionTimeout = 20 * time.Millisecond
	t.Cleanup(func() { scriptExecutionTimeout = previous })

	start := time.Now()
	res := jsPre(`while (true) {}`, NewContext(nil, nil))
	if !strings.Contains(res.Error, "timed out") {
		t.Fatalf("expected timeout error, got %q", res.Error)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("timeout took too long: %s", elapsed)
	}
}

func TestJSRejectsOversizedScripts(t *testing.T) {
	res := jsPre(strings.Repeat("a", scriptMaxSourceBytes+1), NewContext(nil, nil))
	if res.Error != "script is too large" {
		t.Fatalf("expected source size guard, got %q", res.Error)
	}
}

func TestJSLimitsRecursiveCallStack(t *testing.T) {
	start := time.Now()
	res := jsPre(`function recur() { return recur(); } recur();`, NewContext(nil, nil))
	if res.Error == "" {
		t.Fatal("expected recursive script to fail")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("recursive script took too long: %s", elapsed)
	}
}

func TestJSSandboxBlocksRequireAndImport(t *testing.T) {
	ctx := NewContext(nil, nil)
	res := jsPre(`var fs = require("fs");`, ctx)
	if res.Error == "" || !strings.Contains(res.Error, "require") {
		t.Fatalf("require should be unavailable, got %q", res.Error)
	}

	res2 := jsPre(`process.exit(1);`, NewContext(nil, nil))
	if res2.Error == "" || !strings.Contains(res2.Error, "process") {
		t.Fatalf("process should be unavailable, got %q", res2.Error)
	}
}

func TestJSSyntaxErrorReported(t *testing.T) {
	res := jsPre(`this is not valid javascript {{{`, NewContext(nil, nil))
	if res.Error == "" {
		t.Fatalf("expected a syntax error message")
	}
}

func TestJSEmptyScriptNoop(t *testing.T) {
	res := jsPre("   \n  ", NewContext(nil, nil))
	if res.Error != "" {
		t.Fatalf("empty script should be a no-op, got %q", res.Error)
	}
}

func TestJSRequestBodyReadAndRewrite(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.RequestBody = `{"amount":10}`
	ctx.RequestBodyType = "json"
	res := jsPre(`
pm.variables.set("mode", pm.request.body.mode);
pm.variables.set("raw", pm.request.body.raw);
const parsed = pm.request.body.json();
parsed.amount = parsed.amount * 2;
pm.request.body.update(parsed);
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["mode"] != "raw" {
		t.Fatalf("mode = %q", ctx.Variables["mode"])
	}
	if ctx.Variables["raw"] != `{"amount":10}` {
		t.Fatalf("raw = %q", ctx.Variables["raw"])
	}
	if ctx.RequestBody != `{"amount":20}` {
		t.Fatalf("body = %q", ctx.RequestBody)
	}
	if !ctx.RequestBodyChanged {
		t.Fatal("RequestBodyChanged should be set after a write")
	}
}

func TestJSRequestBodyAssignmentAndSigning(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.RequestBody = "payload"
	res := jsPre(`
pm.request.headers.set("X-Signature", pm.crypto.hmacSha256(pm.request.body.raw, "key"));
pm.request.body.raw = "replaced";
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.RequestBody != "replaced" {
		t.Fatalf("body = %q", ctx.RequestBody)
	}
	if ctx.RequestHeaders["X-Signature"] == "" {
		t.Fatalf("signature header missing: %+v", ctx.RequestHeaders)
	}
}

func TestJSRequestBodyUntouchedStaysUnchanged(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.RequestBody = "keep"
	if res := jsPre(`pm.variables.set("seen", pm.request.body.toString());`, ctx); res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.RequestBodyChanged {
		t.Fatal("reading the body must not mark it changed")
	}
	if ctx.Variables["seen"] != "keep" {
		t.Fatalf("seen = %q", ctx.Variables["seen"])
	}
}

func TestJSBodyModeUsesPostmanNames(t *testing.T) {
	for bodyType, want := range map[string]string{
		"json":       "raw",
		"text":       "raw",
		"xml":        "raw",
		"graphql":    "graphql",
		"urlencoded": "urlencoded",
		"form":       "formdata",
		"binary":     "file",
		"none":       "none",
		"":           "none",
	} {
		ctx := NewContext(nil, nil)
		ctx.RequestBodyType = bodyType
		if res := jsPre(`pm.variables.set("mode", pm.request.body.mode);`, ctx); res.Error != "" {
			t.Fatalf("%s: unexpected error: %s", bodyType, res.Error)
		}
		if ctx.Variables["mode"] != want {
			t.Fatalf("body type %q reported mode %q, want %q", bodyType, ctx.Variables["mode"], want)
		}
	}
}

func TestJSUrlencodedBodyEdits(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.RequestBodyType = "urlencoded"
	ctx.RequestFormData = []model.KeyValue{
		{Key: "grant_type", Value: "password", Enabled: true},
		{Key: "scope", Value: "read", Enabled: true},
	}
	res := jsPre(`
pm.variables.set("before", pm.request.body.urlencoded.get("grant_type"));
pm.variables.set("count", String(pm.request.body.urlencoded.count()));
pm.request.body.urlencoded.upsert({ key: "scope", value: "read write" });
pm.request.body.urlencoded.add({ key: "client_id", value: "abc" });
pm.request.body.urlencoded.remove("grant_type");
pm.variables.set("after", JSON.stringify(pm.request.body.urlencoded.toObject()));
pm.variables.set("formdata", String(pm.request.body.formdata));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["before"] != "password" || ctx.Variables["count"] != "2" {
		t.Fatalf("read back %q / %q", ctx.Variables["before"], ctx.Variables["count"])
	}
	if !ctx.RequestFormDataChanged {
		t.Fatal("RequestFormDataChanged should be set after an edit")
	}
	want := []model.KeyValue{
		{Key: "scope", Value: "read write", Enabled: true},
		{Key: "client_id", Value: "abc", Enabled: true},
	}
	if !reflect.DeepEqual(ctx.RequestFormData, want) {
		t.Fatalf("form data = %+v, want %+v", ctx.RequestFormData, want)
	}
	if ctx.Variables["formdata"] != "undefined" {
		t.Fatalf("formdata on a urlencoded body = %q", ctx.Variables["formdata"])
	}
}

func TestJSFormDataKeepsAttachments(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.RequestBodyType = "form"
	ctx.RequestFormData = []model.KeyValue{
		{Key: "avatar", Value: "/tmp/a.png", Enabled: true, IsFile: true, FileName: "a.png"},
		{Key: "note", Value: "hi", Enabled: true},
	}
	res := jsPre(`
pm.request.body.formdata.upsert({ key: "note", value: "signed" });
pm.variables.set("kind", pm.request.body.formdata.one("avatar").type);
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["kind"] != "file" {
		t.Fatalf("attachment reported as %q", ctx.Variables["kind"])
	}
	want := []model.KeyValue{
		{Key: "avatar", Value: "/tmp/a.png", Enabled: true, IsFile: true, FileName: "a.png"},
		{Key: "note", Value: "signed", Enabled: true},
	}
	if !reflect.DeepEqual(ctx.RequestFormData, want) {
		t.Fatalf("form data = %+v, want %+v", ctx.RequestFormData, want)
	}
}

func TestJSRawWriteOnFormBodyWarns(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.RequestBodyType = "urlencoded"
	res := jsPre(`pm.request.body.raw = "a=1"; pm.request.body.raw = "a=2";`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if len(res.Logs) != 1 {
		t.Fatalf("expected exactly one warning, got %v", res.Logs)
	}
	if !strings.Contains(res.Logs[0], "pm.request.body.urlencoded") {
		t.Fatalf("warning does not point at the fix: %q", res.Logs[0])
	}
}

func TestJSBodyUpdateWithModeObject(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.RequestBodyType = "urlencoded"
	res := jsPre(`pm.request.body.update({ mode: "urlencoded", urlencoded: [{ key: "a", value: "1" }, { key: "b", value: "2", disabled: true }] });`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	want := []model.KeyValue{
		{Key: "a", Value: "1", Enabled: true},
		{Key: "b", Value: "2", Enabled: false},
	}
	if !reflect.DeepEqual(ctx.RequestFormData, want) {
		t.Fatalf("form data = %+v, want %+v", ctx.RequestFormData, want)
	}
}

func TestJSTestScriptSeesTheSentBody(t *testing.T) {
	ctx := NewContext(nil, nil)
	ctx.RequestBody = `{"id":7}`
	ctx.Response = &model.HttpResponse{Status: "200 OK", StatusCode: 200, Body: `{"ok":true}`}
	res := jsTests(`pm.test("echoes the id", () => pm.expect(pm.request.body.json().id).to.eql(7));`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if len(res.Tests) != 1 || !res.Tests[0].Passed {
		t.Fatalf("tests = %+v", res.Tests)
	}
}

func jsonResponseCtx(body string) *Context {
	ctx := NewContext(nil, nil)
	ctx.Response = &model.HttpResponse{Status: "200 OK", StatusCode: 200, Body: body}
	return ctx
}

func TestJSResponseJSONSchemaAssertion(t *testing.T) {
	ctx := jsonResponseCtx(`{"id":7,"name":"Ada"}`)
	res := jsTests(`
const schema = { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" } } };
pm.test("matches", () => pm.response.to.have.jsonSchema(schema));
pm.test("rejects", () => pm.response.to.have.jsonSchema({ type: "object", required: ["missing"] }));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if len(res.Tests) != 2 || !res.Tests[0].Passed {
		t.Fatalf("tests = %+v", res.Tests)
	}
	if res.Tests[1].Passed {
		t.Fatal("the second assertion should have failed")
	}
	if !strings.Contains(res.Tests[1].Error, "missing") {
		t.Fatalf("failure should name the missing property: %q", res.Tests[1].Error)
	}
}

func TestJSJsonBodyAssertion(t *testing.T) {
	ctx := jsonResponseCtx(`{"user":{"id":7},"ok":true}`)
	res := jsTests(`
pm.test("has path", () => pm.response.to.have.jsonBody("user.id"));
pm.test("path value", () => pm.response.to.have.jsonBody("user.id", 7));
pm.test("wrong value", () => pm.response.to.have.jsonBody("user.id", 8));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if !res.Tests[0].Passed || !res.Tests[1].Passed || res.Tests[2].Passed {
		t.Fatalf("tests = %+v", res.Tests)
	}
}

func TestJSTv4AndAjvModules(t *testing.T) {
	ctx := jsonResponseCtx(`{"id":7}`)
	res := jsTests(`
const schema = { type: "object", required: ["id"], properties: { id: { type: "integer" } } };
pm.test("tv4 valid", () => pm.expect(tv4.validate(pm.response.json(), schema)).to.be.true);
pm.test("tv4 invalid", () => pm.expect(tv4.validate({}, schema)).to.be.false);
const Ajv = require("ajv");
const ajv = new Ajv();
pm.test("ajv valid", () => pm.expect(ajv.validate(schema, pm.response.json())).to.be.true);
const validate = ajv.compile(schema);
pm.test("ajv compile", () => pm.expect(validate({})).to.be.false);
pm.variables.set("errText", ajv.errorsText());
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	for _, test := range res.Tests {
		if !test.Passed {
			t.Fatalf("test %q failed: %s", test.Name, test.Error)
		}
	}
	if !strings.Contains(ctx.Variables["errText"], "id") {
		t.Fatalf("errorsText = %q", ctx.Variables["errText"])
	}
}

func TestJSRequireLodashAndUuid(t *testing.T) {
	ctx := NewContext(nil, nil)
	res := jsPre(`
const _ = require("lodash");
const data = { user: { roles: ["admin", "user", "admin"] } };
pm.variables.set("role", _.get(data, "user.roles[0]"));
pm.variables.set("missing", _.get(data, "user.absent", "fallback"));
pm.variables.set("unique", _.uniq(_.get(data, "user.roles")).join(","));
pm.variables.set("grouped", JSON.stringify(_.groupBy([{ t: "a" }, { t: "b" }, { t: "a" }], "t").a.length));
pm.variables.set("id", require("uuid").v4());
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["role"] != "admin" {
		t.Fatalf("role = %q", ctx.Variables["role"])
	}
	if ctx.Variables["missing"] != "fallback" {
		t.Fatalf("missing = %q", ctx.Variables["missing"])
	}
	if ctx.Variables["unique"] != "admin,user" {
		t.Fatalf("unique = %q", ctx.Variables["unique"])
	}
	if ctx.Variables["grouped"] != "2" {
		t.Fatalf("grouped = %q", ctx.Variables["grouped"])
	}
	if len(ctx.Variables["id"]) != 36 {
		t.Fatalf("uuid = %q", ctx.Variables["id"])
	}
}

func TestJSRequireUnknownModuleFailsClearly(t *testing.T) {
	res := jsPre(`require("cheerio")`, NewContext(nil, nil))
	if !strings.Contains(res.Error, "cheerio") || !strings.Contains(res.Error, "sandbox") {
		t.Fatalf("error = %q", res.Error)
	}
}

func TestJSUnsupportedLodashMemberFailsClearly(t *testing.T) {
	res := jsPre(`require("lodash").debounce(function () {}, 10)`, NewContext(nil, nil))
	if !strings.Contains(res.Error, "lodash.debounce") {
		t.Fatalf("error = %q", res.Error)
	}
}

func TestJSBase64Globals(t *testing.T) {
	ctx := NewContext(nil, nil)
	res := jsPre(`
pm.variables.set("encoded", btoa("user:pass"));
pm.variables.set("decoded", atob(btoa("user:pass")));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["encoded"] != "dXNlcjpwYXNz" {
		t.Fatalf("encoded = %q", ctx.Variables["encoded"])
	}
	if ctx.Variables["decoded"] != "user:pass" {
		t.Fatalf("decoded = %q", ctx.Variables["decoded"])
	}
}

func TestJSScriptCanRedeclareSandboxGlobals(t *testing.T) {
	ctx := NewContext(nil, nil)
	res := jsPre(`
const _ = require("lodash");
const expect = require("chai").expect;
const Ajv = require("ajv");
pm.variables.set("ok", String(_.size([1, 2]) === 2 && typeof expect === "function" && typeof Ajv === "function"));
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if ctx.Variables["ok"] != "true" {
		t.Fatalf("ok = %q", ctx.Variables["ok"])
	}
}

package script

import (
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func responseContext() *Context {
	ctx := NewContext(nil, map[string]string{"host": "api.test"})
	ctx.Response = &model.HttpResponse{
		StatusCode: 200,
		Status:     "200 OK",
		Body:       `{"id":7}`,
		Duration:   12,
		Headers:    []model.KeyValue{{Key: "Content-Type", Value: "application/json"}},
	}
	return ctx
}

func TestJSLegacyTestsObjectBecomesTestResults(t *testing.T) {
	t.Parallel()

	ctx := responseContext()
	res := jsTests(`
tests["status is 200"] = responseCode.code === 200;
tests["body has id"] = JSON.parse(responseBody).id === 7;
tests["fast"] = responseTime < 5;
tests["json header"] = responseHeaders["Content-Type"] === "application/json";
`, ctx)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	got := map[string]bool{}
	for _, test := range res.Tests {
		got[test.Name] = test.Passed
	}
	want := map[string]bool{"status is 200": true, "body has id": true, "fast": false, "json header": true}
	for name, passed := range want {
		if got[name] != passed {
			t.Errorf("%s: passed=%v, want %v (all: %+v)", name, got[name], passed, res.Tests)
		}
	}
}

func TestJSLegacyTestsSurviveALaterError(t *testing.T) {
	t.Parallel()

	res := jsTests(`tests["before"] = true; throw new Error("boom");`, responseContext())
	if !strings.Contains(res.Error, "boom") || len(res.Tests) != 1 || !res.Tests[0].Passed {
		t.Fatalf("expected the error and the earlier test, got %q %+v", res.Error, res.Tests)
	}
}

func TestJSLegacyPostmanVariableHelpers(t *testing.T) {
	t.Parallel()

	ctx := NewContext(nil, nil)
	res := jsPre(`
postman.setEnvironmentVariable("token", "abc");
postman.setGlobalVariable("g", "1");
pm.test("reads back", () => {
  pm.expect(postman.getEnvironmentVariable("token")).to.equal("abc");
  pm.expect(postman.getGlobalVariable("g")).to.equal("1");
});
postman.clearGlobalVariable("g");
`, ctx)
	if res.Error != "" || len(res.Tests) != 1 || !res.Tests[0].Passed {
		t.Fatalf("unexpected result %+v", res)
	}
	if ctx.Environment["token"] != "abc" {
		t.Fatalf("environment = %v", ctx.Environment)
	}
	if _, ok := ctx.Variables["g"]; ok {
		t.Fatalf("expected the global to be cleared, got %v", ctx.Variables)
	}
	if preRequest := jsPre(`responseBody.length`, NewContext(nil, nil)); !strings.Contains(preRequest.Error, "responseBody") {
		t.Fatalf("expected responseBody to be absent before the response, got %q", preRequest.Error)
	}
}

func TestJSSetNextRequestExplainsItIsUnsupported(t *testing.T) {
	t.Parallel()

	res := jsTests(`postman.setNextRequest("Login")`, responseContext())
	if !strings.Contains(res.Error, "setNextRequest is not supported") {
		t.Fatalf("unexpected error %q", res.Error)
	}
}

func TestJSVariablesReplaceIn(t *testing.T) {
	t.Parallel()

	ctx := NewContext(map[string]string{"g": "global"}, map[string]string{"base": "https://{{host}}", "host": "api.test"})
	ctx.CollectionVariables["токен"] = "ru"
	ctx.DynamicVariable = func(name string) (string, bool) {
		if name == "$guid" {
			return "fixed-guid", true
		}
		return "", false
	}
	res := jsPre(`pm.environment.set("path", "/v1"); pm.test("replaceIn", () => pm.expect(pm.variables.replaceIn("{{base}}{{path}}?t={{токен}}&g={{g}}&id={{$guid}}&x={{missing}}")).to.equal("https://api.test/v1?t=ru&g=global&id=fixed-guid&x={{missing}}"));`, ctx)
	if res.Error != "" || len(res.Tests) != 1 || !res.Tests[0].Passed {
		t.Fatalf("unexpected result %+v", res)
	}
}

func TestJSXML2Json(t *testing.T) {
	t.Parallel()

	res := jsTests(`
const doc = xml2Json('<?xml version="1.0"?><order id="9"><item>a</item><item>b</item><note lang="en">hi</note><empty/></order>');
pm.test("xml", () => {
  pm.expect(doc.order.$.id).to.equal("9");
  pm.expect(doc.order.item).to.eql(["a", "b"]);
  pm.expect(doc.order.note._).to.equal("hi");
  pm.expect(doc.order.note.$.lang).to.equal("en");
  pm.expect(doc.order.empty).to.equal("");
});
pm.test("invalid", () => pm.expect(xml2Json("not xml")).to.equal(null));
`, responseContext())
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	for _, test := range res.Tests {
		if !test.Passed {
			t.Errorf("%s failed: %s", test.Name, test.Error)
		}
	}
}

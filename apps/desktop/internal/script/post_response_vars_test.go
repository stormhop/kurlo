package script

import (
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func responseCtx(body string) *Context {
	ctx := jsCtx()
	ctx.Response = &model.HttpResponse{
		StatusCode: 201,
		Status:     "201 Created",
		Body:       body,
		Duration:   12,
		Headers:    []model.KeyValue{{Key: "X-Request-Id", Value: "abc", Enabled: true}},
	}
	return ctx
}

func varRow(key, value string, enabled bool) model.KeyValue {
	return model.KeyValue{Key: key, Value: value, Enabled: enabled}
}

func TestPostResponseVarsReadTheResponse(t *testing.T) {
	ctx := responseCtx(`{"token":"t-1","data":{"items":[{"id":7}]},"meta":{"page":2}}`)
	result := RunPostResponseVars([]model.KeyValue{
		varRow("token", "res.body.token", true),
		varRow("firstId", "res('data.items[0].id')", true),
		varRow("status", "res.status", true),
		varRow("requestId", "res.getHeader('x-request-id')", true),
		varRow("meta", "res.body.meta", true),
		varRow("off", "res.status", false),
		varRow("", "res.status", true),
	}, ctx)
	if result.Error != "" {
		t.Fatalf("error: %s", result.Error)
	}
	want := map[string]string{"token": "t-1", "firstId": "7", "status": "201", "requestId": "abc", "meta": `{"page":2}`}
	for key, value := range want {
		if ctx.Variables[key] != value {
			t.Errorf("%s = %q, want %q", key, ctx.Variables[key], value)
		}
	}
	if _, ok := ctx.Variables["off"]; ok {
		t.Error("disabled var was set")
	}
}

func TestPostResponseVarsReportBadExpressionsAndKeepGoing(t *testing.T) {
	ctx := responseCtx(`plain text`)
	ctx.Variables["kept"] = "old"
	result := RunPostResponseVars([]model.KeyValue{
		varRow("broken", "res.body.(", true),
		varRow("kept", "res.body.missing", true),
		varRow("text", "res.body", true),
	}, ctx)
	if result.Error != "" {
		t.Fatalf("error: %s", result.Error)
	}
	if ctx.Variables["text"] != "plain text" {
		t.Errorf("text = %q", ctx.Variables["text"])
	}
	if ctx.Variables["kept"] != "old" {
		t.Errorf("undefined result overwrote kept: %q", ctx.Variables["kept"])
	}
	logs := strings.Join(result.Logs, "\n")
	if !strings.Contains(logs, `Post-response var "broken" failed`) || !strings.Contains(logs, `Post-response var "kept" is undefined`) {
		t.Errorf("logs = %q", logs)
	}
}

func TestPostResponseVarsSkipWithoutRows(t *testing.T) {
	ctx := responseCtx(`{}`)
	result := RunPostResponseVars([]model.KeyValue{varRow("x", "", true)}, ctx)
	if result.Error != "" || len(result.Logs) != 0 || len(ctx.Variables) != 0 {
		t.Fatalf("unexpected result %+v vars=%v", result, ctx.Variables)
	}
}

func TestRequestVariablesSitAboveEnvironmentAndCollection(t *testing.T) {
	ctx := jsCtx()
	ctx.Variables["userId"] = "global"
	ctx.Environment["userId"] = "env"
	ctx.CollectionVariables["userId"] = "collection"
	ctx.RequestVariables["userId"] = "request"
	ctx.RequestVariables["tenant"] = "acme"
	runPre(t, ctx, `
pm.environment.set("seen", pm.variables.get("userId"));
pm.environment.set("url", pm.variables.replaceIn("{{tenant}}/{{userId}}"));
pm.environment.set("fromEnv", pm.environment.get("userId"));
`)
	if ctx.Environment["seen"] != "request" || ctx.Environment["url"] != "acme/request" || ctx.Environment["fromEnv"] != "env" {
		t.Fatalf("env = %v", ctx.Environment)
	}
	ctx.IterationData = map[string]string{"userId": "row"}
	runPre(t, ctx, `pm.environment.set("seen", pm.variables.get("userId"))`)
	if ctx.Environment["seen"] != "row" {
		t.Fatalf("iteration data should win, got %q", ctx.Environment["seen"])
	}
}

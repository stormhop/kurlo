package api

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestGrpcPreRequestCanSkipTheSend(t *testing.T) {
	invoked := false
	var done model.GrpcDoneEvent
	resp := sendGrpcRequestWith(t.Context(), model.GrpcRequest{
		RequestID: "skip", ScriptEngine: "js",
		PreRequestScript: `pm.environment.set("token", "pre"); pm.collectionVariables.set("token", "collection"); pm.execution.skipRequest();`,
		TestScript:       `throw new Error("post-request must not execute");`,
	}, state.New(), func(name string, payload any) {
		if name == "grpc:done" {
			done = payload.(model.GrpcDoneEvent)
		}
	}, func(context.Context, model.GrpcRequest, grpcEventEmitter) model.GrpcResponse {
		invoked = true
		return model.GrpcResponse{GrpcCode: "OK"}
	}, grpcRunIteration{})
	if invoked || !resp.Skipped || !resp.PreRequestResult.SkippedRequest || resp.Error != "" || resp.TestResult.Error != "" {
		t.Fatalf("skipped request invoked=%v response=%#v", invoked, resp)
	}
	if resp.SkipReason == "" || resp.EnvironmentUpdates["token"] != "pre" || resp.CollectionVariableUpdates["token"] != "collection" {
		t.Fatalf("skip lost script changes: %#v", resp)
	}
	if done.RequestID != "skip" || !reflect.DeepEqual(done.Response, resp) {
		t.Fatalf("done event does not contain final response: %#v", done)
	}
}

func TestGrpcPreRequestCollectionChangesReachPostRequest(t *testing.T) {
	resp := sendGrpcRequestWith(t.Context(), model.GrpcRequest{
		ScriptEngine: "js", CollectionVariables: map[string]string{"token": "old", "remove": "old"},
		PreRequestScript: `pm.collectionVariables.set("token", "new"); pm.collectionVariables.unset("remove");`,
		TestScript:       `pm.test("pre-request changes are visible", function () { pm.expect(pm.collectionVariables.get("token")).to.equal("new"); pm.expect(pm.collectionVariables.get("remove")).to.equal(undefined); }); pm.collectionVariables.set("token", "post");`,
	}, state.New(), nil, func(context.Context, model.GrpcRequest, grpcEventEmitter) model.GrpcResponse {
		return model.GrpcResponse{GrpcCode: "OK"}
	}, grpcRunIteration{})
	if resp.PreRequestResult.Error != "" || resp.TestResult.Error != "" || len(resp.TestResult.Tests) != 1 || !resp.TestResult.Tests[0].Passed {
		t.Fatalf("script results: %#v %#v", resp.PreRequestResult, resp.TestResult)
	}
	if resp.CollectionVariableUpdates["token"] != "post" || !reflect.DeepEqual(resp.CollectionVariablesRemoved, []string{"remove"}) {
		t.Fatalf("merged collection changes: %#v", resp)
	}
}

func TestGrpcScriptSnapshotsStayIsolatedFromActiveEnvironment(t *testing.T) {
	sm := state.New()
	sm.SetEnvironment(map[string]string{"mode": "production", "untouched": "yes"})
	sm.SetVariables(map[string]string{"source": "other", "unchanged": "live", "remove": "old"})
	resp := sendGrpcRequestWith(t.Context(), model.GrpcRequest{
		ScriptEngine:      "js",
		ScriptEnvironment: map[string]string{"mode": "test", "remove": "old"},
		ScriptVariables:   map[string]string{"source": "captured", "unchanged": "captured", "remove": "old"},
		PreRequestScript:  `pm.test("captured state", function () { pm.expect(pm.environment.get("mode")).to.equal("test"); pm.expect(pm.globals.get("source")).to.equal("captured"); }); pm.environment.set("token", "pre"); pm.environment.unset("remove"); pm.globals.set("changed", "new"); pm.globals.unset("remove");`,
		TestScript:        `pm.test("pre-request state survives switch", function () { pm.expect(pm.environment.get("mode")).to.equal("test"); pm.expect(pm.environment.get("token")).to.equal("pre"); }); pm.environment.set("token", "post");`,
	}, sm, nil, func(context.Context, model.GrpcRequest, grpcEventEmitter) model.GrpcResponse {
		sm.SetEnvironment(map[string]string{"mode": "switched"})
		return model.GrpcResponse{GrpcCode: "OK"}
	}, grpcRunIteration{})
	for _, result := range []model.ScriptResult{resp.PreRequestResult, resp.TestResult} {
		if result.Error != "" || len(result.Tests) != 1 || !result.Tests[0].Passed {
			t.Fatalf("script did not use captured state: %#v", result)
		}
	}
	if !reflect.DeepEqual(sm.GetEnvironment(), map[string]string{"mode": "switched"}) {
		t.Fatalf("active environment changed: %#v", sm.GetEnvironment())
	}
	if !reflect.DeepEqual(resp.EnvironmentUpdates, map[string]string{"token": "post"}) || !reflect.DeepEqual(resp.EnvironmentRemoved, []string{"remove"}) {
		t.Fatalf("environment delta: %#v", resp)
	}
	if !reflect.DeepEqual(sm.GetVariables(), map[string]string{"source": "other", "unchanged": "live", "changed": "new"}) {
		t.Fatalf("global changes: %#v", sm.GetVariables())
	}
	if !reflect.DeepEqual(resp.GlobalVariableUpdates, map[string]string{"changed": "new"}) || !reflect.DeepEqual(resp.GlobalVariablesRemoved, []string{"remove"}) {
		t.Fatalf("global delta: %#v", resp)
	}
}

func TestGrpcPreRequestFailureReturnsEnvironmentDelta(t *testing.T) {
	resp := sendGrpcRequestWith(t.Context(), model.GrpcRequest{
		ScriptEngine: "js", ScriptEnvironment: map[string]string{"remove": "old"},
		PreRequestScript: `pm.environment.set("token", "pre"); pm.environment.unset("remove"); throw new Error("stop");`,
	}, state.New(), nil, func(context.Context, model.GrpcRequest, grpcEventEmitter) model.GrpcResponse {
		t.Fatal("failed pre-request script must not send")
		return model.GrpcResponse{}
	}, grpcRunIteration{})
	if !strings.Contains(resp.Error, "stop") || resp.EnvironmentUpdates["token"] != "pre" || !reflect.DeepEqual(resp.EnvironmentRemoved, []string{"remove"}) {
		t.Fatalf("failed script response: %#v", resp)
	}
}

func TestAgentGrpcSkippedStreamReportsTheReason(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	session := &agentLiveSession{
		ctx: ctx, cancel: cancel, ready: make(chan error, 1), done: make(chan struct{}), messages: make(chan agentSessionEvent, 1),
	}
	go session.runGRPC(model.GrpcRequest{ScriptEngine: "js", PreRequestScript: `pm.execution.skipRequest();`}, state.New())
	select {
	case err := <-session.ready:
		if err == nil || !strings.Contains(err.Error(), "skipRequest") {
			t.Fatalf("skipped stream was not reported as skipped: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("skipped stream did not complete its readiness lifecycle")
	}
	select {
	case <-session.done:
	case <-time.After(time.Second):
		t.Fatal("skipped stream did not finish")
	}
	event := <-session.messages
	if event.Type != "close" || event.Data.(map[string]any)["skipped"] != true {
		t.Fatalf("skipped stream close event: %#v", event)
	}
}

package api

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestHTTPScriptSnapshotsPreserveTheOriginatingEnvironment(t *testing.T) {
	sm := state.New()
	sm.SetEnvironment(map[string]string{"mode": "production"})
	sm.SetVariables(map[string]string{"source": "live", "remove": "old"})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sm.SetEnvironment(map[string]string{"mode": "switched"})
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	resp := sendRequest(t.Context(), model.HttpRequest{
		URL: server.URL, Method: http.MethodGet, ScriptEngine: "js",
		ScriptEnvironment: map[string]string{"mode": "test", "remove": "old"},
		ScriptVariables:   map[string]string{"source": "captured", "remove": "old"},
		PreRequestScript:  `pm.test("captured state", function () { pm.expect(pm.environment.get("mode")).to.equal("test"); pm.expect(pm.globals.get("source")).to.equal("captured"); }); pm.environment.set("token", "pre"); pm.environment.unset("remove"); pm.globals.set("changed", "new"); pm.globals.unset("remove");`,
		TestScript:        `pm.test("pre-request state survives switching", function () { pm.expect(pm.environment.get("mode")).to.equal("test"); pm.expect(pm.environment.get("token")).to.equal("pre"); }); pm.environment.set("token", "post");`,
	}, sm, nil, nil)
	if resp.Error != "" {
		t.Fatal(resp.Error)
	}
	for _, result := range []model.ScriptResult{resp.PreRequestResult, resp.TestResult} {
		if result.Error != "" || len(result.Tests) != 1 || !result.Tests[0].Passed {
			t.Fatalf("script did not use captured state: %#v", result)
		}
	}
	if !reflect.DeepEqual(sm.GetEnvironment(), map[string]string{"mode": "switched"}) || !reflect.DeepEqual(resp.EnvironmentUpdates, map[string]string{"token": "post"}) || !reflect.DeepEqual(resp.EnvironmentRemoved, []string{"remove"}) {
		t.Fatalf("environment changed: active=%#v response=%#v", sm.GetEnvironment(), resp)
	}
	if !reflect.DeepEqual(sm.GetVariables(), map[string]string{"source": "live", "changed": "new"}) || !reflect.DeepEqual(resp.GlobalVariableUpdates, map[string]string{"changed": "new"}) || !reflect.DeepEqual(resp.GlobalVariablesRemoved, []string{"remove"}) {
		t.Fatalf("global changes: active=%#v response=%#v", sm.GetVariables(), resp)
	}
}

func TestEmptyScriptSnapshotDoesNotReadActiveEnvironment(t *testing.T) {
	sm := state.New()
	sm.SetEnvironment(map[string]string{"mode": "production"})
	sm.SetVariables(map[string]string{"token": "production"})
	resp := sendRequest(t.Context(), model.HttpRequest{
		ScriptEngine: "js", ScriptEnvironment: map[string]string{}, ScriptVariables: map[string]string{},
		PreRequestScript: `pm.test("empty captured state", function () { pm.expect(pm.environment.get("mode")).to.equal(undefined); pm.expect(pm.globals.get("token")).to.equal(undefined); }); pm.execution.skipRequest();`,
	}, sm, nil, nil)
	if !resp.Skipped || len(resp.PreRequestResult.Tests) != 1 || !resp.PreRequestResult.Tests[0].Passed {
		t.Fatalf("empty snapshot inherited active state: %#v", resp)
	}
}

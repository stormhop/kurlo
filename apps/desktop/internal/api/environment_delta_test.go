package api

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestScriptEnvironmentChangesComeBackAsADelta(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	app := NewApp()
	app.state.SetEnvironment(map[string]string{"host": "a", "stale": "x", "keep": "1"})
	req := bigRequest(server.URL)
	req.Method = http.MethodGet
	req.PreRequestScript = `pm.environment.set("token", "pre"); pm.environment.unset("stale");`
	req.TestScript = `pm.environment.set("token", "post"); pm.environment.set("status", "200");`

	resp := app.SendRequest(req)
	if resp.Error != "" || resp.TestResult.Error != "" {
		t.Fatal(resp.Error, resp.TestResult.Error)
	}
	if want := map[string]string{"token": "post", "status": "200"}; !reflect.DeepEqual(resp.EnvironmentUpdates, want) {
		t.Fatalf("updates %#v, want %#v", resp.EnvironmentUpdates, want)
	}
	if want := []string{"stale"}; !reflect.DeepEqual(resp.EnvironmentRemoved, want) {
		t.Fatalf("removed %#v, want %#v", resp.EnvironmentRemoved, want)
	}
}

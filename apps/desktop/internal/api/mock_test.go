package api

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func mockRoute(method, path string, status int, body string) model.MockRoute {
	return model.MockRoute{
		ExampleID:     method + " " + path,
		ExampleName:   method + " " + path,
		Method:        method,
		PathTemplate:  path,
		StatusCode:    status,
		Body:          body,
		BodyMediaType: "application/json",
	}
}

func TestSelectMockRoutePrefersTheMoreSpecificPath(t *testing.T) {
	routes := compileMockRoutes([]model.MockRoute{
		mockRoute("GET", "/pets/:id", 200, `{"one":true}`),
		mockRoute("GET", "/pets/featured", 200, `{"featured":true}`),
	})

	matched, ok := selectMockRoute(routes, "GET", "/pets/featured", nil)
	if !ok {
		t.Fatal("no route matched")
	}
	if matched.route.Body != `{"featured":true}` {
		t.Errorf("a literal segment must win over a parameter, got %s", matched.route.Body)
	}

	matched, ok = selectMockRoute(routes, "GET", "/pets/42", nil)
	if !ok {
		t.Fatal("no route matched the parameter path")
	}
	if matched.route.Body != `{"one":true}` {
		t.Errorf("expected the parameter route, got %s", matched.route.Body)
	}
}

func TestSelectMockRouteMatchesMethodAndShape(t *testing.T) {
	routes := compileMockRoutes([]model.MockRoute{
		mockRoute("GET", "/pets", 200, "list"),
		mockRoute("POST", "/pets", 201, "created"),
	})

	cases := []struct {
		method string
		path   string
		want   string
		found  bool
	}{
		{"GET", "/pets", "list", true},
		{"POST", "/pets", "created", true},
		{"get", "/pets/", "list", true},
		{"DELETE", "/pets", "", false},
		{"GET", "/pets/1", "", false},
		{"GET", "/", "", false},
	}
	for _, tc := range cases {
		matched, ok := selectMockRoute(routes, tc.method, tc.path, nil)
		if ok != tc.found {
			t.Errorf("%s %s: matched=%v, want %v", tc.method, tc.path, ok, tc.found)
			continue
		}
		if ok && matched.route.Body != tc.want {
			t.Errorf("%s %s: body %q, want %q", tc.method, tc.path, matched.route.Body, tc.want)
		}
	}
}

func TestSelectMockRouteHonoursRequiredQuery(t *testing.T) {
	withQuery := mockRoute("GET", "/pets", 200, "open only")
	withQuery.Query = []model.KeyValue{{Key: "status", Value: "open"}}
	routes := compileMockRoutes([]model.MockRoute{
		mockRoute("GET", "/pets", 200, "any"),
		withQuery,
	})

	matched, ok := selectMockRoute(routes, "GET", "/pets", url.Values{"status": {"open"}})
	if !ok || matched.route.Body != "open only" {
		t.Errorf("a route constraining the query must win when it matches, got %v %q", ok, matched.route.Body)
	}

	matched, ok = selectMockRoute(routes, "GET", "/pets", url.Values{"status": {"closed"}})
	if !ok || matched.route.Body != "any" {
		t.Errorf("a mismatched query must fall through to the unconstrained route, got %v %q", ok, matched.route.Body)
	}
}

func TestMockPathTemplateAcceptsBraceParameters(t *testing.T) {
	routes := compileMockRoutes([]model.MockRoute{mockRoute("GET", "/pets/{petId}/toys", 200, "toys")})
	if _, ok := selectMockRoute(routes, "GET", "/pets/9/toys", nil); !ok {
		t.Error("an OpenAPI-style {param} segment must match like :param")
	}
}

func startTestMock(t *testing.T, config model.MockServerConfig) (*mockServer, string, chan model.MockRequestLog) {
	t.Helper()
	server := newMockServer()
	logs := make(chan model.MockRequestLog, 16)
	status := server.start(config, func(entry model.MockRequestLog) { logs <- entry })
	if status.Error != "" {
		t.Fatalf("start mock server: %s", status.Error)
	}
	t.Cleanup(func() { server.stop() })
	return server, status.URL, logs
}

func TestMockServerServesTheExample(t *testing.T) {
	route := mockRoute("GET", "/pets/:id", 201, `{"id":"p_1"}`)
	route.Headers = []model.KeyValue{
		{Key: "Content-Type", Value: "application/json"},
		{Key: "X-Total-Count", Value: "1"},
		{Key: "Content-Length", Value: "999"},
	}
	_, base, logs := startTestMock(t, model.MockServerConfig{Routes: []model.MockRoute{route}})

	resp, err := http.Get(base + "/pets/42")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 201 {
		t.Errorf("status = %d, want 201", resp.StatusCode)
	}
	if string(body) != `{"id":"p_1"}` {
		t.Errorf("body = %q", body)
	}
	if got := resp.Header.Get("X-Total-Count"); got != "1" {
		t.Errorf("X-Total-Count = %q, want 1", got)
	}
	if got := resp.Header.Get("Content-Length"); got == "999" {
		t.Error("a recorded Content-Length must not override the real one")
	}

	select {
	case entry := <-logs:
		if !entry.Matched || entry.StatusCode != 201 || entry.Path != "/pets/42" {
			t.Errorf("log entry = %+v", entry)
		}
	case <-time.After(2 * time.Second):
		t.Error("no request was logged")
	}
}

func TestMockServerReplaysAnExampleCapturedFromACompressedResponse(t *testing.T) {
	route := mockRoute("GET", "/report", 200, `{"ok":true}`)
	route.Headers = []model.KeyValue{
		{Key: "Content-Type", Value: "application/json"},
		{Key: "Content-Encoding", Value: "gzip"},
	}
	_, base, _ := startTestMock(t, model.MockServerConfig{Routes: []model.MockRoute{route}})

	resp, err := http.Get(base + "/report")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("a client could not read the replayed body: %v", err)
	}
	if string(body) != `{"ok":true}` || resp.Header.Get("Content-Encoding") != "" {
		t.Fatalf("expected the stored plain body without Content-Encoding, got %q (encoding %q)", body, resp.Header.Get("Content-Encoding"))
	}
}

func TestMockServerExplainsAnUnmatchedRequest(t *testing.T) {
	_, base, logs := startTestMock(t, model.MockServerConfig{
		Routes: []model.MockRoute{mockRoute("GET", "/pets", 200, "list")},
	})

	resp, err := http.Get(base + "/unknown")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
	var payload struct {
		Error     string   `json:"error"`
		Available []string `json:"available"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("404 body is not JSON: %v (%s)", err, body)
	}
	if len(payload.Available) != 1 || payload.Available[0] != "GET /pets" {
		t.Errorf("the 404 must list what is available, got %v", payload.Available)
	}

	select {
	case entry := <-logs:
		if entry.Matched || entry.StatusCode != 404 {
			t.Errorf("an unmatched request must still be logged, got %+v", entry)
		}
	case <-time.After(2 * time.Second):
		t.Error("no request was logged")
	}
}

func TestMockServerAnswersPreflight(t *testing.T) {
	_, base, _ := startTestMock(t, model.MockServerConfig{
		Routes: []model.MockRoute{mockRoute("GET", "/pets", 200, "list")},
	})

	req, _ := http.NewRequest(http.MethodOptions, base+"/pets", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", "GET")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("preflight status = %d, want 204", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Errorf("Allow-Origin = %q, want the requesting origin", got)
	}
}

func TestMockServerRefusesAnEmptyCollection(t *testing.T) {
	server := newMockServer()
	status := server.start(model.MockServerConfig{Port: 0}, nil)
	if status.Error == "" {
		t.Fatal("starting with no routes must be refused")
	}
	if !strings.Contains(status.Error, "no saved examples") {
		t.Errorf("error should say why, got %q", status.Error)
	}
}

func TestMockServerReportsAPortAlreadyInUse(t *testing.T) {
	routes := []model.MockRoute{mockRoute("GET", "/pets", 200, "list")}
	first, base, _ := startTestMock(t, model.MockServerConfig{Routes: routes})
	port := first.status().Port
	if port == 0 || base == "" {
		t.Fatal("the first server did not report a port")
	}

	second := newMockServer()
	status := second.start(model.MockServerConfig{Port: port, Routes: routes}, nil)
	t.Cleanup(func() { second.stop() })
	if status.Error == "" {
		t.Fatal("binding a taken port must fail")
	}
	if !strings.Contains(status.Error, "already in use") {
		t.Errorf("error should name the cause, got %q", status.Error)
	}
}

func TestMockServerStopsServing(t *testing.T) {
	server, base, _ := startTestMock(t, model.MockServerConfig{
		Routes: []model.MockRoute{mockRoute("GET", "/pets", 200, "list")},
	})
	server.stop()

	if server.status().Running {
		t.Error("status must report the server as stopped")
	}
	client := http.Client{Timeout: 2 * time.Second}
	if _, err := client.Get(base + "/pets"); err == nil {
		t.Error("the port must stop answering once stopped")
	}
}

func TestMockServerRestartsOntoANewCollection(t *testing.T) {
	server, base, _ := startTestMock(t, model.MockServerConfig{
		CollectionName: "First",
		Routes:         []model.MockRoute{mockRoute("GET", "/one", 200, "one")},
	})

	status := server.start(model.MockServerConfig{
		CollectionName: "Second",
		Routes:         []model.MockRoute{mockRoute("GET", "/two", 200, "two")},
	}, nil)
	if status.Error != "" {
		t.Fatalf("restart: %s", status.Error)
	}
	if status.CollectionName != "Second" {
		t.Errorf("status still names %q", status.CollectionName)
	}
	if status.URL == base {
		t.Log("the restart reused the same port, which is fine")
	}

	resp, err := http.Get(status.URL + "/two")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("the new collection is not being served: status %d", resp.StatusCode)
	}
}

func TestMockServerSimulatesRecordedLatency(t *testing.T) {
	route := mockRoute("GET", "/slow", 200, "slow")
	route.DelayMs = 120
	_, base, _ := startTestMock(t, model.MockServerConfig{
		Routes:          []model.MockRoute{route},
		SimulateLatency: true,
	})

	start := time.Now()
	resp, err := http.Get(base + "/slow")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if elapsed := time.Since(start); elapsed < 100*time.Millisecond {
		t.Errorf("recorded latency was not applied: %s", elapsed)
	}
}

func TestMockServerIgnoresLatencyWhenTurnedOff(t *testing.T) {
	route := mockRoute("GET", "/slow", 200, "slow")
	route.DelayMs = 5000
	_, base, _ := startTestMock(t, model.MockServerConfig{Routes: []model.MockRoute{route}})

	start := time.Now()
	resp, err := http.Get(base + "/slow")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("latency was applied while switched off: %s", elapsed)
	}
}

func TestMockServerBindsLoopbackOnly(t *testing.T) {
	server, _, _ := startTestMock(t, model.MockServerConfig{
		Routes: []model.MockRoute{mockRoute("GET", "/pets", 200, "list")},
	})
	addr := server.listener.Addr().String()
	if !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Errorf("the mock must not be reachable from the network, bound %s", addr)
	}
}

func freeMockPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}

func TestMockServerRefusesAnOriginFromAnotherHost(t *testing.T) {
	_, base, logs := startTestMock(t, model.MockServerConfig{
		Routes: []model.MockRoute{mockRoute("GET", "/pets", 200, "list")},
	})

	req, _ := http.NewRequest(http.MethodGet, base+"/pets", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("a refused origin must not be allowed back, got %q", got)
	}
	if strings.Contains(string(body), "list") {
		t.Error("the recorded response leaked to a site on another host")
	}

	select {
	case entry := <-logs:
		if entry.StatusCode != http.StatusForbidden || entry.Note == "" {
			t.Errorf("the refusal must be logged with a reason, got %+v", entry)
		}
	case <-time.After(2 * time.Second):
		t.Error("the refusal was not logged")
	}
}

func TestMockServerAllowsAnyLoopbackOrigin(t *testing.T) {
	_, base, _ := startTestMock(t, model.MockServerConfig{
		Routes: []model.MockRoute{mockRoute("GET", "/pets", 200, "list")},
	})

	for _, origin := range []string{"http://localhost:5173", "http://127.0.0.1:3000", "http://app.localhost:8080", "http://[::1]:4200"} {
		req, _ := http.NewRequest(http.MethodGet, base+"/pets", nil)
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("get %s: %v", origin, err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Errorf("%s: status = %d, want 200", origin, resp.StatusCode)
		}
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != origin {
			t.Errorf("%s: Allow-Origin = %q", origin, got)
		}
	}
}

func TestMockServerNamesTheHeadersItExposes(t *testing.T) {
	route := mockRoute("GET", "/pets", 200, "list")
	route.Headers = []model.KeyValue{{Key: "X-Total-Count", Value: "1"}}
	_, base, _ := startTestMock(t, model.MockServerConfig{Routes: []model.MockRoute{route}})

	req, _ := http.NewRequest(http.MethodGet, base+"/pets", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()

	exposed := resp.Header.Get("Access-Control-Expose-Headers")
	for _, want := range []string{"X-Total-Count", "X-Kurlo-Mock-Example"} {
		if !strings.Contains(exposed, want) {
			t.Errorf("Expose-Headers = %q, must name %s so a credentialed client can read it", exposed, want)
		}
	}
	if strings.Contains(exposed, "*") {
		t.Error("a wildcard is ignored on a credentialed response, so it must not be used")
	}
}

func TestMockServerReloadKeepsThePortAndTheLog(t *testing.T) {
	port := freeMockPort(t)
	config := model.MockServerConfig{
		Port:         port,
		CollectionID: "c_1",
		Routes:       []model.MockRoute{mockRoute("GET", "/pets", 200, "old")},
	}
	server, base, _ := startTestMock(t, config)

	resp, err := http.Get(base + "/pets")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if len(server.recentLog()) != 1 {
		t.Fatalf("the first request was not logged: %d entries", len(server.recentLog()))
	}

	config.Routes = []model.MockRoute{mockRoute("GET", "/pets", 200, "new")}
	status := server.start(config, nil)
	if status.Error != "" {
		t.Fatalf("reload: %s", status.Error)
	}
	if status.Port != port {
		t.Errorf("a reload moved the server from %d to %d", port, status.Port)
	}
	if len(server.recentLog()) != 1 {
		t.Errorf("a reload threw the request log away: %d entries", len(server.recentLog()))
	}

	resp, err = http.Get(base + "/pets")
	if err != nil {
		t.Fatalf("get after reload: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "new" {
		t.Errorf("body = %q, want the edited example", body)
	}
}

func TestMockServerKeepsServingWhenAMoveToAnotherPortFails(t *testing.T) {
	routes := []model.MockRoute{mockRoute("GET", "/pets", 200, "list")}
	server, base, _ := startTestMock(t, model.MockServerConfig{
		Port:         freeMockPort(t),
		CollectionID: "c_1",
		Routes:       routes,
	})

	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("occupy a port: %v", err)
	}
	defer taken.Close()

	status := server.start(model.MockServerConfig{
		Port:         taken.Addr().(*net.TCPAddr).Port,
		CollectionID: "c_1",
		Routes:       routes,
	}, nil)
	if status.Error == "" {
		t.Fatal("moving onto a taken port must fail")
	}

	if !server.status().Running {
		t.Error("a failed move must leave the running server alone")
	}
	resp, err := http.Get(base + "/pets")
	if err != nil {
		t.Fatalf("the original server stopped answering: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
}

func TestMockServerLogsARequestTheClientGaveUpOn(t *testing.T) {
	route := mockRoute("GET", "/slow", 200, "slow")
	route.DelayMs = 5000
	_, base, logs := startTestMock(t, model.MockServerConfig{
		Routes:          []model.MockRoute{route},
		SimulateLatency: true,
	})

	client := http.Client{Timeout: 150 * time.Millisecond}
	if _, err := client.Get(base + "/slow"); err == nil {
		t.Fatal("the request was meant to time out")
	}

	select {
	case entry := <-logs:
		if entry.StatusCode != mockClientClosedStatus || entry.Note == "" {
			t.Errorf("an abandoned request must be logged with a reason, got %+v", entry)
		}
		if entry.ExampleName == "" {
			t.Error("the log must still name the example that would have answered")
		}
	case <-time.After(3 * time.Second):
		t.Error("the abandoned request was not logged")
	}
}

func TestMockServerReplaysEveryValueOfARepeatedHeader(t *testing.T) {
	route := mockRoute("GET", "/login", 200, `{}`)
	route.Headers = []model.KeyValue{
		{Key: "Set-Cookie", Value: "session=abc; Path=/"},
		{Key: "Set-Cookie", Value: "theme=dark; Path=/"},
	}
	_, base, _ := startTestMock(t, model.MockServerConfig{Routes: []model.MockRoute{route}})

	resp, err := http.Get(base + "/login")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()

	got := resp.Header.Values("Set-Cookie")
	if len(got) != 2 || got[0] != "session=abc; Path=/" || got[1] != "theme=dark; Path=/" {
		t.Fatalf("Set-Cookie = %q, want both recorded cookies in order", got)
	}
}

func TestMockServerAnswersHeadFromAGetExample(t *testing.T) {
	route := mockRoute("GET", "/pets", 200, `[{"id":1}]`)
	route.Headers = []model.KeyValue{{Key: "X-Total-Count", Value: "1"}}
	_, base, _ := startTestMock(t, model.MockServerConfig{Routes: []model.MockRoute{route}})

	resp, err := http.Head(base + "/pets")
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 || resp.Header.Get("X-Total-Count") != "1" || len(body) != 0 {
		t.Fatalf("HEAD = %d %q body %q, want the GET example's status and headers without a body", resp.StatusCode, resp.Header.Get("X-Total-Count"), body)
	}
}

func TestMockServerPrefersAnExplicitHeadExample(t *testing.T) {
	head := mockRoute("HEAD", "/pets", 204, ``)
	get := mockRoute("GET", "/pets", 200, `[]`)
	_, base, _ := startTestMock(t, model.MockServerConfig{Routes: []model.MockRoute{get, head}})

	resp, err := http.Head(base + "/pets")
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 204 {
		t.Fatalf("status = %d, want the HEAD example's 204", resp.StatusCode)
	}
}

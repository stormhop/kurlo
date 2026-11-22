package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestLoadRunKeepsRequestAndDataValuesOnTheWire(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := fileWorkspaceStorePath()
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "rows.json"), []byte(`[{"account":9007199254740993},{}]`), 0600); err != nil {
		t.Fatal(err)
	}

	type observation struct{ uri, body, account, token, credential string }
	var observations []observation
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		observations = append(observations, observation{r.RequestURI, string(body), r.Header.Get("X-Account"), r.Header.Get("X-Token"), r.Header.Get("X-Credential")})
		mu.Unlock()
		w.Header().Set("X-Session", "extracted")
		w.Header().Set("Location", "/unexpected")
		w.WriteHeader(http.StatusFound)
	}))
	defer server.Close()

	row := func(key, value string) cliKV { return cliKV{Enabled: true, Key: key, Value: value} }
	const firstSecret = "first-request-secret"
	const secondSecret = "second-request-secret"
	request := cliSavedRequest{
		ID: "first", Name: "First", Method: "POST", URL: server.URL + "/items/:id?fixed=1#notes", Settings: cliSettings{FollowRedirects: new(false)},
		PathParams: []cliKV{row("id", "{{item}}")}, Params: []cliKV{row("page", "2")}, BodyType: "urlencoded", FormRows: []cliKV{row("tag", "red"), row("tag", "blue")},
		Headers: []cliKV{row("X-Account", "{{account}}"), row("X-Token", "{{token}}"), row("X-Credential", "{{credential}}")},
		Vars:    []cliKV{row("item", "{{item}}/b"), {Enabled: true, Key: "credential", Value: firstSecret, Secret: true}},
	}
	second := request
	second.ID, second.Name = "second", "Second"
	second.PathParams = []cliKV{row("id", "a%2Fb")}
	second.Vars = []cliKV{{Enabled: true, Key: "credential", Value: secondSecret, Secret: true}}
	unused := cliSavedRequest{ID: "unused", Vars: []cliKV{{Enabled: true, Key: "unused", Value: "unused\x00secret", Secret: true}}}
	test := model.LoadTest{ID: "test", Name: "Smoke", Data: &model.LoadDataSource{Path: "rows.json", Mode: "per-iteration"}, Scenarios: []model.LoadScenario{{
		Executor: model.LoadExecutor{Type: "constant-vus", VUs: 1, DurationMs: 1000},
		Steps:    []model.LoadStep{{ID: "first", RequestID: "first", Extract: []model.LoadExtract{{Var: "token", From: "header", Path: "X-Session"}}}, {ID: "second", RequestID: "second", ThinkTimeMs: 50}},
	}}}
	data, err := json.Marshal(loadTestPayload{LoadTest: test, Collection: cliCollection{ID: "collection"}, Requests: []cliSavedRequest{request, second, unused}, Globals: []cliKV{row("account", "fallback"), row("item", "a"), row("token", "initial"), row("credential", "global")}})
	if err != nil {
		t.Fatal(err)
	}
	app := &App{}
	export := app.ExportLoadTestK6(string(data), false)
	if export.Error != "" || strings.Contains(export.Script, firstSecret) || strings.Contains(export.Script, secondSecret) {
		t.Fatal("request secrets must be supplied at runtime")
	}
	start := app.StartLoadRun(string(data), k6ForTest(t))
	if !start.Running {
		t.Fatal(start.Error)
	}
	waitForLoadRun(t, app, 15*time.Second)
	if result := app.LastLoadRun("collection", "test"); result.Status != "passed" {
		t.Fatalf("run: %+v", result)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(observations) < 4 {
		t.Fatalf("only %d requests", len(observations))
	}
	for i, hit := range observations {
		want := observation{uri: "/items/a%2Fb?fixed=1&page=2", body: "tag=red&tag=blue", account: "9007199254740993", token: "extracted", credential: firstSecret}
		if i == 0 {
			want.token = "initial"
		}
		if i%2 == 1 {
			want.credential = secondSecret
		}
		if (i/2)%2 == 1 {
			want.account = "fallback"
		}
		if hit != want {
			t.Fatalf("request %d: got %+v, want %+v", i, hit, want)
		}
	}
}

func TestLoadRunRejectsUnreadableDataBeforeLookingForK6(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	const file = "rows.json"
	root := fileWorkspaceStorePath()
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	var payload loadTestPayload
	if err := json.Unmarshal([]byte(runPayload(t, "http://127.0.0.1", map[string]any{"type": "constant-vus", "vus": 1, "durationMs": 100})), &payload); err != nil {
		t.Fatal(err)
	}
	payload.LoadTest.Data = &model.LoadDataSource{Path: file, Mode: "per-vu"}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{"", "[]", "[bad"} {
		if content != "" {
			if err := os.WriteFile(filepath.Join(root, file), []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
		}
		result := (&App{}).StartLoadRun(string(raw), "/missing/k6")
		if result.Running || !strings.Contains(result.Error, "test data") {
			t.Fatalf("data %q: %+v", content, result)
		}
	}
}

func TestLoadRunReadsOnlyTheOwningCollectionsArtifacts(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	const id = "same-test"
	app := &App{}
	result := model.LoadRunResult{CollectionID: "original", LoadTestID: id, Status: "passed", StartedAt: 1}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	legacy := loadRunDir(id)
	if err := os.MkdirAll(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{loadRunResultFile: raw, loadRunSummary: []byte("original"), loadRunReportFile: []byte("original report")} {
		if err := os.WriteFile(filepath.Join(legacy, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if app.LastLoadRun("copy", id).LoadTestID != "" || app.LoadRunSummaryJSON("copy", id) != "" {
		t.Fatal("copy can read legacy result")
	}
	for _, col := range []string{"copy", "original"} {
		result.CollectionID = col
		result.StartedAt++
		if err := saveLoadRun(result, []byte(col), []byte(col+" report")); err != nil {
			t.Fatal(err)
		}
		for _, owner := range []string{"copy", "original"} {
			report, err := os.ReadFile(filepath.Join(readableLoadRunDir(owner, id), loadRunReportFile))
			if err != nil {
				t.Fatal(err)
			}
			if app.LastLoadRun(owner, id).CollectionID != owner || app.LoadRunSummaryJSON(owner, id) != owner || string(report) != owner+" report" {
				t.Fatalf("wrong artifacts for %s", owner)
			}
		}
	}
}

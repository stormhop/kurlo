package api

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

func scaleWorkspaceStore(requestCount int) map[string]any {
	body := `{"vacancy":{"title":"Курьер","salary":{"from":60000,"to":90000},"schedule":"full","address":{"city":"Москва","street":"Тверская","house":"1"},"contacts":{"name":"Иван","phone":"+70000000000"},"description":"` + strings.Repeat("Описание вакансии. ", 40) + `"}}`
	responseBody := `{"items":[` + strings.TrimSuffix(strings.Repeat(`{"id":123456,"title":"Вакансия","status":"active","updatedAt":"2026-11-12T10:00:00Z"},`, 12), ",") + `]}`
	requests := make([]any, 0, requestCount)
	methods := []string{"GET", "POST", "PUT", "DELETE", "PATCH"}
	for i := 0; i < requestCount; i++ {
		group := i / 254
		folder := (i / 25) % 11
		method := methods[i%len(methods)]
		requests = append(requests, map[string]any{
			"id": fmt.Sprintf("req-%05d", i), "name": fmt.Sprintf("Получение информации %d", i),
			"requestType": "http", "isDraft": false, "collectionId": "collection-main", "collection": "Avito",
			"folderPath": []any{"collections", fmt.Sprintf("Группа %d", group), fmt.Sprintf("Раздел %d", folder)},
			"method":     method, "url": fmt.Sprintf("{{baseUrl}}/job/v1/applications/%d/webhook?page={{page}}", i),
			"requestTab": "params",
			"params":     []any{map[string]any{"enabled": true, "key": "page", "value": "{{page}}", "description": "Номер страницы"}},
			"headers": []any{
				map[string]any{"enabled": true, "key": "Content-Type", "value": "application/json", "description": ""},
				map[string]any{"enabled": true, "key": "X-Request-Id", "value": "{{$guid}}", "description": ""},
			},
			"auth":     map[string]any{"type": "inherit"},
			"bodyType": "json", "rawBodyType": "json", "bodyContent": body,
			"formRows":         []any{},
			"preRequestScript": "pm.variables.set('ts', Date.now());",
			"testScript":       "pm.test('status 200', () => pm.response.to.have.status(200));",
			"requestNotes":     "Документация метода из Bruno.",
			"settings":         map[string]any{"timeoutMs": 30000},
			"createdAt":        1, "updatedAt": 1,
			"examples": []any{map[string]any{
				"id": fmt.Sprintf("ex-%05d", i), "name": "200 OK",
				"snapshot": map[string]string{"method": method},
				"response": map[string]any{"statusCode": 200, "body": responseBody, "bodyMediaType": "application/json"},
			}},
		})
	}
	return map[string]any{
		"version": 2, "activeId": "req-00011", "activeWorkspaceId": "workspace-main", "activeEnvironmentId": "environment-local",
		"openIds":         []any{"req-00005", "req-00008", "req-00011"},
		"folderCollapsed": map[string]any{},
		"workspaces":      []any{map[string]any{"id": "workspace-main", "name": "My Workspace", "filesystemName": "My-Workspace", "description": "", "createdAt": 1, "updatedAt": 1}},
		"collections":     []any{map[string]any{"id": "collection-main", "workspaceId": "workspace-main", "name": "Avito", "filesystemName": "Avito", "description": "", "collapsed": false, "createdAt": 1, "updatedAt": 1}},
		"environments": []any{map[string]any{"id": "environment-local", "workspaceId": "workspace-main", "name": "Local", "filesystemName": "Local",
			"values": []any{map[string]any{"enabled": true, "key": "baseUrl", "value": "https://api.example.test"}}, "createdAt": 1, "updatedAt": 1}},
		"requests":         requests,
		"history":          []any{},
		"workspaceCookies": map[string]any{},
	}
}

func timeScalePhase(t *testing.T, name string, runs int, fn func()) {
	t.Helper()
	samples := make([]time.Duration, 0, runs)
	if os.Getenv("KURLO_SCALE_MARKERS") != "" {
		fmt.Fprintf(os.Stderr, "@@phase %d %s\n", runs, strings.TrimSpace(name))
	}
	for i := 0; i < runs; i++ {
		start := time.Now()
		fn()
		samples = append(samples, time.Since(start))
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	t.Logf("%-46s median %8s  min %8s  max %8s", name, samples[len(samples)/2].Round(time.Millisecond), samples[0].Round(time.Millisecond), samples[len(samples)-1].Round(time.Millisecond))
}

func TestWorkspaceScaleTimings(t *testing.T) {
	if os.Getenv("KURLO_SCALE") == "" {
		t.Skip("set KURLO_SCALE=1 to measure a large workspace")
	}
	requestCount := 1300
	if n, err := strconv.Atoi(os.Getenv("KURLO_SCALE_REQUESTS")); err == nil && n > 0 {
		requestCount = n
	}
	app, _ := appWorkspaceForTest(t)
	root := fileWorkspaceStorePath()
	local := requestStorePath()
	store := scaleWorkspaceStore(requestCount)
	encoded, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	payload := string(encoded)
	t.Logf("requests %d, save payload %.1f MB", requestCount, float64(len(payload))/1e6)

	timeScalePhase(t, "import: first save of the whole store", 1, func() {
		if result := app.SaveRequestStoreWithError(payload); !result.Ok {
			t.Fatal(result.Error)
		}
	})
	files := 0
	if snapshot, err := scanWorkspaceFiles(root, nil, false); err == nil {
		files = len(snapshot)
	}
	t.Logf("tracked workspace files %d", files)

	loaded := ""
	timeScalePhase(t, "startup: LoadRequestStore", 5, func() { loaded = app.LoadRequestStore() })
	t.Logf("load payload %.1f MB", float64(len(loaded))/1e6)
	if loaded == "" {
		t.Fatal("load failed")
	}

	timeScalePhase(t, "quit: save with nothing changed", 5, func() {
		if result := app.SaveRequestStoreWithError(loaded); !result.Ok {
			t.Fatal(result.Error)
		}
	})

	var edited map[string]any
	if err := json.Unmarshal([]byte(loaded), &edited); err != nil {
		t.Fatal(err)
	}
	editedRequests := edited["requests"].([]any)
	edit := 0
	timeScalePhase(t, "autosave: one request URL changed", 5, func() {
		edit++
		editedRequests[11].(map[string]any)["url"] = fmt.Sprintf("{{baseUrl}}/job/v1/edited/%d", edit)
		next, _ := json.Marshal(edited)
		if result := app.SaveRequestStoreWithError(string(next)); !result.Ok {
			t.Fatal(result.Error)
		}
	})

	timeScalePhase(t, "tab close: SaveRequestStoreView", 5, func() {
		if result := app.SaveRequestStoreView(`{"activeId":"req-00008","activeWorkspaceId":"workspace-main","openIds":["req-00005","req-00008"]}`); !result.Ok {
			t.Fatal(result.Error)
		}
	})

	timeScalePhase(t, "idle: one 1s poll tick", 20, func() { app.workspaceChangedOutside() })

	t.Log("save breakdown:")
	timeScalePhase(t, "  decode JSON payload", 5, func() {
		if _, err := decodeJSONMap(loaded); err != nil {
			t.Fatal(err)
		}
	})
	timeScalePhase(t, "  externalChanges (scan + compare)", 5, func() {
		if _, _, err := workspaceDisk.externalChanges(root); err != nil {
			t.Fatal(err)
		}
	})
	timeScalePhase(t, "  loadKurloStoreWithDiagnostics", 5, func() {
		if _, _, err := loadKurloStoreWithDiagnostics(local, root); err != nil {
			t.Fatal(err)
		}
	})
	timeScalePhase(t, "  saveKurloStorePayloadPreserving", 5, func() {
		if err := saveKurloStorePayloadPreserving(local, root, loaded, nil); err != nil {
			t.Fatal(err)
		}
	})
	timeScalePhase(t, "  workspaceDisk.remember", 5, func() { workspaceDisk.remember(root) })
	timeScalePhase(t, "  scanWorkspaceFiles without hashes", 5, func() {
		if _, err := scanWorkspaceFiles(root, nil, false); err != nil {
			t.Fatal(err)
		}
	})
}

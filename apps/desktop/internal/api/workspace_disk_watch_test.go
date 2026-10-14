package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestAgentWritesLeaveEveryAppSavedFileAlone(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")

	var store map[string]any
	if err := json.Unmarshal([]byte(kurloSaveFlowPayload("https://api.example.test/v1", "main-bearer", []string{"req-main"}, "sid-cookie")), &store); err != nil {
		t.Fatal(err)
	}
	for _, op := range restartOps() {
		op.apply(store)
		payload, err := json.Marshal(store)
		if err != nil {
			t.Fatal(err)
		}
		if err := saveKurloStorePayload(local, root, string(payload)); err != nil {
			t.Fatalf("%s: save: %v", op.name, err)
		}
		before := workspaceTreeForTest(t, root)
		st, err := loadMCPStore(root)
		if err != nil {
			t.Fatalf("%s: load without secrets: %v", op.name, err)
		}
		if err := st.save(); err != nil {
			t.Fatalf("%s: write back: %v", op.name, err)
		}
		if after := workspaceTreeForTest(t, root); !reflect.DeepEqual(before, after) {
			for path, content := range after {
				if before[path] != content {
					t.Errorf("%s: %s changed:\n--- before\n%s\n--- after\n%s", op.name, path, before[path], content)
				}
			}
			t.Fatalf("%s: an untouched load and write changed files", op.name)
		}
	}
}

func TestPureVariableReferencesStayInTheSharedFile(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	if err := saveKurloStorePayload(local, root, kurloSaveFlowPayload("https://api.example.test", "{{ apiToken }}", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "workspaces", "Main", "collections", "Core", "requests", "Main-request.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "{{ apiToken }}") || strings.Contains(string(data), "kurloSecret") {
		t.Fatalf("a bearer token that only names a variable should be written as is:\n%s", data)
	}

	if err := saveKurloStorePayload(local, root, kurloSaveFlowPayload("https://api.example.test", "Bearer {{apiToken}}", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(filepath.Join(root, "workspaces", "Main", "collections", "Core", "requests", "Main-request.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "Bearer {{apiToken}}") || !strings.Contains(string(data), "kurloSecret") {
		t.Fatalf("a token with literal text around the variable is still a secret:\n%s", data)
	}
}

func appWorkspaceForTest(t *testing.T) (*App, string) {
	t.Helper()
	withRequestStoreTestKey(t)
	useTempConfigDir(t, t.TempDir())
	app := NewApp()
	if result := app.SaveRequestStoreWithError(kurloSaveFlowPayload("https://api.example.test", "secret-token", []string{"req-main"}, "")); !result.Ok {
		t.Fatalf("first save: %s", result.Error)
	}
	if app.LoadRequestStore() == "" {
		t.Fatal("load failed")
	}
	t.Cleanup(func() {
		workspaceDisk.mu.Lock()
		workspaceDisk.root, workspaceDisk.known, workspaceDisk.announced = "", nil, ""
		workspaceDisk.mu.Unlock()
	})
	return app, fileWorkspaceStorePath()
}

func agentAddsRequest(t *testing.T, root, name string) {
	t.Helper()
	time.Sleep(10 * time.Millisecond)
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	st.requests = append(st.requests, map[string]any{
		"id": "req-" + strings.ToLower(name), "name": name, "requestType": "http", "collectionId": "collection-main",
		"folderPath": []any{}, "method": "GET", "url": "{{baseUrl}}/" + strings.ToLower(name), "auth": map[string]any{"type": "inherit"},
	})
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
}

func loadedRequestNames(t *testing.T, app *App) map[string]bool {
	t.Helper()
	var store struct {
		Requests []struct {
			Name string `json:"name"`
		} `json:"requests"`
	}
	if err := json.Unmarshal([]byte(app.LoadRequestStore()), &store); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, req := range store.Requests {
		names[req.Name] = true
	}
	return names
}

func TestAppSaveKeepsRequestsAnAgentAddedMeanwhile(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	agentAddsRequest(t, root, "Orders")

	if !app.workspaceChangedOutside() {
		t.Fatal("the poll should notice files written by another process")
	}
	if app.workspaceChangedOutside() {
		t.Fatal("the same change should be announced once")
	}

	edited := strings.Replace(kurloSaveFlowPayload("https://api.example.test", "secret-token", []string{"req-main"}, ""), `"name":"Main request"`, `"name":"Main request edited"`, 1)
	if result := app.SaveRequestStoreWithError(edited); !result.Ok {
		t.Fatalf("save with stale memory: %s", result.Error)
	}

	names := loadedRequestNames(t, app)
	if !names["Orders"] {
		t.Fatalf("the app's save dropped the request the agent added: %v", names)
	}
	if !names["Main request edited"] {
		t.Fatalf("the app's own edit was lost: %v", names)
	}
	if app.workspaceChangedOutside() {
		t.Fatal("after a reload nothing is outstanding")
	}
}

func TestAppSaveKeepsAnAgentDeletion(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	agentAddsRequest(t, root, "Orders")
	if names := loadedRequestNames(t, app); !names["Orders"] {
		t.Fatalf("setup: %v", names)
	}
	var current map[string]any
	if err := json.Unmarshal([]byte(app.LoadRequestStore()), &current); err != nil {
		t.Fatal(err)
	}

	time.Sleep(10 * time.Millisecond)
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	kept := st.requests[:0]
	for _, req := range st.requests {
		if stringValue(req, "name") != "Orders" {
			kept = append(kept, req)
		}
	}
	st.requests = kept
	if err := st.save(); err != nil {
		t.Fatal(err)
	}

	current["activeId"] = "req-main"
	payload, err := json.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	if result := app.SaveRequestStoreWithError(string(payload)); !result.Ok {
		t.Fatalf("save: %s", result.Error)
	}
	if names := loadedRequestNames(t, app); names["Orders"] || !names["Main request"] {
		t.Fatalf("a request the agent deleted came back, or the app's own request went: %v", names)
	}
}

func TestAppEditWinsOverAnAgentEditOfTheSameRequest(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	time.Sleep(10 * time.Millisecond)
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, req := range st.requests {
		if stringValue(req, "id") == "req-main" {
			req["url"] = "https://agent.example.test"
		}
	}
	if err := st.save(); err != nil {
		t.Fatal(err)
	}

	if result := app.SaveRequestStoreWithError(kurloSaveFlowPayload("https://app.example.test", "secret-token", []string{"req-main"}, "")); !result.Ok {
		t.Fatalf("save: %s", result.Error)
	}
	data, err := os.ReadFile(filepath.Join(root, "workspaces", "Main", "collections", "Core", "requests", "Main-request.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "app.example.test") {
		t.Fatalf("when both changed one file, the app's version is kept:\n%s", data)
	}
}

func TestWorkspaceLockIsExclusiveAcrossHolders(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := t.TempDir()
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := tryLockWorkspaceWrites(root); ok {
		t.Fatal("a second holder got the lock")
	}
	unlock()
	again, ok := tryLockWorkspaceWrites(root)
	if !ok {
		t.Fatal("the lock was not released")
	}
	again()
}

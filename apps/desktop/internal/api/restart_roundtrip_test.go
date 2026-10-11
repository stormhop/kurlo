package api

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"
)

type storeOp struct {
	name  string
	apply func(store map[string]any)
}

func storeItems(store map[string]any, section string) []any {
	items, _ := store[section].([]any)
	return items
}

func storeItem(store map[string]any, section, id string) map[string]any {
	for _, raw := range storeItems(store, section) {
		if item, ok := raw.(map[string]any); ok && item["id"] == id {
			return item
		}
	}
	return nil
}

func removeStoreItems(store map[string]any, section string, drop func(map[string]any) bool) {
	kept := []any{}
	for _, raw := range storeItems(store, section) {
		if item, ok := raw.(map[string]any); ok && drop(item) {
			continue
		}
		kept = append(kept, raw)
	}
	store[section] = kept
}

func cloneJSONValue(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func newRoundtripRequest(id, collectionID, collectionName, name string, folder []any) map[string]any {
	request := crashRequest(id, collectionID, collectionName, name, "Bearer "+id+"-secret")
	request["folderPath"] = folder
	request["method"] = "POST"
	request["params"] = []any{map[string]any{"id": "p-" + id, "key": "q", "value": "1", "enabled": true}}
	request["bodyType"] = "raw"
	request["bodyContent"] = `{"hello":"world"}`
	request["preRequestScript"] = "pm.variables.set('x', 1)"
	request["testScript"] = "pm.test('ok', () => {})"
	request["requestNotes"] = "notes for " + name
	return request
}

func restartOps() []storeOp {
	return []storeOp{
		{"add request with secrets", func(s map[string]any) {
			s["requests"] = append(storeItems(s, "requests"), newRoundtripRequest("req-new", "collection-main", "Core", "New-request", []any{}))
		}},
		{"rename request", func(s map[string]any) {
			r := storeItem(s, "requests", "req-new")
			r["name"], r["filesystemName"] = "Renamed request", "Renamed-request"
		}},
		{"move request into a folder", func(s map[string]any) {
			storeItem(s, "requests", "req-new")["folderPath"] = []any{"Auth", "Nested"}
		}},
		{"edit request body and url", func(s map[string]any) {
			r := storeItem(s, "requests", "req-main")
			r["url"] = "https://api.example.test/v2/{{path}}?a=1&b=2"
			r["bodyType"] = "raw"
			r["bodyContent"] = "line one\nline two\n\ttabbed"
		}},
		{"add collection and move request into it", func(s map[string]any) {
			s["collections"] = append(storeItems(s, "collections"), map[string]any{"id": "collection-second", "workspaceId": "workspace-main", "name": "Second", "filesystemName": "Second", "description": "second one"})
			r := storeItem(s, "requests", "req-new")
			r["collectionId"], r["collection"], r["folderPath"] = "collection-second", "Second", []any{}
		}},
		{"rename collection", func(s map[string]any) {
			c := storeItem(s, "collections", "collection-second")
			c["name"], c["filesystemName"] = "Second renamed", "Second-renamed"
			storeItem(s, "requests", "req-new")["collection"] = "Second renamed"
		}},
		{"add environment with a secret", func(s map[string]any) {
			e := storeItem(s, "environments", "environment-local")
			e["values"] = []any{
				map[string]any{"id": "v-host", "key": "host", "value": "localhost", "enabled": true},
				map[string]any{"id": "v-token", "key": "token", "value": "env-secret", "enabled": true, "secret": true},
			}
		}},
		{"add example", func(s map[string]any) {
			storeItem(s, "requests", "req-main")["examples"] = []any{map[string]any{
				"id": "ex-1", "requestId": "req-main", "name": "OK", "filesystemName": "ok", "source": "captured",
				"snapshot": map[string]any{"method": "GET", "url": "https://api.example.test/v2"},
				"response": map[string]any{"statusCode": 200, "status": "200 OK", "bodyMediaType": "application/json", "body": `{"ok":true}`, "headers": []any{}},
			}}
		}},
		{"add cookie", func(s map[string]any) {
			s["workspaceCookies"] = map[string]any{"workspace-main": []any{map[string]any{"name": "sid", "value": "cookie-secret", "domain": "example.test", "path": "/", "hostOnly": true, "session": true}}}
		}},
		{"add second workspace", func(s map[string]any) {
			s["workspaces"] = append(storeItems(s, "workspaces"), map[string]any{"id": "workspace-two", "name": "Two", "filesystemName": "Two", "description": ""})
			s["collections"] = append(storeItems(s, "collections"), map[string]any{"id": "collection-two", "workspaceId": "workspace-two", "name": "Other", "filesystemName": "Other"})
			s["requests"] = append(storeItems(s, "requests"), newRoundtripRequest("req-two", "collection-two", "Other", "Other-request", []any{}))
		}},
		{"unicode names", func(s map[string]any) {
			r := storeItem(s, "requests", "req-two")
			r["name"] = "Заказ 🚀 注文 «тест»"
			r["requestNotes"] = "Привет, мир — 你好 👋"
		}},
		{"delete request", func(s map[string]any) {
			removeStoreItems(s, "requests", func(r map[string]any) bool { return r["id"] == "req-main" })
		}},
		{"delete collection with its requests", func(s map[string]any) {
			removeStoreItems(s, "collections", func(c map[string]any) bool { return c["id"] == "collection-second" })
			removeStoreItems(s, "requests", func(r map[string]any) bool { return r["collectionId"] == "collection-second" })
		}},
		{"delete workspace", func(s map[string]any) {
			removeStoreItems(s, "workspaces", func(w map[string]any) bool { return w["id"] == "workspace-two" })
			removeStoreItems(s, "collections", func(c map[string]any) bool { return c["workspaceId"] == "workspace-two" })
			removeStoreItems(s, "requests", func(r map[string]any) bool { return r["collectionId"] == "collection-two" })
			if cookies, ok := s["workspaceCookies"].(map[string]any); ok {
				delete(cookies, "workspace-two")
			}
			s["activeWorkspaceId"] = "workspace-main"
		}},
	}
}

func emptyJSONValue(value any) bool {
	switch v := value.(type) {
	case nil:
		return true
	case string:
		return v == ""
	case bool:
		return !v
	case []any:
		return len(v) == 0
	case map[string]any:
		return len(v) == 0
	}
	return false
}

func assertSectionSurvived(t *testing.T, label, section string, want, got map[string]any) {
	t.Helper()
	gotByID := map[string]map[string]any{}
	for _, raw := range storeItems(got, section) {
		item := raw.(map[string]any)
		gotByID[item["id"].(string)] = item
	}
	wantItems := storeItems(want, section)
	if len(wantItems) != len(gotByID) {
		t.Fatalf("%s: %s count %d after restart, want %d", label, section, len(gotByID), len(wantItems))
	}
	for _, raw := range wantItems {
		item := normalizedForDisk(t, section, raw.(map[string]any))
		id := item["id"].(string)
		loadedRaw, ok := gotByID[id]
		if !ok {
			t.Fatalf("%s: %s %s missing after restart", label, section, id)
		}
		loaded := normalizedForDisk(t, section, loadedRaw)
		for key, value := range item {
			if key == filesystemNameField {
				continue
			}
			if !reflect.DeepEqual(value, loaded[key]) && !(emptyJSONValue(value) && emptyJSONValue(loaded[key])) {
				t.Fatalf("%s: %s %s field %q changed across restart:\nwant %#v\ngot  %#v", label, section, id, key, value, loaded[key])
			}
		}
	}
}

func normalizedForDisk(t *testing.T, section string, item map[string]any) map[string]any {
	t.Helper()
	clone := cloneJSONValue(t, item).(map[string]any)
	switch section {
	case "workspaces":
		stripWorkspaceForFilesystem(clone)
	case "collections":
		stripCollectionForFilesystem(clone)
	case "requests":
		stripRequestForFilesystem(clone)
	case "environments":
		stripEnvironmentForFilesystem(clone)
	}
	return cloneJSONValue(t, clone).(map[string]any)
}

func TestEveryOperationSurvivesARestart(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")

	var store map[string]any
	if err := json.Unmarshal([]byte(kurloSaveFlowPayload("https://api.example.test/v1", "main-bearer", []string{"req-main"}, "")), &store); err != nil {
		t.Fatal(err)
	}
	for _, op := range restartOps() {
		op.apply(store)
		want := cloneJSONValue(t, store).(map[string]any)
		payload, err := json.Marshal(store)
		if err != nil {
			t.Fatal(err)
		}
		if err := saveKurloStorePayload(local, root, string(payload)); err != nil {
			t.Fatalf("%s: save: %v", op.name, err)
		}
		loadedPayload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
		if err != nil {
			t.Fatalf("%s: load: %v", op.name, err)
		}
		if len(diagnostics) > 0 {
			t.Fatalf("%s: diagnostics after restart: %#v", op.name, diagnostics)
		}
		var loaded map[string]any
		if err := json.Unmarshal([]byte(loadedPayload), &loaded); err != nil {
			t.Fatal(err)
		}
		for _, section := range []string{"workspaces", "collections", "requests", "environments"} {
			assertSectionSurvived(t, op.name, section, want, loaded)
		}
		if !reflect.DeepEqual(cloneJSONValue(t, want["workspaceCookies"]), cloneJSONValue(t, loaded["workspaceCookies"])) && len(want["workspaceCookies"].(map[string]any)) > 0 {
			t.Fatalf("%s: cookies changed across restart:\nwant %#v\ngot  %#v", op.name, want["workspaceCookies"], loaded["workspaceCookies"])
		}

		before := workspaceTreeForTest(t, root)
		if err := saveKurloStorePayload(local, root, loadedPayload); err != nil {
			t.Fatalf("%s: resave after restart: %v", op.name, err)
		}
		if after := workspaceTreeForTest(t, root); !reflect.DeepEqual(before, after) {
			t.Fatalf("%s: saving the reloaded store rewrote files on disk", op.name)
		}
		store = loaded
	}
}

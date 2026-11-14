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

type deltaSaver struct {
	t        *testing.T
	app      *App
	revision int64
	sent     map[string]string
	deltas   int
	fulls    int
}

func newDeltaSaver(t *testing.T, app *App) *deltaSaver {
	return &deltaSaver{t: t, app: app, sent: map[string]string{}}
}

func (d *deltaSaver) remember(store map[string]any) {
	d.sent = map[string]string{}
	for _, request := range mapSlice(store["requests"]) {
		d.sent[stringValue(request, "id")] = canonicalJSON(request)
	}
}

func (d *deltaSaver) full(store map[string]any, step string) {
	d.t.Helper()
	payload, err := json.Marshal(store)
	if err != nil {
		d.t.Fatal(err)
	}
	result := d.app.SaveRequestStoreWithError(string(payload))
	if !result.Ok {
		d.t.Fatalf("%s: full save: %s", step, result.Error)
	}
	d.fulls++
	d.revision = result.Revision
	d.remember(store)
}

func (d *deltaSaver) save(store map[string]any, step string) SaveRequestStoreResult {
	d.t.Helper()
	if d.revision == 0 {
		d.full(store, step)
		return SaveRequestStoreResult{Ok: true, Revision: d.revision}
	}
	top := map[string]any{}
	for key, value := range store {
		if key != "requests" {
			top[key] = value
		}
	}
	ids := []string{}
	changed := []map[string]any{}
	for _, request := range mapSlice(store["requests"]) {
		id := stringValue(request, "id")
		ids = append(ids, id)
		if d.sent[id] != canonicalJSON(request) {
			changed = append(changed, request)
		}
	}
	encoded, err := json.Marshal(map[string]any{"base": d.revision, "store": top, "requestIds": ids, "requests": changed})
	if err != nil {
		d.t.Fatal(err)
	}
	result := d.app.SaveRequestStoreDelta(string(encoded))
	if result.NeedFull {
		d.full(store, step)
		return result
	}
	if !result.Ok {
		d.t.Fatalf("%s: delta save: %s", step, result.Error)
	}
	d.deltas++
	d.revision = result.Revision
	d.remember(store)
	return result
}

func deltaOps() []storeOp {
	return []storeOp{
		{"edit url", func(s map[string]any) {
			storeItem(s, "requests", "req-main")["url"] = "https://api.example.test/v2/{{path}}?a=1"
		}},
		{"edit body and scripts", func(s map[string]any) {
			r := storeItem(s, "requests", "req-main")
			r["bodyType"] = "text"
			r["bodyContent"] = "line one\nline two\n\ttabbed"
			r["preRequestScript"] = "pm.variables.set('t', 1)"
		}},
		{"change bearer secret", func(s map[string]any) {
			storeItem(s, "requests", "req-main")["auth"].(map[string]any)["bearerToken"] = "rotated-token"
		}},
		{"add secret header row", func(s map[string]any) {
			storeItem(s, "requests", "req-main")["headers"] = []any{map[string]any{"id": "h-1", "key": "X-Key", "value": "row-secret", "enabled": true, "secret": true}}
		}},
		{"add request", func(s map[string]any) {
			s["requests"] = append(storeItems(s, "requests"), newRoundtripRequest("req-new", "collection-main", "Core", "New request", []any{}))
		}},
		{"edit the new request", func(s map[string]any) {
			storeItem(s, "requests", "req-new")["bodyContent"] = `{"hello":"delta"}`
		}},
		{"move request into a folder", func(s map[string]any) {
			storeItem(s, "requests", "req-new")["folderPath"] = []any{"Auth", "Nested"}
		}},
		{"rename keeping the file name", func(s map[string]any) {
			storeItem(s, "requests", "req-new")["name"] = "new request"
		}},
		{"rename to a new file name", func(s map[string]any) {
			storeItem(s, "requests", "req-new")["name"] = "Totally different"
		}},
		{"environment secret value", func(s map[string]any) {
			storeItem(s, "environments", "environment-local")["values"] = []any{
				map[string]any{"id": "v-host", "key": "host", "value": "localhost", "enabled": true},
				map[string]any{"id": "v-token", "key": "token", "value": "env-secret", "enabled": true, "secret": true},
			}
		}},
		{"environment value again", func(s map[string]any) {
			rows := storeItem(s, "environments", "environment-local")["values"].([]any)
			rows[0].(map[string]any)["value"] = "127.0.0.1"
		}},
		{"cookie from a response", func(s map[string]any) {
			s["workspaceCookies"] = map[string]any{"workspace-main": []any{map[string]any{"name": "sid", "value": "cookie-secret", "domain": "example.test", "path": "/", "hostOnly": true, "session": true}}}
		}},
		{"history entry", func(s map[string]any) {
			s["history"] = []any{map[string]any{"id": "h-1", "requestId": "req-main", "method": "GET", "url": "https://api.example.test", "status": 200, "timestamp": 1}}
		}},
		{"add example", func(s map[string]any) {
			storeItem(s, "requests", "req-main")["examples"] = []any{map[string]any{
				"id": "ex-1", "requestId": "req-main", "name": "OK", "source": "captured",
				"snapshot": map[string]any{"method": "GET", "url": "https://api.example.test/v2"},
				"response": map[string]any{"statusCode": 200, "status": "200 OK", "bodyMediaType": "application/json", "body": `{"ok":true}`, "headers": []any{}},
			}}
		}},
		{"edit request that has an example", func(s map[string]any) {
			storeItem(s, "requests", "req-main")["requestNotes"] = "with example"
		}},
		{"collection settings", func(s map[string]any) {
			storeItem(s, "collections", "collection-main")["description"] = "changed"
		}},
		{"delete request", func(s map[string]any) {
			removeStoreItems(s, "requests", func(r map[string]any) bool { return r["id"] == "req-new" })
		}},
	}
}

func deltaTreesForOps(t *testing.T, useDelta bool) ([]map[string]string, []map[string]any, *deltaSaver) {
	t.Helper()
	app, root := appWorkspaceForTest(t)
	store := saveFlowStoreForTest(t)
	saver := newDeltaSaver(t, app)
	saver.full(store, "start")
	var trees []map[string]string
	var loads []map[string]any
	for _, op := range deltaOps() {
		op.apply(store)
		if useDelta {
			saver.save(store, op.name)
		} else {
			saver.full(store, op.name)
		}
		tree := workspaceTreeForTest(t, root)
		for _, dir := range workspaceDirsForTest(t, root) {
			tree[dir+"/"] = "dir"
		}
		trees = append(trees, tree)
		local, _, err := loadLocalRequestStore(requestStorePath())
		if err != nil {
			t.Fatal(err)
		}
		delete(local, "storage")
		loads = append(loads, local)
	}
	return trees, loads, saver
}

func TestDeltaSavesWriteTheSameFilesAsFullSaves(t *testing.T) {
	deltaTrees, deltaLocal, saver := deltaTreesForOps(t, true)
	fullTrees, fullLocal, _ := deltaTreesForOps(t, false)
	ops := deltaOps()
	for i := range ops {
		if !reflect.DeepEqual(deltaTrees[i], fullTrees[i]) {
			for path, content := range fullTrees[i] {
				if deltaTrees[i][path] != content {
					t.Errorf("%s: %s differs\n--- full save\n%s\n--- delta save\n%s", ops[i].name, path, content, deltaTrees[i][path])
				}
			}
			for path := range deltaTrees[i] {
				if _, ok := fullTrees[i][path]; !ok {
					t.Errorf("%s: %s exists only after the delta save", ops[i].name, path)
				}
			}
			t.FailNow()
		}
		if !reflect.DeepEqual(deltaLocal[i], fullLocal[i]) {
			left, _ := json.MarshalIndent(fullLocal[i], "", " ")
			right, _ := json.MarshalIndent(deltaLocal[i], "", " ")
			t.Fatalf("%s: local store differs\n--- full\n%s\n--- delta\n%s", ops[i].name, left, right)
		}
	}
	if saver.deltas < 10 {
		t.Fatalf("expected most content edits to go through the delta path, got %d deltas and %d full saves", saver.deltas, saver.fulls)
	}
}

func TestDeltaSaveFallsBackToFullForStructuralChanges(t *testing.T) {
	app, _ := appWorkspaceForTest(t)
	store := saveFlowStoreForTest(t)
	saver := newDeltaSaver(t, app)
	saver.full(store, "start")
	cases := []storeOp{
		{"add request", func(s map[string]any) {
			s["requests"] = append(storeItems(s, "requests"), newRoundtripRequest("req-new", "collection-main", "Core", "New request", []any{}))
		}},
		{"rename to a new file name", func(s map[string]any) {
			storeItem(s, "requests", "req-new")["name"] = "Totally different"
		}},
		{"move request to another collection", func(s map[string]any) {
			s["collections"] = append(storeItems(s, "collections"), map[string]any{"id": "collection-second", "workspaceId": "workspace-main", "name": "Second", "description": ""})
		}},
		{"add example", func(s map[string]any) {
			storeItem(s, "requests", "req-main")["examples"] = []any{map[string]any{"id": "ex-1", "requestId": "req-main", "name": "OK", "response": map[string]any{"statusCode": 200, "body": "ok"}}}
		}},
		{"add environment", func(s map[string]any) {
			s["environments"] = append(storeItems(s, "environments"), map[string]any{"id": "environment-two", "workspaceId": "workspace-main", "name": "Two", "values": []any{}})
		}},
	}
	for _, op := range cases {
		op.apply(store)
		if result := saver.save(store, op.name); !result.NeedFull {
			t.Fatalf("%s: expected the delta to be refused", op.name)
		}
	}
}

func TestDeltaSaveRefusesAStaleBase(t *testing.T) {
	app, _ := appWorkspaceForTest(t)
	store := saveFlowStoreForTest(t)
	saver := newDeltaSaver(t, app)
	saver.full(store, "start")
	storeItem(store, "requests", "req-main")["url"] = "https://one.example.test"
	saver.save(store, "first")
	if saver.deltas != 1 {
		t.Fatal("first edit should go through the delta path")
	}
	saver.revision--
	storeItem(store, "requests", "req-main")["url"] = "https://two.example.test"
	if result := saver.save(store, "stale"); !result.NeedFull {
		t.Fatal("a delta against an older revision must be refused")
	}
	app.LoadRequestStore()
	storeItem(store, "requests", "req-main")["url"] = "https://three.example.test"
	if result := saver.save(store, "after reload"); !result.NeedFull {
		t.Fatal("a delta after the workspace was reloaded must be refused")
	}
}

func TestDeltaSaveLeavesAFileChangedOutsideKurloAlone(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	store := saveFlowStoreForTest(t)
	saver := newDeltaSaver(t, app)
	saver.full(store, "start")
	var requestPath string
	for path := range workspaceTreeForTest(t, root) {
		if strings.HasSuffix(path, "/requests/Main-request.yml") {
			requestPath = filepath.Join(root, filepath.FromSlash(path))
		}
	}
	if requestPath == "" {
		t.Fatal("request file not found")
	}
	time.Sleep(10 * time.Millisecond)
	external := []byte("version: 1\nrequest:\n  id: req-main\n  name: Main request\n  url: https://edited.outside\n")
	if err := os.WriteFile(requestPath, external, 0o644); err != nil {
		t.Fatal(err)
	}
	storeItem(store, "requests", "req-main")["url"] = "https://edited.inside"
	payload, _ := json.Marshal(map[string]any{"base": saver.revision, "store": map[string]any{"workspaces": store["workspaces"], "collections": store["collections"], "environments": store["environments"]}, "requestIds": []string{"req-main"}, "requests": []any{storeItem(store, "requests", "req-main")}})
	result := app.SaveRequestStoreDelta(string(payload))
	if !result.NeedFull {
		t.Fatalf("expected the delta to be refused, got %+v", result)
	}
	data, err := os.ReadFile(requestPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(external) {
		t.Fatalf("the file changed outside Kurlo was rewritten:\n%s", data)
	}
}

func TestDeltaSaveKeepsTheNextFullSaveHonest(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	store := saveFlowStoreForTest(t)
	saver := newDeltaSaver(t, app)
	saver.full(store, "start")
	before := cloneJSONValue(t, store).(map[string]any)
	beforeTree := workspaceTreeForTest(t, root)
	storeItem(store, "requests", "req-main")["url"] = "https://changed.example.test"
	saver.save(store, "delta")
	if saver.deltas != 1 {
		t.Fatal("expected a delta save")
	}
	saver.full(before, "revert with a full save")
	if after := workspaceTreeForTest(t, root); !reflect.DeepEqual(after, beforeTree) {
		t.Fatal("a full save back to the earlier state must rewrite what the delta changed")
	}
}

package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type crashFixture struct {
	collections []map[string]any
	requests    []map[string]any
}

func crashRequest(id, collectionID, collectionName, name string, headerValue string) map[string]any {
	headers := []any{}
	if headerValue != "" {
		headers = append(headers, map[string]any{"id": "h-" + id, "key": "Authorization", "value": headerValue, "enabled": true, "secret": true})
	}
	return map[string]any{
		"id": id, "name": name, "filesystemName": name, "requestType": "http",
		"collectionId": collectionID, "collection": collectionName, "folderPath": []any{},
		"method": "GET", "url": "https://api.example.test/" + id, "requestTab": "params",
		"params": []any{}, "headers": headers, "auth": map[string]any{"type": "none"},
		"bodyType": "none", "rawBodyType": "json", "bodyContent": "", "bodyFilePath": "", "bodyFileName": "",
		"formRows": []any{}, "preRequestScript": "", "testScript": "", "requestNotes": "",
		"settings": map[string]any{"timeoutMs": 30000}, "examples": []any{},
	}
}

func crashCollection(id, name string) map[string]any {
	return map[string]any{"id": id, "workspaceId": "workspace-main", "name": name, "filesystemName": name}
}

func (f crashFixture) payload(t testing.TB) string {
	t.Helper()
	store := map[string]any{
		"version": 2, "activeId": "", "activeWorkspaceId": "workspace-main", "openIds": []any{},
		"workspaces":       []any{map[string]any{"id": "workspace-main", "name": "Main", "filesystemName": "Main"}},
		"collections":      f.collections,
		"environments":     []any{},
		"requests":         f.requests,
		"history":          []any{},
		"workspaceCookies": map[string]any{},
	}
	data, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func crashBaseline() crashFixture {
	f := crashFixture{collections: []map[string]any{crashCollection("col-a", "Alpha"), crashCollection("col-b", "Beta")}}
	for i := 0; i < 4; i++ {
		f.requests = append(f.requests, crashRequest(fmt.Sprintf("a-%d", i), "col-a", "Alpha", fmt.Sprintf("Alpha-%d", i), fmt.Sprintf("Bearer old-a-%d", i)))
		f.requests = append(f.requests, crashRequest(fmt.Sprintf("b-%d", i), "col-b", "Beta", fmt.Sprintf("Beta-%d", i), ""))
	}
	return f
}

func crashAfterImport() crashFixture {
	f := crashBaseline()
	f.collections = append(f.collections, crashCollection("col-imported", "Imported"))
	for i := 0; i < 12; i++ {
		f.requests = append(f.requests, crashRequest(fmt.Sprintf("imp-%d", i), "col-imported", "Imported", fmt.Sprintf("Imported-%d", i), fmt.Sprintf("Bearer new-%d", i)))
	}
	for _, request := range f.requests {
		if request["id"] == "a-0" {
			request["collectionId"] = "col-b"
			request["collection"] = "Beta"
		}
		if request["id"] == "a-1" {
			request["name"] = "Alpha-renamed"
			request["filesystemName"] = "Alpha-renamed"
		}
	}
	return f
}

func loadedRequestsByID(t testing.TB, local, root string) (map[string]map[string]any, []WorkspaceDiagnostic) {
	t.Helper()
	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	var decoded struct {
		Requests []map[string]any `json:"requests"`
	}
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		t.Fatal(err)
	}
	byID := map[string]map[string]any{}
	for _, request := range decoded.Requests {
		id, _ := request["id"].(string)
		if _, dup := byID[id]; dup {
			t.Fatalf("request %s loaded twice", id)
		}
		byID[id] = request
	}
	return byID, diagnostics
}

func authorizationValue(request map[string]any) string {
	headers, _ := request["headers"].([]any)
	for _, raw := range headers {
		if row, ok := raw.(map[string]any); ok && row["key"] == "Authorization" {
			value, _ := row["value"].(string)
			return value
		}
	}
	return ""
}

func assertCrashState(t testing.TB, label, local, root string, before, after crashFixture) {
	t.Helper()
	loaded, diagnostics := loadedRequestsByID(t, local, root)
	if err := workspaceIntegrityError(diagnostics); err != nil {
		t.Fatalf("%s: workspace blocked: %v", label, err)
	}
	expected := map[string]map[string]any{}
	for _, request := range before.requests {
		expected[request["id"].(string)] = request
	}
	afterByID := map[string]map[string]any{}
	for _, request := range after.requests {
		afterByID[request["id"].(string)] = request
	}
	for id, old := range expected {
		got, ok := loaded[id]
		if !ok {
			t.Fatalf("%s: request %s that existed before the save is gone", label, id)
		}
		want := []string{authorizationValue(old)}
		if next, ok := afterByID[id]; ok {
			want = append(want, authorizationValue(next))
		}
		value := authorizationValue(got)
		if value != want[0] && value != want[len(want)-1] {
			t.Fatalf("%s: request %s lost its secret: got %q, want %q", label, id, value, want)
		}
	}
	for id, request := range loaded {
		if strings.HasPrefix(authorizationValue(request), "{{") {
			t.Fatalf("%s: request %s shows an unresolved secret placeholder %q", label, id, authorizationValue(request))
		}
	}
}

func TestInterruptedImportOverExistingWorkspaceKeepsEveryRequest(t *testing.T) {
	withRequestStoreTestKey(t)
	before, after := crashBaseline(), crashAfterImport()
	t.Cleanup(func() { beforeYAMLWrite = nil })
	for cut := 0; ; cut++ {
		dir := t.TempDir()
		root := filepath.Join(dir, "workspace")
		local := filepath.Join(dir, "requests.json")
		if err := saveKurloStorePayload(local, root, before.payload(t)); err != nil {
			t.Fatal(err)
		}
		writes := 0
		beforeYAMLWrite = func(string) error {
			writes++
			if writes > cut {
				return errors.New("power cut")
			}
			return nil
		}
		err := saveKurloStorePayload(local, root, after.payload(t))
		beforeYAMLWrite = nil
		assertCrashState(t, fmt.Sprintf("cut after %d files", cut), local, root, before, after)
		if err == nil {
			return
		}
	}
}

func TestSaveCutBeforeTheLocalStoreKeepsNewSecrets(t *testing.T) {
	withRequestStoreTestKey(t)
	before, after := crashBaseline(), crashAfterImport()
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	if err := saveKurloStorePayload(local, root, before.payload(t)); err != nil {
		t.Fatal(err)
	}
	var atLastYAMLWrite []byte
	t.Cleanup(func() { beforeYAMLWrite = nil })
	beforeYAMLWrite = func(string) error {
		data, err := os.ReadFile(local)
		if err != nil {
			return err
		}
		atLastYAMLWrite = data
		return nil
	}
	err := saveKurloStorePayload(local, root, after.payload(t))
	beforeYAMLWrite = nil
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(local, atLastYAMLWrite, 0600); err != nil {
		t.Fatal(err)
	}
	assertCrashState(t, "yaml written, local store not", local, root, before, after)
}

const crashHelperEnv = "KURLO_CRASH_HELPER_DIR"

func TestCrashHelperProcess(t *testing.T) {
	dir := os.Getenv(crashHelperEnv)
	if dir == "" {
		t.Skip("helper for TestKillDuringSaveLeavesALoadableWorkspace")
	}
	withRequestStoreTestKey(t)
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	payloads := []string{crashAfterImport().payload(t), crashBaseline().payload(t)}
	if err := os.WriteFile(filepath.Join(dir, "ready"), nil, 0644); err != nil {
		t.Fatal(err)
	}
	for i := 0; ; i++ {
		if err := saveKurloStorePayload(local, root, payloads[i%2]); err != nil {
			t.Fatal(err)
		}
	}
}

func TestKillDuringSaveLeavesALoadableWorkspace(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns and kills processes")
	}
	withRequestStoreTestKey(t)
	before := crashBaseline()
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	for round := 0; round < 15; round++ {
		dir := t.TempDir()
		root := filepath.Join(dir, "workspace")
		local := filepath.Join(dir, "requests.json")
		if err := saveKurloStorePayload(local, root, before.payload(t)); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(os.Args[0], "-test.run=^TestCrashHelperProcess$")
		cmd.Env = append(os.Environ(), crashHelperEnv+"="+dir)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for {
			if _, err := os.Stat(filepath.Join(dir, "ready")); err == nil {
				break
			}
			if time.Now().After(deadline) {
				_ = cmd.Process.Kill()
				t.Fatal("helper never started")
			}
			time.Sleep(5 * time.Millisecond)
		}
		time.Sleep(time.Duration(5+rng.Intn(120)) * time.Millisecond)
		if err := cmd.Process.Kill(); err != nil {
			t.Fatal(err)
		}
		_ = cmd.Wait()
		assertCrashState(t, fmt.Sprintf("kill round %d", round), local, root, before, crashAfterImport())
	}
}

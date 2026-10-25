package api

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const checkoutLoadTest = `{
  "id": "lt-checkout",
  "name": "Checkout flow",
  "filesystemName": "Checkout-flow",
  "settings": {"environment": "staging", "timeoutMs": 10000},
  "thresholds": [
    {"metric": "http_req_duration", "stat": "p(95)", "op": "<", "value": 300},
    {"metric": "http_req_duration", "stat": "p(99)", "op": "<", "value": 400, "step": "st-create"},
    {"metric": "http_req_failed", "stat": "rate", "op": "<", "value": 0.01, "abortOnFail": true}
  ],
  "data": {"path": "data/users.csv", "mode": "per-vu"},
  "scenarios": [
    {
      "id": "sc-main",
      "name": "Checkout",
      "executor": {"type": "ramping-vus", "stages": [{"durationMs": 120000, "target": 100}, {"durationMs": 600000, "target": 100}, {"durationMs": 60000, "target": 0}]},
      "steps": [
        {"id": "st-login", "requestId": "req-main", "once": true,
         "extract": [{"var": "token", "from": "json", "path": "$.access_token"}],
         "checks": [{"type": "status", "value": "200"}]},
        {"id": "st-create", "requestId": "req-main", "name": "create_order", "thinkTimeMs": 500, "thinkJitterMs": 1000,
         "checks": [{"type": "jsonExists", "path": "$.id"}]}
      ]
    }
  ]
}`

func loadTestStorePayload(t *testing.T, loadTests string) string {
	t.Helper()
	collection := `{"id":"collection-main","workspaceId":"workspace-main","name":"Core","filesystemName":"Core"}`
	if loadTests != "" {
		collection = fmt.Sprintf(`{"id":"collection-main","workspaceId":"workspace-main","name":"Core","filesystemName":"Core","loadTests":%s}`, loadTests)
	}
	return strings.Replace(exampleStorePayload(t, "[]"), `{"id":"collection-main","workspaceId":"workspace-main","name":"Core","filesystemName":"Core"}`, collection, 1)
}

func loadTestDirFor(root string) string {
	return filepath.Join(root, "workspaces", "Main", "collections", "Core", "loadtests")
}

func collectionLoadTestsFromPayload(t *testing.T, payload string) []model.LoadTest {
	t.Helper()
	var decoded struct {
		Collections []struct {
			LoadTests []model.LoadTest `json:"loadTests"`
		} `json:"collections"`
	}
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if len(decoded.Collections) != 1 {
		t.Fatalf("expected one collection, got %d", len(decoded.Collections))
	}
	return decoded.Collections[0].LoadTests
}

func TestLoadTestsRoundTripThroughWorkspace(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces-root")

	if err := saveKurloStorePayload(localPath, workspaceRoot, loadTestStorePayload(t, "["+checkoutLoadTest+"]")); err != nil {
		t.Fatalf("save: %v", err)
	}

	entries, err := os.ReadDir(loadTestDirFor(workspaceRoot))
	if err != nil {
		t.Fatalf("read load test dir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "Checkout-flow.yml" {
		t.Fatalf("a load test is one YAML file named after it, got %v", entries)
	}
	rawYAML, err := os.ReadFile(filepath.Join(loadTestDirFor(workspaceRoot), "Checkout-flow.yml"))
	if err != nil {
		t.Fatalf("read load test yaml: %v", err)
	}
	for _, want := range []string{"version: 1", "loadTest:", "requestId: req-main", "path: $.access_token"} {
		if !strings.Contains(string(rawYAML), want) {
			t.Errorf("load test YAML is missing %q:\n%s", want, rawYAML)
		}
	}
	if strings.Contains(string(rawYAML), "filesystemName") {
		t.Errorf("the file name is not repeated inside the file:\n%s", rawYAML)
	}
	collectionYAML, err := os.ReadFile(filepath.Join(workspaceRoot, "workspaces", "Main", "collections", "Core", "collection.yml"))
	if err != nil {
		t.Fatalf("read collection yaml: %v", err)
	}
	if strings.Contains(string(collectionYAML), "loadTests") {
		t.Errorf("load tests must not be written inline in the collection file:\n%s", collectionYAML)
	}

	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diagnostics)
	}
	var want model.LoadTest
	if err := json.Unmarshal([]byte(checkoutLoadTest), &want); err != nil {
		t.Fatal(err)
	}
	got := collectionLoadTestsFromPayload(t, payload)
	if len(got) != 1 || !reflect.DeepEqual(got[0], want) {
		t.Fatalf("load test changed on the way through disk:\n got %+v\nwant %+v", got, want)
	}
}

func TestLoadTestsKeepTheirOrder(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces-root")

	tests := `[
    {"id":"lt-z","name":"Zebra","filesystemName":"Zebra","scenarios":[],"settings":{}},
    {"id":"lt-a","name":"Alpha","filesystemName":"Alpha","scenarios":[],"settings":{}}
  ]`
	if err := saveKurloStorePayload(localPath, workspaceRoot, loadTestStorePayload(t, tests)); err != nil {
		t.Fatalf("save: %v", err)
	}
	payload, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	got := collectionLoadTestsFromPayload(t, payload)
	if len(got) != 2 || got[0].ID != "lt-z" || got[1].ID != "lt-a" {
		t.Fatalf("load tests should come back in the saved order, got %+v", got)
	}
}

func TestDeletedLoadTestFileIsRemoved(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces-root")

	if err := saveKurloStorePayload(localPath, workspaceRoot, loadTestStorePayload(t, "["+checkoutLoadTest+"]")); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := saveKurloStorePayload(localPath, workspaceRoot, loadTestStorePayload(t, "[]")); err != nil {
		t.Fatalf("save without load tests: %v", err)
	}
	if _, err := os.Stat(loadTestDirFor(workspaceRoot)); !os.IsNotExist(err) {
		t.Fatalf("deleting the last load test should remove its file and folder, stat err = %v", err)
	}
	payload, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if strings.Contains(payload, `"loadTests"`) {
		t.Error("a collection with no load tests must not grow a loadTests field")
	}
}

func TestLoadTestNamesDifferingOnlyInCaseGetSeparateFiles(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces-root")

	tests := `[
    {"id":"lt-1","name":"Smoke","filesystemName":"Smoke","scenarios":[],"settings":{}},
    {"id":"lt-2","name":"smoke","filesystemName":"smoke","scenarios":[],"settings":{}}
  ]`
	if err := saveKurloStorePayload(localPath, workspaceRoot, loadTestStorePayload(t, tests)); err != nil {
		t.Fatalf("save: %v", err)
	}
	entries, err := os.ReadDir(loadTestDirFor(workspaceRoot))
	if err != nil {
		t.Fatalf("read load test dir: %v", err)
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		lower := strings.ToLower(entry.Name())
		if seen[lower] {
			t.Fatalf("two load test files collide on a case-insensitive filesystem: %s", entry.Name())
		}
		seen[lower] = true
	}
	if len(seen) != 2 {
		t.Fatalf("expected two load test files, got %v", seen)
	}
}

func TestBrokenLoadTestFileIsReportedNotFatal(t *testing.T) {
	withRequestStoreTestKey(t)
	cases := map[string]string{
		"invalid yaml": "version: 1\nloadTest: [\n",
		"no load test": "version: 1\norder: 0\n",
		"no id":        "version: 1\nloadTest:\n    name: Orphan\n",
		"duplicate id": "version: 1\nloadTest:\n    id: lt-checkout\n    name: Copy\n",
		"numeric id":   "version: 1\nloadTest:\n    id: 42\n    name: Numbers\n",
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			localPath := filepath.Join(dir, "requests.json")
			workspaceRoot := filepath.Join(dir, "workspaces-root")
			if err := saveKurloStorePayload(localPath, workspaceRoot, loadTestStorePayload(t, "["+checkoutLoadTest+"]")); err != nil {
				t.Fatalf("save: %v", err)
			}
			if err := os.WriteFile(filepath.Join(loadTestDirFor(workspaceRoot), "Broken.yml"), []byte(content), 0644); err != nil {
				t.Fatal(err)
			}
			payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localPath, workspaceRoot)
			if err != nil {
				t.Fatalf("a broken load test must not stop the workspace from loading: %v", err)
			}
			if workspaceIntegrityError(diagnostics) == nil {
				t.Fatalf("a broken load test must block saving until it is fixed, got %+v", diagnostics)
			}
			got := collectionLoadTestsFromPayload(t, payload)
			if len(got) == 0 || got[0].ID != "lt-checkout" {
				t.Fatalf("the healthy load test should still load, got %+v", got)
			}
		})
	}
}

func TestLoadTestFolderWithoutCollectionFileIsReported(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces-root")

	if err := saveKurloStorePayload(localPath, workspaceRoot, loadTestStorePayload(t, "["+checkoutLoadTest+"]")); err != nil {
		t.Fatalf("save: %v", err)
	}
	collectionDir := filepath.Join(workspaceRoot, "workspaces", "Main", "collections", "Core")
	if err := os.RemoveAll(filepath.Join(collectionDir, "requests")); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(collectionDir, "examples")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(collectionDir, "collection.yml")); err != nil {
		t.Fatal(err)
	}
	_, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if workspaceIntegrityError(diagnostics) == nil {
		t.Fatalf("load tests left without their collection file must block saving, got %+v", diagnostics)
	}
}

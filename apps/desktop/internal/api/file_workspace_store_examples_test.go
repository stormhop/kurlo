package api

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func exampleStorePayload(t *testing.T, examples string) string {
	t.Helper()
	return fmt.Sprintf(`{
  "version": 2,
  "activeId": "req-main",
  "activeWorkspaceId": "workspace-main",
  "openIds": ["req-main"],
  "workspaces": [
    {"id":"workspace-main","name":"Main","filesystemName":"Main"}
  ],
  "collections": [
    {"id":"collection-main","workspaceId":"workspace-main","name":"Core","filesystemName":"Core"}
  ],
  "environments": [],
  "requests": [
    {"id":"req-main","name":"Create order","filesystemName":"Create-order","requestType":"http","collectionId":"collection-main","collection":"Core","folderPath":[],"method":"POST","url":"https://api.example.test/orders","requestTab":"params","params":[],"headers":[],"auth":{"type":"none"},"bodyType":"json","rawBodyType":"json","bodyContent":"","bodyFilePath":"","bodyFileName":"","formRows":[],"preRequestScript":"","testScript":"","requestNotes":"","settings":{"timeoutMs":30000},"examples":%s}
  ],
  "history": [],
  "workspaceCookies": {}
}`, examples)
}

const createdExample = `[
  {
    "id": "ex-created",
    "requestId": "req-main",
    "name": "Created",
    "filesystemName": "created",
    "source": "captured",
    "createdAt": 1787000000000,
    "snapshot": {"method": "POST", "url": "https://api.example.test/orders", "bodyType": "json", "bodyContent": "{\"amount\":500}"},
    "response": {
      "statusCode": 201,
      "status": "201 Created",
      "bodyMediaType": "application/json",
      "body": "{\n  \"id\": \"ord_1\"\n}",
      "headers": []
    },
    "match": {"pathTemplate": "/orders"}
  }
]`

func exampleDirFor(root string) string {
	return filepath.Join(root, "workspaces", "Main", "collections", "Core", "examples", "Create-order")
}

func requestExamplesFromPayload(t *testing.T, payload string) []map[string]any {
	t.Helper()
	var decoded struct {
		Requests []map[string]any `json:"requests"`
	}
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if len(decoded.Requests) != 1 {
		t.Fatalf("expected one request, got %d", len(decoded.Requests))
	}
	raw, ok := decoded.Requests[0]["examples"].([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if example, ok := item.(map[string]any); ok {
			out = append(out, example)
		}
	}
	return out
}

func TestExamplesRoundTripThroughWorkspace(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces-root")

	if err := saveKurloStorePayload(localPath, workspaceRoot, exampleStorePayload(t, createdExample)); err != nil {
		t.Fatalf("save: %v", err)
	}

	exampleDir := exampleDirFor(workspaceRoot)
	entries, err := os.ReadDir(exampleDir)
	if err != nil {
		t.Fatalf("read example dir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "created.yml" {
		t.Fatalf("an example is one YAML file, got %v", entries)
	}
	rawYAML, err := os.ReadFile(filepath.Join(exampleDir, "created.yml"))
	if err != nil {
		t.Fatalf("read example yaml: %v", err)
	}
	if !strings.Contains(string(rawYAML), "body: |-\n            {\n              \"id\": \"ord_1\"") {
		t.Errorf("the body must be a readable block inside the YAML:\n%s", rawYAML)
	}
	if strings.Contains(string(rawYAML), "bodyFile") {
		t.Errorf("no body file pointer expected:\n%s", rawYAML)
	}

	requestYAML, err := os.ReadFile(filepath.Join(workspaceRoot, "workspaces", "Main", "collections", "Core", "requests", "Create-order.yml"))
	if err != nil {
		t.Fatalf("read request yaml: %v", err)
	}
	if strings.Contains(string(requestYAML), "examples") {
		t.Errorf("examples must not be written inline in the request file:\n%s", requestYAML)
	}

	payload, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	examples := requestExamplesFromPayload(t, payload)
	if len(examples) != 1 {
		t.Fatalf("expected one example after load, got %d", len(examples))
	}
	if got := examples[0]["name"]; got != "Created" {
		t.Errorf("name = %v, want Created", got)
	}
	if got := examples[0]["filesystemName"]; got != "created" {
		t.Errorf("filesystemName = %v, want created", got)
	}
	response, _ := examples[0]["response"].(map[string]any)
	if response == nil {
		t.Fatal("example came back with no response")
	}
	if got := response["body"]; got != "{\n  \"id\": \"ord_1\"\n}" {
		t.Errorf("body = %q, want the saved body", got)
	}
	if _, ok := response["bodyFile"]; ok {
		t.Error("bodyFile is an on-disk detail and must not reach the frontend")
	}
}

func writeLegacyExampleBodyForTest(t *testing.T, root, bodyFile, body string) {
	t.Helper()
	yamlPath := filepath.Join(exampleDirFor(root), "created.yml")
	raw, err := os.ReadFile(yamlPath)
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(raw), "        body: |-")
	end := strings.Index(string(raw), "        bodyMediaType:")
	if start < 0 || end < start {
		t.Fatalf("test premise: inline body not found:\n%s", raw)
	}
	legacy := string(raw[:start]) + "        bodyFile: " + bodyFile + "\n" + string(raw[end:])
	if err := os.WriteFile(yamlPath, []byte(legacy), 0644); err != nil {
		t.Fatal(err)
	}
	if body != "" {
		if err := os.WriteFile(filepath.Join(exampleDirFor(root), bodyFile), []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLegacyExampleBodyFileIsInlinedOnNextSave(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces-root")
	if err := saveKurloStorePayload(localPath, workspaceRoot, exampleStorePayload(t, createdExample)); err != nil {
		t.Fatalf("save: %v", err)
	}
	writeLegacyExampleBodyForTest(t, workspaceRoot, "created.body.txt", "legacy body\n")

	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localPath, workspaceRoot)
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("legacy body must load: %v %#v", err, diagnostics)
	}
	response, _ := requestExamplesFromPayload(t, payload)[0]["response"].(map[string]any)
	if response["body"] != "legacy body\n" {
		t.Fatalf("legacy body not read: %#v", response)
	}
	store, err := decodeJSONMap(payload)
	if err != nil {
		t.Fatal(err)
	}
	mapSlice(store["requests"])[0]["url"] = "https://api.example.test/orders/v2"
	edited, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveKurloStorePayload(localPath, workspaceRoot, string(edited)); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := os.Stat(filepath.Join(exampleDirFor(workspaceRoot), "created.body.txt")); !os.IsNotExist(err) {
		t.Fatalf("legacy body file must be removed after the body moves into the YAML: %v", err)
	}
	rawYAML, err := os.ReadFile(filepath.Join(exampleDirFor(workspaceRoot), "created.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rawYAML), "legacy body") || strings.Contains(string(rawYAML), "bodyFile") {
		t.Fatalf("body was not inlined:\n%s", rawYAML)
	}
}

func TestWorkspaceWithoutExamplesLoadsUnchanged(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces-root")

	if err := saveKurloStorePayload(localPath, workspaceRoot, kurloSaveFlowPayload("/saved", "token", []string{"req-main"}, "")); err != nil {
		t.Fatalf("save: %v", err)
	}
	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diagnostics)
	}
	if strings.Contains(payload, `"examples"`) {
		t.Error("a workspace with no examples must not grow an examples field")
	}
}

func TestExampleBodyFileEscapingIsRefused(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces-root")

	if err := saveKurloStorePayload(localPath, workspaceRoot, exampleStorePayload(t, createdExample)); err != nil {
		t.Fatalf("save: %v", err)
	}
	secret := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(secret, []byte("do not read me"), 0600); err != nil {
		t.Fatalf("write bait: %v", err)
	}
	writeLegacyExampleBodyForTest(t, workspaceRoot, "../../../../../secret.txt", "")

	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if strings.Contains(payload, "do not read me") {
		t.Fatal("a body pointer outside the example directory must not be followed")
	}
	if len(diagnostics) == 0 {
		t.Error("refusing the path should be reported, not silent")
	}
}

func TestExampleNamesAreMadeUniqueOnDisk(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspaces-root")

	twoExamples := `[
    {"id":"ex-1","name":"Created","filesystemName":"created","response":{"statusCode":201,"bodyMediaType":"application/json","body":"{\"n\":1}","headers":[]}},
    {"id":"ex-2","name":"Created","filesystemName":"created","response":{"statusCode":201,"bodyMediaType":"application/json","body":"{\"n\":2}","headers":[]}}
  ]`
	if err := saveKurloStorePayload(localPath, workspaceRoot, exampleStorePayload(t, twoExamples)); err != nil {
		t.Fatalf("save: %v", err)
	}

	exampleDir := exampleDirFor(workspaceRoot)
	for _, name := range []string{"created.yml", "created-1.yml"} {
		if _, err := os.Stat(filepath.Join(exampleDir, name)); err != nil {
			t.Errorf("expected %s on disk: %v", name, err)
		}
	}

	payload, err := loadKurloStorePayload(localPath, workspaceRoot)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	examples := requestExamplesFromPayload(t, payload)
	if len(examples) != 2 {
		t.Fatalf("expected both examples back, got %d", len(examples))
	}
	bodies := map[string]bool{}
	for _, example := range examples {
		response, _ := example["response"].(map[string]any)
		bodies[fmt.Sprint(response["body"])] = true
	}
	if !bodies[`{"n":1}`] || !bodies[`{"n":2}`] {
		t.Errorf("both bodies should survive, got %v", bodies)
	}
}

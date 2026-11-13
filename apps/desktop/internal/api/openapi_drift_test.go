package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func driftSpec(paths map[string]any) map[string]any {
	return map[string]any{"openapi": "3.0.3", "info": map[string]any{"title": "Pets"}, "servers": []any{map[string]any{"url": "https://pets.example.test"}}, "paths": paths}
}

func getPetOperation(description string) map[string]any {
	return map[string]any{
		"operationId": "getPet",
		"description": description,
		"parameters":  []any{map[string]any{"name": "id", "in": "path", "required": true, "schema": map[string]any{"$ref": "#/components/schemas/Id"}}},
	}
}

func TestCompareOpenAPIDocumentsFindsEachKindOfChange(t *testing.T) {
	base := driftSpec(map[string]any{
		"/pets/{id}": map[string]any{"get": getPetOperation("one pet")},
		"/pets":      map[string]any{"post": map[string]any{"operationId": "createPet"}},
		"/legacy":    map[string]any{"delete": map[string]any{"operationId": "dropLegacy"}},
	})
	next := driftSpec(map[string]any{
		"/animals/{id}": map[string]any{"get": getPetOperation("one pet")},
		"/pets":         map[string]any{"post": map[string]any{"operationId": "createPet", "description": "now documented"}},
		"/owners":       map[string]any{"get": map[string]any{"operationId": "listOwners"}},
	})
	report := compareOpenAPIDocuments(base, next)
	if report.InSync {
		t.Fatal("report says in sync")
	}
	want := map[string][]openAPIDriftChange{
		"added":   {{Operation: "GET /owners"}},
		"changed": {{Operation: "POST /pets"}},
		"moved":   {{Operation: "GET /animals/{id}", From: "GET /pets/{id}"}},
		"removed": {{Operation: "DELETE /legacy"}},
	}
	got := map[string][]openAPIDriftChange{"added": report.Added, "changed": report.Changed, "moved": report.Moved, "removed": report.Removed}
	for kind, changes := range want {
		if len(got[kind]) != len(changes) || (len(changes) > 0 && got[kind][0] != changes[0]) {
			t.Fatalf("%s = %+v, want %+v", kind, got[kind], changes)
		}
	}
}

func TestCompareOpenAPIDocumentsFollowsReferencesAndIgnoresExtensions(t *testing.T) {
	withSchema := func(kind string) map[string]any {
		spec := driftSpec(map[string]any{"/pets/{id}": map[string]any{"get": getPetOperation("one pet")}})
		spec["components"] = map[string]any{"schemas": map[string]any{"Id": map[string]any{"type": kind}}}
		spec["x-generated-at"] = kind
		return spec
	}
	if report := compareOpenAPIDocuments(withSchema("string"), withSchema("string")); !report.InSync {
		t.Fatalf("identical specs drifted: %+v", report)
	}
	report := compareOpenAPIDocuments(withSchema("string"), withSchema("integer"))
	if report.InSync || len(report.Changed) != 1 || report.Changed[0].Operation != "GET /pets/{id}" {
		t.Fatalf("a changed referenced schema was not reported: %+v", report)
	}
	moved := withSchema("string")
	moved["servers"] = []any{map[string]any{"url": "https://v2.example.test"}}
	if report := compareOpenAPIDocuments(withSchema("string"), moved); report.InSync || report.Changed[0].Operation != "servers" {
		t.Fatalf("a server change was not reported: %+v", report)
	}
}

func TestCompareOpenAPIDocumentsSurvivesRecursiveSchemas(t *testing.T) {
	spec := driftSpec(map[string]any{"/nodes": map[string]any{"get": map[string]any{"responses": map[string]any{"200": map[string]any{"content": map[string]any{"application/json": map[string]any{"schema": map[string]any{"$ref": "#/components/schemas/Node"}}}}}}}})
	spec["components"] = map[string]any{"schemas": map[string]any{"Node": map[string]any{"type": "object", "properties": map[string]any{"children": map[string]any{"type": "array", "items": map[string]any{"$ref": "#/components/schemas/Node"}}}}}}
	if report := compareOpenAPIDocuments(spec, spec); !report.InSync {
		t.Fatalf("recursive spec drifted from itself: %+v", report)
	}
}

func writeDriftWorkspace(t *testing.T, source string, base map[string]any) string {
	t.Helper()
	root := t.TempDir()
	collections := []map[string]any{{
		"id": "c1", "workspaceId": "w1", "name": "Pets",
		"defaults": map[string]any{"variables": []any{map[string]any{"key": "region", "value": "eu", "enabled": true}}},
		"openapi":  map[string]any{"source": source, "intervalMinutes": 15, "headers": []any{map[string]any{"key": "Authorization", "value": "Bearer {{specToken}}", "enabled": true}}},
	}}
	requests := []map[string]any{
		{"id": "r1", "collectionId": "c1", "name": "Get pet", "method": "GET", "url": "{{baseUrl}}/pets/:id", "openapi": "GET /pets/{id}"},
		{"id": "r2", "collectionId": "c1", "name": "Scratch", "method": "GET", "url": "{{baseUrl}}/debug"},
	}
	if err := writeYAMLWorkspaceStore(root, []map[string]any{{"id": "w1", "name": "Team"}}, collections, requests, nil, nil, nil); err != nil {
		t.Fatalf("write workspace: %v", err)
	}
	if base != nil {
		data, _ := json.Marshal(base)
		if err := writeOpenAPIBaseSpec(root, "c1", string(data)); err != nil {
			t.Fatalf("write base: %v", err)
		}
	}
	return root
}

func TestOpenAPICheckCommandExitCodes(t *testing.T) {
	base := driftSpec(map[string]any{"/pets/{id}": map[string]any{"get": getPetOperation("one pet")}})
	current := base
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(current)
	}))
	defer server.Close()
	root := writeDriftWorkspace(t, strings.Replace(server.URL, "127.0.0.1", "{{specHost}}", 1)+"/openapi.json", base)

	run := func(args ...string) (int, string, string) {
		var stdout, stderr bytes.Buffer
		code := RunOpenAPICLI(append([]string{"check"}, args...), &stdout, &stderr)
		return code, stdout.String(), stderr.String()
	}

	code, out, errOut := run("Pets", "--workspace", root, "--var", "specHost=127.0.0.1", "--var", "specToken=t0ken")
	if code != 0 || !strings.Contains(out, "Pets is in sync") {
		t.Fatalf("in sync: code %d\n%s%s", code, out, errOut)
	}
	if gotAuth != "Bearer t0ken" {
		t.Fatalf("Authorization header = %q", gotAuth)
	}
	if !strings.Contains(out, "Requests not linked to an operation (1): Scratch") {
		t.Fatalf("unlinked requests missing:\n%s", out)
	}

	current = driftSpec(map[string]any{
		"/pets/{id}": map[string]any{"get": getPetOperation("changed")},
		"/owners":    map[string]any{"get": map[string]any{"operationId": "listOwners"}},
	})
	code, out, _ = run("--workspace", root, "--var", "specHost=127.0.0.1")
	if code != 1 || !strings.Contains(out, "+ GET /owners") || !strings.Contains(out, "~ GET /pets/{id}") {
		t.Fatalf("drift: code %d\n%s", code, out)
	}

	code, out, _ = run("Pets", "--workspace", root, "--reporter", "json", "--var", "specHost=127.0.0.1")
	var report openAPIDriftReport
	if code != 1 || json.Unmarshal([]byte(out), &report) != nil || report.InSync || len(report.Added) != 1 {
		t.Fatalf("json: code %d\n%s", code, out)
	}

	code, _, errOut = run("Pets", "--workspace", root)
	if code != 2 || !strings.Contains(errOut, "--var") {
		t.Fatalf("unresolved variable: code %d, %s", code, errOut)
	}
}

func TestOpenAPICheckCommandWithLocalSpec(t *testing.T) {
	base := driftSpec(map[string]any{"/pets/{id}": map[string]any{"get": getPetOperation("one pet")}})
	root := writeDriftWorkspace(t, "../spec/openapi.yaml", base)
	specDir := filepath.Join(filepath.Dir(root), "spec")
	if err := os.MkdirAll(specDir, 0755); err != nil {
		t.Fatal(err)
	}
	yamlSpec := "openapi: 3.0.3\ninfo:\n  title: Pets\nservers:\n  - url: https://pets.example.test\npaths:\n  /pets/{id}:\n    get:\n      operationId: getPet\n      description: one pet\n      parameters:\n        - name: id\n          in: path\n          required: true\n          schema:\n            $ref: '#/components/schemas/Id'\n"
	if err := os.WriteFile(filepath.Join(specDir, "openapi.yaml"), []byte(yamlSpec), 0644); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if code := RunOpenAPICLI([]string{"check", "--workspace", root}, &stdout, &stderr); code != 0 {
		t.Fatalf("local spec: code %d\n%s%s", code, stdout.String(), stderr.String())
	}
	other := filepath.Join(t.TempDir(), "next.json")
	data, _ := json.Marshal(driftSpec(map[string]any{}))
	if err := os.WriteFile(other, data, 0644); err != nil {
		t.Fatal(err)
	}
	stdout.Reset()
	if code := RunOpenAPICLI([]string{"check", "--workspace", root, "--spec", other}, &stdout, &stderr); code != 1 || !strings.Contains(stdout.String(), "- GET /pets/{id}") {
		t.Fatalf("--spec: code %d\n%s", code, stdout.String())
	}
}

func TestOpenAPICheckCommandNeedsASyncedCollection(t *testing.T) {
	root := writeDriftWorkspace(t, "https://pets.example.test/openapi.json", nil)
	var stdout, stderr bytes.Buffer
	if code := RunOpenAPICLI([]string{"check", "Pets", "--workspace", root}, &stdout, &stderr); code != 2 || !strings.Contains(stderr.String(), "has not been synced yet") {
		t.Fatalf("code %d, %s", code, stderr.String())
	}
	stderr.Reset()
	if code := RunOpenAPICLI([]string{"check", "Nope", "--workspace", root}, &stdout, &stderr); code != 2 || !strings.Contains(stderr.String(), "synced collections: Pets") {
		t.Fatalf("code %d, %s", code, stderr.String())
	}
}

package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestMCPWorkspaceRequestDocumentsAndPatch(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := writeYAMLWorkspace(t, "https://example.test")
	h := startMCPHarness(t, mcpServerOptions{workspace: root})
	for _, protocol := range []string{"http", "graphql", "grpc", "ws", "socketio", "mcp", "ai"} {
		t.Run(protocol, func(t *testing.T) {
			var saved struct{ ID, File string }
			h.tool("save_request", map[string]any{"collection": "Smoke", "yaml": fmt.Sprintf("version: 1\nrequest:\n  name: %s native\n  requestType: %s\n  url: https://example.test\n  auth:\n    type: oauth2\n    oauth2GrantType: device_code\n    oauth2Secret: '{{clientSecret}}'\n", protocol, protocol)}, &saved)
			if saved.ID == "" || !strings.Contains(readWorkspaceFile(t, root, saved.File), "requestType: "+protocol) {
				t.Fatalf("request was not saved: %+v", saved)
			}
			h.tool("patch_request", map[string]any{"request": saved.ID, "patch": map[string]any{"requestNotes": "Changed", "auth": map[string]any{"oauth2Scope": "read"}}}, nil)
			content := readWorkspaceFile(t, root, saved.File)
			for _, value := range []string{"requestNotes: Changed", "oauth2Scope: read", "oauth2Secret: '{{clientSecret}}'"} {
				if !strings.Contains(content, value) {
					t.Fatalf("patch did not preserve or add %q:\n%s", value, content)
				}
			}
			var read struct{ YAML string }
			h.tool("get_request", map[string]any{"request": saved.ID, "format": "yaml"}, &read)
			if !strings.Contains(read.YAML, "requestType: "+protocol) || !strings.Contains(read.YAML, "oauth2Secret: '{{clientSecret}}'") {
				t.Fatalf("YAML read did not return the request fields: %s", read.YAML)
			}
			if protocol == "http" {
				h.tool("patch_request", map[string]any{"request": saved.ID, "patch": map[string]any{"auth": map[string]any{
					"type": "ntlm", "basicUser": "DOMAIN\\user", "basicPass": "{{ntlmPassword}}",
				}}}, nil)
				content = readWorkspaceFile(t, root, saved.File)
				if !strings.Contains(content, "type: ntlm") || !strings.Contains(content, "basicPass: '{{ntlmPassword}}'") {
					t.Fatalf("NTLM config was lost: %s", content)
				}
			}
			for _, patch := range []map[string]any{
				{"requestType": "invalid"},
				{"auth": map[string]any{"oauth2Secret": "literal-secret"}},
				{"headers": []map[string]any{{"key": "Authorization", "value": "literal-secret"}}},
			} {
				if result := h.tool("patch_request", map[string]any{"request": saved.ID, "patch": patch}, nil); !result.IsError {
					t.Fatalf("patch should be refused: %+v", patch)
				}
			}
			if got := readWorkspaceFile(t, root, saved.File); got != content {
				t.Fatalf("invalid patches changed %s", saved.File)
			}
		})
	}
}

func TestMCPWorkspaceBatchStagesOneReview(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := writeYAMLWorkspace(t, "https://example.test")
	s := newMCPServer(mcpServerOptions{workspace: root}, io.Discard)
	call := func(ctx context.Context, operations string) (string, bool) {
		t.Helper()
		result, err := s.callTool(ctx, json.RawMessage(`{"name":"apply_changes","arguments":{"operations":`+operations+`}}`))
		if err != nil {
			t.Fatal(err)
		}
		return mcpResultPlainText(result)
	}
	batch := `[
		{"tool":"save_request","arguments":{"collection":"Smoke","folder":"A","name":"Batch","url":"https://example.test/batch"}},
		{"tool":"move_folder","arguments":{"collection":"Smoke","from":"A","to":"B"}},
		{"tool":"patch_request","arguments":{"request":"Smoke/B/Batch","patch":{"requestNotes":"reviewed"}}},
		{"tool":"create_environment","arguments":{"name":"Batch environment"}},
		{"tool":"patch_environment","arguments":{"environment":"Batch environment","patch":{"name":"Renamed environment"}}}
	]`
	reviews := 0
	ctx := withMcpReview(context.Background(), func(changes []model.AgentFileChange) error {
		reviews++
		if len(changes) < 3 {
			t.Fatalf("expected request, collection and environment in one review, got %+v", changes)
		}
		st, err := loadMCPStore(root)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := st.request("Smoke/B/Batch"); err == nil {
			t.Fatal("request was visible before approval")
		}
		return nil
	})
	bad := strings.TrimSuffix(strings.TrimSpace(batch), "]") + `,{"tool":"patch_environment","arguments":{"environment":"Renamed environment","patch":{"protected":false}}}]`
	if result, failed := call(ctx, bad); !failed || reviews != 0 || !strings.Contains(result, "protected") {
		t.Fatalf("invalid batch = %s, failed=%v, reviews=%d", result, failed, reviews)
	}
	if result, failed := call(ctx, batch); failed || reviews != 1 {
		t.Fatalf("batch = %s, failed=%v, reviews=%d", result, failed, reviews)
	}
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	request, _, err := st.request("Smoke/B/Batch")
	if err != nil || stringValue(request, "requestNotes") != "reviewed" {
		t.Fatalf("saved request = %+v, %v", request, err)
	}
	if _, err := mcpFindByName(st.environments, "Renamed environment", "environment"); err != nil {
		t.Fatal(err)
	}
}

func TestMCPWorkspaceEditsExamplesAndRejectsProtectedEnvironmentChanges(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := writeYAMLWorkspace(t, "https://example.test")
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	environment, err := mcpFindByName(st.environments, "Local", "environment")
	if err != nil {
		t.Fatal(err)
	}
	environment["protected"] = true
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	h := startMCPHarness(t, mcpServerOptions{workspace: root})
	var example struct{ ID string }
	h.tool("save_example", map[string]any{"request": "req-ok", "name": "Example", "status": 200, "body": "first body"}, &example)
	batch := func(tool string, args map[string]any) map[string]any {
		return map[string]any{"operations": []any{map[string]any{"tool": tool, "arguments": args}}}
	}
	h.tool("apply_changes", batch("patch_example", map[string]any{"request": "req-ok", "example": example.ID, "patch": map[string]any{"notes": "Edited"}}), nil)
	var detail struct{ Examples []mcpExample }
	h.tool("get_request", map[string]any{"request": "req-ok"}, &detail)
	if len(detail.Examples) != 1 || detail.Examples[0].Notes != "Edited" {
		t.Fatalf("example was not updated: %+v", detail)
	}
	h.tool("apply_changes", batch("delete_example", map[string]any{"request": "req-ok", "example": example.ID}), nil)
	detail.Examples = nil
	h.tool("get_request", map[string]any{"request": "req-ok"}, &detail)
	if len(detail.Examples) != 0 {
		t.Fatalf("example was not removed: %+v", detail)
	}
	if result := h.tool("apply_changes", batch("delete_environment", map[string]any{"environment": "Local"}), nil); !result.IsError {
		t.Fatal("protected environment was deleted")
	}
}

func TestMCPWorkspaceGlobalsAndFilesShareOneReview(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := writeYAMLWorkspace(t, "https://example.test")
	profile := map[string]any{
		"storage": map[string]any{"root": root},
		"globals": []any{map[string]any{"id": 1, "key": "private", "enabled": true, "secret": true, "value": "profile-private-value"}},
	}
	if err := saveLocalKurloStore(requestStorePath(), profile); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	before := app.LoadRequestStore()
	s := newMCPServer(mcpServerOptions{workspace: root}, io.Discard)
	call := func(ctx context.Context, payload string) (string, bool) {
		t.Helper()
		result, err := s.callTool(ctx, json.RawMessage(payload))
		if err != nil {
			t.Fatal(err)
		}
		return mcpResultPlainText(result)
	}
	reviews := 0
	ctx := withMcpReview(context.Background(), func(changes []model.AgentFileChange) error {
		reviews++
		var globals, request bool
		for _, change := range changes {
			if change.Path == "Profile globals" {
				globals = change.After != nil && strings.Contains(*change.After, "renamed") && !strings.Contains(*change.After, "profile-private-value")
			}
			request = request || strings.Contains(change.Path, "/requests/")
		}
		if !globals || !request {
			t.Fatalf("missing safe combined review: %+v", changes)
		}
		return nil
	})
	text, failed := call(ctx, `{"name":"apply_changes","arguments":{"operations":[
		{"tool":"edit_global","arguments":{"key":"temporary","value":"saved"}},
		{"tool":"edit_global","arguments":{"key":"temporary","name":"renamed"}},
		{"tool":"patch_request","arguments":{"request":"req-ok","patch":{"requestNotes":"with globals"}}}
	]}}`)
	if failed || reviews != 1 {
		t.Fatalf("batch = %s, reviews = %d", text, reviews)
	}
	if result := app.SaveRequestStoreWithError(before); result.Ok || !strings.Contains(result.Error, "global variables changed") {
		t.Fatalf("stale application save was not blocked: %+v", result)
	}
	if updated := app.LoadRequestStore(); !strings.Contains(updated, "renamed") {
		t.Fatal("reload did not pick up new globals")
	}
	text, failed = call(context.Background(), `{"name":"list_globals"}`)
	if failed || !strings.Contains(text, "renamed") || strings.Contains(text, "profile-private-value") {
		t.Fatalf("list_globals = %s", text)
	}
	if text, failed = call(context.Background(), `{"name":"apply_changes","arguments":{"operations":[{"tool":"edit_global","arguments":{"key":"private","delete":true}}]}}`); !failed {
		t.Fatalf("secret global was deleted: %s", text)
	}
	if text, failed = call(context.Background(), `{"name":"apply_changes","arguments":{"operations":[{"tool":"edit_global","arguments":{"key":"renamed","delete":true}}]}}`); failed {
		t.Fatalf("global was not deleted: %s", text)
	}
}

func TestMCPWorkspaceClonesAndMovesScriptsAtAllLevels(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	echo := echoServer(t)
	root := writeYAMLWorkspace(t, echo.URL)
	h := startMCPHarness(t, mcpServerOptions{workspace: root})
	h.tool("create_collection", map[string]any{"name": "Destination"}, nil)
	operation := func(tool string, args map[string]any) map[string]any {
		return map[string]any{"tool": tool, "arguments": args}
	}
	scripts := func(level string) map[string]any {
		return map[string]any{
			"preRequestScriptJs": fmt.Sprintf("console.log(%q)", level+" pre"),
			"testScriptJs":       fmt.Sprintf("console.log(%q)", level+" test"),
		}
	}
	folder := scripts("folder")
	folder["id"] = "folder-1"
	folder["path"] = []string{"Original"}
	h.tool("apply_changes", map[string]any{"operations": []any{
		operation("patch_collection", map[string]any{"collection": "Destination", "patch": map[string]any{"defaults": scripts("collection")}}),
		operation("save_request", map[string]any{"collection": "Smoke", "folder": "Original", "name": "Scripted", "url": echo.URL}),
		operation("patch_request", map[string]any{"request": "Smoke/Original/Scripted", "patch": scripts("request")}),
		operation("patch_collection", map[string]any{"collection": "Smoke", "patch": map[string]any{"folderDefaults": []any{folder}}}),
		operation("duplicate_folder", map[string]any{"collection": "Smoke", "from": "Original", "to": "Copied"}),
		operation("move_folder", map[string]any{"collection": "Smoke", "targetCollection": "Destination", "from": "Copied", "to": "Moved"}),
		operation("duplicate_collection", map[string]any{"collection": "Destination", "name": "Cloned"}),
	}}, nil)
	var run mcpRequestOutcome
	h.tool("run_request", map[string]any{"request": "Cloned/Moved/Scripted"}, &run)
	if run.Status != 200 {
		t.Fatalf("run failed: %+v", run)
	}
	var collectionRun mcpCollectionRun
	h.tool("run_collection", map[string]any{"collection": "Cloned"}, &collectionRun)
	if len(collectionRun.Results) != 1 {
		t.Fatalf("collection run = %+v", collectionRun)
	}
	for _, log := range []string{"collection pre", "collection test", "folder pre", "folder test", "request pre", "request test"} {
		if !strings.Contains(strings.Join(run.Logs, "\n"), log) || !strings.Contains(strings.Join(collectionRun.Results[0].Logs, "\n"), log) {
			t.Fatalf("missing %q from %+v", log, run.Logs)
		}
	}
}

func TestMCPWorkspaceAndLoaderRejectTheSameInvalidRequestField(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := writeYAMLWorkspace(t, "https://example.test")
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	request, _, err := st.request("req-ok")
	if err != nil {
		t.Fatal(err)
	}
	rel := st.requestFile(request)
	file := readWorkspaceFile(t, root, rel)
	file = strings.Replace(file, "requestType: http", "requestType: invalid", 1)
	if !strings.Contains(file, "requestType: invalid") {
		t.Fatal("test fixture did not include a request type")
	}
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(rel)), []byte(file), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = loadMCPStore(root)
	if err == nil || !strings.Contains(err.Error(), "workspace YAML schema") {
		t.Fatalf("loader accepted invalid request type: %v", err)
	}
}

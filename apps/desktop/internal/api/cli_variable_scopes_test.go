package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func collectionVariableWorkspace(t *testing.T, firstURL, secondURL, firstScript string) string {
	t.Helper()
	root := t.TempDir()
	workspaces := []map[string]any{{"id": "ws", "name": "Demo"}}
	collections := []map[string]any{}
	requests := []map[string]any{}
	for i, target := range []string{firstURL, secondURL} {
		id := fmt.Sprintf("collection-%d", i)
		name := []string{"A", "B"}[i]
		collections = append(collections, map[string]any{"id": id, "workspaceId": "ws", "name": name, "defaults": map[string]any{"variables": []any{
			map[string]any{"id": 1, "key": "baseUrl", "value": target, "enabled": true},
			map[string]any{"id": 2, "key": "scope", "value": name, "enabled": true},
		}}})
		req := map[string]any{"id": "request-" + name, "collectionId": id, "name": "Request", "method": "GET", "url": "{{baseUrl}}/{{scope}}", "requestType": "http", "auth": map[string]any{"type": "none"}}
		if i == 0 && firstScript != "" {
			req["preRequestScriptJs"] = firstScript
		}
		requests = append(requests, req)
	}
	ensureStoreFilesystemNames(workspaces, collections, requests, nil, nil, false)
	if err := writeFilesystemWorkspaceStore(root, workspaces, collections, requests, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestRunCLIResolvesVariablesForEachSelectedCollection(t *testing.T) {
	for _, selection := range []string{"A", ""} {
		t.Run("selection="+selection, func(t *testing.T) {
			first, firstHits := countingServer(t)
			second, secondHits := countingServer(t)
			root := collectionVariableWorkspace(t, first.URL, second.URL, "")
			var out bytes.Buffer
			code := runCLI(cliOptions{workspace: root, collection: selection, reporters: []string{"cli"}, iterations: 1, stdout: &out, stderr: &out, globalVars: map[string]string{"baseUrl": "http://invalid.test"}})
			if code != 0 {
				t.Fatalf("code=%d: %s", code, out.String())
			}
			wantSecond := int32(1)
			if selection == "A" {
				wantSecond = 0
			}
			if firstHits.Load() != 1 || secondHits.Load() != wantSecond {
				t.Fatalf("first=%d second=%d", firstHits.Load(), secondHits.Load())
			}
		})
	}
}

func TestMCPRunsKeepCollectionVariablesAndSessionChangesInTheirScope(t *testing.T) {
	first, firstHits := countingServer(t)
	second, secondHits := countingServer(t)
	script := `if (pm.collectionVariables.get("scope") === "A") { pm.collectionVariables.set("scope", "changed-A"); pm.environment.set("shared", "yes"); }`
	root := collectionVariableWorkspace(t, first.URL, second.URL, script)
	s := newMCPServer(mcpServerOptions{workspace: root}, nil)
	run := func(request string, overrides map[string]any) mcpRequestOutcome {
		t.Helper()
		args, _ := json.Marshal(map[string]any{"request": request, "variables": overrides})
		result, err := s.toolRunRequest(context.Background(), args)
		if err != nil {
			t.Fatal(err)
		}
		out := result.(mcpRequestOutcome)
		if out.Status != 200 {
			t.Fatalf("outcome=%+v", out)
		}
		return out
	}
	if out := run("A/Request", nil); out.URL != first.URL+"/A" {
		t.Fatalf("first outcome=%+v", out)
	}
	if out := run("A/Request", nil); out.URL != first.URL+"/changed-A" {
		t.Fatalf("collection session not retained: %+v", out)
	}
	if out := run("B/Request", nil); out.URL != second.URL+"/B" {
		t.Fatalf("collection session escaped to B: %+v", out)
	}
	if out := run("A/Request", map[string]any{"baseUrl": second.URL, "scope": "override"}); out.URL != second.URL+"/override" {
		t.Fatalf("call override not applied: %+v", out)
	}
	args, _ := json.Marshal(map[string]any{"url": first.URL + "/{{shared}}"})
	result, err := s.toolSendRequest(context.Background(), args)
	if err != nil || result.(mcpRequestOutcome).URL != first.URL+"/yes" {
		t.Fatalf("environment session not shared: %v %+v", err, result)
	}
	if firstHits.Load() != 3 || secondHits.Load() != 2 {
		t.Fatalf("first=%d second=%d", firstHits.Load(), secondHits.Load())
	}
}

func TestMCPCollectionRunResolvesEachCollectionAndKeepsEnvironmentOverrides(t *testing.T) {
	first, firstHits := countingServer(t)
	second, secondHits := countingServer(t)
	override, overrideHits := countingServer(t)
	root := collectionVariableWorkspace(t, first.URL, second.URL, "")
	s := newMCPServer(mcpServerOptions{workspace: root}, nil)
	for _, variables := range []map[string]any{nil, {"baseUrl": override.URL}} {
		args, _ := json.Marshal(map[string]any{"variables": variables})
		result, err := s.toolRunCollection(context.Background(), args)
		if err != nil {
			t.Fatal(err)
		}
		out := result.(mcpCollectionRun)
		if len(out.Results) != 2 || out.Results[0].StatusCode != 200 || out.Results[1].StatusCode != 200 {
			t.Fatalf("outcome=%+v", out)
		}
	}
	if firstHits.Load() != 1 || secondHits.Load() != 1 || overrideHits.Load() != 2 {
		t.Fatalf("first=%d second=%d override=%d", firstHits.Load(), secondHits.Load(), overrideHits.Load())
	}
}

func TestRunCLISharesEnvironmentButSeparatesScriptCollectionChanges(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); fmt.Fprint(w, `{}`) }))
	defer server.Close()
	root := collectionVariableWorkspace(t, server.URL, server.URL, `pm.collectionVariables.set("scope", "changed-A"); pm.environment.set("shared", "yes");`)
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	st.requests[1]["testScriptJs"] = `pm.test("own collection", () => pm.expect(pm.collectionVariables.get("scope")).to.equal("B")); pm.test("shared environment", () => pm.expect(pm.environment.get("shared")).to.equal("yes"));`
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	code := runCLI(cliOptions{workspace: root, reporters: []string{"cli"}, iterations: 2, stdout: &out, stderr: &out})
	if code != 0 || hits.Load() != 4 {
		t.Fatalf("code=%d hits=%d output=%s", code, hits.Load(), out.String())
	}
}

func TestMCPReportsSkippedGRPCRequestsWithoutCallingTheServer(t *testing.T) {
	root := collectionVariableWorkspace(t, "127.0.0.1:1", "127.0.0.1:1", "")
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	st.requests = st.requests[:1]
	st.requests[0]["requestType"] = "grpc"
	st.requests[0]["grpcMethod"] = "demo.Service/Method"
	st.requests[0]["preRequestScriptJs"] = `if (pm.collectionVariables.get("scope") !== "A") { throw new Error("missing collection scope"); } pm.execution.skipRequest();`
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	s := newMCPServer(mcpServerOptions{workspace: root}, nil)
	result, err := s.toolRunRequest(context.Background(), json.RawMessage(`{"request":"A/Request"}`))
	if err != nil {
		t.Fatal(err)
	}
	out := result.(mcpProtocolOutcome)
	if out.Error != "" || out.Response["skipped"] != true || out.Response["skipReason"] != "skipped by pm.execution.skipRequest()" {
		t.Fatalf("protocol outcome=%+v", out)
	}
	httpResponse := out.Response["http"].(map[string]any)
	if httpResponse["skipped"] != true {
		t.Fatalf("HTTP projection=%v", httpResponse)
	}
	result, err = s.toolRunCollection(context.Background(), json.RawMessage(`{"collection":"A"}`))
	if err != nil {
		t.Fatal(err)
	}
	run := result.(mcpCollectionRun)
	if len(run.Results) != 1 || !run.Results[0].Skipped || run.Summary["failed"] != 0 {
		t.Fatalf("collection outcome=%+v", run)
	}
}

package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func twoWorkspaceFolder(t *testing.T) (root, demoID, otherID string) {
	t.Helper()
	root = agentTestWorkspace(t, "http://127.0.0.1:1")
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	demoID = stringValue(st.workspaces[0], "id")
	otherID = "workspace-other"
	st.workspaces = append(st.workspaces, map[string]any{"id": otherID, "name": "Billing team"})
	st.collections = append(st.collections, map[string]any{"id": "collection-billing", "workspaceId": otherID, "name": "Billing"})
	st.requests = append(st.requests, map[string]any{"id": "request-invoices", "collectionId": "collection-billing", "name": "List invoices", "requestType": "http", "method": "GET", "url": "http://127.0.0.1:1/invoices"})
	st.environments = append(st.environments, map[string]any{"id": "environment-billing", "workspaceId": otherID, "name": "Billing local", "values": []any{}})
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	return root, demoID, otherID
}

func otherWorkspaceFiles(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{}
	base := filepath.Join(root, fileStoreWorkspacesDir, "Billing-team")
	err := filepath.Walk(base, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		files[path] = string(data)
		return err
	})
	if err != nil || len(files) == 0 {
		t.Fatalf("other workspace files = %v, %v", files, err)
	}
	return files
}

func TestAgentBridgeWorksOnlyInTheChatWorkspace(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root, demoID, otherID := twoWorkspaceFolder(t)
	before := otherWorkspaceFiles(t, root)
	bridge, _ := newTestAgentBridge(t, root, model.AgentApprovalAllow, model.AgentApprovalAllow, model.AgentApprovalAllow)
	bridge.server.opts.workspaceID = demoID

	text, isError := agentBridgeCall(t, bridge, "list_requests", map[string]any{})
	if isError || !strings.Contains(text, "Smoke/Ok") || strings.Contains(text, "List invoices") {
		t.Fatalf("list_requests = %v %s", isError, text)
	}
	if text, isError = agentBridgeCall(t, bridge, "list_environments", map[string]any{}); isError || strings.Contains(text, "Billing local") {
		t.Fatalf("list_environments = %v %s", isError, text)
	}
	if text, isError = agentBridgeCall(t, bridge, "get_request", map[string]any{"request": "List invoices"}); !isError {
		t.Fatalf("a request of another workspace must not be found: %s", text)
	}
	if text, isError = agentBridgeCall(t, bridge, "save_request", map[string]any{"collection": "Billing", "name": "Create invoice", "method": "POST", "url": "{{baseUrl}}/invoices"}); !isError {
		t.Fatalf("writing into another workspace must fail: %s", text)
	}
	if text, isError = agentBridgeCall(t, bridge, "create_collection", map[string]any{"name": "Orders"}); isError {
		t.Fatalf("create_collection without a workspace should use the chat's: %s", text)
	}
	if text, isError = agentBridgeCall(t, bridge, "set_variable", map[string]any{"environment": "Local", "key": "token", "value": "{{token}}"}); isError {
		t.Fatalf("set_variable: %s", text)
	}

	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.workspaces) != 2 || len(st.requests) < 2 {
		t.Fatalf("the other workspace must survive the agent's writes: %d workspaces, %d requests", len(st.workspaces), len(st.requests))
	}
	for _, collection := range st.collections {
		if stringValue(collection, "name") == "Orders" && stringValue(collection, "workspaceId") != demoID {
			t.Fatalf("Orders landed in %s", stringValue(collection, "workspaceId"))
		}
	}
	after := otherWorkspaceFiles(t, root)
	for path, data := range before {
		if after[path] != data {
			t.Fatalf("%s changed:\n%s\nvs\n%s", path, data, after[path])
		}
	}

	all := listAgentActivityFor(t, model.AgentActivityFilter{WorkspaceID: otherID, AllWorkspaces: true}, root)
	here := listAgentActivityFor(t, model.AgentActivityFilter{WorkspaceID: otherID}, root)
	if len(here) != 0 || len(all) == 0 {
		t.Fatalf("activity of workspace %s: here %d, all %d", otherID, len(here), len(all))
	}
	for _, entry := range all {
		if entry.WorkspaceID != demoID || entry.Here || entry.WorkspaceName != "Demo" {
			t.Fatalf("entry = %+v", entry)
		}
	}
	if mine := listAgentActivityFor(t, model.AgentActivityFilter{WorkspaceID: demoID}, root); len(mine) != len(all) || !mine[0].Here {
		t.Fatalf("activity of the chat workspace = %+v", mine)
	}
}

func TestAgentBridgeNamesAMissingChatWorkspace(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := agentTestWorkspace(t, "http://127.0.0.1:1")
	bridge, _ := newTestAgentBridge(t, root, model.AgentApprovalAllow)
	bridge.server.opts.workspaceID = "workspace-gone"
	if text, isError := agentBridgeCall(t, bridge, "save_request", map[string]any{"collection": "Smoke", "name": "X", "url": "{{baseUrl}}/x"}); !isError || !strings.Contains(text, "no longer in") {
		t.Fatalf("save_request = %v %s", isError, text)
	}
}

func TestMCPClientWritesAreLoggedWithTheirWorkspace(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root, _, otherID := twoWorkspaceFolder(t)
	h := startMCPHarness(t, mcpServerOptions{workspace: root})
	h.tool("save_request", map[string]any{"workspace": "Billing team", "collection": "Billing", "name": "Create invoice", "method": "POST", "url": "{{baseUrl}}/invoices"}, nil)
	h.tool("list_requests", map[string]any{}, nil)
	entries := listAgentActivityFor(t, model.AgentActivityFilter{WorkspaceID: otherID, AllWorkspaces: true}, root)
	if len(entries) != 2 || entries[1].Tool != "save_request" || entries[1].WorkspaceID != otherID || !entries[1].Here {
		t.Fatalf("save entry = %+v", entries)
	}
	if entries[0].Tool != "list_requests" || entries[0].WorkspaceID != "" || entries[0].Here {
		t.Fatalf("a read with no files has no workspace: %+v", entries[0])
	}
}

func listAgentActivityFor(t *testing.T, filter model.AgentActivityFilter, root string) []model.AgentActivitySummary {
	t.Helper()
	if err := persistActiveWorkspaceRootMode(root, workspaceStorageModeGit); err != nil {
		t.Fatal(err)
	}
	entries, err := listAgentActivity(filter)
	if err != nil {
		t.Fatal(err)
	}
	return entries
}

func fixtureWorkspaceID(t *testing.T, root string) string {
	t.Helper()
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	return stringValue(st.workspaces[0], "id")
}

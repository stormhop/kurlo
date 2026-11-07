package api

import (
	"reflect"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestDiffWorkspaceFilesSummarizesChangesWithoutIDs(t *testing.T) {
	collection := []byte("version: 1\ncollection:\n    id: collection-1a2b\n    name: Shop API\n    workspaceId: workspace-9f\n")
	beforeRequest := "version: 1\nrequest:\n    collectionId: collection-1a2b\n    folderPath:\n        - Orders\n    id: request-77\n    method: GET\n    name: List orders\n    url: '{{baseUrl}}/orders'\n"
	afterRequest := beforeRequest + "    testScriptJs: |\n        pm.test(\"ok\", () => {})\n"
	beforeEnv := "version: 1\nenvironment:\n    id: environment-1\n    name: Local\n    values:\n        - key: baseUrl\n          value: http://localhost\n        - key: token\n          value: old\n    workspaceId: workspace-9f\n"
	afterEnv := "version: 1\nenvironment:\n    id: environment-1\n    name: Local\n    sandbox: true\n    values:\n        - key: baseUrl\n          value: http://localhost:8080\n        - key: userId\n          value: \"7\"\n    workspaceId: workspace-9f\n"
	newRequest := "version: 1\nrequest:\n    collectionId: collection-1a2b\n    id: request-88\n    method: post\n    name: Create order\n    url: '{{baseUrl}}/orders'\n"
	before := map[string][]byte{
		"workspaces/Main/collections/Shop-API/collection.yml":           collection,
		"workspaces/Main/collections/Shop-API/requests/List-orders.yml": []byte(beforeRequest),
		"workspaces/Main/environments/Local.yml":                        []byte(beforeEnv),
		"kurlo-agent.md":                                                []byte("notes"),
	}
	after := map[string][]byte{
		"workspaces/Main/collections/Shop-API/collection.yml":            collection,
		"workspaces/Main/collections/Shop-API/requests/List-orders.yml":  []byte(afterRequest),
		"workspaces/Main/collections/Shop-API/requests/Create-order.yml": []byte(newRequest),
		"workspaces/Main/environments/Local.yml":                         []byte(afterEnv),
		"kurlo-agent.md":                                                 []byte("notes and more"),
	}
	summaries := map[string]*model.AgentChangeSummary{}
	for _, change := range diffWorkspaceFiles(before, after) {
		summaries[change.Path] = change.Summary
	}
	want := map[string]*model.AgentChangeSummary{
		"kurlo-agent.md": nil,
		"workspaces/Main/collections/Shop-API/requests/Create-order.yml": {Kind: "request", Name: "Create order", Location: "Shop API", Detail: "POST {{baseUrl}}/orders"},
		"workspaces/Main/collections/Shop-API/requests/List-orders.yml":  {Kind: "request", Name: "List orders", Location: "Shop API / Orders", Detail: "GET {{baseUrl}}/orders", Fields: []model.AgentChangeField{{Label: "Tests", Change: "added"}}},
		"workspaces/Main/environments/Local.yml": {Kind: "environment", Name: "Local", Fields: []model.AgentChangeField{
			{Label: "Sandbox for the agent", Change: "added", After: "true"},
			{Label: "Variable baseUrl", Change: "changed"},
			{Label: "Variable token", Change: "removed"},
			{Label: "Variable userId", Change: "added"},
		}},
	}
	if !reflect.DeepEqual(summaries, want) {
		t.Fatalf("summaries:\n%#v\nwant:\n%#v", summaries, want)
	}
}

func TestAgentChangeSummaryShowsShortScalarValuesOnly(t *testing.T) {
	before := "version: 1\nrequest:\n    method: GET\n    name: Ping\n    url: https://example.test/ping\n    bodyContent: a\n"
	after := "version: 1\nrequest:\n    method: GET\n    name: Health\n    url: https://example.test/health\n    bodyContent: b\n"
	summary := agentChangeSummary(model.AgentFileChange{Path: "w/requests/Ping.yml", Before: &before, After: &after}, nil)
	want := []model.AgentChangeField{
		{Label: "Body", Change: "changed"},
		{Label: "Name", Change: "changed", Before: "Ping", After: "Health"},
		{Label: "URL", Change: "changed", Before: "https://example.test/ping", After: "https://example.test/health"},
	}
	if summary == nil || !reflect.DeepEqual(summary.Fields, want) {
		t.Fatalf("fields = %#v", summary)
	}
}

func TestAgentGlobalsSummaryListsVariableNames(t *testing.T) {
	before := "[\n  {\"key\": \"token\", \"value\": \"a\"}\n]"
	after := "[\n  {\"key\": \"token\", \"value\": \"b\"},\n  {\"key\": \"baseUrl\", \"value\": \"x\"}\n]"
	summary := agentChangeSummary(model.AgentFileChange{Path: "Profile globals", Before: &before, After: &after}, nil)
	want := &model.AgentChangeSummary{Kind: "globals", Name: "Globals", Fields: []model.AgentChangeField{{Label: "Variable baseUrl", Change: "added"}, {Label: "Variable token", Change: "changed"}}}
	if !reflect.DeepEqual(summary, want) {
		t.Fatalf("summary = %#v", summary)
	}
}

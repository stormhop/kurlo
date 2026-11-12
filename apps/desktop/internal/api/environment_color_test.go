package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMCPListEnvironmentsShowsTheColor(t *testing.T) {
	root := writeYAMLWorkspace(t, "https://api.example.test")
	path := filepath.Join(root, "workspaces", "Demo", "environments", "Local.yml")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	updated := strings.Replace(string(data), "  filesystemName: Local\n", "  filesystemName: Local\n  color: red\n", 1)
	if err := os.WriteFile(path, []byte(updated), 0o644); err != nil {
		t.Fatal(err)
	}

	h := startMCPHarness(t, mcpServerOptions{workspace: root, env: "Local"})
	var envs struct {
		Environments []struct {
			Name  string `json:"name"`
			Color string `json:"color"`
		} `json:"environments"`
	}
	h.tool("list_environments", map[string]any{}, &envs)
	if len(envs.Environments) != 1 || envs.Environments[0].Color != "red" {
		t.Fatalf("environments = %+v", envs.Environments)
	}
}

func TestEnvironmentColorSurvivesWorkspaceRoundTrip(t *testing.T) {
	root := t.TempDir()
	workspaces := []map[string]any{{"id": "w1", "name": "WS"}}
	environments := []map[string]any{{"id": "e1", "workspaceId": "w1", "name": "Prod", "color": "red", "values": []any{}}}
	if err := writeYAMLWorkspaceStore(root, workspaces, nil, nil, environments, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, _, _, loaded, _, _, err := loadYAMLWorkspaceStoreWithDiagnostics(root, map[string]string{})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded) != 1 || loaded[0]["color"] != "red" {
		t.Fatalf("environments = %v", loaded)
	}
}

func TestAgentChangeSummaryNamesTheEnvironmentColor(t *testing.T) {
	if agentChangeLabels["color"] != "Color" || !agentChangeScalarFields["color"] {
		t.Fatal("color changes should be listed by name with the old and new value")
	}
}

package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func cliEnvValues(env cliEnvironment) map[string]string {
	values := map[string]string{}
	for _, row := range env.Values {
		if row.Enabled {
			values[row.Key] = row.Value
		}
	}
	return values
}

func TestFlattenCLIEnvironmentsTakesUnsetValuesFromTheNearestAncestor(t *testing.T) {
	envs := flattenCLIEnvironments([]cliEnvironment{
		{ID: "base", WorkspaceID: "ws", Name: "Base", Values: []cliKV{{Key: "baseUrl", Value: "https://base", Enabled: true}, {Key: "token", Value: "t", Enabled: true, Secret: true}, {Key: "off", Value: "x"}}},
		{ID: "stage", WorkspaceID: "ws", Name: "Stage", ParentID: "base", Values: []cliKV{{Key: "baseUrl", Value: "https://stage", Enabled: true}, {Key: "region", Value: "eu", Enabled: true}}},
		{ID: "stage-eu", WorkspaceID: "ws", Name: "Stage EU", ParentID: "stage", Values: []cliKV{{Key: "token", Value: "", Enabled: false}}},
		{ID: "other", WorkspaceID: "ws-2", Name: "Other", ParentID: "base"},
	})
	got := cliEnvValues(envs[2])
	want := map[string]string{"baseUrl": "https://stage", "token": "t", "region": "eu"}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("Stage EU %s = %q, want %q (all: %v)", key, got[key], value, got)
		}
	}
	if _, ok := got["off"]; ok {
		t.Errorf("a disabled ancestor row was inherited: %v", got)
	}
	if envs[2].Parent != "Stage" {
		t.Errorf("parent name = %q", envs[2].Parent)
	}
	secret := false
	for _, row := range envs[2].Values {
		if row.Key == "token" && row.Enabled {
			secret = row.Secret
		}
	}
	if !secret {
		t.Error("an inherited secret row lost its secret flag")
	}
	if len(cliEnvValues(envs[3])) != 0 || envs[3].Parent != "" {
		t.Errorf("a parent from another workspace was used: %+v", envs[3])
	}
}

func TestFlattenCLIEnvironmentsSurvivesACycleAndInheritsProtection(t *testing.T) {
	envs := flattenCLIEnvironments([]cliEnvironment{
		{ID: "a", WorkspaceID: "ws", Name: "A", ParentID: "b", Values: []cliKV{{Key: "x", Value: "a", Enabled: true}}},
		{ID: "b", WorkspaceID: "ws", Name: "B", ParentID: "a", Protected: true, Values: []cliKV{{Key: "y", Value: "b", Enabled: true}}},
	})
	if got := cliEnvValues(envs[0]); got["x"] != "a" || got["y"] != "b" {
		t.Fatalf("A = %v", got)
	}
	if !envs[0].Protected {
		t.Fatal("A inherits from a protected environment, so it is protected too")
	}
}

func writeChildEnvironment(t *testing.T, root, name, parentID string, rows ...string) {
	t.Helper()
	lines := []string{
		"version: 1",
		"environment:",
		"  id: env-" + strings.ToLower(name),
		"  workspaceId: ws-demo",
		"  name: " + name,
		"  filesystemName: " + name,
		"  parentId: " + parentID,
		"  values:",
	}
	if len(rows) == 0 {
		lines[len(lines)-1] = "  values: []"
	}
	lines = append(lines, rows...)
	lines = append(lines, "")
	if err := os.WriteFile(filepath.Join(root, "workspaces", "Demo", "environments", name+".yml"), []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestMCPServerResolvesInheritedEnvironmentValues(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	writeChildEnvironment(t, root, "Staging", "env-local")
	h := startMCPHarness(t, mcpServerOptions{workspace: root})

	var envs struct {
		Environments []struct {
			Name      string `json:"name"`
			Inherits  string `json:"inherits"`
			Variables []struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			} `json:"variables"`
		} `json:"environments"`
	}
	h.tool("list_environments", map[string]any{}, &envs)
	found := false
	for _, env := range envs.Environments {
		if env.Name != "Staging" {
			continue
		}
		found = true
		if env.Inherits != "Local" || len(env.Variables) != 1 || env.Variables[0].Key != "baseUrl" || env.Variables[0].Value != server.URL {
			t.Fatalf("Staging = %+v", env)
		}
	}
	if !found {
		t.Fatalf("environments = %+v", envs)
	}

	var run mcpRequestOutcome
	h.tool("run_request", map[string]any{"request": "Smoke/Ok", "environment": "Staging"}, &run)
	if run.Status != 200 {
		t.Fatalf("Staging should send with the baseUrl it inherits: %+v", run)
	}

	if result := h.tool("set_variable", map[string]any{"environment": "Staging", "key": "baseUrl", "value": "http://staging.test"}, nil); result.IsError {
		t.Fatalf("set_variable = %+v", result)
	}
	if file := readWorkspaceFile(t, root, "workspaces/Demo/environments/Staging.yml"); !strings.Contains(file, "http://staging.test") || !strings.Contains(file, "parentId: env-local") {
		t.Fatalf("Staging should get its own value and keep its parent:\n%s", file)
	}
	if file := readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml"); strings.Contains(file, "staging.test") {
		t.Fatalf("the parent environment was changed:\n%s", file)
	}
}

func TestMCPServerRefusesToOverrideAnInheritedSecret(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	addSecretEnvironment(t, root, server.URL, "tok-123456")
	writeChildEnvironment(t, root, "ProdEU", "env-prod")
	h := startMCPHarness(t, mcpServerOptions{workspace: root})
	result := h.tool("set_variable", map[string]any{"environment": "ProdEU", "key": "apiToken", "value": "leak"}, nil)
	if !result.IsError || !strings.Contains(result.Content[0].Text, "comes from Prod and is a secret") {
		t.Fatalf("overriding an inherited secret should be refused: %+v", result)
	}
}

func TestMCPServerRefusesEnvironmentsThatInheritFromAProtectedOne(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	addSecretEnvironment(t, root, server.URL, "tok-123456")
	envPath := filepath.Join(root, "workspaces", "Demo", "environments", "Prod.yml")
	data, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(envPath, []byte(strings.Replace(string(data), "  name: Prod\n", "  name: Prod\n  protected: true\n", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	writeChildEnvironment(t, root, "ProdEU", "env-prod")
	h := startMCPHarness(t, mcpServerOptions{workspace: root})

	for name, args := range map[string]map[string]any{
		"run_request":  {"request": "Smoke/Ok", "environment": "ProdEU"},
		"set_variable": {"environment": "ProdEU", "key": "region", "value": "eu"},
	} {
		result := h.tool(name, args, nil)
		if !result.IsError || !strings.Contains(result.Content[0].Text, "protected") {
			t.Errorf("%s with a child of a protected environment should be refused: %+v", name, result)
		}
	}
}

func TestCLIRunUsesInheritedEnvironmentValues(t *testing.T) {
	server := echoServer(t)
	root := writeYAMLWorkspace(t, server.URL)
	writeChildEnvironment(t, root, "Staging", "env-local")
	_, collections, _, environments, err := loadCLIWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	values, _, err := resolveCLIValues(cliOptions{env: "Staging"}, collections, environments, nil)
	if err != nil {
		t.Fatal(err)
	}
	if values["baseUrl"] != server.URL {
		t.Fatalf("baseUrl = %q, want the value Staging inherits from Local", values["baseUrl"])
	}
}

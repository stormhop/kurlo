package api

import (
	"errors"
	"strings"
	"testing"
)

func TestCheckWorkspaceYAMLPointsAtTheProblemLine(t *testing.T) {
	workspace := "workspaces/My-Workspace/workspace.yml"
	for _, tc := range []struct {
		name, path, content string
		line                int
		ok                  bool
	}{
		{"valid workspace", workspace, "version: 1\nworkspace:\n    id: workspace-a\n    name: Main\n", 0, true},
		{"stray line", workspace, "version: 1\nworkspace:\n    id: workspace-a\n    name: My Workspace\n    а\ncollectionOrder:\n    - c\n", 5, false},
		{"wrong type", workspace, "version: 1\nworkspace:\n    id: w\ncollectionOrder: nope\n", 4, false},
		{"newer version", workspace, "version: 9\nworkspace:\n    id: w\n", 1, false},
		{"missing section", "workspaces/Main/collections/Core/collection.yml", "version: 1\nrequestOrder: []\n", 1, false},
		{"numeric id", "workspaces/Main/collections/Core/requests/Get.yml", "version: 1\nrequest:\n    name: Get\n    id: 123\n", 4, false},
		{"empty id", "workspaces/Main/environments/Local.yml", "version: 1\nenvironment:\n    id: ''\n", 3, false},
		{"root index", "kurlo.yml", "version: 1\nworkspaceOrder:\n    - a\n", 0, true},
		{"valid load test", "workspaces/Main/collections/Core/loadtests/Smoke.yml", "version: 1\norder: 2\nloadTest:\n    id: lt-a\n    name: Smoke\n", 0, true},
		{"load test without block", "workspaces/Main/collections/Core/loadtests/Smoke.yml", "version: 1\nrequest:\n    id: lt-a\n", 1, false},
		{"load test without id", "workspaces/Main/collections/Core/loadtests/Smoke.yml", "version: 1\nloadTest:\n    name: Smoke\n", 2, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result := checkWorkspaceYAML(tc.path, tc.content)
			if result.Ok != tc.ok || result.Line != tc.line {
				t.Fatalf("got %#v, want ok=%v line=%d", result, tc.ok, tc.line)
			}
			if !tc.ok && result.Message == "" {
				t.Fatal("a failure needs a message")
			}
		})
	}
}

func TestYAMLErrorsReadAsHints(t *testing.T) {
	result := checkWorkspaceYAML("workspaces/My-Workspace/workspace.yml", "version: 1\nworkspace:\n    id: w\n    name: My Workspace\n    а\ncollectionOrder: []\n")
	if result.Line != 5 || result.Message != "This line is not a key: value pair. Add a key with a colon, or remove the line." {
		t.Fatalf("unexpected result: %#v", result)
	}
	diagnostic := workspaceDiagnostic{scope: "workspace", path: "/r/workspaces/W/workspace.yml", root: "/r", err: errors.New("read /r/workspaces/W/workspace.yml: yaml: line 5: could not find expected ':'")}.toDiagnostic()
	if diagnostic.Line != 5 || strings.Contains(diagnostic.Message, "line 5") || !strings.Contains(diagnostic.Message, "key: value") {
		t.Fatalf("diagnostic should carry the line separately and read as a hint: %#v", diagnostic)
	}
}

package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readmeTestWorkspaces(description string) []map[string]any {
	workspace := map[string]any{"id": "w1", "name": "Team API"}
	if description != "" {
		workspace["description"] = description
	}
	return []map[string]any{workspace, {"id": "w2", "name": "Other"}}
}

func readmeTestCollections() []map[string]any {
	return []map[string]any{{"id": "c1", "workspaceId": "w1", "name": "Col"}, {"id": "c2", "workspaceId": "w2", "name": "Col"}}
}

func loadedDescription(t *testing.T, root, id string) (string, bool) {
	t.Helper()
	workspaces, _, _, _, _, _, err := loadYAMLWorkspaceStoreWithDiagnostics(root, map[string]string{})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	for _, workspace := range workspaces {
		if stringValue(workspace, "id") == id {
			value, ok := workspace["description"].(string)
			return value, ok
		}
	}
	t.Fatalf("workspace %s not loaded", id)
	return "", false
}

func TestWorkspaceDescriptionIsStoredAsReadme(t *testing.T) {
	root := t.TempDir()
	text := "# Team API\n\nRun **Login** first.\n"
	if err := writeYAMLWorkspaceStore(root, readmeTestWorkspaces(text), readmeTestCollections(), nil, nil, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	dir := filepath.Join(root, fileStoreWorkspacesDir, "Team-API")
	data, err := os.ReadFile(filepath.Join(dir, workspaceReadmeFile))
	if err != nil {
		t.Fatalf("read README.md: %v", err)
	}
	if string(data) != text {
		t.Fatalf("README.md = %q, want %q", data, text)
	}
	yml, err := os.ReadFile(filepath.Join(dir, fileStoreRootFileName))
	if err != nil {
		t.Fatalf("read workspace.yml: %v", err)
	}
	if strings.Contains(string(yml), "description") || strings.Contains(string(yml), "Login") {
		t.Fatalf("workspace.yml still carries the description:\n%s", yml)
	}
	if got, _ := loadedDescription(t, root, "w1"); got != text {
		t.Fatalf("loaded description = %q, want %q", got, text)
	}
	if _, err := os.Stat(filepath.Join(root, fileStoreWorkspacesDir, "Other", workspaceReadmeFile)); !os.IsNotExist(err) {
		t.Fatalf("workspace without a description got a README.md: %v", err)
	}
}

func TestReadmeEditedOutsideKurloIsLoaded(t *testing.T) {
	root := t.TempDir()
	if err := writeYAMLWorkspaceStore(root, readmeTestWorkspaces("old"), readmeTestCollections(), nil, nil, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	path := filepath.Join(root, fileStoreWorkspacesDir, "Team-API", workspaceReadmeFile)
	if err := os.WriteFile(path, []byte("edited in an editor\n"), 0o644); err != nil {
		t.Fatalf("edit: %v", err)
	}
	if got, _ := loadedDescription(t, root, "w1"); got != "edited in an editor\n" {
		t.Fatalf("loaded description = %q", got)
	}
}

func TestEmptyDescriptionRemovesReadme(t *testing.T) {
	root := t.TempDir()
	if err := writeYAMLWorkspaceStore(root, readmeTestWorkspaces("notes"), readmeTestCollections(), nil, nil, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writeYAMLWorkspaceStore(root, readmeTestWorkspaces("  \n"), readmeTestCollections(), nil, nil, nil, nil); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, fileStoreWorkspacesDir, "Team-API", workspaceReadmeFile)); !os.IsNotExist(err) {
		t.Fatalf("README.md still exists: %v", err)
	}
	if got, ok := loadedDescription(t, root, "w1"); ok && got != "" {
		t.Fatalf("loaded description = %q, want none", got)
	}
}

func TestLegacyYAMLDescriptionMovesToReadme(t *testing.T) {
	root := t.TempDir()
	if err := writeYAMLWorkspaceStore(root, readmeTestWorkspaces(""), readmeTestCollections(), nil, nil, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	dir := filepath.Join(root, fileStoreWorkspacesDir, "Team-API")
	legacy := "version: 1\nworkspace:\n  id: w1\n  name: Team API\n  filesystemName: Team-API\n  description: kept from before\ncollectionOrder:\n  - c1\n"
	if err := os.WriteFile(filepath.Join(dir, fileStoreRootFileName), []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy: %v", err)
	}
	workspaces, collections, _, _, _, _, err := loadYAMLWorkspaceStoreWithDiagnostics(root, map[string]string{})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got, _ := loadedDescription(t, root, "w1"); got != "kept from before" {
		t.Fatalf("legacy description = %q", got)
	}
	if err := writeYAMLWorkspaceStore(root, workspaces, collections, nil, nil, nil, nil); err != nil {
		t.Fatalf("resave: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, workspaceReadmeFile))
	if err != nil || string(data) != "kept from before\n" {
		t.Fatalf("README.md = %q, %v", data, err)
	}
}

func TestDeletingWorkspaceRemovesItsReadmeAndFolder(t *testing.T) {
	root := t.TempDir()
	if err := writeYAMLWorkspaceStore(root, readmeTestWorkspaces("notes"), readmeTestCollections(), nil, nil, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	remaining := readmeTestWorkspaces("")[1:]
	if err := writeYAMLWorkspaceStore(root, remaining, readmeTestCollections()[1:], nil, nil, nil, nil); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, fileStoreWorkspacesDir, "Team-API")); !os.IsNotExist(err) {
		t.Fatalf("deleted workspace folder still exists: %v", err)
	}
}

func TestRenamingWorkspaceMovesItsReadme(t *testing.T) {
	root := t.TempDir()
	if err := writeYAMLWorkspaceStore(root, readmeTestWorkspaces("notes"), readmeTestCollections(), nil, nil, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	renamed := readmeTestWorkspaces("notes")
	renamed[0]["name"] = "Billing"
	if err := writeYAMLWorkspaceStore(root, renamed, readmeTestCollections(), nil, nil, nil, nil); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, fileStoreWorkspacesDir, "Billing", workspaceReadmeFile))
	if err != nil || string(data) != "notes\n" {
		t.Fatalf("README.md in renamed folder = %q, %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(root, fileStoreWorkspacesDir, "Team-API")); !os.IsNotExist(err) {
		t.Fatalf("old workspace folder still exists: %v", err)
	}
}

func writeReadmeStore(t *testing.T, root, description string) {
	t.Helper()
	if err := writeYAMLWorkspaceStore(root, readmeTestWorkspaces(description), readmeTestCollections(), nil, nil, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func loadedWorkspace(t *testing.T, root, id string) map[string]any {
	t.Helper()
	workspaces, _, _, _, _, _, err := loadYAMLWorkspaceStoreWithDiagnostics(root, map[string]string{})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	for _, workspace := range workspaces {
		if stringValue(workspace, "id") == id {
			return workspace
		}
	}
	t.Fatalf("workspace %s not loaded", id)
	return nil
}

func TestUnusableReadmeIsFlaggedAndNeverTouched(t *testing.T) {
	cases := map[string]func(t *testing.T, path string){
		"too large": func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte(strings.Repeat("a", workspaceReadmeMaxBytes+1)), 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"binary": func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte{0x89, 'P', 'N', 'G', 0, 0xff, 0xfe}, 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"symlink": func(t *testing.T, path string) {
			target := filepath.Join(t.TempDir(), "outside.md")
			if err := os.WriteFile(target, []byte("outside"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, path); err != nil {
				t.Skip("symlinks unavailable")
			}
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			writeReadmeStore(t, root, "")
			path := filepath.Join(root, fileStoreWorkspacesDir, "Team-API", workspaceReadmeFile)
			setup(t, path)
			before, _ := os.Readlink(path)
			beforeData, _ := os.ReadFile(path)

			workspace := loadedWorkspace(t, root, "w1")
			if stringValue(workspace, workspaceReadmeIssueField) == "" {
				t.Fatalf("no readme issue reported")
			}
			if stringValue(workspace, "description") != "" {
				t.Fatalf("unusable README leaked into the description")
			}

			for _, description := range []string{"", "overwritten"} {
				writeReadmeStore(t, root, description)
				after, _ := os.Readlink(path)
				afterData, err := os.ReadFile(path)
				if err != nil || after != before || string(afterData) != string(beforeData) {
					t.Fatalf("README changed after saving %q: %v", description, err)
				}
			}
			yml, _ := os.ReadFile(filepath.Join(root, fileStoreWorkspacesDir, "Team-API", fileStoreRootFileName))
			if strings.Contains(string(yml), workspaceReadmeIssueField) {
				t.Fatalf("readmeIssue was written to workspace.yml")
			}
		})
	}
}

func TestReadmeKeepsLineEndingsAndBOM(t *testing.T) {
	root := t.TempDir()
	writeReadmeStore(t, root, "")
	path := filepath.Join(root, fileStoreWorkspacesDir, "Team-API", workspaceReadmeFile)
	original := append(append([]byte{}, utf8BOM...), []byte("# Title\r\nline\r\n")...)
	if err := os.WriteFile(path, original, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := stringValue(loadedWorkspace(t, root, "w1"), "description"); got != "# Title\nline\n" {
		t.Fatalf("description = %q", got)
	}
	writeReadmeStore(t, root, "# Title\nline\n")
	if data, _ := os.ReadFile(path); string(data) != string(original) {
		t.Fatalf("unchanged README was rewritten: %q", data)
	}
	writeReadmeStore(t, root, "# Title\nline\nmore")
	want := append(append([]byte{}, utf8BOM...), []byte("# Title\r\nline\r\nmore\r\n")...)
	if data, _ := os.ReadFile(path); string(data) != string(want) {
		t.Fatalf("edited README = %q, want %q", data, want)
	}
}

func TestReadmeNameIsMatchedWithoutCase(t *testing.T) {
	root := t.TempDir()
	writeReadmeStore(t, root, "")
	dir := filepath.Join(root, fileStoreWorkspacesDir, "Team-API")
	if err := os.WriteFile(filepath.Join(dir, "Readme.md"), []byte("lower\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := stringValue(loadedWorkspace(t, root, "w1"), "description"); got != "lower\n" {
		t.Fatalf("description = %q", got)
	}
	writeReadmeStore(t, root, "edited")
	entries, _ := os.ReadDir(dir)
	var readmes []string
	for _, entry := range entries {
		if isWorkspaceReadmeName(entry.Name()) {
			readmes = append(readmes, entry.Name())
		}
	}
	if len(readmes) != 1 {
		t.Fatalf("README files = %v, want one", readmes)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, readmes[0])); string(data) != "edited\n" {
		t.Fatalf("README = %q", data)
	}
}

func TestRenamingWorkspaceMovesAnUnusableReadme(t *testing.T) {
	root := t.TempDir()
	writeReadmeStore(t, root, "")
	big := strings.Repeat("b", workspaceReadmeMaxBytes+10)
	if err := os.WriteFile(filepath.Join(root, fileStoreWorkspacesDir, "Team-API", workspaceReadmeFile), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	renamed := readmeTestWorkspaces("")
	renamed[0]["name"] = "Billing"
	if err := writeYAMLWorkspaceStore(root, renamed, readmeTestCollections(), nil, nil, nil, nil); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, fileStoreWorkspacesDir, "Billing", workspaceReadmeFile))
	if err != nil || string(data) != big {
		t.Fatalf("large README was not moved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, fileStoreWorkspacesDir, "Team-API")); !os.IsNotExist(err) {
		t.Fatalf("old workspace folder still exists: %v", err)
	}
}

func TestWorkspaceReadmeIsAKurloGitFile(t *testing.T) {
	for path, want := range map[string]bool{
		"workspaces/Team-API/README.md":               true,
		"workspaces/Team-API/readme.md":               true,
		"workspaces/Team-API/collections/x/README.md": false,
		"README.md":            false,
		"workspaces/README.md": false,
	} {
		if got := isManagedWorkspaceGitPath("/repo", "/repo", path); got != want {
			t.Errorf("isManagedWorkspaceGitPath(%q) = %v, want %v", path, got, want)
		}
	}
	found := false
	for _, spec := range managedWorkspaceGitPathspecs("/repo", "/repo") {
		if strings.Contains(spec, workspaceReadmeFile) {
			found = true
		}
	}
	if !found {
		t.Fatalf("pathspecs leave README.md out")
	}
}

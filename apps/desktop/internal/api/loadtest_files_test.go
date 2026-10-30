package api

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestPreviewLoadTestDataUsesWorkspacePathsAndLimitsRows(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "users.csv")
	if err := os.WriteFile(path, []byte("email,name\na@test,A\nb@test,B\nc@test,C\nd@test,D\ne@test,E\nf@test,F\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{path, "users.csv"} {
		preview := previewLoadTestData(root, input)
		if preview.Error != "" || preview.Path != "users.csv" || preview.Total != 6 || len(preview.Rows) != 5 || !reflect.DeepEqual(preview.Columns, []string{"email", "name"}) || preview.Rows[0][0] != "a@test" {
			t.Fatalf("unexpected preview: %+v", preview)
		}
	}
}

func TestPreviewLoadTestDataReportsInvalidFiles(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte(`[{"token":"outside"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"broken.json": "[", "empty.csv": "", "users.json": `[{"email":"a@test"},{"name":"B"}]`} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked.json")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{outside, "../outside.json", "linked.json", "broken.json", "empty.csv", "missing.csv", "users.txt"} {
		if preview := previewLoadTestData(root, path); preview.Error == "" || len(preview.Rows) != 0 {
			t.Errorf("%s: expected an error without data, got %+v", path, preview)
		}
	}
	if preview := previewLoadTestData("", "users.json"); preview.Error == "" {
		t.Fatal("expected a workspace error")
	}
	preview := previewLoadTestData(root, "users.json")
	if preview.Error != "" || preview.Total != 2 || len(preview.Columns) != 2 {
		t.Fatalf("unexpected JSON preview: %+v", preview)
	}
}

func TestWriteLoadTestFolderWritesBundleWithoutOverwriting(t *testing.T) {
	parent := t.TempDir()
	files := []model.K6ExportFile{{Path: "script.k6.js", Content: "script"}, {Path: "data.json", Content: "[]"}}
	if err := writeLoadTestFolder(parent, "checkout", files); err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		got, err := os.ReadFile(filepath.Join(parent, "checkout", file.Path))
		if err != nil || string(got) != file.Content {
			t.Fatalf("%s: %q, %v", file.Path, got, err)
		}
	}
	if err := writeLoadTestFolder(parent, "checkout", files); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected existing export error, got %v", err)
	}
	if err := writeLoadTestFolder(parent, "invalid", []model.K6ExportFile{{Path: "../escaped", Content: "bad"}}); err == nil {
		t.Fatal("expected invalid path error")
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 1 {
		t.Fatalf("failed export left files: %v, %v", entries, err)
	}
}

func TestLoadTestFolderAPISavesThePreviewedWorkspaceData(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	root := fileWorkspaceStorePath()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "data", "users.csv")
	if err := os.WriteFile(path, []byte("email\nada@shop.test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	preview := app.PreviewLoadTestData(path)
	if preview.Error != "" || preview.Path != "data/users.csv" || preview.Total != 1 {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	result := app.ExportLoadTestK6Files(exportPayload, false)
	if result.Error != "" || len(result.Files) != 2 {
		t.Fatalf("unexpected export: %+v", result)
	}
	parent := t.TempDir()
	if message := app.SaveLoadTestK6Folder(exportPayload, false, parent); message != "" {
		t.Fatal(message)
	}
	for _, file := range result.Files {
		content, err := os.ReadFile(filepath.Join(parent, "orders-smoke", file.Path))
		if err != nil || string(content) != file.Content || strings.Contains(string(content), "env-secret-token") {
			t.Fatalf("saved export differs from preview or exposes a secret: %s, %v", file.Path, err)
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if message := app.SaveLoadTestK6Folder(exportPayload, false, t.TempDir()); message == "" {
		t.Fatal("missing data must prevent a folder export")
	}
}

package api

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestResolveRequestFilePathJoinsRelativePathsToWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	if got := resolveRequestFilePath(root, "fixtures/photo.png"); got != filepath.Join(root, "fixtures", "photo.png") {
		t.Fatalf("relative path resolved to %q", got)
	}
	absolute := filepath.Join(t.TempDir(), "outside.bin")
	if got := resolveRequestFilePath(root, absolute); got != absolute {
		t.Fatalf("absolute path changed to %q", got)
	}
	if got := resolveRequestFilePath(root, "  "); got != "" {
		t.Fatalf("blank path resolved to %q", got)
	}
	if got := resolveRequestFilePath("", "fixtures/photo.png"); got != filepath.FromSlash("fixtures/photo.png") {
		t.Fatalf("path without root resolved to %q", got)
	}
}

func TestWorkspaceRelativeFilePathKeepsFilesOutsideTheWorkspaceAbsolute(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "fixtures", "photo.png")
	if got, ok := workspaceRelativeFilePath(root, inside); !ok || got != "fixtures/photo.png" {
		t.Fatalf("inside path = %q, %v", got, ok)
	}
	outside := filepath.Join(filepath.Dir(root), "elsewhere.bin")
	if got, ok := workspaceRelativeFilePath(root, outside); ok || got != outside {
		t.Fatalf("outside path = %q, %v", got, ok)
	}
	if _, ok := workspaceRelativeFilePath(root, root); ok {
		t.Fatal("the workspace folder itself is not a file inside it")
	}
}

func TestInspectRequestFileReportsSizeTypeAndWorkspacePath(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "fixtures"), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "fixtures", "photo.png")
	if err := os.WriteFile(file, []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}
	info := inspectRequestFile(root, file)
	if !info.Exists || info.Error != "" {
		t.Fatalf("file should exist: %+v", info)
	}
	if info.Path != "fixtures/photo.png" || !info.InsideWorkspace {
		t.Fatalf("path = %q inside = %v", info.Path, info.InsideWorkspace)
	}
	if info.Name != "photo.png" || info.Size != 5 || info.ContentType != "image/png" {
		t.Fatalf("unexpected details: %+v", info)
	}
	again := inspectRequestFile(root, "fixtures/photo.png")
	if !again.Exists || again.Path != "fixtures/photo.png" || again.AbsolutePath != file {
		t.Fatalf("relative path should inspect the same file: %+v", again)
	}
}

func TestInspectRequestFileReportsMissingFilesAndFolders(t *testing.T) {
	root := t.TempDir()
	missing := inspectRequestFile(root, "fixtures/gone.pdf")
	if missing.Exists || missing.Error != "File not found." || missing.Path != "fixtures/gone.pdf" || missing.ContentType != "application/pdf" {
		t.Fatalf("missing file: %+v", missing)
	}
	folder := inspectRequestFile(root, root)
	if folder.Exists || folder.Error != "This is a folder, not a file." {
		t.Fatalf("folder: %+v", folder)
	}
	empty := inspectRequestFile(root, "")
	if empty.Exists || empty.Error == "" {
		t.Fatalf("empty path: %+v", empty)
	}
}

func TestBinaryAndFormFilesResolveAgainstTheRequestFileRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "fixtures"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "fixtures", "body.bin"), []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	req := model.HttpRequest{Method: "POST", BodyType: "binary", BodyFilePath: "fixtures/body.bin", FileRoot: root}
	body, err := buildRequestBody(req)
	if err != nil {
		t.Fatalf("binary body: %v", err)
	}
	defer body.cleanup()
	data, err := io.ReadAll(body.reader)
	if err != nil || string(data) != "payload" {
		t.Fatalf("binary body = %q, %v", data, err)
	}

	form := model.HttpRequest{Method: "POST", BodyType: "form", FileRoot: root, FormData: []model.KeyValue{{Key: "upload", Value: "fixtures/body.bin", Enabled: true, IsFile: true}}}
	resolved := resolveRequestFilePaths(form)
	if resolved.FormData[0].Value != filepath.Join(root, "fixtures", "body.bin") {
		t.Fatalf("form file = %q", resolved.FormData[0].Value)
	}
	if form.FormData[0].Value != "fixtures/body.bin" {
		t.Fatal("resolving must not change the caller's rows")
	}
	if _, err := buildRequestBody(form); err != nil {
		t.Fatalf("form body: %v", err)
	}
}

package api

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestReadCollectionTextFilesSkipsIgnoredAndSymlinkPaths(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "opencollection.yml"), []byte("info:\n  name: API\n"), 0644); err != nil {
		t.Fatalf("write root file: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "requests"), 0755); err != nil {
		t.Fatalf("create requests dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "requests", "login.bru"), []byte("get {\n  url: https://example.com\n}\n"), 0644); err != nil {
		t.Fatalf("write bru file: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0755); err != nil {
		t.Fatalf("create .git dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "ignored.yml"), []byte("ignore: true\n"), 0644); err != nil {
		t.Fatalf("write ignored file: %v", err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink(filepath.Join(root, "opencollection.yml"), filepath.Join(root, "linked.yml")); err != nil {
			t.Fatalf("create symlink: %v", err)
		}
	}

	files, err := readCollectionTextFilesForRoot(root)
	if err != nil {
		t.Fatalf("read collection files: %v", err)
	}
	var paths []string
	for _, file := range files {
		paths = append(paths, file.Path)
	}
	got := strings.Join(paths, "\n")
	if !strings.Contains(got, "opencollection.yml") || !strings.Contains(got, "requests/login.bru") {
		t.Fatalf("expected collection files, got:\n%s", got)
	}
	if strings.Contains(got, ".git") || strings.Contains(got, "linked.yml") {
		t.Fatalf("ignored or symlink file leaked into import list:\n%s", got)
	}
}

func TestWriteCollectionTextFilesRejectsUnsafePathsAndSymlinkOverwrite(t *testing.T) {
	root := t.TempDir()
	if err := writeCollectionTextFilesForRoot(root, []CollectionTextFile{{Path: "../outside.yml", Content: "bad: true\n"}}); err == nil {
		t.Fatal("expected traversal path to be rejected")
	}

	if runtime.GOOS != "windows" {
		target := filepath.Join(root, "target.yml")
		if err := os.WriteFile(target, []byte("safe: true\n"), 0644); err != nil {
			t.Fatalf("write symlink target: %v", err)
		}
		if err := os.Symlink(target, filepath.Join(root, "linked.yml")); err != nil {
			t.Fatalf("create symlink: %v", err)
		}
		if err := writeCollectionTextFilesForRoot(root, []CollectionTextFile{{Path: "linked.yml", Content: "bad: true\n"}}); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("expected symlink overwrite to be rejected, got %v", err)
		}

		outside := t.TempDir()
		if err := os.Symlink(outside, filepath.Join(root, "linked-folder")); err != nil {
			t.Fatalf("create symlink folder: %v", err)
		}
		err := writeCollectionTextFilesForRoot(root, []CollectionTextFile{{Path: "linked-folder/request.yml", Content: "bad: true\n"}})
		if err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("expected symlink parent to be rejected, got %v", err)
		}
		if _, err := os.Stat(filepath.Join(outside, "request.yml")); !os.IsNotExist(err) {
			t.Fatalf("export wrote through symlink parent, stat err %v", err)
		}
	}

	if err := writeCollectionTextFilesForRoot(root, []CollectionTextFile{{Path: "folder/request.yml", Content: "info:\n  name: Request\n"}}); err != nil {
		t.Fatalf("write valid collection file: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, "folder", "request.yml"))
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if !strings.Contains(string(data), "Request") {
		t.Fatalf("unexpected written content:\n%s", string(data))
	}
}

func TestEnsureWorkspaceGitignoreFollowsTheFilesLineEnding(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".gitignore")
	if err := os.WriteFile(path, []byte(".kurlo-local/\r\n.env\r\n"), 0644); err != nil {
		t.Fatalf("write .gitignore: %v", err)
	}

	if err := ensureWorkspaceGitignore(root); err != nil {
		t.Fatalf("ensure gitignore: %v", err)
	}

	content := readFileString(t, path)
	if strings.Contains(strings.ReplaceAll(content, "\r\n", ""), "\n") {
		t.Fatalf("expected every line to end with CRLF, got %q", content)
	}
	for _, entry := range kurloGitignoreEntries {
		if !strings.Contains(content, entry) {
			t.Fatalf("expected %q to be appended:\n%s", entry, content)
		}
	}
}

func TestEnsureWorkspaceGitignoreKeepsLFWhereItFoundLF(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".gitignore")
	if err := os.WriteFile(path, []byte(".kurlo-local/\n"), 0644); err != nil {
		t.Fatalf("write .gitignore: %v", err)
	}

	if err := ensureWorkspaceGitignore(root); err != nil {
		t.Fatalf("ensure gitignore: %v", err)
	}

	if content := readFileString(t, path); strings.Contains(content, "\r") {
		t.Fatalf("an LF file must stay LF, got %q", content)
	}
}

func TestWriteNewCollectionTextFilesKeepsExistingExportsAndRollsBackErrors(t *testing.T) {
	parent := t.TempDir()
	const requestPath = "postman/collections/api/check.request.yaml"
	files := []CollectionTextFile{{Path: requestPath, Content: "$kind: grpc-request\n"}}
	if err := writeNewCollectionTextFiles(parent, "api", files); err != nil {
		t.Fatal(err)
	}
	if err := writeNewCollectionTextFiles(parent, "api", []CollectionTextFile{{Path: requestPath, Content: "changed"}}); err == nil {
		t.Fatal("expected existing export to be rejected")
	}
	if got := readFileString(t, filepath.Join(parent, "api", filepath.FromSlash(requestPath))); got != files[0].Content {
		t.Fatalf("existing export changed: %q", got)
	}
	badFiles := append(files, CollectionTextFile{Path: "../outside.yaml", Content: "invalid"})
	if err := writeNewCollectionTextFiles(parent, "incomplete", badFiles); err == nil {
		t.Fatal("expected invalid request path to be rejected")
	}
	if _, err := os.Lstat(filepath.Join(parent, "incomplete")); !os.IsNotExist(err) {
		t.Fatalf("incomplete folder remains: %v", err)
	}
	for _, name := range []string{"..", ".", "../outside", `other\folder`, "C:folder"} {
		if err := writeNewCollectionTextFiles(parent, name, files); err == nil {
			t.Fatalf("accepted unsafe export folder name %q", name)
		}
	}
}

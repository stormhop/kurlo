package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImportDialogOptionsFilterBySource(t *testing.T) {
	t.Parallel()

	httpFile := importDialogOptions("httpfile")
	if len(httpFile.Filters) != 1 || httpFile.Filters[0].Pattern != "*.http;*.rest" {
		t.Fatalf("httpfile filters = %+v", httpFile.Filters)
	}
	for _, source := range []string{"postman", "insomnia", "openapi", "asyncapi", "har", "wsdl"} {
		if len(importDialogOptions(source).Filters) != 1 {
			t.Errorf("%s has no filter", source)
		}
	}
	if unknown := importDialogOptions("other"); len(unknown.Filters) != 0 {
		t.Fatalf("unknown source filters = %+v", unknown.Filters)
	}
}

func TestReadImportFile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	httpPath := filepath.Join(dir, "api.http")
	if err := os.WriteFile(httpPath, []byte("GET https://example.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := readImportFile(httpPath)
	if got.Error != "" || got.Name != "api.http" || got.Content != "GET https://example.com\n" || got.Path != httpPath {
		t.Fatalf("read = %+v", got)
	}

	binary := filepath.Join(dir, "logo.png")
	if err := os.WriteFile(binary, []byte{0x89, 0x50, 0xff, 0xfe, 0x00}, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readImportFile(binary); !strings.Contains(got.Error, "not a text file") || got.Content != "" {
		t.Fatalf("binary = %+v", got)
	}
	if got := readImportFile(dir); !strings.Contains(got.Error, "folder") {
		t.Fatalf("dir = %+v", got)
	}
	if got := readImportFile(filepath.Join(dir, "missing.json")); got.Error == "" {
		t.Fatalf("missing = %+v", got)
	}
}

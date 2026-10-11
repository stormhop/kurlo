package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCookieTimestampsStayOutOfWorkspaceFiles(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")

	first := kurloSaveFlowPayload("https://api.example.test", "token", []string{"req-main"}, "abc")
	first = strings.Replace(first, `"session":true}`, `"session":true,"createdAt":1791388997652,"updatedAt":1791388997652}`, 1)
	if err := saveKurloStorePayload(local, root, first); err != nil {
		t.Fatal(err)
	}
	workspaceFile := filepath.Join(root, "workspaces", "Main", "workspace.yml")
	before, err := os.ReadFile(workspaceFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(before), "1791388997652") {
		t.Fatalf("cookie timestamps written to disk:\n%s", before)
	}

	touched := strings.Replace(first, `"updatedAt":1791388997652`, `"updatedAt":1791390576182`, 1)
	if err := saveKurloStorePayload(local, root, touched); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(workspaceFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("a cookie timestamp change rewrote workspace.yml")
	}
	if !strings.Contains(string(after), "sid") {
		t.Fatal("the cookie itself is missing")
	}
}

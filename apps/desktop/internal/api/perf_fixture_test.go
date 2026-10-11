package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPerfFixtureWorkspace(t *testing.T) {
	storePath := os.Getenv("KURLO_PERF_STORE")
	root := os.Getenv("KURLO_PERF_WORKSPACE")
	if storePath == "" || root == "" {
		t.Skip("run through npm run perf:fixtures")
	}
	withRequestStoreTestKey(t)
	payload, err := os.ReadFile(storePath)
	if err != nil {
		t.Fatal(err)
	}
	var source struct {
		Collections      []map[string]any            `json:"collections"`
		Requests         []map[string]any            `json:"requests"`
		Environments     []map[string]any            `json:"environments"`
		WorkspaceCookies map[string][]map[string]any `json:"workspaceCookies"`
	}
	if err := json.Unmarshal(payload, &source); err != nil {
		t.Fatal(err)
	}
	local := filepath.Join(t.TempDir(), "requests.json")
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	if err := saveKurloStorePayload(local, root, string(payload)); err != nil {
		t.Fatalf("write workspace: %v", err)
	}
	t.Logf("perf fixture: wrote %d requests as YAML in %v", len(source.Requests), time.Since(start).Round(time.Millisecond))

	start = time.Now()
	loaded, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	t.Logf("perf fixture: loaded in %v", time.Since(start).Round(time.Millisecond))
	if len(diagnostics) > 0 {
		t.Fatalf("workspace has %d diagnostics, first: %#v", len(diagnostics), diagnostics[0])
	}
	var back struct {
		Collections      []map[string]any            `json:"collections"`
		Requests         []map[string]any            `json:"requests"`
		Environments     []map[string]any            `json:"environments"`
		WorkspaceCookies map[string][]map[string]any `json:"workspaceCookies"`
	}
	if err := json.Unmarshal([]byte(loaded), &back); err != nil {
		t.Fatal(err)
	}
	counts := func(collections, requests, environments int, cookies map[string][]map[string]any) [4]int {
		total := 0
		for _, list := range cookies {
			total += len(list)
		}
		return [4]int{collections, requests, environments, total}
	}
	want := counts(len(source.Collections), len(source.Requests), len(source.Environments), source.WorkspaceCookies)
	got := counts(len(back.Collections), len(back.Requests), len(back.Environments), back.WorkspaceCookies)
	if want != got {
		t.Fatalf("collections/requests/environments/cookies %v after load, want %v", got, want)
	}

	before := workspaceTreeForTest(t, root)
	for path, content := range before {
		if strings.Contains(content, "perf-local-secret") || strings.Contains(content, "createdAt") || strings.Contains(content, "updatedAt") {
			t.Fatalf("%s holds a secret value or a timestamp", path)
		}
	}
	start = time.Now()
	if err := saveKurloStorePayload(local, root, loaded); err != nil {
		t.Fatalf("resave workspace: %v", err)
	}
	t.Logf("perf fixture: resaved unchanged workspace in %v", time.Since(start).Round(time.Millisecond))
	if !reflect.DeepEqual(before, workspaceTreeForTest(t, root)) {
		t.Fatal("saving the loaded workspace rewrote files: the fixture does not match the current format")
	}
	t.Logf("perf fixture: %d files, 0 diagnostics, resave is a no-op", len(before))
}

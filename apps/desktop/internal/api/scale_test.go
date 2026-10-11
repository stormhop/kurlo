package api

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func scaleFixture(total int) crashFixture {
	f := crashFixture{collections: []map[string]any{crashCollection("col-big", "Big")}}
	deep := make([]any, 200)
	for i := range deep {
		deep[i] = fmt.Sprintf("Уровень %d 📁", i)
	}
	for i := 0; i < total; i++ {
		name := "New Request"
		switch i % 4 {
		case 1:
			name = fmt.Sprintf("Заказ №%d 🚀 注文", i)
		case 2:
			name = fmt.Sprintf("request-%d", i)
		}
		request := crashRequest(fmt.Sprintf("big-%05d", i), "col-big", "Big", name, "")
		request["name"] = name
		delete(request, "filesystemName")
		if i%10 == 0 {
			request["folderPath"] = deep
		} else {
			request["folderPath"] = []any{fmt.Sprintf("Папка %d", i%50)}
		}
		f.requests = append(f.requests, request)
	}
	return f
}

func timed(t *testing.T, label string, budget time.Duration, fn func()) {
	t.Helper()
	start := time.Now()
	fn()
	elapsed := time.Since(start)
	t.Logf("%-28s %v", label, elapsed.Round(time.Millisecond))
	if elapsed > budget {
		t.Errorf("%s took %v, budget %v", label, elapsed, budget)
	}
}

func TestTenThousandRequestsWithDeepFoldersAndUnicode(t *testing.T) {
	if testing.Short() {
		t.Skip("writes ten thousand files")
	}
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	fixture := scaleFixture(10000)
	payload := fixture.payload(t)

	timed(t, "first save", 20*time.Second, func() {
		if err := saveKurloStorePayload(local, root, payload); err != nil {
			t.Fatal(err)
		}
	})

	var loadedPayload string
	timed(t, "load", 20*time.Second, func() {
		var diagnostics []WorkspaceDiagnostic
		var err error
		loadedPayload, diagnostics, err = loadKurloStorePayloadWithDiagnostics(local, root)
		if err != nil {
			t.Fatal(err)
		}
		if len(diagnostics) > 0 {
			t.Fatalf("diagnostics: %#v", diagnostics[0])
		}
	})

	var loaded struct {
		Requests []map[string]any `json:"requests"`
	}
	if err := json.Unmarshal([]byte(loadedPayload), &loaded); err != nil {
		t.Fatal(err)
	}
	if len(loaded.Requests) != 10000 {
		t.Fatalf("loaded %d requests, want 10000", len(loaded.Requests))
	}
	byID := map[string]map[string]any{}
	for _, request := range loaded.Requests {
		byID[request["id"].(string)] = request
	}
	for _, want := range fixture.requests {
		got := byID[want["id"].(string)]
		if got == nil || got["name"] != want["name"] {
			t.Fatalf("request %s came back as %#v", want["id"], got)
		}
		wantFolders, _ := json.Marshal(want["folderPath"])
		gotFolders, _ := json.Marshal(got["folderPath"])
		if string(wantFolders) != string(gotFolders) {
			t.Fatalf("request %s folders changed: %s", want["id"], gotFolders)
		}
	}

	before := workspaceTreeForTest(t, root)
	timed(t, "autosave with no changes", 10*time.Second, func() {
		if err := saveKurloStorePayload(local, root, loadedPayload); err != nil {
			t.Fatal(err)
		}
	})
	if len(workspaceTreeForTest(t, root)) != len(before) {
		t.Fatal("unchanged save added or removed files")
	}

	var store map[string]any
	if err := json.Unmarshal([]byte(loadedPayload), &store); err != nil {
		t.Fatal(err)
	}
	storeItem(store, "requests", "big-05000")["url"] = "https://api.example.test/edited"
	edited, _ := json.Marshal(store)
	timed(t, "autosave after one edit", 10*time.Second, func() {
		if err := saveKurloStorePayload(local, root, string(edited)); err != nil {
			t.Fatal(err)
		}
	})
}

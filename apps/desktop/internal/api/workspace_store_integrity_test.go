package api

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func workspaceTreeForTest(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(rel)] = string(data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func replaceWorkspaceTextForTest(t *testing.T, root, path, before, after string) {
	t.Helper()
	path = filepath.Join(root, filepath.FromSlash(path))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), before) {
		t.Fatalf("missing replacement target in %s", path)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(string(data), before, after, 1)), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceIntegrityBlocksInvalidDiskWithoutWriting(t *testing.T) {
	workspace := "workspaces/Main/workspace.yml"
	collection := "workspaces/Main/collections/Core/collection.yml"
	request := "workspaces/Main/collections/Core/requests/Main-request.yml"
	environment := "workspaces/Main/environments/Local.yml"
	for _, tc := range []struct {
		name, path, before, after string
		duplicate                 bool
	}{
		{name: "workspace ID missing", path: workspace, before: "id: workspace-main", after: "id: ''"},
		{name: "collection ID missing", path: collection, before: "id: collection-main", after: "id: ''"},
		{name: "request ID missing", path: request, before: "id: req-main", after: "id: ''"},
		{name: "duplicate workspace", path: workspace, after: "workspaces/Duplicate/workspace.yml", duplicate: true},
		{name: "duplicate collection", path: collection, after: "workspaces/Main/collections/Duplicate/collection.yml", duplicate: true},
		{name: "duplicate request", path: request, after: "workspaces/Main/collections/Core/requests/Duplicate.yml", duplicate: true},
		{name: "duplicate environment", path: environment, after: "workspaces/Main/environments/Duplicate.yml", duplicate: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withRequestStoreTestKey(t)
			dir := t.TempDir()
			root := filepath.Join(dir, "workspace")
			local := filepath.Join(dir, "requests.json")
			payload := kurloSaveFlowPayload("/original", "token-a", []string{"req-main"}, "")
			if err := saveKurloStorePayload(local, root, payload); err != nil {
				t.Fatal(err)
			}
			if tc.duplicate {
				data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(tc.path)))
				if err != nil {
					t.Fatal(err)
				}
				target := filepath.Join(root, filepath.FromSlash(tc.after))
				if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target, data, 0644); err != nil {
					t.Fatal(err)
				}
			} else {
				replaceWorkspaceTextForTest(t, root, tc.path, tc.before, tc.after)
			}
			before := workspaceTreeForTest(t, dir)
			loaded, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
			if err != nil {
				t.Fatal(err)
			}
			if workspaceIntegrityError(diagnostics) == nil {
				t.Fatalf("missing integrity diagnostics: %#v", diagnostics)
			}
			if len(diagnostics) != 1 {
				t.Fatalf("one broken file must produce one issue, got %#v", diagnostics)
			}
			loadedStore, err := decodeJSONMap(loaded)
			if err != nil {
				t.Fatal(err)
			}
			for _, kind := range []string{"workspace", "collection", "request", "environment"} {
				seen := map[string]bool{}
				for _, item := range mapSlice(loadedStore[kind+"s"]) {
					id := stringValue(item, "id")
					if id == "" || seen[id] {
						t.Fatalf("ambiguous ID reached UI: %s %q", kind, id)
					}
					seen[id] = true
				}
			}
			for _, candidate := range []string{payload, loaded} {
				if err := saveKurloStorePayloadPreserving(local, root, candidate, diagnosticPreserveDirs(root, diagnostics)); err == nil {
					t.Fatal("invalid disk was writable")
				}
			}
			if !reflect.DeepEqual(before, workspaceTreeForTest(t, dir)) {
				t.Fatal("loading or rejected save changed files")
			}
		})
	}
}

func TestWorkspaceIntegrityAllowsConsistentExternalChanges(t *testing.T) {
	for _, change := range []string{"name", "rekey"} {
		t.Run(change, func(t *testing.T) {
			withRequestStoreTestKey(t)
			dir := t.TempDir()
			root := filepath.Join(dir, "workspace")
			local := filepath.Join(dir, "requests.json")
			payload := kurloSaveFlowPayload("/original", "token-a", []string{"req-main"}, "")
			if err := saveKurloStorePayload(local, root, payload); err != nil {
				t.Fatal(err)
			}
			if change == "name" {
				replaceWorkspaceTextForTest(t, root, "workspaces/Main/workspace.yml", "name: Main", "name: Renamed")
			} else {
				for path, data := range workspaceTreeForTest(t, root) {
					if strings.HasSuffix(path, ".yml") {
						if err := os.WriteFile(filepath.Join(root, path), []byte(strings.ReplaceAll(data, "workspace-main", "workspace-renamed")), 0644); err != nil {
							t.Fatal(err)
						}
					}
				}
			}
			loaded, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
			if err != nil || len(diagnostics) != 0 {
				t.Fatalf("valid change rejected: %v %#v", err, diagnostics)
			}
			if err := saveKurloStorePayload(local, root, loaded); err != nil {
				t.Fatal(err)
			}
			before := workspaceTreeForTest(t, root)
			if _, moved := before["workspaces/Renamed/workspace.yml"]; change == "name" && !moved {
				t.Fatalf("a renamed workspace must move to its new folder: %v", keysOf(before))
			}
			loaded, _, err = loadKurloStorePayloadWithDiagnostics(local, root)
			if err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 3; i++ {
				if err := saveKurloStorePayload(local, root, loaded); err != nil {
					t.Fatal(err)
				}
				loaded, diagnostics, err = loadKurloStorePayloadWithDiagnostics(local, root)
				if err != nil || len(diagnostics) != 0 {
					t.Fatalf("reload failed: %v %#v", err, diagnostics)
				}
			}
			if !reflect.DeepEqual(before, workspaceTreeForTest(t, root)) {
				t.Fatal("round trip rewrote shared files")
			}
		})
	}
}

func TestWorkspaceIntegrityRejectsInvalidPayloadBeforeCreatingFiles(t *testing.T) {
	dir := t.TempDir()
	local := filepath.Join(dir, "requests.json")
	root := filepath.Join(dir, "workspace")
	payload := strings.Replace(kurloSaveFlowPayload("/test", "", nil, ""), `"workspaceId":"workspace-main"`, `"workspaceId":"missing"`, 1)
	if err := saveKurloStorePayload(local, root, payload); err == nil {
		t.Fatal("orphan payload accepted")
	}
	if len(workspaceTreeForTest(t, dir)) != 0 {
		t.Fatal("rejected payload created files")
	}
}

func TestGitPullChangedWorkspaceIDKeepsFolderContents(t *testing.T) {
	withRequestStoreTestKey(t)
	useTempConfigDir(t, t.TempDir())
	dir, peer := setupGitPullRemoteForTest(t)
	app := NewApp()
	if result := app.openWorkspaceRoot(dir); !result.Ok {
		t.Fatalf("open failed: %s", result.Error)
	}
	replaceWorkspaceTextForTest(t, peer, "workspaces/Main/workspace.yml", "id: workspace-main", "id: workspace-changed")
	runGitForTest(t, peer, "add", "workspaces/Main/workspace.yml")
	runGitForTest(t, peer, "commit", "-m", "Change workspace ID")
	runGitForTest(t, peer, "push")
	result := app.gitPullWorkspace("ff")
	if !result.Ok || len(result.Diagnostics) != 0 {
		t.Fatalf("changed ID must load cleanly: %#v", result)
	}
	store, err := decodeJSONMap(result.Payload)
	if err != nil {
		t.Fatal(err)
	}
	collections := mapSlice(store["collections"])
	if len(collections) == 0 || stringValue(collections[0], "workspaceId") != "workspace-changed" {
		t.Fatalf("collections must follow their folder: %#v", collections)
	}
	if saved := app.SaveRequestStoreWithError(result.Payload); !saved.Ok {
		t.Fatalf("save after changed ID failed: %s", saved.Error)
	}
	collectionFile := readFileForTest(t, filepath.Join(dir, "workspaces", "Main", "collections", "Default", "collection.yml"))
	if !strings.Contains(collectionFile, "workspaceId: workspace-changed") {
		t.Fatalf("save did not update the reference:\n%s", collectionFile)
	}
	if commit := gitCommitWorkspaceForRoot(dir, "Follow workspace ID"); !commit.Ok {
		t.Fatalf("commit failed: %s", commit.Error)
	}
}

func TestWorkspaceIntegrityFollowsFoldersWhenReferencesDisagree(t *testing.T) {
	workspace := "workspaces/Main/workspace.yml"
	collection := "workspaces/Main/collections/Core/collection.yml"
	request := "workspaces/Main/collections/Core/requests/Main-request.yml"
	environment := "workspaces/Main/environments/Local.yml"
	for _, tc := range []struct {
		name, path, before, after string
		workspaceID, collectionID string
	}{
		{name: "workspace ID changed", path: workspace, before: "id: workspace-main", after: "id: workspace-changed", workspaceID: "workspace-changed", collectionID: "collection-main"},
		{name: "collection ID changed", path: collection, before: "id: collection-main", after: "id: collection-changed", workspaceID: "workspace-main", collectionID: "collection-changed"},
		{name: "collection points elsewhere", path: collection, before: "workspaceId: workspace-main", after: "workspaceId: workspace-other", workspaceID: "workspace-main", collectionID: "collection-main"},
		{name: "request points elsewhere", path: request, before: "collectionId: collection-main", after: "collectionId: collection-other", workspaceID: "workspace-main", collectionID: "collection-main"},
		{name: "environment points elsewhere", path: environment, before: "workspaceId: workspace-main", after: "workspaceId: workspace-other", workspaceID: "workspace-main", collectionID: "collection-main"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withRequestStoreTestKey(t)
			dir := t.TempDir()
			root := filepath.Join(dir, "workspace")
			local := filepath.Join(dir, "requests.json")
			if err := saveKurloStorePayload(local, root, kurloSaveFlowPayload("/original", "token-a", []string{"req-main"}, "")); err != nil {
				t.Fatal(err)
			}
			replaceWorkspaceTextForTest(t, root, tc.path, tc.before, tc.after)
			loaded, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
			if err != nil || len(diagnostics) != 0 {
				t.Fatalf("reference mismatch must not block: %v %#v", err, diagnostics)
			}
			store, err := decodeJSONMap(loaded)
			if err != nil {
				t.Fatal(err)
			}
			for _, item := range append(mapSlice(store["collections"]), mapSlice(store["environments"])...) {
				if stringValue(item, "workspaceId") != tc.workspaceID {
					t.Fatalf("item left its workspace folder: %#v", item)
				}
			}
			for _, item := range mapSlice(store["requests"]) {
				if stringValue(item, "collectionId") != tc.collectionID {
					t.Fatalf("request left its collection folder: %#v", item)
				}
			}
			workspaces := mapSlice(store["workspaces"])
			workspaces[0]["name"] = "Edited"
			edited, err := json.Marshal(store)
			if err != nil {
				t.Fatal(err)
			}
			if err := saveKurloStorePayload(local, root, string(edited)); err != nil {
				t.Fatal(err)
			}
			settled := workspaceTreeForTest(t, root)
			for path, data := range settled {
				if strings.Contains(data, "workspace-other") || strings.Contains(data, "collection-other") {
					t.Fatalf("stale reference kept in %s", path)
				}
			}
			reloaded, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
			if err != nil || len(diagnostics) != 0 {
				t.Fatalf("reload failed: %v %#v", err, diagnostics)
			}
			if err := saveKurloStorePayload(local, root, reloaded); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(settled, workspaceTreeForTest(t, root)) {
				t.Fatal("second save rewrote files")
			}
		})
	}
}

func TestWorkspaceIntegrityReportsCopiedFolderOnce(t *testing.T) {
	for _, folder := range []string{"workspaces/Main", "workspaces/Main/collections/Core"} {
		t.Run(folder, func(t *testing.T) {
			withRequestStoreTestKey(t)
			dir := t.TempDir()
			root := filepath.Join(dir, "workspace")
			local := filepath.Join(dir, "requests.json")
			if err := saveKurloStorePayload(local, root, kurloSaveFlowPayload("/original", "", []string{"req-main"}, "")); err != nil {
				t.Fatal(err)
			}
			source := filepath.Join(root, filepath.FromSlash(folder))
			copied := source + "-copy"
			for path, data := range workspaceTreeForTest(t, source) {
				target := filepath.Join(copied, path)
				if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target, []byte(data), 0644); err != nil {
					t.Fatal(err)
				}
			}
			loaded, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
			if err != nil {
				t.Fatal(err)
			}
			store, err := decodeJSONMap(loaded)
			if err != nil {
				t.Fatal(err)
			}
			for _, kind := range []string{"workspaces", "collections", "requests"} {
				if items := mapSlice(store[kind]); len(items) != 1 {
					t.Fatalf("original %s must stay and the copy must be dropped: %#v", kind, items)
				}
			}
			if len(diagnostics) != 1 || !strings.HasSuffix(diagnostics[0].Path, "-copy/"+filepath.Base(diagnostics[0].Path)) {
				t.Fatalf("copied folder must be one issue on the copy: %#v", diagnostics)
			}
			if !strings.Contains(diagnostics[0].Message, "looks like a copy") {
				t.Fatalf("unexpected message: %s", diagnostics[0].Message)
			}
		})
	}
}

func TestWorkspaceIntegrityDetectsMissingParentFiles(t *testing.T) {
	for _, path := range []string{"kurlo.yml", "workspaces/Main/workspace.yml", "workspaces/Main/collections/Core/collection.yml"} {
		t.Run(path, func(t *testing.T) {
			withRequestStoreTestKey(t)
			dir := t.TempDir()
			root := filepath.Join(dir, "workspace")
			local := filepath.Join(dir, "requests.json")
			original := kurloSaveFlowPayload("/original", "", nil, "")
			if err := saveKurloStorePayload(local, root, original); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(filepath.Join(root, filepath.FromSlash(path))); err != nil {
				t.Fatal(err)
			}
			before := workspaceTreeForTest(t, dir)
			_, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
			if err != nil {
				t.Fatal(err)
			}
			if workspaceIntegrityError(diagnostics) == nil {
				t.Fatalf("missing parent not detected: %#v", diagnostics)
			}
			if err := saveKurloStorePayload(local, root, original); err == nil {
				t.Fatal("save recreated missing parent")
			}
			if !reflect.DeepEqual(before, workspaceTreeForTest(t, dir)) {
				t.Fatal("missing parent's children changed")
			}
		})
	}
}

func TestWorkspaceIntegrityDetectsExampleReferencesAndDuplicates(t *testing.T) {
	for _, change := range []string{"duplicate", "missing body", "missing request", "invalid YAML"} {
		t.Run(change, func(t *testing.T) {
			withRequestStoreTestKey(t)
			dir := t.TempDir()
			root := filepath.Join(dir, "workspace")
			local := filepath.Join(dir, "requests.json")
			original := exampleStorePayload(t, createdExample)
			if err := saveKurloStorePayload(local, root, original); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(exampleDirFor(root), "created.yml")
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if change == "missing body" {
				writeLegacyExampleBodyForTest(t, root, "created.body.json", "")
			} else if change == "missing request" {
				if err := os.Remove(filepath.Join(root, "workspaces", "Main", "collections", "Core", "requests", "Create-order.yml")); err != nil {
					t.Fatal(err)
				}
			} else if change == "invalid YAML" {
				if err := os.WriteFile(path, []byte("example: ["), 0644); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(filepath.Join(exampleDirFor(root), "duplicate.yml"), data, 0644); err != nil {
					t.Fatal(err)
				}
			}
			before := workspaceTreeForTest(t, dir)
			loaded, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
			if err != nil {
				t.Fatal(err)
			}
			if workspaceIntegrityError(diagnostics) == nil {
				t.Fatalf("invalid example not detected: %#v", diagnostics)
			}
			if err := saveKurloStorePayload(local, root, loaded); err == nil {
				t.Fatal("invalid example saved")
			}
			if !reflect.DeepEqual(before, workspaceTreeForTest(t, dir)) {
				t.Fatal("example files changed")
			}
		})
	}
}

func TestWorkspaceIDChangedAndRestoredLeavesNoDiff(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	if err := saveKurloStorePayload(local, root, kurloSaveFlowPayload("/original", "token-a", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	original := workspaceTreeForTest(t, root)
	collection := "workspaces/Main/collections/Core/collection.yml"
	replaceWorkspaceTextForTest(t, root, collection, "collection:", "# owned by the payments team\ncollection:")
	commented := workspaceTreeForTest(t, root)

	replaceWorkspaceTextForTest(t, root, "workspaces/Main/workspace.yml", "id: workspace-main", "id: workspace-main2222")
	if _, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root); err != nil || len(diagnostics) != 0 {
		t.Fatalf("changed ID must load: %v %#v", err, diagnostics)
	}
	changed := workspaceTreeForTest(t, root)
	for _, path := range []string{collection, "workspaces/Main/environments/Local.yml"} {
		if !strings.Contains(changed[path], "workspaceId: workspace-main2222") {
			t.Fatalf("load must update the reference in %s:\n%s", path, changed[path])
		}
	}
	if !strings.Contains(changed["kurlo.yml"], "- workspace-main2222") {
		t.Fatalf("workspace order must follow the new ID:\n%s", changed["kurlo.yml"])
	}
	if !strings.Contains(changed[collection], "# owned by the payments team") {
		t.Fatalf("repair must keep comments:\n%s", changed[collection])
	}

	replaceWorkspaceTextForTest(t, root, "workspaces/Main/workspace.yml", "id: workspace-main2222", "id: workspace-main")
	if _, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root); err != nil || len(diagnostics) != 0 {
		t.Fatalf("restored ID must load: %v %#v", err, diagnostics)
	}
	if !reflect.DeepEqual(commented, workspaceTreeForTest(t, root)) {
		t.Fatal("restoring the ID must leave the files exactly as before")
	}
	replaceWorkspaceTextForTest(t, root, collection, "# owned by the payments team\ncollection:", "collection:")
	if !reflect.DeepEqual(original, workspaceTreeForTest(t, root)) {
		t.Fatal("unexpected leftover changes")
	}
}

func TestReferenceRepairWaitsForBrokenFiles(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	if err := saveKurloStorePayload(local, root, kurloSaveFlowPayload("/original", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	replaceWorkspaceTextForTest(t, root, "workspaces/Main/workspace.yml", "id: workspace-main", "id: workspace-main2222\n    oops")
	before := workspaceTreeForTest(t, root)
	if _, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root); err != nil || len(diagnostics) != 1 {
		t.Fatalf("expected the syntax error: %v %#v", err, diagnostics)
	}
	if !reflect.DeepEqual(before, workspaceTreeForTest(t, root)) {
		t.Fatal("files under an unreadable workspace.yml must not be touched")
	}
}

func TestInterruptedSaveNeverLeavesABlockedWorkspace(t *testing.T) {
	withRequestStoreTestKey(t)
	payload := exampleStorePayload(t, createdExample)
	t.Cleanup(func() { beforeYAMLWrite = nil })
	for cut := 1; ; cut++ {
		dir := t.TempDir()
		root := filepath.Join(dir, "workspace")
		local := filepath.Join(dir, "requests.json")
		writes := 0
		beforeYAMLWrite = func(string) error {
			writes++
			if writes > cut {
				return errors.New("power cut")
			}
			return nil
		}
		err := saveKurloStorePayload(local, root, payload)
		beforeYAMLWrite = nil
		if err == nil {
			if cut < 3 {
				t.Fatalf("save finished after only %d files", cut)
			}
			return
		}
		_, diagnostics, loadErr := loadKurloStorePayloadWithDiagnostics(local, root)
		if loadErr != nil && hasYAMLWorkspaceStore(root) {
			t.Fatalf("save cut after %d files: load failed: %v", cut, loadErr)
		}
		if workspaceIntegrityError(diagnostics) != nil {
			t.Fatalf("save cut after %d files leaves a blocked workspace: %#v", cut, diagnostics)
		}
	}
}

func TestWorkspaceIDChangeKeepsWorkspaceOrder(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	store, err := decodeJSONMap(kurloSaveFlowPayload("/original", "", []string{"req-main"}, ""))
	if err != nil {
		t.Fatal(err)
	}
	store["workspaces"] = append(mapSlice(store["workspaces"]), map[string]any{"id": "workspace-second", "name": "Second", "filesystemName": "Second"})
	initial, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveKurloStorePayload(local, root, string(initial)); err != nil {
		t.Fatal(err)
	}
	original := workspaceTreeForTest(t, root)
	if !strings.Contains(original["kurlo.yml"], "- workspace-main\n    - workspace-second") {
		t.Fatalf("fixture order:\n%s", original["kurlo.yml"])
	}
	for _, id := range []string{"workspace-main2222", "workspace-main"} {
		current := map[string]string{"workspace-main2222": "workspace-main", "workspace-main": "workspace-main2222"}[id]
		replaceWorkspaceTextForTest(t, root, "workspaces/Main/workspace.yml", "id: "+current+"\n", "id: "+id+"\n")
		payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
		if err != nil || len(diagnostics) != 0 {
			t.Fatalf("load: %v %#v", err, diagnostics)
		}
		if err := saveKurloStorePayload(local, root, payload); err != nil {
			t.Fatal(err)
		}
		if order := workspaceTreeForTest(t, root)["kurlo.yml"]; !strings.Contains(order, "- "+id+"\n    - workspace-second") {
			t.Fatalf("the renamed workspace must keep its place:\n%s", order)
		}
	}
	if !reflect.DeepEqual(original, workspaceTreeForTest(t, root)) {
		t.Fatal("changing the ID and back must leave no diff")
	}
}

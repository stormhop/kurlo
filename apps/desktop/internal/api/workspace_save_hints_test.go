package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"gopkg.in/yaml.v3"
)

func saveFlowStoreForTest(t *testing.T) map[string]any {
	t.Helper()
	var store map[string]any
	if err := json.Unmarshal([]byte(kurloSaveFlowPayload("https://api.example.test/v1", "main-bearer", []string{"req-main"}, "sid-cookie")), &store); err != nil {
		t.Fatal(err)
	}
	return store
}

func saveAppStoreForTest(t *testing.T, app *App, store map[string]any, step string) {
	t.Helper()
	payload, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	if result := app.SaveRequestStoreWithError(string(payload)); !result.Ok {
		t.Fatalf("%s: save: %s", step, result.Error)
	}
}

func forgetWorkspaceDiskState() {
	workspaceDisk.mu.Lock()
	workspaceDisk.known, workspaceDisk.savedSegments = nil, nil
	workspaceDisk.mu.Unlock()
}

func workspaceDirsForTest(t *testing.T, root string) []string {
	t.Helper()
	var dirs []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && path != root {
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			dirs = append(dirs, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return dirs
}

func workspaceTreesForOps(t *testing.T, cached bool) []map[string]string {
	t.Helper()
	app, root := appWorkspaceForTest(t)
	store := saveFlowStoreForTest(t)
	var trees []map[string]string
	for _, op := range restartOps() {
		op.apply(store)
		if cached {
			if workspaceDisk.saveHints(root).disk == nil {
				t.Fatalf("%s: the save before this step should have left the disk state for the next one", op.name)
			}
		} else {
			forgetWorkspaceDiskState()
		}
		saveAppStoreForTest(t, app, store, op.name)
		scanned, err := scanWorkspaceFiles(root, nil, true)
		if err != nil {
			t.Fatalf("%s: scan: %v", op.name, err)
		}
		if known := workspaceDisk.knownFor(root); !reflect.DeepEqual(known, scanned) {
			t.Fatalf("%s: the snapshot after the save differs from the disk\nremembered: %v\non disk:    %v", op.name, known, scanned)
		}
		tree := workspaceTreeForTest(t, root)
		for _, dir := range workspaceDirsForTest(t, root) {
			tree[dir+"/"] = "dir"
		}
		trees = append(trees, tree)
		if cached {
			onDisk, err := inspectWorkspaceStoreOnDisk(root)
			if err != nil {
				t.Fatalf("%s: inspect: %v", op.name, err)
			}
			if remembered := workspaceDisk.saveHints(root).disk; !reflect.DeepEqual(remembered, onDisk) {
				t.Fatalf("%s: remembered file names differ from the disk\nremembered: %v\non disk:    %v", op.name, remembered, onDisk)
			}
		}
	}
	return trees
}

func TestSavesFromTheRememberedDiskStateWriteTheSameFiles(t *testing.T) {
	cached := workspaceTreesForOps(t, true)
	full := workspaceTreesForOps(t, false)
	ops := restartOps()
	for i := range ops {
		if reflect.DeepEqual(cached[i], full[i]) {
			continue
		}
		for path, content := range full[i] {
			if cached[i][path] != content {
				t.Errorf("%s: %s differs\n--- full save\n%s\n--- remembered state\n%s", ops[i].name, path, content, cached[i][path])
			}
		}
		for path := range cached[i] {
			if _, ok := full[i][path]; !ok {
				t.Errorf("%s: %s exists only after the remembered-state save", ops[i].name, path)
			}
		}
		t.FailNow()
	}
}

func TestAFileWithAKnownHashIsNeitherReadNorRewritten(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request.yml")
	if err := os.WriteFile(path, []byte("on disk\n"), 0644); err != nil {
		t.Fatal(err)
	}
	value := map[string]any{"name": "Saved"}
	data, err := yaml.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}

	journal := &saveJournal{root: filepath.Dir(path), known: map[string]string{path: contentHash(data)}}
	if err := writeCanonicalYAMLFile(path, value, journal, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != "on disk\n" {
		t.Fatalf("a file whose hash is known to match should be skipped without reading it, got:\n%s", got)
	}

	journal.known[path] = "other"
	if err := writeCanonicalYAMLFile(path, value, journal, nil); err != nil {
		t.Fatal(err)
	}
	journal.close()
	if got, _ := os.ReadFile(path); string(got) != string(data) {
		t.Fatalf("a file whose hash differs should be written, got:\n%s", got)
	}
}

func TestAFileChangedOutsideKurloIsReadBeforeTheNextSave(t *testing.T) {
	app, root := appWorkspaceForTest(t)
	store := saveFlowStoreForTest(t)
	saveAppStoreForTest(t, app, store, "first")
	if workspaceDisk.saveHints(root).disk == nil {
		t.Fatal("a healthy save should leave the disk state for the next one")
	}
	broken := filepath.Join(root, "workspaces", "Main", "collections", "Core", "requests", "Broken.yml")
	if err := os.WriteFile(broken, []byte("version: 1\nrequest: [unclosed\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, external, err := workspaceDisk.externalChanges(root); err != nil || len(external) == 0 {
		t.Fatalf("the broken file should count as an outside change: %v %v", external, err)
	}

	storeItem(store, "requests", "req-main")["url"] = "https://api.example.test/v2"
	payload, _ := json.Marshal(store)
	app.SaveRequestStoreWithError(string(payload))

	if _, err := os.Stat(broken); err != nil {
		t.Fatalf("a file Kurlo cannot read must be left alone: %v", err)
	}
	if workspaceDisk.saveHints(root).disk != nil {
		t.Fatal("a workspace with a broken file should not be saved from remembered state")
	}
}

func TestLegacyWorkspaceRowsKeepCommentedFilesByteForByte(t *testing.T) {
	const legacyRows = `[{key: X-On, value: on, enabled: true, description: ""}, {key: X-Off, value: off, enabled: false}]`
	rows := []any{
		map[string]any{"key": "X-On", "value": "on"},
		map[string]any{"key": "X-Off", "value": "off", "enabled": false},
	}
	for _, tc := range []struct {
		name   string
		source string
		value  any
	}{
		{
			name:   "environment",
			source: "version: 1\nenvironment:\n  id: env\n  values: " + legacyRows + " # keep\n",
			value:  filesystemEnvironmentFile{Version: fileStoreVersion, Environment: map[string]any{"id": "env", "values": rows}},
		},
		{
			name:   "collection",
			source: "version: 1\ncollection:\n  id: col\n  defaults:\n    headers: " + legacyRows + " # keep\n",
			value: filesystemCollectionFile{Version: fileStoreVersion, Collection: map[string]any{
				"id": "col", "defaults": map[string]any{"headers": rows},
			}},
		},
		{
			name:   "example",
			source: "version: 1\nexample:\n  id: saved\n  response:\n    headers: " + legacyRows + " # keep\n",
			value: filesystemExampleFile{Version: fileStoreVersion, Example: map[string]any{
				"id": "saved", "response": map[string]any{"headers": rows},
			}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), tc.name+".yml")
			if err := os.WriteFile(path, []byte(tc.source), 0644); err != nil {
				t.Fatal(err)
			}
			journal := &saveJournal{root: filepath.Dir(path)}
			if err := writeCanonicalYAMLFile(path, tc.value, journal, nil); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.source {
				t.Fatalf("unchanged legacy file was rewritten:\n%s", got)
			}
			journal.close()
		})
	}
}

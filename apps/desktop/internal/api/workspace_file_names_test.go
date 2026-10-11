package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestFileNameForName(t *testing.T) {
	for name, want := range map[string]string{
		"Общий":              "Obshchiy",
		"Ёжик в тумане":      "Yozhik-v-tumane",
		"Щука и Ясень":       "Shchuka-i-Yasen",
		"Café déjà vu":       "Cafe-deja-vu",
		"Get /users/{id}":    "Get-users-id",
		"Ґанок і Їжак":       "Ganok-i-Yizhak",
		"CON":                "CON-item",
		"   ":                "",
		"日本語":                "item",
		"environment/update": "environment-update",
	} {
		if got := fileNameForName(name); got != want {
			t.Errorf("fileNameForName(%q) = %q, want %q", name, got, want)
		}
	}
}

func saveStoreForTest(t *testing.T, local, root string, store map[string]any) {
	t.Helper()
	payload, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveKurloStorePayload(local, root, string(payload)); err != nil {
		t.Fatal(err)
	}
}

func loadStoreForTest(t *testing.T, local, root string) map[string]any {
	t.Helper()
	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("load: %v %#v", err, diagnostics)
	}
	store, err := decodeJSONMap(payload)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestRenamingInTheAppMovesFilesAndFolders(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	if err := saveKurloStorePayload(local, root, exampleStorePayload(t, createdExample)); err != nil {
		t.Fatal(err)
	}
	store := loadStoreForTest(t, local, root)
	mapSlice(store["workspaces"])[0]["name"] = "Платежи"
	mapSlice(store["collections"])[0]["name"] = "EF"
	mapSlice(store["requests"])[0]["name"] = "Общий"
	saveStoreForTest(t, local, root, store)

	tree := workspaceTreeForTest(t, root)
	for _, path := range []string{
		"workspaces/Platezhi/workspace.yml",
		"workspaces/Platezhi/collections/EF/collection.yml",
		"workspaces/Platezhi/collections/EF/requests/Obshchiy.yml",
		"workspaces/Platezhi/collections/EF/examples/Obshchiy/created.yml",
	} {
		if _, ok := tree[path]; !ok {
			t.Errorf("missing %s after rename; files: %v", path, keysOf(tree))
		}
	}
	for path := range tree {
		if strings.Contains(path, "Main") || strings.Contains(path, "Core") || strings.Contains(path, "Create-order") {
			t.Errorf("old path left behind: %s", path)
		}
	}
	saveStoreForTest(t, local, root, loadStoreForTest(t, local, root))
	if !reflect.DeepEqual(tree, workspaceTreeForTest(t, root)) {
		t.Fatal("a save without renames moved files")
	}
}

func TestOlderPathsAndNamesEditedInYAMLAreBroughtInLineOnSave(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	if err := saveKurloStorePayload(local, root, kurloSaveFlowPayload("/x", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	replaceWorkspaceTextForTest(t, root, "workspaces/Main/collections/Core/collection.yml", "name: Core", "name: EF")
	replaceWorkspaceTextForTest(t, root, "workspaces/Main/collections/Core/requests/Main-request.yml", "name: Main request", "name: Общий")
	before := workspaceTreeForTest(t, root)
	store := loadStoreForTest(t, local, root)
	if !reflect.DeepEqual(before, workspaceTreeForTest(t, root)) {
		t.Fatal("loading must not move files; only a save does")
	}
	saveStoreForTest(t, local, root, store)
	if _, err := os.Stat(filepath.Join(root, "workspaces", "Main", "collections", "EF", "requests", "Obshchiy.yml")); err != nil {
		t.Fatalf("paths were not brought in line: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "workspaces", "Main", "collections", "Core")); !os.IsNotExist(err) {
		t.Fatalf("old folder left behind: %v", err)
	}
	settled := workspaceTreeForTest(t, root)
	saveStoreForTest(t, local, root, loadStoreForTest(t, local, root))
	if !reflect.DeepEqual(settled, workspaceTreeForTest(t, root)) {
		t.Fatal("a second save moved files again")
	}
}

func TestDuplicateNamesKeepTheirNumberedFiles(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	if err := saveKurloStorePayload(local, root, kurloSaveFlowPayload("/x", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	store := loadStoreForTest(t, local, root)
	requests := mapSlice(store["requests"])
	for _, id := range []string{"req-b", "req-c"} {
		twin := cloneMap(requests[0])
		twin["id"] = id
		requests = append(requests, twin)
	}
	store["requests"] = requests
	saveStoreForTest(t, local, root, store)
	settled := workspaceTreeForTest(t, root)
	reordered := loadStoreForTest(t, local, root)
	list := mapSlice(reordered["requests"])
	list[0], list[2] = list[2], list[0]
	reordered["requests"] = list
	saveStoreForTest(t, local, root, reordered)
	after := workspaceTreeForTest(t, root)
	for path := range settled {
		if strings.HasSuffix(path, ".yml") && strings.Contains(path, "requests") {
			if _, ok := after[path]; !ok {
				t.Fatalf("reordering requests with the same name moved %s", path)
			}
		}
	}
}

func TestNewItemsAvoidNamesTakenOnDiskIgnoringCase(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	if err := saveKurloStorePayload(local, root, kurloSaveFlowPayload("/x", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	store := loadStoreForTest(t, local, root)
	requests := mapSlice(store["requests"])
	twin := cloneMap(requests[0])
	twin["id"], twin["name"] = "req-twin", "MAIN REQUEST"
	delete(twin, "filesystemName")
	store["requests"] = append(requests, twin)
	saveStoreForTest(t, local, root, store)
	dir2 := filepath.Join(root, "workspaces", "Main", "collections", "Core", "requests")
	for _, name := range []string{"Main-request.yml", "MAIN-REQUEST-1.yml"} {
		if _, err := os.Stat(filepath.Join(dir2, name)); err != nil {
			t.Errorf("expected %s: %v", name, err)
		}
	}
}

func TestFileNamesStayPutWhileAFileIsBroken(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	local := filepath.Join(dir, "requests.json")
	if err := saveKurloStorePayload(local, root, kurloSaveFlowPayload("/x", "", []string{"req-main"}, "")); err != nil {
		t.Fatal(err)
	}
	requests := filepath.Join(root, "workspaces", "Main", "collections", "Core", "requests")
	if err := os.WriteFile(filepath.Join(requests, "Broken.yml"), []byte("version: 1\nrequest: [\n"), 0644); err != nil {
		t.Fatal(err)
	}
	payload, diagnostics, err := loadKurloStorePayloadWithDiagnostics(local, root)
	if err != nil {
		t.Fatal(err)
	}
	store, _ := decodeJSONMap(payload)
	mapSlice(store["collections"])[0]["name"] = "Renamed"
	edited, _ := json.Marshal(store)
	if err := saveKurloStorePayloadPreserving(local, root, string(edited), diagnosticPreserveDirs(root, diagnostics)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(requests, "Broken.yml")); err != nil {
		t.Fatalf("the broken file must stay where it is: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "workspaces", "Main", "collections", "Core", "collection.yml")); err != nil {
		t.Fatalf("the folder holding a broken file must not move: %v", err)
	}
}

func keysOf(tree map[string]string) []string {
	var keys []string
	for key := range tree {
		keys = append(keys, key)
	}
	return keys
}

func TestPulledRenameMovesTheFolderOnTheNextSave(t *testing.T) {
	withRequestStoreTestKey(t)
	useTempConfigDir(t, t.TempDir())
	dir, peer := setupGitPullRemoteForTest(t)
	app := NewApp()
	if result := app.openWorkspaceRoot(dir); !result.Ok {
		t.Fatalf("open failed: %s", result.Error)
	}
	collection := filepath.ToSlash(filepath.Join("workspaces", "Main", "collections", "Default", "collection.yml"))
	data := readFileForTest(t, filepath.Join(peer, filepath.FromSlash(collection)))
	nameLine := ""
	for _, line := range strings.Split(data, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "name: ") {
			nameLine = line
			break
		}
	}
	if nameLine == "" {
		t.Fatalf("fixture has no name line:\n%s", data)
	}
	replaceWorkspaceTextForTest(t, peer, collection, nameLine, strings.Repeat(" ", len(nameLine)-len(strings.TrimLeft(nameLine, " ")))+"name: Платежи")
	runGitForTest(t, peer, "add", "-A")
	runGitForTest(t, peer, "commit", "-m", "Rename collection")
	runGitForTest(t, peer, "push")

	pulled := app.gitPullWorkspace("ff")
	if !pulled.Ok {
		t.Fatalf("pull failed: %s", pulled.Error)
	}
	if status := gitStatusForWorkspace(dir); !status.Clean {
		t.Fatalf("a pull must not move files by itself: %#v", status.Files)
	}
	if saved := app.SaveRequestStoreWithError(pulled.Payload); !saved.Ok {
		t.Fatalf("save failed: %s", saved.Error)
	}
	status := gitStatusForWorkspace(dir)
	var changed []string
	for _, file := range status.Files {
		changed = append(changed, file.Status+" "+file.Path)
	}
	joined := strings.Join(changed, "\n")
	if !strings.Contains(joined, "collections/Default/collection.yml") || !strings.Contains(joined, "collections/Platezhi/") {
		t.Fatalf("the save should move Default to Platezhi and show it as changes:\n%s", joined)
	}
}

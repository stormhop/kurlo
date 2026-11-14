package api

import (
	"encoding/json"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"testing"
)

func roundTripThroughAppStore(t *testing.T, frontend, payload string) map[string]any {
	t.Helper()
	dir := t.TempDir()
	in, out := filepath.Join(dir, "in.json"), filepath.Join(dir, "out.json")
	if err := os.WriteFile(in, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("npx", "playwright", "test", "e2e/workspace.spec.ts", "-g", "real workspace round trip", "--project=chromium", "--workers=1")
	cmd.Dir = frontend
	cmd.Env = append(os.Environ(), "HOME="+t.TempDir(), "KURLO_ROUNDTRIP_IN="+in, "KURLO_ROUNDTRIP_OUT="+out)
	if os.Getenv("PLAYWRIGHT_BROWSERS_PATH") == "" {
		if account, err := user.Current(); err == nil {
			cache := filepath.Join(account.HomeDir, ".cache")
			switch runtime.GOOS {
			case "darwin":
				cache = filepath.Join(account.HomeDir, "Library", "Caches")
			case "windows":
				cache = filepath.Join(account.HomeDir, "AppData", "Local")
			}
			cmd.Env = append(cmd.Env, "PLAYWRIGHT_BROWSERS_PATH="+filepath.Join(cache, "ms-playwright"))
		}
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("round trip: %v\n%s", err, output)
	}
	saved, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	store, err := decodeJSONMap(string(saved))
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestTheAppStoreKeepsTheLoadedShapeForTheDelta(t *testing.T) {
	frontend := os.Getenv("KURLO_ROUNDTRIP_FRONTEND")
	if frontend == "" {
		t.Skip("set KURLO_ROUNDTRIP_FRONTEND to the frontend directory")
	}
	stores := map[string]map[string]any{"save flow": saveFlowStoreForTest(t), "imported": scaleWorkspaceStore(40)}
	if copy := os.Getenv("KURLO_ROUNDTRIP_WORKSPACE"); copy != "" {
		stores["copy of "+filepath.Base(copy)] = nil
	}
	for name, store := range stores {
		t.Run(name, func(t *testing.T) {
			app, _ := appWorkspaceForTest(t)
			asIs := store == nil
			if asIs {
				root := fileWorkspaceStorePath()
				if err := os.RemoveAll(root); err != nil {
					t.Fatal(err)
				}
				if err := os.CopyFS(root, os.DirFS(os.Getenv("KURLO_ROUNDTRIP_WORKSPACE"))); err != nil {
					t.Fatal(err)
				}
				workspaceDisk.remember(root)
				loadedRequestExamples.forget(root)
			} else {
				encoded, err := json.Marshal(store)
				if err != nil {
					t.Fatal(err)
				}
				if result := app.SaveRequestStoreWithError(string(encoded)); !result.Ok {
					t.Fatal(result.Error)
				}
				written, err := json.Marshal(roundTripThroughAppStore(t, frontend, app.LoadWorkspace().Payload))
				if err != nil {
					t.Fatal(err)
				}
				if result := app.SaveRequestStoreWithError(string(written)); !result.Ok {
					t.Fatal(result.Error)
				}
			}
			loaded := app.LoadWorkspace()
			if loaded.Revision == 0 {
				t.Fatal("no revision after load")
			}
			fromApp := roundTripThroughAppStore(t, frontend, loaded.Payload)
			fromLoad, _ := decodeJSONMap(loaded.Payload)
			want, got := storeShapeFromPayload(fromLoad), storeShapeFromPayload(fromApp)
			if got.workspaces != want.workspaces {
				t.Fatalf("workspaces on disk differ\n load: %s\n  app: %s", want.workspaces, got.workspaces)
			}
			if got.collections != want.collections {
				t.Fatalf("collections on disk differ\n load: %s\n  app: %s", want.collections, got.collections)
			}
			if !sameStringList(got.requestOrder, want.requestOrder) || !sameStringList(got.environmentOrder, want.environmentOrder) {
				t.Fatalf("order differs\n load: %v %v\n  app: %v %v", want.requestOrder, want.environmentOrder, got.requestOrder, got.environmentOrder)
			}
			requests := mapSlice(fromApp["requests"])
			ids := make([]string, 0, len(requests))
			for _, request := range requests {
				ids = append(ids, stringValue(request, "id"))
			}
			delete(fromApp, "requests")
			delta, _ := json.Marshal(map[string]any{"base": loaded.Revision, "store": fromApp, "requestIds": ids, "requests": requests[:1]})
			if result := app.SaveRequestStoreDelta(string(delta)); !result.Ok || result.NeedFull {
				t.Fatalf("the first save after loading should be a delta: %+v", result)
			}
		})
	}
}

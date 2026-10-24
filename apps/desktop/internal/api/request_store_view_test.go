package api

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type viewFields struct {
	ActiveID          string   `json:"activeId"`
	ActiveWorkspaceID string   `json:"activeWorkspaceId"`
	OpenIDs           []string `json:"openIds"`
}

func loadedViewForTest(t *testing.T, app *App) viewFields {
	t.Helper()
	payload := app.LoadRequestStore()
	if payload == "" {
		t.Fatal("load failed")
	}
	var view viewFields
	if err := json.Unmarshal([]byte(payload), &view); err != nil {
		t.Fatal(err)
	}
	return view
}

func TestSavedViewIsWhatTheNextLaunchOpens(t *testing.T) {
	app, _ := appWorkspaceForTest(t)
	before, err := os.ReadFile(requestStorePath())
	if err != nil {
		t.Fatal(err)
	}

	if result := app.SaveRequestStoreView(`{"activeId":"req-other","activeWorkspaceId":"workspace-main","openIds":["req-main","req-other"]}`); !result.Ok {
		t.Fatalf("save view: %s", result.Error)
	}
	after, err := os.ReadFile(requestStorePath())
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("saving the view rewrote the request store")
	}

	got := loadedViewForTest(t, app)
	want := viewFields{ActiveID: "req-other", ActiveWorkspaceID: "workspace-main", OpenIDs: []string{"req-main", "req-other"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("loaded view %+v, want %+v", got, want)
	}
}

func TestFullSaveReplacesAnEarlierView(t *testing.T) {
	app, _ := appWorkspaceForTest(t)
	if result := app.SaveRequestStoreView(`{"activeId":"req-other","activeWorkspaceId":"workspace-main","openIds":["req-other"]}`); !result.Ok {
		t.Fatalf("save view: %s", result.Error)
	}
	if result := app.SaveRequestStoreWithError(kurloSaveFlowPayload("https://api.example.test", "secret-token", []string{"req-main"}, "")); !result.Ok {
		t.Fatalf("full save: %s", result.Error)
	}
	if _, err := os.Stat(requestStoreViewPath(requestStorePath())); !os.IsNotExist(err) {
		t.Fatalf("view file should be gone after a full save, stat error %v", err)
	}
	got := loadedViewForTest(t, app)
	want := viewFields{ActiveID: "req-main", ActiveWorkspaceID: "workspace-main", OpenIDs: []string{"req-main"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("loaded view %+v, want %+v", got, want)
	}
}

func TestViewWithAMissingWorkspaceFallsBackToTheFirstOne(t *testing.T) {
	app, _ := appWorkspaceForTest(t)
	if result := app.SaveRequestStoreView(`{"activeId":"req-main","activeWorkspaceId":"workspace-gone","openIds":["req-main"]}`); !result.Ok {
		t.Fatalf("save view: %s", result.Error)
	}
	if got := loadedViewForTest(t, app).ActiveWorkspaceID; got != "workspace-main" {
		t.Fatalf("active workspace %q, want workspace-main", got)
	}
}

func TestBrokenViewFileIsIgnored(t *testing.T) {
	app, _ := appWorkspaceForTest(t)
	if err := os.WriteFile(requestStoreViewPath(requestStorePath()), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadedViewForTest(t, app).ActiveID; got != "req-main" {
		t.Fatalf("active request %q, want req-main", got)
	}
}

func TestInvalidViewPayloadIsRefused(t *testing.T) {
	app, _ := appWorkspaceForTest(t)
	if result := app.SaveRequestStoreView(`{"openIds":`); result.Ok {
		t.Fatal("a broken view payload should be refused")
	}
}

func TestCachedStorePlaintextFollowsTheFileOnDisk(t *testing.T) {
	withRequestStoreTestKey(t)
	path := t.TempDir() + "/requests.json"
	if err := saveRequestStorePayload(path, `{"activeId":"one"}`); err != nil {
		t.Fatal(err)
	}
	if got, err := loadRequestStorePayload(path); err != nil || got != `{"activeId":"one"}` {
		t.Fatalf("first load %q, %v", got, err)
	}
	other := t.TempDir() + "/requests.json"
	if err := saveRequestStorePayload(other, `{"activeId":"two, longer"}`); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(other)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := loadRequestStorePayload(path); err != nil || got != `{"activeId":"two, longer"}` {
		t.Fatalf("load after the file changed underneath %q, %v", got, err)
	}
}

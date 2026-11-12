package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestKurloStorePersistsReorderedRequests(t *testing.T) {
	withRequestStoreTestKey(t)
	dir := t.TempDir()
	localPath := filepath.Join(dir, "requests.json")
	workspaceRoot := filepath.Join(dir, "workspace")
	store, err := decodeJSONMap(kurloSaveFlowPayload("/saved", "token-a", []string{"req-main"}, ""))
	if err != nil {
		t.Fatal(err)
	}
	original := mapSlice(store["requests"])[0]
	requests := make([]map[string]any, 0, 3)
	for _, id := range []string{"a", "b", "c"} {
		request := make(map[string]any, len(original))
		for key, value := range original {
			request[key] = value
		}
		request["id"] = id
		request["name"] = id
		request["filesystemName"] = id
		request["folderPath"] = []string{"Users", "Active"}
		requests = append(requests, request)
	}
	store["activeId"] = "a"
	store["openIds"] = []string{"a"}
	orders := [][]map[string]any{requests, {requests[2], requests[0], requests[1]}, {requests[0], requests[1], requests[2]}}
	for _, order := range orders {
		store["requests"] = order
		payload, err := json.Marshal(store)
		if err != nil {
			t.Fatal(err)
		}
		if err := saveKurloStorePayload(localPath, workspaceRoot, string(payload)); err != nil {
			t.Fatal(err)
		}
		want := make([]string, 0, len(order))
		for _, request := range order {
			want = append(want, stringValue(request, "id"))
		}
		collectionYAML, err := os.ReadFile(filepath.Join(workspaceRoot, "workspaces", "Main", "collections", "Core", "collection.yml"))
		if err != nil {
			t.Fatal(err)
		}
		var collection struct {
			RequestOrder []string `yaml:"requestOrder"`
		}
		if err := yaml.Unmarshal(collectionYAML, &collection); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(collection.RequestOrder, want) {
			t.Fatalf("YAML request order = %v, want %v", collection.RequestOrder, want)
		}
		loaded, err := loadKurloStorePayload(localPath, workspaceRoot)
		if err != nil {
			t.Fatal(err)
		}
		restored, err := decodeJSONMap(loaded)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, request := range mapSlice(restored["requests"]) {
			got = append(got, stringValue(request, "id"))
			if !reflect.DeepEqual(request["folderPath"], []any{"Users", "Active"}) {
				t.Fatalf("folder changed: %v", request["folderPath"])
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("restored request order = %v, want %v", got, want)
		}
	}
}

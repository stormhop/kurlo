package api

import (
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func encodedExampleFiles(t *testing.T, save func()) []string {
	t.Helper()
	encoded := []string{}
	beforeYAMLWrite = func(path string) error {
		if filepath.Base(filepath.Dir(filepath.Dir(path))) == fileStoreExamplesDir {
			encoded = append(encoded, filepath.Base(path))
		}
		return nil
	}
	defer func() { beforeYAMLWrite = nil }()
	save()
	return encoded
}

func TestSavingDoesNotReencodeUnchangedExamples(t *testing.T) {
	app, root := setUpExamplesWorkspace(t)
	app.LoadWorkspace()
	save := func(payload string) func() {
		return func() {
			if result := app.SaveRequestStoreWithError(payload); !result.Ok {
				t.Fatalf("save: %s", result.Error)
			}
		}
	}

	payload := strings.Replace(examplesTestPayload("Orders", "Orders", ""), "https://example.test/orders", "https://example.test/orders?page=2", 1)
	if encoded := encodedExampleFiles(t, save(payload)); len(encoded) != 0 {
		t.Fatalf("examples the editor did not send were encoded again: %v", encoded)
	}

	edited := strings.Replace(twoExamples, `"body":"none"`, `"body":"gone"`, 1)
	if encoded := encodedExampleFiles(t, save(examplesTestPayload("Orders", "Orders", edited))); strings.Join(encoded, ",") != "OK.yml,Missing.yml" {
		t.Fatalf("an edited request should write its examples, got %v", encoded)
	}
	var onDisk []string
	for _, data := range exampleFiles(t, root) {
		onDisk = append(onDisk, data)
	}
	if !strings.Contains(strings.Join(onDisk, "\n"), "gone") {
		t.Fatalf("edited body missing on disk")
	}
	if encoded := encodedExampleFiles(t, save(examplesTestPayload("Orders", "Orders", ""))); len(encoded) != 0 {
		t.Fatalf("examples saved a moment ago were encoded again: %v", encoded)
	}
}

func TestMockRoutesComeFromStoredExamplesWithoutBodies(t *testing.T) {
	app, _ := setUpExamplesWorkspace(t)
	app.LoadWorkspace()
	routes := app.LoadMockRoutes([]model.MockRequestRef{{RequestID: "req", RequestName: "Orders", Method: "GET"}})
	if len(routes) != 2 {
		t.Fatalf("expected two routes, got %+v", routes)
	}
	for _, route := range routes {
		if route.Body != "" || len(route.Headers) != 0 || route.RequestName != "Orders" || route.PathTemplate != "/orders" || route.RequestID != "req" {
			t.Fatalf("unexpected light route: %+v", route)
		}
	}
	if routes[0].StatusCode != 200 || routes[1].StatusCode != 404 || routes[1].ExampleName != "Missing" {
		t.Fatalf("unexpected routes: %+v", routes)
	}
}

func TestMockServerServesStoredExamplesTheFrontendDidNotSend(t *testing.T) {
	app, _ := setUpExamplesWorkspace(t)
	app.LoadWorkspace()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	edited := model.MockRoute{ExampleID: "ex-draft", ExampleName: "Draft", RequestID: "draft", RequestName: "Draft", Method: "GET", PathTemplate: "/draft", StatusCode: 201, Body: "draft", Query: []model.KeyValue{}, Headers: []model.KeyValue{}}
	status := app.StartMockServer(model.MockServerConfig{
		Port: port, CollectionID: "col", CollectionName: "API",
		Requests: []model.MockRequestRef{
			{RequestID: "req", RequestName: "Orders", Method: "GET"},
			{RequestID: "draft", RequestName: "Draft", Method: "GET", Loaded: true, Routes: []model.MockRoute{edited}},
		},
	})
	t.Cleanup(func() { app.StopMockServer() })
	if status.Error != "" || !status.Running || status.RouteCount != 3 {
		t.Fatalf("unexpected status: %+v", status)
	}
	for path, want := range map[string]string{"/orders": `{"ok":true}`, "/draft": "draft"} {
		resp, err := httpGetBody(status.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		if resp != want {
			t.Fatalf("%s served %q, want %q", path, resp, want)
		}
	}
}

func httpGetBody(url string) (string, error) {
	resp, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return string(data), err
}

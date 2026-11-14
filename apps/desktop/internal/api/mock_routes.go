package api

import (
	"encoding/json"
	"mime"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type mockExampleSummary struct {
	Snapshot struct {
		Method string `json:"method"`
	} `json:"snapshot"`
	Match struct {
		PathTemplate string            `json:"pathTemplate"`
		Query        map[string]string `json:"query"`
	} `json:"match"`
	ID       string `json:"id"`
	Name     string `json:"name"`
	Response struct {
		StatusCode int    `json:"statusCode"`
		Status     string `json:"status"`
	} `json:"response"`
}

func mockRouteFromExample(requestID, requestName, requestMethod string, example cliExample) model.MockRoute {
	resp := example.Response
	route := mockRouteHead(requestID, requestName, requestMethod, example.ID, example.Name, example.Snapshot.Method, example.Match.PathTemplate, example.Match.Query, resp.StatusCode, resp.Status)
	route.Body = resp.Body
	route.BodyMediaType = resp.BodyMediaType
	route.DelayMs = resp.DurationMs
	for _, header := range resp.Headers {
		if strings.TrimSpace(header.Key) == "" {
			continue
		}
		route.Headers = append(route.Headers, model.KeyValue{Key: header.Key, Value: header.Value, Enabled: true})
		if route.BodyMediaType == "" && strings.EqualFold(header.Key, "Content-Type") {
			route.BodyMediaType, _, _ = mime.ParseMediaType(header.Value)
		}
	}
	return route
}

func mockRouteHead(requestID, requestName, requestMethod, exampleID, exampleName, method, pathTemplate string, query map[string]string, statusCode int, status string) model.MockRoute {
	route := model.MockRoute{
		ExampleID: exampleID, ExampleName: exampleName, RequestID: requestID, RequestName: requestName,
		Method: defaultString(method, defaultString(requestMethod, "GET")), PathTemplate: defaultString(pathTemplate, "/"),
		StatusCode: statusCode, Status: status, Query: []model.KeyValue{}, Headers: []model.KeyValue{},
	}
	if route.StatusCode == 0 {
		route.StatusCode = 200
	}
	for _, key := range sortedKeys(query) {
		route.Query = append(route.Query, model.KeyValue{Key: key, Value: query[key], Enabled: true})
	}
	return route
}

func mockRoutesForRefs(refs []model.MockRequestRef, cached map[string]json.RawMessage, full bool) ([]model.MockRoute, error) {
	routes := []model.MockRoute{}
	for _, ref := range refs {
		if ref.Loaded {
			routes = append(routes, ref.Routes...)
			continue
		}
		raw, ok := cached[ref.RequestID]
		if !ok {
			continue
		}
		if full {
			var examples []cliExample
			if err := json.Unmarshal(raw, &examples); err != nil {
				return nil, err
			}
			for _, example := range examples {
				routes = append(routes, mockRouteFromExample(ref.RequestID, ref.RequestName, ref.Method, example))
			}
			continue
		}
		var examples []mockExampleSummary
		if err := json.Unmarshal(raw, &examples); err != nil {
			return nil, err
		}
		for _, example := range examples {
			routes = append(routes, mockRouteHead(ref.RequestID, ref.RequestName, ref.Method, example.ID, example.Name, example.Snapshot.Method, example.Match.PathTemplate, example.Match.Query, example.Response.StatusCode, example.Response.Status))
		}
	}
	return routes, nil
}

func mockRoutesFromWorkspace(refs []model.MockRequestRef, full bool) ([]model.MockRoute, error) {
	root := fileWorkspaceStorePath()
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return nil, err
	}
	defer unlock()
	cached, err := requestExamplesForRoot(root)
	if err != nil {
		return nil, err
	}
	return mockRoutesForRefs(refs, cached, full)
}

func (a *App) LoadMockRoutes(refs []model.MockRequestRef) []model.MockRoute {
	routes, err := mockRoutesFromWorkspace(refs, false)
	if err != nil {
		return []model.MockRoute{}
	}
	return routes
}

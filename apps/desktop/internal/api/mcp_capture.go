package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type captureObservation struct {
	ID       int     `json:"id"`
	Method   string  `json:"method"`
	Host     string  `json:"host"`
	Path     string  `json:"path"`
	Status   int     `json:"status"`
	Duration float64 `json:"durationMs"`
}

func loadCaptureObservations(file string) ([]captureObservation, error) {
	if file == "" {
		return nil, errors.New("start kurlo mcp with --capture-har to share a capture")
	}
	data, err := readCaptureFile(file)
	if err != nil {
		return nil, err
	}
	var har struct {
		Log struct {
			Entries []struct {
				Request  struct{ URL, Method string }
				Response struct{ Status int }
				Time     float64
			}
		}
	}
	if err = json.Unmarshal(data, &har); err != nil {
		return nil, err
	}
	if har.Log.Entries == nil {
		return nil, errors.New("expected a HAR log.entries array")
	}
	out := make([]captureObservation, 0, len(har.Log.Entries))
	for i, e := range har.Log.Entries {
		u, err := url.Parse(e.Request.URL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			continue
		}
		out = append(out, captureObservation{ID: i + 1, Method: e.Request.Method, Host: u.Host, Path: u.EscapedPath(), Status: e.Response.Status, Duration: e.Time})
	}
	return out, nil
}

func readCaptureFile(file string) ([]byte, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 256<<20 {
		return nil, errors.New("choose a regular HAR file up to 256 MiB")
	}
	data, err := io.ReadAll(io.LimitReader(f, (256<<20)+1))
	if len(data) > 256<<20 {
		return nil, errors.New("HAR exceeds 256 MiB")
	}
	return data, err
}

func (s *mcpServer) captureTools() []map[string]any {
	tools := mcpServerTools(s.opts.readOnly)
	if s.opts.captureHAR == "" {
		return tools
	}
	for _, t := range []struct {
		name, description string
		properties        map[string]any
	}{
		{"proxy_status", "Summarize the HAR session supplied to this server.", nil},
		{"list_captured", "List method, host, path, status and duration in the supplied HAR.", map[string]any{"host": map[string]any{"type": "string"}, "offset": map[string]any{"type": "integer", "minimum": 0}}},
		{"get_captured", "Read the metadata of one supplied HAR entry by id.", map[string]any{"id": map[string]any{"type": "integer", "minimum": 1}}},
		{"check_captured_openapi", "Compare observed HTTP operations with a synced collection's saved OpenAPI specification.", map[string]any{"collection": map[string]any{"type": "string"}, "host": map[string]any{"type": "string"}, "basePath": map[string]any{"type": "string"}}},
	} {
		schema := map[string]any{"type": "object", "additionalProperties": false}
		if t.properties != nil {
			schema["properties"] = t.properties
		}
		if t.name == "get_captured" {
			schema["required"] = []string{"id"}
		}
		if t.name == "check_captured_openapi" {
			schema["required"] = []string{"collection", "host"}
		}
		tools = append(tools, map[string]any{"name": t.name, "description": t.description, "inputSchema": schema, "annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false}})
	}
	if !s.opts.readOnly {
		tools = append(tools, map[string]any{"name": "create_captured_collection", "description": "Create a collection of request templates for a single host in the supplied HAR. URLs use {{baseUrl}} and contain only paths. Records expected response statuses.", "inputSchema": map[string]any{"type": "object", "required": []string{"name", "host"}, "additionalProperties": false, "properties": map[string]any{"name": map[string]any{"type": "string"}, "host": map[string]any{"type": "string"}, "workspace": map[string]any{"type": "string"}}}, "annotations": map[string]any{"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}})
	}
	return tools
}

func (s *mcpServer) captureTool(name string, raw json.RawMessage) (any, error) {
	var a struct {
		ID, Offset                 int
		Collection, Host, BasePath string
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	items, err := loadCaptureObservations(s.opts.captureHAR)
	if err != nil {
		return nil, err
	}
	switch name {
	case "proxy_status":
		return map[string]any{"source": "har", "entries": len(items)}, nil
	case "get_captured":
		for _, e := range items {
			if e.ID == a.ID {
				return e, nil
			}
		}
		return nil, errors.New("unknown capture entry")
	case "list_captured":
		if a.Offset < 0 {
			return nil, errors.New("offset must be non-negative")
		}
		var count int
		page := []captureObservation{}
		for _, e := range items {
			if a.Host != "" && !strings.EqualFold(e.Host, a.Host) {
				continue
			}
			if count >= a.Offset && len(page) < 100 {
				page = append(page, e)
			}
			count++
		}
		return map[string]any{"entries": page, "total": count}, nil
	case "check_captured_openapi":
		if a.Host == "" || a.Collection == "" {
			return nil, errors.New("host and collection are required")
		}
		ws, err := s.loadWorkspace()
		if err != nil {
			return nil, err
		}
		col, err := findOpenAPICollection(ws.collections, a.Collection)
		if err != nil {
			return nil, err
		}
		base := readOpenAPIBaseSpec(s.opts.workspace, col.ID)
		if !base.Exists || base.Error != "" {
			return nil, errors.New("collection has no readable saved OpenAPI spec")
		}
		return compareCaptureOperations(base.Content, a.Host, a.BasePath, items)
	}
	return nil, fmt.Errorf("unknown capture tool %q", name)
}

func compareCaptureOperations(spec, host, basePath string, entries []captureObservation) (any, error) {
	doc, err := parseOpenAPIDocumentText(spec)
	if err != nil {
		return nil, err
	}
	operations := openAPIOperationsOf(doc)
	basePath = strings.TrimRight(basePath, "/")
	unmatched := []int{}
	matched := 0
	for _, e := range entries {
		if !strings.EqualFold(e.Host, host) {
			continue
		}
		p := e.Path
		if basePath != "" && (p == basePath || strings.HasPrefix(p, basePath+"/")) {
			p = strings.TrimPrefix(p, basePath)
		} else if basePath != "" {
			unmatched = append(unmatched, e.ID)
			continue
		}
		found := false
		for key := range operations {
			m, template, _ := strings.Cut(key, " ")
			if m == e.Method && mockPathMatches(normalizeMockPath(template), normalizeMockPath(path.Clean("/"+p))) {
				found = true
				break
			}
		}
		if found {
			matched++
		} else {
			unmatched = append(unmatched, e.ID)
		}
	}
	return map[string]any{"matched": matched, "unmatchedIds": unmatched}, nil
}

func (s *mcpServer) captureHandler(name string) func(context.Context, json.RawMessage) (any, error) {
	return func(_ context.Context, args json.RawMessage) (any, error) { return s.captureTool(name, args) }
}

func (s *mcpServer) createCapturedCollection(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct{ Name, Host, Workspace string }
	if err := mcpDecodeArguments(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.Host) == "" || strings.TrimSpace(args.Name) == "" {
		return nil, errors.New("host and name are required")
	}
	observations, err := loadCaptureObservations(s.opts.captureHAR)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var items []captureObservation
	for _, item := range observations {
		if !strings.EqualFold(item.Host, args.Host) {
			continue
		}
		switch item.Method {
		case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions:
		default:
			continue
		}
		if item.Path == "" {
			item.Path = "/"
		}
		key := item.Method + " " + item.Path
		if seen[key] {
			continue
		}
		if len(items) == 1000 {
			return nil, errors.New("choose a capture with up to 1000 unique operations per host")
		}
		seen[key] = true
		items = append(items, item)
	}
	if len(items) == 0 {
		return nil, errors.New("no matching HTTP operations for this host")
	}
	createArgs, err := json.Marshal(map[string]string{"name": args.Name, "workspace": args.Workspace})
	if err != nil {
		return nil, err
	}
	return s.mutate(ctx, func(st *mcpStore) (func() any, error) {
		describe, err := editCreateCollection(st, createArgs)
		if err != nil {
			return nil, err
		}
		id := stringValue(st.collections[len(st.collections)-1], "id")
		for _, item := range items {
			method, route := item.Method, "{{baseUrl}}"+item.Path
			name := method + " " + item.Path
			request := mcpSaveRequestArgs{Collection: &id, Name: &name, Method: &method, URL: &route, Auth: &mcpAuthArg{Type: "none"}}
			if item.Status >= 100 && item.Status <= 599 {
				request.Assertions = &[]model.Assertion{{Enabled: true, Target: "status", Operator: "eq", Value: strconv.Itoa(item.Status)}}
			}
			if _, err = mcpSaveRequest(st, request); err != nil {
				return nil, err
			}
		}
		return func() any { return map[string]any{"collection": describe(), "requests": len(items)} }, nil
	})
}

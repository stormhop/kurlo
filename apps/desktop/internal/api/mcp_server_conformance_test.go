package api

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

type mcpSpecSchema struct {
	t        *testing.T
	revision string
	defs     string
	compiler *jsonschema.Compiler
	url      string
}

func loadMCPSpecSchema(t *testing.T, revision string) *mcpSpecSchema {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "mcp-schema", revision+".json"))
	if err != nil {
		t.Fatalf("read schema %s: %v", revision, err)
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("parse schema %s: %v", revision, err)
	}
	defs := "definitions"
	if root, ok := doc.(map[string]any); ok {
		if _, ok := root["$defs"]; ok {
			defs = "$defs"
		}
	}
	url := "file:///mcp-schema/" + revision + ".json"
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource(url, doc); err != nil {
		t.Fatalf("add schema %s: %v", revision, err)
	}
	return &mcpSpecSchema{t: t, revision: revision, defs: defs, compiler: compiler, url: url}
}

func (s *mcpSpecSchema) check(definition, label string, raw json.RawMessage) {
	s.t.Helper()
	schema, err := s.compiler.Compile(s.url + "#/" + s.defs + "/" + definition)
	if err != nil {
		s.t.Fatalf("%s: compile %s: %v", s.revision, definition, err)
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		s.t.Fatalf("%s %s: decode: %v", s.revision, label, err)
	}
	if err := schema.Validate(value); err != nil {
		excerpt, _ := mcpTruncate(string(raw), 600)
		s.t.Errorf("%s %s does not match the spec's %s:\n%v\n%s", s.revision, label, definition, err, excerpt)
	}
}

func mcpConformanceCalls(serverURL string) []struct {
	label     string
	name      string
	arguments map[string]any
} {
	return []struct {
		label     string
		name      string
		arguments map[string]any
	}{
		{"list_requests", "list_requests", map[string]any{}},
		{"get_request", "get_request", map[string]any{"request": "Smoke/Ok"}},
		{"list_environments", "list_environments", map[string]any{}},
		{"run_request", "run_request", map[string]any{"request": "Smoke/Ok"}},
		{"run_collection", "run_collection", map[string]any{"collection": "Smoke"}},
		{"send_request", "send_request", map[string]any{"url": serverURL + "/one-off"}},
		{"list_history", "list_history", map[string]any{}},
		{"get_history_entry on no history", "get_history_entry", map[string]any{}},
		{"run_request on a missing request", "run_request", map[string]any{"request": "Nope"}},
		{"save_request", "save_request", map[string]any{"collection": "Smoke", "name": "Spec check", "url": "{{baseUrl}}/spec"}},
		{"delete_request", "delete_request", map[string]any{"request": "Smoke/Spec check"}},
	}
}

func TestMCPServerAnswersMatchEveryHandshakeRevisionSchema(t *testing.T) {
	for _, revision := range mcpServerHandshakeVersions {
		t.Run(revision, func(t *testing.T) {
			useTempConfigDir(t, t.TempDir())
			server := echoServer(t)
			spec := loadMCPSpecSchema(t, revision)
			h := startMCPHarness(t, mcpServerOptions{workspace: writeYAMLWorkspace(t, server.URL), env: "Local"})

			resp := h.request("initialize", map[string]any{
				"protocolVersion": revision,
				"capabilities":    map[string]any{},
				"clientInfo":      map[string]any{"name": "spec-check", "version": "1"},
			})
			spec.check("InitializeResult", "initialize", resp.Result)
			h.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})

			resp = h.request("tools/list", map[string]any{})
			spec.check("ListToolsResult", "tools/list", resp.Result)

			for _, call := range mcpConformanceCalls(server.URL) {
				resp := h.request("tools/call", map[string]any{"name": call.name, "arguments": call.arguments})
				if resp.Error != nil {
					t.Fatalf("%s: rpc error %+v", call.label, resp.Error)
				}
				spec.check("CallToolResult", "tools/call "+call.label, resp.Result)
			}
		})
	}
}

func TestMCPServerAnswersMatchTheStatelessRevisionSchema(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	server := echoServer(t)
	spec := loadMCPSpecSchema(t, "2026-07-28")
	h := startMCPHarness(t, mcpServerOptions{workspace: writeYAMLWorkspace(t, server.URL), env: "Local"})
	meta := map[string]any{
		mcpMetaProtocolVersion:                       "2026-07-28",
		"io.modelcontextprotocol/clientInfo":         map[string]any{"name": "spec-check", "version": "1"},
		"io.modelcontextprotocol/clientCapabilities": map[string]any{},
	}

	resp := h.request(mcpMethodDiscover, map[string]any{"_meta": meta})
	spec.check("DiscoverResult", "server/discover", resp.Result)

	resp = h.request("tools/list", map[string]any{"_meta": meta})
	spec.check("ListToolsResult", "tools/list", resp.Result)

	for _, call := range mcpConformanceCalls(server.URL) {
		resp := h.request("tools/call", map[string]any{"name": call.name, "arguments": call.arguments, "_meta": meta})
		if resp.Error != nil {
			t.Fatalf("%s: rpc error %+v", call.label, resp.Error)
		}
		spec.check("CallToolResult", "tools/call "+call.label, resp.Result)
	}
}

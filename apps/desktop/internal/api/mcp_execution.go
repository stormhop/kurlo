package api

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type executionTool struct {
	description string
	properties  map[string]string
	required    []string
	kind        string
	reason      string
	live        bool
	write       bool
	run         func(*mcpServer, context.Context, json.RawMessage) (any, error)
}

var executionTools = map[string]executionTool{
	"import_preview": knowledgeReadTool(
		"Preview an OpenAPI/Swagger, Postman, Insomnia, HAR or cURL import. Provide file (relative to the project or workspace), url (OpenAPI only), content or a chat attachment ID. Returns an importId and the YAML diff. For more changes call again with importId and offset from nextOffset. Specify collection to append or omit it to create one.",
		map[string]string{"format": "string", "file": "string", "url": "string", "content": "string", "attachment": "string", "workspace": "string", "collection": "string", "name": "string", "importId": "string", "offset": "integer", "limit": "integer"}, nil, (*mcpServer).toolImportPreview),
	"import_apply": {
		description: "Apply the last import_preview using its importId. Agent Mode shows a diff for approval. External MCP clients must review the diff and pass confirm: true.",
		properties:  map[string]string{"importId": "string", "confirm": "boolean"}, required: []string{"importId"},
		kind: model.AgentToolWrite, write: true, run: (*mcpServer).toolImportApply,
	},
	"list_files": knowledgeReadTool("List text and other regular files inside the connected read-only project. Optional relative path, glob and limit.",
		map[string]string{"path": "string", "glob": "string", "limit": "integer"}, nil, (*mcpServer).toolListFiles),
	"read_file": knowledgeReadTool("Read UTF-8 text within the connected project, optionally by one-based startLine and lineCount.",
		map[string]string{"path": "string", "startLine": "integer", "lineCount": "integer"}, []string{"path"}, (*mcpServer).toolReadFile),
	"search_code": knowledgeReadTool("Search for case-insensitive literal text in the connected project. Returns matching paths and line numbers.",
		map[string]string{"query": "string", "path": "string", "glob": "string", "limit": "integer"}, []string{"query"}, (*mcpServer).toolSearchCode),
	"read_attachment": {
		description: "Read a user-attached UTF-8 file in this turn by its attachment ID and optional line range. Images arrive directly with the message.",
		properties:  map[string]string{"attachment": "string", "startLine": "integer", "lineCount": "integer"}, required: []string{"attachment"},
		kind: model.AgentToolRead, live: true, run: (*mcpServer).toolReadAttachment,
	},
	"get_docs": knowledgeReadTool("Read Markdown docs for a saved request or collection.",
		map[string]string{"request": "string", "collection": "string"}, nil, (*mcpServer).toolGetDocs),
	"save_docs": {
		description: "Replace Markdown docs for exactly one saved request or collection, with a workspace diff. An empty string clears them.",
		properties:  map[string]string{"request": "string", "collection": "string", "markdown": "string"}, required: []string{"markdown"},
		kind: model.AgentToolWrite, write: true, run: (*mcpServer).toolSaveDocs,
	},
	"code_snippet": knowledgeReadTool("Generate a code snippet for a saved HTTP or GraphQL request. Supported languages: curl, httpie, javascript, node, axios, python, go, java, csharp, php, ruby, swift, kotlin, rust.",
		map[string]string{"request": "string", "language": "string"}, []string{"request"}, (*mcpServer).toolCodeSnippet),
	"sync_collection": knowledgeReadTool("Get the workflow for syncing a collection with routes found in the connected source folder.",
		map[string]string{"collection": "string", "source": "string"}, nil, (*mcpServer).toolSyncCollection),
	"cover_endpoint": knowledgeReadTool("Get the workflow for finding one endpoint in connected source and covering it with a request, tests and an example.",
		map[string]string{"endpoint": "string", "collection": "string"}, []string{"endpoint"}, (*mcpServer).toolCoverEndpoint),

	"open_session": {
		description: "Open a saved WebSocket, Socket.IO, SSE or gRPC stream for this turn. A gRPC server stream sends its saved body on open.",
		properties:  map[string]string{"request": "string", "environment": "string", "variables": "object", "timeoutMs": "integer"},
		required:    []string{"request"},
		kind:        model.AgentToolExternal,
		reason:      "Opens a live connection to the saved request's server.",
		live:        true,
		run:         (*mcpServer).toolOpenSession,
	},
	"send_message": {
		description: "Send data on a live session. WebSocket uses data and optional type/encoding. Socket.IO uses eventName, JSON args and optional ack. gRPC uses data as JSON or endStream to finish sending.",
		properties:  map[string]string{"sessionId": "string", "data": "string", "type": "string", "encoding": "string", "eventName": "string", "args": "array", "ack": "boolean", "endStream": "boolean"},
		required:    []string{"sessionId"},
		kind:        model.AgentToolRun,
		reason:      "Sends a message that can change data on the server.",
		live:        true,
		run:         (*mcpServer).toolSendMessage,
	},
	"read_messages": {
		description: "Read queued messages, waiting up to timeoutMs for the first one. A zero timeout polls immediately.",
		properties:  map[string]string{"sessionId": "string", "timeoutMs": "integer", "limit": "integer"},
		required:    []string{"sessionId"},
		kind:        model.AgentToolRead,
		live:        true,
		run:         (*mcpServer).toolReadMessages,
	},
	"close_session": {
		description: "Close a live connection owned by this turn.",
		properties:  map[string]string{"sessionId": "string"},
		required:    []string{"sessionId"},
		kind:        model.AgentToolRun,
		live:        true,
		run:         (*mcpServer).toolCloseSession,
	},
	"list_load_runs": {
		description: "List recent completed runs of a saved load test with their startedAt timestamps.",
		properties:  map[string]string{"test": "string", "limit": "integer"},
		required:    []string{"test"},
		kind:        model.AgentToolRead,
		run:         (*mcpServer).toolListLoadRuns,
	},
	"list_load_tests": {
		description: "List saved load tests. Use the returned ID to inspect, edit or start one.",
		properties:  map[string]string{"collection": "string"},
		kind:        model.AgentToolRead,
		run:         (*mcpServer).toolListLoadTests,
	},
	"get_load_test": {
		description: "Read the complete saved load test configuration.",
		properties:  map[string]string{"test": "string"},
		required:    []string{"test"},
		kind:        model.AgentToolRead,
		run:         (*mcpServer).toolGetLoadTest,
	},
	"save_load_test": {
		description: "Create or replace a load test in a collection. To edit, copy the definition from get_load_test and keep its ID. Steps reference saved HTTP or GraphQL request IDs. A minimal test object is {\"name\":\"Smoke\",\"scenarios\":[{\"executor\":{\"type\":\"constant-vus\",\"vus\":1,\"durationMs\":1000},\"steps\":[{\"requestId\":\"saved-request-id\"}]}]}.",
		properties:  map[string]string{"collection": "string", "test": "object"},
		required:    []string{"collection", "test"},
		kind:        model.AgentToolWrite,
		reason:      "Writes the load test definition.",
		write:       true,
		run:         (*mcpServer).toolSaveLoadTest,
	},
	"start_load_test": {
		description: "Start a saved load test in the background with the installed k6. Use load_test_status and load_test_result to follow the run.",
		properties:  map[string]string{"test": "string", "environment": "string"},
		required:    []string{"test"},
		kind:        model.AgentToolRun,
		reason:      "Starts k6 and sends repeated requests to the configured targets.",
		run:         (*mcpServer).toolStartLoadTest,
	},
	"load_test_status": {
		description: "Read the current k6 run and its progress.",
		kind:        model.AgentToolRead,
		run:         (*mcpServer).toolLoadTestStatus,
	},
	"stop_load_test": {
		description: "Stop the active k6 run.",
		kind:        model.AgentToolWrite,
		reason:      "Stops the active k6 run.",
		write:       true,
		run:         (*mcpServer).toolStopLoadTest,
	},
	"load_test_result": {
		description: "Read a k6 run's summary, thresholds and per-step metrics. Omit startedAt for the latest completed run.",
		properties:  map[string]string{"test": "string", "startedAt": "integer"},
		required:    []string{"test"},
		kind:        model.AgentToolRead,
		run:         (*mcpServer).toolLoadTestResult,
	},
	"compare_load_runs": {
		description: "Compare two completed k6 runs. Each reference contains test and optionally startedAt (milliseconds). Delta values are candidate minus baseline.",
		properties:  map[string]string{"baseline": "object", "candidate": "object"},
		required:    []string{"baseline", "candidate"},
		kind:        model.AgentToolRead,
		run:         (*mcpServer).toolCompareLoadRuns,
	},
	"start_mock_server": {
		description: "Start a localhost mock server using the saved examples in a collection. Omit port for the default.",
		properties:  map[string]string{"collection": "string", "port": "integer", "simulateLatency": "boolean"},
		required:    []string{"collection"},
		kind:        model.AgentToolWrite,
		reason:      "Starts or replaces the local mock server and serves the collection's saved examples.",
		write:       true,
		run:         (*mcpServer).toolStartMock,
	},
	"stop_mock_server": {
		description: "Stop the local mock server.",
		kind:        model.AgentToolWrite,
		reason:      "Stops the local mock server.",
		write:       true,
		run:         (*mcpServer).toolStopMock,
	},
	"mock_server_log": {
		description: "Read mock server status and recent request log.",
		properties:  map[string]string{"limit": "integer"},
		kind:        model.AgentToolRead,
		run:         (*mcpServer).toolMockLog,
	},
	"list_cookies": {
		description: "List cookie metadata for a domain in the current workspace jar. Cookie values are hidden.",
		properties:  map[string]string{"domain": "string", "workspaceId": "string"},
		required:    []string{"domain"},
		kind:        model.AgentToolRead,
		run:         (*mcpServer).toolListCookies,
	},
	"clear_cookie_jar": {
		description: "Clear the cookie jar for the current workspace.",
		properties:  map[string]string{"workspaceId": "string"},
		kind:        model.AgentToolWrite,
		reason:      "Clears all cookies in the selected workspace jar. This can sign you out.",
		write:       true,
		run:         (*mcpServer).toolClearCookies,
	},
}

func executionToolDefinitions(readOnly, live bool) []map[string]any {
	names := make([]string, 0, len(executionTools))
	for name := range executionTools {
		names = append(names, name)
	}
	slices.Sort(names)
	var definitions []map[string]any
	for _, name := range names {
		tool := executionTools[name]
		if tool.live != live || (readOnly && tool.write) {
			continue
		}
		properties := map[string]any{}
		for key, kind := range tool.properties {
			property := map[string]any{"type": kind}
			if kind == "array" {
				property["items"] = map[string]any{}
			}
			properties[key] = property
		}
		schema := map[string]any{"type": "object", "properties": properties}
		if len(tool.required) > 0 {
			schema["required"] = tool.required
		}
		read := tool.kind == model.AgentToolRead
		definitions = append(definitions, map[string]any{
			"name": name, "description": tool.description, "inputSchema": schema,
			"annotations": map[string]any{"readOnlyHint": read, "openWorldHint": !read && !tool.write},
		})
	}
	return definitions
}

func readMCPRunData(directory, path string) ([]map[string]string, error) {
	name, err := cleanGitRelativePath(path)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	data, err := readKnowledgeRoot(root, name, 16<<20)
	if err != nil {
		return nil, fmt.Errorf("data file: %w", err)
	}
	return parseCLIData(string(data), name)
}

func (ws mcpWorkspace) withDefaults(req cliSavedRequest) cliSavedRequest {
	for i := range ws.collections {
		if ws.collections[i].ID == req.CollectionID {
			return applyCollectionDefaults(req, &ws.collections[i])
		}
	}
	return applyCollectionDefaults(req, nil)
}

func (ws mcpWorkspace) forRequest(req cliSavedRequest) mcpWorkspace {
	for _, collection := range ws.collections {
		if collection.ID != req.CollectionID {
			continue
		}
		ws.collections = []cliCollection{collection}
		environments := make([]cliEnvironment, 0, len(ws.environments))
		for _, env := range ws.environments {
			if env.WorkspaceID == collection.WorkspaceID {
				environments = append(environments, env)
			}
		}
		ws.environments = environments
		break
	}
	return ws
}

func (ws mcpWorkspace) collectionScope() map[string]bool {
	ids := make(map[string]bool, len(ws.collections))
	for _, collection := range ws.collections {
		ids[collection.ID] = true
	}
	return ids
}

type mcpRequestDiagnostics struct {
	Timings       model.ResponseTime    `json:"timings"`
	Connection    model.ConnectionInfo  `json:"connection"`
	RedirectChain []map[string]string   `json:"redirectChain,omitempty"`
	Timeline      []model.TimelineEvent `json:"timeline,omitempty"`
}

func mcpDiagnostics(resp model.HttpResponse, secrets []string) mcpRequestDiagnostics {
	out := mcpRequestDiagnostics{Timings: resp.Timings, Connection: resp.Connection}
	out.Connection.ServerName = redactSecrets(out.Connection.ServerName, secrets)
	if len(resp.SentRequests) > 1 {
		for _, hop := range resp.SentRequests {
			out.RedirectChain = append(out.RedirectChain, map[string]string{
				"method": hop.Method, "url": redactSecrets(hop.URL, secrets), "protocol": hop.Proto,
			})
		}
	}
	for _, event := range resp.Timeline {
		event.Detail = redactSecrets(event.Detail, secrets)
		out.Timeline = append(out.Timeline, event)
	}
	return out
}

func (s *mcpServer) cookieWorkspace(workspaceID string) (string, error) {
	if s.opts.workspaceID != "" {
		if workspaceID != "" && workspaceID != s.opts.workspaceID {
			return "", fmt.Errorf("that workspace is outside the current chat")
		}
		return s.opts.workspaceID, nil
	}
	ws, err := s.loadStore()
	if err != nil {
		return "", err
	}
	if workspaceID == "" && len(ws.workspaces) == 1 {
		return stringValue(ws.workspaces[0], "id"), nil
	}
	for _, workspace := range ws.workspaces {
		if workspaceID != "" && stringValue(workspace, "id") == workspaceID {
			return workspaceID, nil
		}
	}
	return "", fmt.Errorf("provide a valid workspaceId")
}

func (s *mcpServer) toolListCookies(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Domain      string `json:"domain"`
		WorkspaceID string `json:"workspaceId"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	domain := strings.Trim(strings.ToLower(strings.TrimSpace(args.Domain)), ".")
	if domain == "" || strings.ContainsAny(domain, "/@") {
		return nil, fmt.Errorf("provide a cookie domain")
	}
	id, err := s.cookieWorkspace(args.WorkspaceID)
	if err != nil {
		return nil, err
	}
	cookies := []model.Cookie{}
	for _, cookie := range s.jars.jar(id).ListCookies() {
		if cookie.Domain == domain || (!cookie.HostOnly && strings.HasSuffix(domain, "."+cookie.Domain)) {
			cookie.Value = ""
			cookies = append(cookies, cookie)
		}
	}
	return map[string]any{"workspaceId": id, "domain": domain, "cookies": cookies}, nil
}

func (s *mcpServer) toolClearCookies(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		WorkspaceID string `json:"workspaceId"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	id, err := s.cookieWorkspace(args.WorkspaceID)
	if err != nil {
		return nil, err
	}
	s.jars.jar(id).ClearCookies()
	s.executionApp.emit("cookies:jar-changed", id)
	return map[string]any{"workspaceId": id, "cleared": true}, nil
}

package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const mcpServerLatestHandshakeVersion = "2025-11-25"

var mcpServerHandshakeVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

const (
	mcpServerDefaultBodyLimit = 64 * 1024
	mcpServerMaxBodyLimit     = 1024 * 1024
	mcpServerExampleBodyLimit = 8 * 1024
)

const (
	mcpRPCParseError     = -32700
	mcpRPCInvalidRequest = -32600
	mcpRPCMethodNotFound = -32601
	mcpRPCInvalidParams  = -32602
)

type mcpServerOptions struct {
	workspace        string
	env              string
	timeoutMs        int
	insecure         bool
	allowSendRequest bool
	loadAppSecrets   bool
	readOnly         bool
}

type mcpServer struct {
	opts     mcpServerOptions
	out      io.Writer
	writeMu  sync.Mutex
	runMu    sync.Mutex
	jars     *cookieJarRegistry
	cache    *preflightCache
	tokens   *oauth2TokenCache
	session  map[string]*mcpSessionScope
	lastRuns map[string]mcpLastRun

	pendingMu sync.Mutex
	pending   map[string]context.CancelFunc
	inflight  sync.WaitGroup
}

type mcpSessionScope struct {
	set     map[string]string
	removed map[string]bool
}

type mcpServerMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type mcpServerError struct {
	code    int
	message string
}

func (e *mcpServerError) Error() string { return e.message }

func RunMCPServer(args []string) int {
	opts, err := parseMCPServerArgs(args, os.Stderr)
	if err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		fmt.Fprintln(os.Stderr, "kurlo mcp:", err)
		return 2
	}
	if !hasYAMLWorkspaceStore(opts.workspace) {
		fmt.Fprintf(os.Stderr, "kurlo mcp: %q is not a Kurlo YAML workspace (no kurlo.yml found)\n", opts.workspace)
		return 2
	}
	defer httpTransports.closeAll()
	if err := newMCPServer(opts, os.Stdout).serve(os.Stdin); err != nil {
		fmt.Fprintln(os.Stderr, "kurlo mcp:", err)
		return 1
	}
	return 0
}

func parseMCPServerArgs(args []string, stderr io.Writer) (mcpServerOptions, error) {
	fs := flag.NewFlagSet("kurlo mcp", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var opts mcpServerOptions
	fs.StringVar(&opts.env, "env", "", "environment to use when a tool call does not name one")
	fs.IntVar(&opts.timeoutMs, "timeout", 0, "per-request timeout in milliseconds (overrides request settings)")
	fs.BoolVar(&opts.insecure, "insecure", false, "disable TLS certificate verification for every request")
	fs.BoolVar(&opts.insecure, "k", false, "alias for --insecure")
	fs.BoolVar(&opts.allowSendRequest, "allow-send-request", false, "allow pm.sendRequest to make HTTP calls from scripts")
	fs.BoolVar(&opts.readOnly, "read-only", false, "only offer the tools that read and run; never change the workspace files")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "Usage: kurlo mcp [workspace] [flags]")
		fmt.Fprint(stderr, "\nServe a Kurlo workspace to AI assistants as a Model Context Protocol server over stdio.\nWithout a workspace argument it serves the workspace the app has open.\n\n")
		fs.PrintDefaults()
	}

	positional := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		positional = args[0]
		args = args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if fs.NArg() > 0 && positional == "" {
		positional = fs.Arg(0)
	}

	appRoot := fileWorkspaceStorePath()
	opts.workspace = positional
	if opts.workspace == "" {
		opts.workspace = appRoot
	}
	opts.loadAppSecrets = sameWorkspaceRoot(opts.workspace, appRoot)
	return opts, nil
}

func newMCPServer(opts mcpServerOptions, out io.Writer) *mcpServer {
	return &mcpServer{
		opts:     opts,
		out:      out,
		jars:     newCookieJarRegistry(),
		cache:    newPreflightCache(),
		tokens:   newOAuth2TokenCache(),
		session:  map[string]*mcpSessionScope{},
		lastRuns: map[string]mcpLastRun{},
		pending:  map[string]context.CancelFunc{},
	}
}

func (s *mcpServer) serve(in io.Reader) error {
	reader := bufio.NewReaderSize(in, 64*1024)
	defer s.inflight.Wait()
	for {
		line, err := reader.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			s.handle(trimmed)
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func (s *mcpServer) handle(line []byte) {
	if line[0] == '[' {
		s.writeError(nil, mcpRPCInvalidRequest, "batched JSON-RPC messages are not supported")
		return
	}
	var msg mcpServerMessage
	if err := json.Unmarshal(line, &msg); err != nil {
		s.writeError(nil, mcpRPCParseError, "parse error: "+err.Error())
		return
	}
	if msg.Method == "" {
		return
	}
	if len(msg.ID) == 0 || string(msg.ID) == "null" {
		if msg.Method == "notifications/cancelled" {
			s.cancel(msg.Params)
		}
		return
	}

	switch msg.Method {
	case "initialize":
		s.writeResult(msg.ID, s.initializeResult(msg.Params))
	case "ping":
		s.writeResult(msg.ID, map[string]any{})
	case mcpMethodDiscover:
		s.writeResult(msg.ID, s.discoverResult())
	case mcpMethodToolsList:
		result := map[string]any{"tools": mcpServerTools(s.opts.readOnly)}
		if mcpServerStateless(msg.Params) {
			result["resultType"] = "complete"
		}
		s.writeResult(msg.ID, result)
	case mcpMethodToolsCall:
		s.startToolCall(msg)
	default:
		s.writeError(msg.ID, mcpRPCMethodNotFound, "method not found: "+msg.Method)
	}
}

func (s *mcpServer) startToolCall(msg mcpServerMessage) {
	key := strings.TrimSpace(string(msg.ID))
	ctx, cancel := context.WithCancel(context.Background())
	s.pendingMu.Lock()
	s.pending[key] = cancel
	s.pendingMu.Unlock()

	s.inflight.Add(1)
	go func() {
		defer s.inflight.Done()
		defer func() {
			s.pendingMu.Lock()
			delete(s.pending, key)
			s.pendingMu.Unlock()
			cancel()
		}()
		result, err := s.callTool(ctx, msg.Params)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			var rpcErr *mcpServerError
			if errors.As(err, &rpcErr) {
				s.writeError(msg.ID, rpcErr.code, rpcErr.message)
				return
			}
			s.writeError(msg.ID, mcpRPCInvalidParams, err.Error())
			return
		}
		if mcpServerStateless(msg.Params) {
			result["resultType"] = "complete"
		}
		s.writeResult(msg.ID, result)
	}()
}

func (s *mcpServer) cancel(params json.RawMessage) {
	var payload struct {
		RequestID json.RawMessage `json:"requestId"`
	}
	if err := json.Unmarshal(params, &payload); err != nil {
		return
	}
	key := strings.TrimSpace(string(payload.RequestID))
	s.pendingMu.Lock()
	cancel := s.pending[key]
	s.pendingMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *mcpServer) write(message map[string]any) {
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, _ = s.out.Write(append(data, '\n'))
}

func (s *mcpServer) writeResult(id json.RawMessage, result any) {
	s.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (s *mcpServer) writeError(id json.RawMessage, code int, message string) {
	var rawID any = id
	if len(id) == 0 {
		rawID = nil
	}
	s.write(map[string]any{"jsonrpc": "2.0", "id": rawID, "error": map[string]any{"code": code, "message": message}})
}

func mcpServerStateless(params json.RawMessage) bool {
	var payload struct {
		Meta map[string]any `json:"_meta"`
	}
	if err := json.Unmarshal(params, &payload); err != nil {
		return false
	}
	version, _ := payload.Meta[mcpMetaProtocolVersion].(string)
	return version == model.McpDefaultProtocolVersion
}

func (s *mcpServer) serverInfo() map[string]any {
	return map[string]any{"name": "kurlo", "title": "Kurlo", "version": appVersion}
}

func (s *mcpServer) instructions() string {
	text := "Kurlo is an API client. This server exposes the saved requests, collections and environments of the Kurlo workspace at " + s.opts.workspace + ". " +
		"Call list_requests to see what is saved and list_environments to see the environments, then run_request to send one saved request and read its response, " +
		"run_collection to run a collection or folder with its test scripts, or send_request for a one-off HTTP call that can use the environment's {{variables}}. " +
		"Values that scripts set with pm.environment.set or pm.collectionVariables.set are kept for later calls in this session, so a login request can hand its token to the requests after it. " +
		"To find out whether a browser would let a web page make a call, pass browserOrigin to run_request or send_request: Kurlo then sends it the way a browser on that origin would, runs the CORS preflight, and reports the CORS error the browser would raise. " +
		"Secret environment values are used when sending but never shown. " +
		"Environments marked protected in Kurlo cannot be used or changed here; ask the user to run those requests in the app. " +
		"When a request uses a {{variable}} that no environment, override or script has set, the result lists it in unresolvedVariables: set it with the variables argument or run the request that sets it first."
	if !s.opts.readOnly {
		text += " The workspace is plain YAML files, usually in Git, and you can keep it up to date as you work: create_collection and save_request add or change saved requests, with JavaScript pm.* test scripts, " +
			"save_example keeps a response as an example that the mock server and response diffs use, delete_request removes one, and set_variable sets a non-secret environment variable. " +
			"Never write a secret into a request: reference it as a {{variable}} and ask the user to add the value in Kurlo as a secret. " +
			"Kurlo, if it is open, picks the changes up by itself."
	}
	if s.opts.env != "" {
		text += " Calls that do not name an environment use " + s.opts.env + "."
	}
	return text
}

func (s *mcpServer) initializeResult(params json.RawMessage) map[string]any {
	var payload struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(params, &payload)
	version := mcpServerLatestHandshakeVersion
	for _, supported := range mcpServerHandshakeVersions {
		if supported == payload.ProtocolVersion {
			version = supported
		}
	}
	return map[string]any{
		"protocolVersion": version,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      s.serverInfo(),
		"instructions":    s.instructions(),
	}
}

func (s *mcpServer) discoverResult() map[string]any {
	return map[string]any{
		"resultType":        "complete",
		"supportedVersions": []string{model.McpDefaultProtocolVersion},
		"capabilities":      map[string]any{"tools": map[string]any{}},
		"instructions":      s.instructions(),
		"_meta":             map[string]any{mcpMetaServerInfo: s.serverInfo()},
	}
}

func mcpServerTools(readOnly bool) []map[string]any {
	environment := map[string]any{"type": "string", "description": "Environment name. Defaults to the one the server was started with."}
	variables := map[string]any{
		"type":                 "object",
		"description":          "Variable overrides for this call, as name to value. They win over the environment.",
		"additionalProperties": map[string]any{"type": "string"},
	}
	maxBody := map[string]any{"type": "integer", "description": "Most bytes of the response body to return (default 65536, max 1048576)."}
	browserOrigin := map[string]any{"type": "string", "description": "Send the call the way a browser on this page origin would, for example https://app.example.com: browser headers, the CORS preflight when one is needed, and the CORS error a browser would raise. Omit it and a saved request uses its own browser settings, if any."}
	browserCredentials := map[string]any{"type": "boolean", "description": "With browserOrigin, make it a credentialed request (fetch credentials: include), which a wildcard Access-Control-Allow-Origin does not satisfy."}
	readOnlyTool := map[string]any{"readOnlyHint": true, "openWorldHint": false}
	network := map[string]any{"readOnlyHint": false, "openWorldHint": true}

	tools := []map[string]any{
		{
			"name":        "list_requests",
			"title":       "List saved requests",
			"description": "List the saved requests in the workspace with their collection, folder, protocol, method and URL. The path or id of a request is what run_request and get_request take.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"collection": map[string]any{"type": "string", "description": "Only list requests in this collection."},
					"query":      map[string]any{"type": "string", "description": "Only list requests whose path, method or URL contains every word of this text, ignoring case. For example: \"post orders\"."},
				},
			},
			"annotations": readOnlyTool,
		},
		{
			"name":        "get_request",
			"title":       "Show a saved request",
			"description": "Show how a saved request is defined: method, URL, query parameters, headers, body, auth type, scripts, browser settings, and the saved example responses to compare a live response against. Credentials are not included.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"request": map[string]any{"type": "string", "description": "Request id, path (Collection/Folder/Name) or name."},
				},
				"required": []string{"request"},
			},
			"annotations": readOnlyTool,
		},
		{
			"name":        "list_environments",
			"title":       "List environments",
			"description": "List the workspace's environments and their variables. Secret values are hidden.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
			"annotations": readOnlyTool,
		},
		{
			"name":        "run_request",
			"title":       "Run a saved request",
			"description": "Send one saved HTTP or GraphQL request with its collection defaults, auth and scripts, and return the status, headers, body, timings and test results.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"request":            map[string]any{"type": "string", "description": "Request id, path (Collection/Folder/Name) or name."},
					"environment":        environment,
					"variables":          variables,
					"maxBodyBytes":       maxBody,
					"browserOrigin":      browserOrigin,
					"browserCredentials": browserCredentials,
				},
				"required": []string{"request"},
			},
			"annotations": network,
		},
		{
			"name":        "run_collection",
			"title":       "Run a collection",
			"description": "Run the HTTP and GraphQL requests of a collection or folder in order, with their test scripts, and return a pass/fail summary per request. Realtime requests are skipped. Reports progress after each request when the call carries a progressToken.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"collection":  map[string]any{"type": "string", "description": "Collection name. Omit to run every collection."},
					"folder":      map[string]any{"type": "string", "description": "Only run requests under this folder path (slash-separated)."},
					"environment": environment,
					"variables":   variables,
					"failFast":    map[string]any{"type": "boolean", "description": "Stop at the first failing request."},
				},
			},
			"annotations": network,
		},
		{
			"name":        "send_request",
			"title":       "Send an HTTP request",
			"description": "Send a one-off HTTP request that is not saved in the workspace. {{variables}} in the URL, headers and body are resolved from the environment.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"method": map[string]any{"type": "string", "description": "HTTP method (default GET)."},
					"url":    map[string]any{"type": "string", "description": "Absolute URL; may use {{variables}}."},
					"headers": map[string]any{
						"type":                 "object",
						"description":          "Request headers, as name to value.",
						"additionalProperties": map[string]any{"type": "string"},
					},
					"body":               map[string]any{"type": "string", "description": "Request body. JSON is sent as application/json, anything else as text/plain, unless a Content-Type header says otherwise."},
					"environment":        environment,
					"variables":          variables,
					"maxBodyBytes":       maxBody,
					"browserOrigin":      browserOrigin,
					"browserCredentials": browserCredentials,
				},
				"required": []string{"url"},
			},
			"annotations": network,
		},
	}
	if readOnly {
		return tools
	}
	return append(tools, mcpServerWriteTools()...)
}

func (s *mcpServer) callTool(ctx context.Context, params json.RawMessage) (map[string]any, error) {
	var call struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
		Meta      struct {
			ProgressToken json.RawMessage `json:"progressToken"`
		} `json:"_meta"`
	}
	if err := json.Unmarshal(params, &call); err != nil {
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "invalid tools/call params: " + err.Error()}
	}
	if token := call.Meta.ProgressToken; len(token) > 0 && string(token) != "null" {
		ctx = context.WithValue(ctx, mcpProgressTokenKey{}, token)
	}
	arguments := call.Arguments
	if len(arguments) == 0 || string(arguments) == "null" {
		arguments = json.RawMessage("{}")
	}

	var run func(ctx context.Context, arguments json.RawMessage) (any, error)
	switch call.Name {
	case "list_requests":
		run = s.toolListRequests
	case "get_request":
		run = s.toolGetRequest
	case "list_environments":
		run = s.toolListEnvironments
	case "run_request":
		run = s.toolRunRequest
	case "run_collection":
		run = s.toolRunCollection
	case "send_request":
		run = s.toolSendRequest
	case "create_collection":
		run = s.toolCreateCollection
	case "save_request":
		run = s.toolSaveRequest
	case "delete_request":
		run = s.toolDeleteRequest
	case "save_example":
		run = s.toolSaveExample
	case "set_variable":
		run = s.toolSetVariable
	default:
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "unknown tool: " + call.Name}
	}
	if s.opts.readOnly && mcpWriteToolNames[call.Name] {
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: call.Name + " is not available: this server was started with --read-only"}
	}

	s.runMu.Lock()
	defer s.runMu.Unlock()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	value, err := run(ctx, arguments)
	if err != nil {
		var rpcErr *mcpServerError
		if errors.As(err, &rpcErr) {
			return nil, err
		}
		return mcpToolText(err.Error(), true), nil
	}
	return mcpToolValue(value)
}

type mcpProgressTokenKey struct{}

func (s *mcpServer) progress(ctx context.Context, done, total int, message string) {
	token, _ := ctx.Value(mcpProgressTokenKey{}).(json.RawMessage)
	if len(token) == 0 {
		return
	}
	s.write(map[string]any{
		"jsonrpc": "2.0",
		"method":  "notifications/progress",
		"params": map[string]any{
			"progressToken": token,
			"progress":      done,
			"total":         total,
			"message":       message,
		},
	})
}

type mcpBrowserArgs struct {
	BrowserOrigin      string `json:"browserOrigin"`
	BrowserCredentials bool   `json:"browserCredentials"`
}

func (b mcpBrowserArgs) apply(req cliSavedRequest) cliSavedRequest {
	origin := strings.TrimSpace(b.BrowserOrigin)
	if origin == "" {
		return req
	}
	req.Settings.BrowserEmulation = true
	req.Settings.BrowserOrigin = origin
	req.Settings.BrowserEnforceCORS = true
	req.Settings.BrowserWithCredentials = b.BrowserCredentials
	return req
}

func mcpToolText(text string, isError bool) map[string]any {
	result := map[string]any{"content": []map[string]any{{"type": "text", "text": text}}}
	if isError {
		result["isError"] = true
	}
	return result
}

func mcpToolValue(value any) (map[string]any, error) {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	var structured map[string]any
	if err := json.Unmarshal(encoded, &structured); err != nil {
		return nil, err
	}
	result := mcpToolText(string(encoded), false)
	result["structuredContent"] = structured
	if failed, ok := value.(interface{ toolFailed() bool }); ok && failed.toolFailed() {
		result["isError"] = true
	}
	return result, nil
}

func mcpDecodeArguments(arguments json.RawMessage, into any) error {
	if err := json.Unmarshal(arguments, into); err != nil {
		return &mcpServerError{code: mcpRPCInvalidParams, message: "invalid arguments: " + err.Error()}
	}
	return nil
}

type mcpWorkspace struct {
	collections  []cliCollection
	requests     []cliSavedRequest
	environments []cliEnvironment
}

func (s *mcpServer) loadWorkspace() (mcpWorkspace, error) {
	secrets := map[string]string{}
	if s.opts.loadAppSecrets {
		if store, _, err := loadLocalRequestStore(requestStorePath()); err == nil && store != nil {
			secrets = stringMap(store["secrets"])
		}
	}
	_, collections, requests, environments, err := loadCLIWorkspaceWithSecrets(s.opts.workspace, secrets)
	if err != nil {
		return mcpWorkspace{}, err
	}
	saved := requests[:0]
	for _, req := range requests {
		if !req.IsDraft {
			saved = append(saved, req)
		}
	}
	return mcpWorkspace{collections: collections, requests: saved, environments: environments}, nil
}

func mcpRequestLabel(req cliSavedRequest) string {
	if name := strings.TrimSpace(req.Name); name != "" {
		return name
	}
	if url := strings.TrimSpace(req.URL); url != "" {
		return url
	}
	return req.ID
}

func mcpRequestPath(req cliSavedRequest) string {
	parts := make([]string, 0, len(req.FolderPath)+2)
	if collection := strings.TrimSpace(req.Collection); collection != "" {
		parts = append(parts, collection)
	}
	parts = append(parts, req.FolderPath...)
	parts = append(parts, mcpRequestLabel(req))
	return strings.Join(parts, "/")
}

func mcpRequestType(req cliSavedRequest) string {
	kind := strings.ToLower(strings.TrimSpace(req.RequestType))
	if kind == "" {
		return "http"
	}
	return kind
}

func mcpFindRequest(requests []cliSavedRequest, ref string) (cliSavedRequest, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return cliSavedRequest{}, &mcpServerError{code: mcpRPCInvalidParams, message: "request is required"}
	}
	for _, req := range requests {
		if req.ID == ref {
			return req, nil
		}
	}
	match := func(key func(cliSavedRequest) string) []cliSavedRequest {
		var found []cliSavedRequest
		for _, req := range requests {
			if strings.EqualFold(strings.TrimSpace(key(req)), ref) {
				found = append(found, req)
			}
		}
		return found
	}
	for _, key := range []func(cliSavedRequest) string{mcpRequestPath, mcpRequestLabel} {
		found := match(key)
		if len(found) == 1 {
			return found[0], nil
		}
		if len(found) > 1 {
			paths := make([]string, 0, len(found))
			for _, req := range found {
				paths = append(paths, fmt.Sprintf("%s (id %s)", mcpRequestPath(req), req.ID))
			}
			return cliSavedRequest{}, fmt.Errorf("%q matches %d requests; pass the path or id of one: %s", ref, len(found), strings.Join(paths, "; "))
		}
	}
	return cliSavedRequest{}, fmt.Errorf("no saved request matches %q; call list_requests to see them", ref)
}

type mcpRequestSummary struct {
	ID         string `json:"id"`
	Path       string `json:"path"`
	Name       string `json:"name"`
	Collection string `json:"collection"`
	Folder     string `json:"folder,omitempty"`
	Type       string `json:"type"`
	Method     string `json:"method,omitempty"`
	URL        string `json:"url"`
	Runnable   bool   `json:"runnable"`
}

func (s *mcpServer) toolListRequests(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Collection string `json:"collection"`
		Query      string `json:"query"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	terms := strings.Fields(strings.ToLower(args.Query))
	summaries := make([]mcpRequestSummary, 0, len(ws.requests))
	for _, req := range ws.requests {
		if args.Collection != "" && !strings.EqualFold(strings.TrimSpace(req.Collection), strings.TrimSpace(args.Collection)) {
			continue
		}
		method := ""
		if kind := mcpRequestType(req); kind == "http" || kind == "graphql" {
			method = strings.ToUpper(defaultString(req.Method, "GET"))
			if isGraphQLRequest(req) {
				method = "POST"
			}
		}
		if !mcpMatchesTerms(strings.ToLower(strings.Join([]string{mcpRequestPath(req), method, req.URL, req.ID}, " ")), terms) {
			continue
		}
		summaries = append(summaries, mcpRequestSummary{
			ID:         req.ID,
			Path:       mcpRequestPath(req),
			Name:       mcpRequestLabel(req),
			Collection: req.Collection,
			Folder:     strings.Join(req.FolderPath, "/"),
			Type:       mcpRequestType(req),
			Method:     method,
			URL:        req.URL,
			Runnable:   cliRunnable(req),
		})
	}
	return map[string]any{"count": len(summaries), "requests": summaries}, nil
}

func mcpMatchesTerms(text string, terms []string) bool {
	for _, term := range terms {
		if !strings.Contains(text, term) {
			return false
		}
	}
	return true
}

type mcpKeyValue struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

func mcpEnabledRows(rows []cliKV) []mcpKeyValue {
	out := make([]mcpKeyValue, 0, len(rows))
	for _, row := range rows {
		if row.Enabled && strings.TrimSpace(row.Key) != "" {
			value := row.Value
			if row.Secret {
				value = "<secret>"
			} else if row.IsFile {
				value = "<file " + defaultString(row.FileName, row.Value) + ">"
			}
			out = append(out, mcpKeyValue{Key: row.Key, Value: value})
		}
	}
	return out
}

func (s *mcpServer) toolGetRequest(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Request string `json:"request"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	req, err := mcpFindRequest(ws.requests, args.Request)
	if err != nil {
		return nil, err
	}
	detail := map[string]any{
		"id":       req.ID,
		"path":     mcpRequestPath(req),
		"type":     mcpRequestType(req),
		"method":   strings.ToUpper(req.Method),
		"url":      req.URL,
		"params":   mcpEnabledRows(req.Params),
		"headers":  mcpEnabledRows(req.Headers),
		"bodyType": defaultString(req.BodyType, "none"),
		"auth":     map[string]any{"type": defaultString(req.Auth.Type, "none")},
		"runnable": cliRunnable(req),
	}
	if req.BodyContent != "" {
		detail["body"] = req.BodyContent
	}
	if rows := mcpEnabledRows(req.FormRows); len(rows) > 0 {
		detail["form"] = rows
	}
	if script := cliPreScript(req); strings.TrimSpace(script) != "" {
		detail["preRequestScript"] = script
	}
	if script := cliTestScript(req); strings.TrimSpace(script) != "" {
		detail["testScript"] = script
	}
	for i := range ws.collections {
		if ws.collections[i].ID == req.CollectionID {
			req = applyCollectionDefaults(req, &ws.collections[i])
			break
		}
	}
	if browser := mcpBrowserSettings(req.Settings); browser != nil {
		detail["browser"] = browser
	}
	if examples := mcpExamples(req.Examples); len(examples) > 0 {
		detail["examples"] = examples
	}
	return detail, nil
}

func mcpBrowserSettings(settings cliSettings) map[string]any {
	if !settings.BrowserEmulation && !settings.BrowserEnforceCORS && !settings.BrowserEnforceCSP {
		return nil
	}
	browser := map[string]any{
		"emulation":       settings.BrowserEmulation,
		"origin":          strings.TrimSpace(settings.BrowserOrigin),
		"withCredentials": settings.BrowserWithCredentials,
		"enforceCors":     settings.BrowserEnforceCORS,
		"enforceCsp":      settings.BrowserEnforceCSP,
	}
	if csp := strings.TrimSpace(settings.BrowserCSP); csp != "" {
		browser["csp"] = csp
	}
	return browser
}

type mcpExample struct {
	Name          string `json:"name"`
	Source        string `json:"source,omitempty"`
	Notes         string `json:"notes,omitempty"`
	Status        int    `json:"status"`
	StatusText    string `json:"statusText,omitempty"`
	ContentType   string `json:"contentType,omitempty"`
	Body          string `json:"body,omitempty"`
	BodyTruncated bool   `json:"bodyTruncated,omitempty"`
}

func mcpExamples(examples []cliExample) []mcpExample {
	out := make([]mcpExample, 0, len(examples))
	for _, example := range examples {
		contentType := strings.TrimSpace(example.Response.BodyMediaType)
		for _, header := range example.Response.Headers {
			if contentType == "" && strings.EqualFold(strings.TrimSpace(header.Key), "Content-Type") {
				contentType = header.Value
			}
		}
		entry := mcpExample{
			Name:        example.Name,
			Source:      example.Source,
			Notes:       example.Notes,
			Status:      example.Response.StatusCode,
			StatusText:  example.Response.Status,
			ContentType: contentType,
		}
		entry.Body, entry.BodyTruncated = mcpTruncate(example.Response.Body, mcpServerExampleBodyLimit)
		out = append(out, entry)
	}
	return out
}

func (s *mcpServer) toolListEnvironments(_ context.Context, _ json.RawMessage) (any, error) {
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	type variable struct {
		Key    string `json:"key"`
		Value  string `json:"value"`
		Secret bool   `json:"secret,omitempty"`
	}
	type environment struct {
		Name             string     `json:"name"`
		Protected        bool       `json:"protected,omitempty"`
		Variables        []variable `json:"variables"`
		SessionVariables []string   `json:"sessionVariables,omitempty"`
	}
	environments := make([]environment, 0, len(ws.environments))
	for _, env := range ws.environments {
		entry := environment{Name: env.Name, Protected: env.Protected, Variables: []variable{}}
		for _, row := range env.Values {
			if !row.Enabled || strings.TrimSpace(row.Key) == "" {
				continue
			}
			if row.Secret {
				entry.Variables = append(entry.Variables, variable{Key: row.Key, Secret: true})
				continue
			}
			entry.Variables = append(entry.Variables, variable{Key: row.Key, Value: row.Value})
		}
		if scope := s.session[strings.ToLower(strings.TrimSpace(env.Name))]; scope != nil {
			entry.SessionVariables = sortedKeys(scope.set)
		}
		environments = append(environments, entry)
	}
	return map[string]any{"default": s.opts.env, "environments": environments}, nil
}

type mcpRunContext struct {
	envName string
	values  map[string]string
	secrets []string
	sm      *state.Manager
}

func (s *mcpServer) prepareRun(ws mcpWorkspace, envName string, overrides map[string]any) (*mcpRunContext, error) {
	envName = strings.TrimSpace(envName)
	if envName == "" {
		envName = s.opts.env
	}
	if env, ok := findEnvironment(ws.environments, envName); ok && env.Protected {
		return nil, fmt.Errorf("environment %s is protected: Kurlo does not send requests with it for AI agents; ask the user to run this in the app, or use another environment", env.Name)
	}
	values, secrets, err := resolveCLIValues(cliOptions{env: envName}, ws.collections, ws.environments, nil)
	if err != nil {
		return nil, err
	}
	if scope := s.session[strings.ToLower(envName)]; scope != nil {
		for key := range scope.removed {
			delete(values, key)
		}
		for key, value := range scope.set {
			values[key] = value
		}
	}
	for key, value := range overrides {
		if key = strings.TrimSpace(key); key != "" {
			values[key] = jsonCellToString(value)
		}
	}
	sm := state.New()
	sm.SetEnvironment(values)
	return &mcpRunContext{envName: envName, values: values, secrets: secrets, sm: sm}, nil
}

func (s *mcpServer) runOptions() cliOptions {
	return cliOptions{
		timeoutMs:        s.opts.timeoutMs,
		insecure:         s.opts.insecure,
		allowSendRequest: s.opts.allowSendRequest,
		iterationCount:   1,
	}
}

func (s *mcpServer) execute(ctx context.Context, run *mcpRunContext, req cliSavedRequest) (cliRunResult, model.HttpResponse) {
	result, resp := executeCLIRequest(ctx, run.sm, s.jars, s.cache, s.tokens, req, 1, nil, s.runOptions(), run.secrets)
	if len(resp.CollectionVariableUpdates) > 0 || len(resp.CollectionVariablesRemoved) > 0 {
		values := run.sm.GetEnvironment()
		for key, value := range resp.CollectionVariableUpdates {
			values[key] = value
		}
		for _, key := range resp.CollectionVariablesRemoved {
			delete(values, key)
		}
		run.sm.SetEnvironment(values)
	}
	return result, resp
}

func (s *mcpServer) remember(run *mcpRunContext) []string {
	after := run.sm.GetEnvironment()
	key := strings.ToLower(run.envName)
	scope := s.session[key]
	var changed []string
	ensure := func() *mcpSessionScope {
		if scope == nil {
			scope = &mcpSessionScope{set: map[string]string{}, removed: map[string]bool{}}
			s.session[key] = scope
		}
		return scope
	}
	for name, value := range after {
		if before, ok := run.values[name]; !ok || before != value {
			ensure().set[name] = value
			delete(scope.removed, name)
			changed = append(changed, name)
		}
	}
	for name := range run.values {
		if _, ok := after[name]; !ok {
			ensure().removed[name] = true
			delete(scope.set, name)
			changed = append(changed, name)
		}
	}
	sort.Strings(changed)
	return changed
}

type mcpHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type mcpRequestOutcome struct {
	Request          string          `json:"request"`
	Method           string          `json:"method"`
	URL              string          `json:"url"`
	Environment      string          `json:"environment,omitempty"`
	Status           int             `json:"status,omitempty"`
	StatusText       string          `json:"statusText,omitempty"`
	DurationMs       int64           `json:"durationMs"`
	Size             int64           `json:"size"`
	Headers          []mcpHeader     `json:"headers,omitempty"`
	Body             string          `json:"body,omitempty"`
	BodyTruncated    bool            `json:"bodyTruncated,omitempty"`
	BodyOmitted      string          `json:"bodyOmitted,omitempty"`
	Tests            []cliTestResult `json:"tests,omitempty"`
	TestsPassed      int             `json:"testsPassed"`
	TestsTotal       int             `json:"testsTotal"`
	Logs             []string        `json:"logs,omitempty"`
	Warnings         []string        `json:"warnings,omitempty"`
	Error            string          `json:"error,omitempty"`
	Skipped          bool            `json:"skipped,omitempty"`
	SkipReason       string          `json:"skipReason,omitempty"`
	VariablesChanged []string        `json:"variablesChanged,omitempty"`
	Unresolved       []string        `json:"unresolvedVariables,omitempty"`
}

var mcpVariableRe = regexp.MustCompile(`\{\{\s*([^{}$\s][^{}]*?)\s*\}\}`)

func mcpUnresolvedVariables(req cliSavedRequest, run *mcpRunContext) []string {
	known := map[string]bool{}
	for _, source := range []map[string]string{run.values, run.sm.GetEnvironment(), run.sm.GetVariables()} {
		for key := range source {
			known[key] = true
		}
	}
	texts := []string{req.URL, req.BodyContent}
	for _, rows := range [][]cliKV{req.Params, req.Headers, req.FormRows} {
		for _, row := range rows {
			if row.Enabled {
				texts = append(texts, row.Key, row.Value)
			}
		}
	}
	if auth, err := json.Marshal(req.Auth); err == nil {
		texts = append(texts, string(auth))
	}
	seen := map[string]bool{}
	var missing []string
	for _, text := range texts {
		for _, match := range mcpVariableRe.FindAllStringSubmatch(text, -1) {
			name := strings.TrimSpace(match[1])
			if strings.HasPrefix(name, "kurloSecret:") || known[name] || seen[name] {
				continue
			}
			seen[name] = true
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	return missing
}

func (o mcpRequestOutcome) toolFailed() bool { return o.Error != "" && o.Status == 0 }

func mcpBodyLimit(requested int) int {
	if requested <= 0 {
		return mcpServerDefaultBodyLimit
	}
	if requested > mcpServerMaxBodyLimit {
		return mcpServerMaxBodyLimit
	}
	return requested
}

func mcpTruncate(text string, limit int) (string, bool) {
	if len(text) <= limit {
		return text, false
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut], true
}

func mcpOutcome(label string, run *mcpRunContext, result cliRunResult, resp model.HttpResponse, bodyLimit int) mcpRequestOutcome {
	secrets := run.secrets
	outcome := mcpRequestOutcome{
		Request:     label,
		Method:      result.Method,
		URL:         redactSecrets(result.URL, secrets),
		Environment: run.envName,
		Status:      resp.StatusCode,
		StatusText:  resp.Status,
		DurationMs:  resp.Duration,
		Size:        resp.Size,
		TestsPassed: result.TestsPassed,
		TestsTotal:  result.TestsTotal,
		Error:       redactSecrets(result.Error, secrets),
		Skipped:     result.Skipped,
		SkipReason:  result.SkipReason,
	}
	for _, header := range resp.Headers {
		outcome.Headers = append(outcome.Headers, mcpHeader{Name: header.Key, Value: redactSecrets(header.Value, secrets)})
	}
	if resp.BodyIsBinary {
		kind := defaultString(resp.BodySniffedType, headerLookup(resp.Headers, "Content-Type"))
		outcome.BodyOmitted = fmt.Sprintf("binary body (%s, %d bytes) is not included", defaultString(kind, "unknown type"), resp.Size)
	} else if resp.Body != "" {
		outcome.Body, outcome.BodyTruncated = mcpTruncate(redactSecrets(resp.Body, secrets), bodyLimit)
	}
	for _, test := range result.Tests {
		test.Error = redactSecrets(test.Error, secrets)
		outcome.Tests = append(outcome.Tests, test)
	}
	for _, log := range append(append([]string{}, resp.PreRequestResult.Logs...), resp.TestResult.Logs...) {
		outcome.Logs = append(outcome.Logs, redactSecrets(log, secrets))
	}
	for _, warning := range resp.Warnings {
		outcome.Warnings = append(outcome.Warnings, redactSecrets(warning, secrets))
	}
	return outcome
}

func (s *mcpServer) toolRunRequest(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Request      string         `json:"request"`
		Environment  string         `json:"environment"`
		Variables    map[string]any `json:"variables"`
		MaxBodyBytes int            `json:"maxBodyBytes"`
		mcpBrowserArgs
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	req, err := mcpFindRequest(ws.requests, args.Request)
	if err != nil {
		return nil, err
	}
	if !cliRunnable(req) {
		return nil, fmt.Errorf("%s is a %s request; only HTTP and GraphQL requests can be run here", mcpRequestPath(req), mcpRequestType(req))
	}
	for i := range ws.collections {
		if ws.collections[i].ID == req.CollectionID {
			req = applyCollectionDefaults(req, &ws.collections[i])
			break
		}
	}
	req = args.apply(req)
	run, err := s.prepareRun(ws, args.Environment, args.Variables)
	if err != nil {
		return nil, err
	}
	result, resp := s.execute(ctx, run, req)
	s.lastRuns[req.ID] = mcpLastRun{request: req, response: resp, secrets: run.secrets}
	outcome := mcpOutcome(mcpRequestPath(req), run, result, resp, mcpBodyLimit(args.MaxBodyBytes))
	outcome.Unresolved = mcpUnresolvedVariables(req, run)
	outcome.VariablesChanged = s.remember(run)
	return outcome, nil
}

func (s *mcpServer) toolSendRequest(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Method       string         `json:"method"`
		URL          string         `json:"url"`
		Headers      map[string]any `json:"headers"`
		Body         string         `json:"body"`
		Environment  string         `json:"environment"`
		Variables    map[string]any `json:"variables"`
		MaxBodyBytes int            `json:"maxBodyBytes"`
		mcpBrowserArgs
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.URL) == "" {
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "url is required"}
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	req := cliSavedRequest{
		RequestType: "http",
		Method:      strings.ToUpper(defaultString(strings.TrimSpace(args.Method), "GET")),
		URL:         args.URL,
		BodyType:    "none",
		BodyContent: args.Body,
	}
	names := make([]string, 0, len(args.Headers))
	for name := range args.Headers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		req.Headers = append(req.Headers, cliKV{Key: name, Value: jsonCellToString(args.Headers[name]), Enabled: true})
	}
	if args.Body != "" {
		req.BodyType = "text"
		if json.Valid([]byte(args.Body)) {
			req.BodyType = "json"
		}
	}
	req = args.apply(req)
	run, err := s.prepareRun(ws, args.Environment, args.Variables)
	if err != nil {
		return nil, err
	}
	result, resp := s.execute(ctx, run, req)
	outcome := mcpOutcome(req.Method+" "+req.URL, run, result, resp, mcpBodyLimit(args.MaxBodyBytes))
	outcome.Unresolved = mcpUnresolvedVariables(req, run)
	outcome.VariablesChanged = s.remember(run)
	return outcome, nil
}

type mcpCollectionRun struct {
	Environment      string         `json:"environment,omitempty"`
	Summary          map[string]any `json:"summary"`
	Results          []cliRunResult `json:"results"`
	VariablesChanged []string       `json:"variablesChanged,omitempty"`
}

func (s *mcpServer) toolRunCollection(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Collection  string         `json:"collection"`
		Folder      string         `json:"folder"`
		Environment string         `json:"environment"`
		Variables   map[string]any `json:"variables"`
		FailFast    bool           `json:"failFast"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	selection := cliOptions{collection: args.Collection}
	for _, segment := range strings.Split(args.Folder, "/") {
		if segment = strings.TrimSpace(segment); segment != "" {
			selection.folder = append(selection.folder, segment)
		}
	}
	selected := selectCLIRequests(ws.requests, selection)
	if len(selected) == 0 {
		return nil, fmt.Errorf("no runnable requests matched; call list_requests to see the collections")
	}
	collectionsByID := make(map[string]*cliCollection, len(ws.collections))
	for i := range ws.collections {
		collectionsByID[ws.collections[i].ID] = &ws.collections[i]
	}
	run, err := s.prepareRun(ws, args.Environment, args.Variables)
	if err != nil {
		return nil, err
	}

	start := time.Now()
	results := make([]cliRunResult, 0, len(selected))
	for _, req := range selected {
		if ctx.Err() != nil {
			break
		}
		result, _ := s.execute(ctx, run, applyCollectionDefaults(req, collectionsByID[req.CollectionID]))
		result.URL = redactSecrets(result.URL, run.secrets)
		result.Error = redactSecrets(result.Error, run.secrets)
		for i := range result.Tests {
			result.Tests[i].Error = redactSecrets(result.Tests[i].Error, run.secrets)
		}
		results = append(results, result)
		s.progress(ctx, len(results), len(selected), mcpProgressMessage(result))
		if args.FailFast && result.failed() {
			break
		}
	}

	summary := summarize(results)
	skipped := 0
	for _, result := range results {
		if result.Skipped {
			skipped++
		}
	}
	return mcpCollectionRun{
		Environment: run.envName,
		Summary: map[string]any{
			"requests":         summary.requests,
			"passed":           summary.passed,
			"failed":           summary.failed,
			"skipped":          skipped,
			"assertions":       summary.assertions,
			"assertionsPassed": summary.assertPass,
			"durationMs":       time.Since(start).Milliseconds(),
			"ok":               summary.failed == 0,
		},
		Results:          results,
		VariablesChanged: s.remember(run),
	}, nil
}

func mcpProgressMessage(result cliRunResult) string {
	outcome := fmt.Sprint(result.StatusCode)
	switch {
	case result.Skipped:
		outcome = "skipped"
	case result.Error != "" && result.StatusCode == 0:
		outcome = "error"
	case result.failed():
		outcome += " failed"
	}
	return fmt.Sprintf("%s %s → %s", result.Method, result.URL, outcome)
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

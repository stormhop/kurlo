package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

var mcpWriteToolNames = map[string]bool{
	"create_collection": true,
	"save_request":      true,
	"delete_request":    true,
	"save_example":      true,
	"set_variable":      true,
	"generate_tests":    true,
}

type mcpStore struct {
	root         string
	workspaces   []map[string]any
	collections  []map[string]any
	requests     []map[string]any
	environments []map[string]any
	cookies      map[string][]map[string]any
}

func loadMCPStore(root string) (*mcpStore, error) {
	workspaces, collections, requests, environments, cookies, diagnostics, err := loadFilesystemWorkspaceStoreWithDiagnostics(root, map[string]string{})
	if err != nil {
		return nil, err
	}
	if len(diagnostics) > 0 {
		return nil, fmt.Errorf("the workspace has files Kurlo cannot read, so it is not changed until they are fixed: %v", workspaceDiagnosticsError(diagnostics))
	}
	if len(workspaces) == 0 {
		return nil, fmt.Errorf("the workspace at %s has no workspaces in it; open it in Kurlo once to create one", root)
	}
	return &mcpStore{root: root, workspaces: workspaces, collections: collections, requests: requests, environments: environments, cookies: cookies}, nil
}

func (st *mcpStore) save() error {
	store := map[string]any{
		"workspaces":   st.workspaces,
		"collections":  st.collections,
		"requests":     st.requests,
		"environments": st.environments,
	}
	if err := validateWorkspaceStorePayload(store); err != nil {
		return err
	}
	disk, err := inspectWorkspaceStoreOnDisk(st.root)
	if err != nil {
		return err
	}
	ensureStoreFilesystemNames(st.workspaces, st.collections, st.requests, st.environments, disk, false)
	existing := map[string]string{}
	secrets := map[string]string{}
	requests := sanitizeRequestsForFilesystem(st.requests, existing, secrets)
	environments := sanitizeEnvironmentsForFilesystem(st.environments, existing, secrets)
	workspaces := sanitizeWorkspacesForFilesystem(st.workspaces)
	collections := sanitizeCollectionsForFilesystem(st.collections, existing, secrets)
	cookies := sanitizeWorkspaceCookiesForFilesystem(st.cookies, entityIDSet(st.workspaces), existing, secrets)
	if len(secrets) > 0 {
		return fmt.Errorf("secret values cannot be written through MCP; put the value in an environment variable marked secret in Kurlo and reference it as {{name}}")
	}
	return writeFilesystemWorkspaceStore(st.root, workspaces, collections, requests, environments, cookies, nil)
}

func (s *mcpServer) mutate(change func(st *mcpStore) (func() any, error)) (any, error) {
	unlock, err := lockWorkspaceWrites(s.opts.workspace)
	if err != nil {
		return nil, err
	}
	defer unlock()
	st, err := loadMCPStore(s.opts.workspace)
	if err != nil {
		return nil, err
	}
	result, err := change(st)
	if err != nil {
		return nil, err
	}
	if err := st.save(); err != nil {
		return nil, err
	}
	return result(), nil
}

func mcpFindByName(items []map[string]any, ref, kind string) (map[string]any, error) {
	ref = strings.TrimSpace(ref)
	for _, item := range items {
		if stringValue(item, "id") == ref {
			return item, nil
		}
	}
	var found []map[string]any
	for _, item := range items {
		if strings.EqualFold(strings.TrimSpace(stringValue(item, "name")), ref) {
			found = append(found, item)
		}
	}
	switch len(found) {
	case 1:
		return found[0], nil
	case 0:
		return nil, fmt.Errorf("no %s named %q; existing: %s", kind, ref, mcpNames(items))
	default:
		return nil, fmt.Errorf("%d %ss are named %q; pass the id of one", len(found), kind, ref)
	}
}

func mcpNames(items []map[string]any) string {
	if len(items) == 0 {
		return "none"
	}
	names := make([]string, 0, len(items))
	for _, item := range items {
		names = append(names, stringValue(item, "name"))
	}
	return strings.Join(names, ", ")
}

func (st *mcpStore) workspace(ref string) (map[string]any, error) {
	if strings.TrimSpace(ref) != "" {
		return mcpFindByName(st.workspaces, ref, "workspace")
	}
	if len(st.workspaces) == 1 {
		return st.workspaces[0], nil
	}
	return nil, fmt.Errorf("this folder holds %d workspaces; pass workspace: one of %s", len(st.workspaces), mcpNames(st.workspaces))
}

func (st *mcpStore) collection(ref string) (map[string]any, error) {
	if strings.TrimSpace(ref) != "" {
		return mcpFindByName(st.collections, ref, "collection")
	}
	if len(st.collections) == 1 {
		return st.collections[0], nil
	}
	if len(st.collections) == 0 {
		return nil, fmt.Errorf("the workspace has no collections yet; call create_collection first")
	}
	return nil, fmt.Errorf("pass collection: one of %s", mcpNames(st.collections))
}

func (st *mcpStore) collectionByID(id string) map[string]any {
	for _, collection := range st.collections {
		if stringValue(collection, "id") == id {
			return collection
		}
	}
	return nil
}

func (st *mcpStore) workspaceByID(id string) map[string]any {
	for _, workspace := range st.workspaces {
		if stringValue(workspace, "id") == id {
			return workspace
		}
	}
	return nil
}

func (st *mcpStore) savedRequests() ([]cliSavedRequest, error) {
	hydrateRequestCollectionNames(st.requests, st.collections)
	decoded, err := decodeMaps[cliSavedRequest](st.requests)
	if err != nil {
		return nil, err
	}
	saved := decoded[:0]
	for _, req := range decoded {
		if !req.IsDraft {
			saved = append(saved, req)
		}
	}
	return saved, nil
}

func (st *mcpStore) request(ref string) (map[string]any, cliSavedRequest, error) {
	saved, err := st.savedRequests()
	if err != nil {
		return nil, cliSavedRequest{}, err
	}
	req, err := mcpFindRequest(saved, ref)
	if err != nil {
		return nil, cliSavedRequest{}, err
	}
	for _, item := range st.requests {
		if stringValue(item, "id") == req.ID {
			return item, req, nil
		}
	}
	return nil, cliSavedRequest{}, fmt.Errorf("request %s disappeared while it was being changed", req.ID)
}

func (st *mcpStore) collectionDir(collection map[string]any) string {
	workspace := st.workspaceByID(stringValue(collection, "workspaceId"))
	return path.Join(fileStoreWorkspacesDir, stringValue(workspace, filesystemNameField), fileStoreCollectionsDir, stringValue(collection, filesystemNameField))
}

func (st *mcpStore) requestFile(request map[string]any) string {
	collection := st.collectionByID(stringValue(request, "collectionId"))
	return path.Join(st.collectionDir(collection), fileStoreRequestsDir, stringValue(request, filesystemNameField)+fileStoreYAMLExt)
}

func (st *mcpStore) requestPath(request map[string]any) string {
	parts := []string{stringValue(st.collectionByID(stringValue(request, "collectionId")), "name")}
	parts = append(parts, mcpFolderPath(request["folderPath"])...)
	return strings.Join(append(parts, stringValue(request, "name")), "/")
}

func mcpFolderPath(value any) []string {
	var out []string
	switch typed := value.(type) {
	case []string:
		out = append(out, typed...)
	case []any:
		for _, segment := range typed {
			if text := stringFromAny(segment); text != "" {
				out = append(out, text)
			}
		}
	}
	return out
}

func mcpSplitFolder(folder string) []string {
	var segments []string
	for _, segment := range strings.Split(folder, "/") {
		if segment = strings.TrimSpace(segment); segment != "" {
			segments = append(segments, segment)
		}
	}
	return segments
}

func mcpEnsureFolder(collection map[string]any, folder []string) {
	if len(folder) == 0 {
		return
	}
	var paths [][]string
	if raw, ok := collection["folderPaths"].([]any); ok {
		for _, entry := range raw {
			paths = append(paths, mcpFolderPath(entry))
		}
	}
	has := func(want []string) bool {
		for _, existing := range paths {
			if strings.EqualFold(strings.Join(existing, "/"), strings.Join(want, "/")) {
				return true
			}
		}
		return false
	}
	for i := 1; i <= len(folder); i++ {
		if prefix := folder[:i]; !has(prefix) {
			paths = append(paths, append([]string{}, prefix...))
		}
	}
	out := make([]any, 0, len(paths))
	for _, entry := range paths {
		segments := make([]any, 0, len(entry))
		for _, segment := range entry {
			segments = append(segments, segment)
		}
		out = append(out, segments)
	}
	collection["folderPaths"] = out
}

func (s *mcpServer) toolCreateCollection(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Name        string `json:"name"`
		Workspace   string `json:"workspace"`
		Description string `json:"description"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(args.Name)
	if name == "" {
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "name is required"}
	}
	return s.mutate(func(st *mcpStore) (func() any, error) {
		workspace, err := st.workspace(args.Workspace)
		if err != nil {
			return nil, err
		}
		workspaceID := stringValue(workspace, "id")
		for _, existing := range st.collections {
			if stringValue(existing, "workspaceId") == workspaceID && strings.EqualFold(strings.TrimSpace(stringValue(existing, "name")), name) {
				return nil, fmt.Errorf("a collection named %q already exists (id %s)", stringValue(existing, "name"), stringValue(existing, "id"))
			}
		}
		collection := map[string]any{
			"id":          "collection-" + uuid.NewString(),
			"workspaceId": workspaceID,
			"name":        name,
			"description": args.Description,
			"collapsed":   false,
			"folderPaths": []any{},
			"defaults":    map[string]any{},
		}
		st.collections = append(st.collections, collection)
		return func() any {
			return map[string]any{
				"id":        stringValue(collection, "id"),
				"name":      name,
				"workspace": stringValue(workspace, "name"),
				"file":      path.Join(st.collectionDir(collection), fileStoreCollection),
			}
		}, nil
	})
}

type mcpRowArg struct {
	Key         string `json:"key"`
	Value       string `json:"value"`
	Description string `json:"description"`
	Enabled     *bool  `json:"enabled"`
}

func mcpRows(field string, args []mcpRowArg, existing any) ([]any, error) {
	var kept []any
	secretKeys := map[string]bool{}
	usedIDs := map[string]bool{}
	if rows, ok := existing.([]any); ok {
		for _, raw := range rows {
			row, ok := raw.(map[string]any)
			if !ok || !boolValue(row["secret"]) {
				continue
			}
			kept = append(kept, row)
			secretKeys[strings.ToLower(strings.TrimSpace(stringValue(row, "key")))] = true
			usedIDs[rowIDValue(row)] = true
		}
	}
	out := make([]any, 0, len(args)+len(kept))
	nextID := 1
	for _, arg := range args {
		key := strings.TrimSpace(arg.Key)
		if key == "" {
			return nil, fmt.Errorf("every entry in %s needs a key", field)
		}
		if secretKeys[strings.ToLower(key)] {
			return nil, fmt.Errorf("%s %q holds a secret value; change it in Kurlo, not through MCP", strings.TrimSuffix(field, "s"), key)
		}
		for usedIDs[fmt.Sprint(nextID)] {
			nextID++
		}
		enabled := true
		if arg.Enabled != nil {
			enabled = *arg.Enabled
		}
		out = append(out, map[string]any{
			"id":          nextID,
			"enabled":     enabled,
			"key":         key,
			"value":       arg.Value,
			"description": arg.Description,
		})
		nextID++
	}
	return append(out, kept...), nil
}

type mcpAuthArg struct {
	Type     string `json:"type"`
	Token    string `json:"token"`
	Username string `json:"username"`
	Password string `json:"password"`
	Key      string `json:"key"`
	Value    string `json:"value"`
	In       string `json:"in"`
}

func mcpAuth(arg mcpAuthArg) (map[string]any, error) {
	secret := func(field, value string) error {
		if secretFieldNeedsVault(value) {
			return fmt.Errorf("auth.%s must be a variable reference such as {{token}}: keep the value itself in an environment variable marked secret in Kurlo", field)
		}
		return nil
	}
	switch kind := strings.ToLower(strings.TrimSpace(arg.Type)); kind {
	case "", "none":
		return map[string]any{"type": "none"}, nil
	case "inherit":
		return map[string]any{"type": "inherit"}, nil
	case "bearer":
		if err := secret("token", arg.Token); err != nil {
			return nil, err
		}
		return map[string]any{"type": "bearer", "bearerToken": arg.Token}, nil
	case "basic":
		if err := secret("password", arg.Password); err != nil {
			return nil, err
		}
		return map[string]any{"type": "basic", "basicUser": arg.Username, "basicPass": arg.Password}, nil
	case "apikey":
		if err := secret("value", arg.Value); err != nil {
			return nil, err
		}
		in := strings.ToLower(strings.TrimSpace(arg.In))
		if in == "" {
			in = "header"
		}
		if in != "header" && in != "query" {
			return nil, fmt.Errorf("auth.in must be header or query")
		}
		return map[string]any{"type": "apikey", "apiKeyName": defaultString(strings.TrimSpace(arg.Key), "X-API-Key"), "apiKeyValue": arg.Value, "apiKeyIn": in}, nil
	default:
		return nil, fmt.Errorf("auth.type %q cannot be set through MCP; use none, inherit, bearer, basic or apikey, or set it up in Kurlo", arg.Type)
	}
}

var mcpRawBodyTypes = map[string]bool{"json": true, "text": true, "xml": true, "html": true}

type mcpSaveRequestArgs struct {
	Request          string          `json:"request"`
	Collection       *string         `json:"collection"`
	Folder           *string         `json:"folder"`
	Name             *string         `json:"name"`
	Type             *string         `json:"type"`
	Method           *string         `json:"method"`
	URL              *string         `json:"url"`
	Params           *[]mcpRowArg    `json:"params"`
	PathVariables    *[]mcpRowArg    `json:"pathVariables"`
	Headers          *[]mcpRowArg    `json:"headers"`
	Body             *mcpTextArg     `json:"body"`
	BodyType         *string         `json:"bodyType"`
	Form             *[]mcpRowArg    `json:"form"`
	Query            *string         `json:"query"`
	Variables        json.RawMessage `json:"variables"`
	Auth             *mcpAuthArg     `json:"auth"`
	PreRequestScript *string         `json:"preRequestScript"`
	TestScript       *string         `json:"testScript"`
	Notes            *string         `json:"notes"`
}

func (s *mcpServer) toolSaveRequest(_ context.Context, arguments json.RawMessage) (any, error) {
	var args mcpSaveRequestArgs
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	return s.mutate(func(st *mcpStore) (func() any, error) {
		creating := strings.TrimSpace(args.Request) == ""
		var request map[string]any
		if creating {
			if args.URL == nil || strings.TrimSpace(*args.URL) == "" {
				return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "url is required for a new request"}
			}
			collectionRef := ""
			if args.Collection != nil {
				collectionRef = *args.Collection
			}
			collection, err := st.collection(collectionRef)
			if err != nil {
				return nil, err
			}
			request = map[string]any{
				"id":           uuid.NewString(),
				"requestType":  "http",
				"collectionId": stringValue(collection, "id"),
				"folderPath":   []any{},
				"method":       "GET",
				"auth":         map[string]any{"type": "inherit"},
				"bodyType":     "none",
				"bodyContent":  "",
				"params":       []any{},
				"headers":      []any{},
				"formRows":     []any{},
			}
		} else {
			found, _, err := st.request(args.Request)
			if err != nil {
				return nil, err
			}
			request = found
			if args.Collection != nil {
				collection, err := st.collection(*args.Collection)
				if err != nil {
					return nil, err
				}
				request["collectionId"] = stringValue(collection, "id")
			}
		}
		if err := mcpApplyRequestArgs(request, args); err != nil {
			return nil, err
		}
		if args.Folder != nil {
			folder := mcpSplitFolder(*args.Folder)
			segments := make([]any, 0, len(folder))
			for _, segment := range folder {
				segments = append(segments, segment)
			}
			request["folderPath"] = segments
		}
		collection := st.collectionByID(stringValue(request, "collectionId"))
		if collection == nil {
			return nil, fmt.Errorf("the request's collection no longer exists")
		}
		mcpEnsureFolder(collection, mcpFolderPath(request["folderPath"]))
		if strings.TrimSpace(stringValue(request, "name")) == "" {
			request["name"] = mcpDefaultRequestName(request)
		}
		if creating {
			st.requests = append(st.requests, request)
		}
		return func() any {
			return map[string]any{
				"id":      stringValue(request, "id"),
				"path":    st.requestPath(request),
				"created": creating,
				"file":    st.requestFile(request),
			}
		}, nil
	})
}

func mcpApplyRequestArgs(request map[string]any, args mcpSaveRequestArgs) error {
	if args.Name != nil {
		request["name"] = strings.TrimSpace(*args.Name)
	}
	if args.Type != nil {
		switch kind := strings.ToLower(strings.TrimSpace(*args.Type)); kind {
		case "http", "graphql":
			request["requestType"] = kind
		default:
			return fmt.Errorf("type must be http or graphql; set up %s requests in Kurlo", *args.Type)
		}
	}
	if kind := stringValue(request, "requestType"); kind != "" && kind != "http" && kind != "graphql" {
		return fmt.Errorf("%s is a %s request; only HTTP and GraphQL requests can be changed through MCP", stringValue(request, "name"), kind)
	}
	if args.Method != nil {
		method := strings.ToUpper(strings.TrimSpace(*args.Method))
		if !mcpMethodRe.MatchString(method) {
			return fmt.Errorf("method %q is not an HTTP method", *args.Method)
		}
		request["method"] = method
	}
	if args.URL != nil {
		request["url"] = strings.TrimSpace(*args.URL)
	}
	for _, rows := range []struct {
		field string
		args  *[]mcpRowArg
	}{{"params", args.Params}, {"pathParams", args.PathVariables}, {"headers", args.Headers}} {
		if rows.args == nil {
			continue
		}
		next, err := mcpRows(rows.field, *rows.args, request[rows.field])
		if err != nil {
			return err
		}
		request[rows.field] = next
	}
	if args.PreRequestScript != nil {
		request["preRequestScriptJs"] = *args.PreRequestScript
	}
	if args.TestScript != nil {
		request["testScriptJs"] = *args.TestScript
	}
	if args.Notes != nil {
		request["requestNotes"] = *args.Notes
	}
	if args.Auth != nil {
		auth, err := mcpAuth(*args.Auth)
		if err != nil {
			return err
		}
		request["auth"] = auth
	}
	if stringValue(request, "requestType") == "graphql" {
		return mcpApplyGraphQLBody(request, args)
	}
	return mcpApplyBody(request, args)
}

func mcpApplyBody(request map[string]any, args mcpSaveRequestArgs) error {
	if args.Query != nil || len(args.Variables) > 0 {
		return fmt.Errorf("query and variables are for GraphQL requests; pass type: graphql")
	}
	if args.Form != nil {
		rows, err := mcpRows("form", *args.Form, request["formRows"])
		if err != nil {
			return err
		}
		request["formRows"] = rows
	}
	bodyType := ""
	if args.BodyType != nil {
		bodyType = strings.ToLower(strings.TrimSpace(*args.BodyType))
	}
	switch {
	case bodyType != "":
	case args.Body != nil && strings.TrimSpace(string(*args.Body)) == "":
		bodyType = "none"
	case args.Body != nil && json.Valid([]byte(string(*args.Body))):
		bodyType = "json"
	case args.Body != nil:
		bodyType = "text"
	case args.Form != nil:
		bodyType = "urlencoded"
	}
	if args.Body != nil {
		request["bodyContent"] = string(*args.Body)
	}
	if bodyType == "" {
		return nil
	}
	switch {
	case mcpRawBodyTypes[bodyType]:
		request["rawBodyType"] = bodyType
	case bodyType == "none", bodyType == "urlencoded", bodyType == "form":
	default:
		return fmt.Errorf("bodyType must be none, json, text, xml, html, urlencoded or form")
	}
	request["bodyType"] = bodyType
	return nil
}

func mcpApplyGraphQLBody(request map[string]any, args mcpSaveRequestArgs) error {
	if args.Body != nil || args.Form != nil || args.BodyType != nil {
		return fmt.Errorf("a GraphQL request takes query and variables, not body, bodyType or form")
	}
	request["bodyType"] = "graphql"
	request["method"] = "POST"
	if args.Query == nil && len(args.Variables) == 0 {
		return nil
	}
	var current struct {
		Query     string `json:"query"`
		Variables any    `json:"variables"`
	}
	_ = json.Unmarshal([]byte(stringValue(request, "bodyContent")), &current)
	if args.Query != nil {
		current.Query = *args.Query
	}
	if len(args.Variables) > 0 {
		var variables any
		if err := json.Unmarshal(args.Variables, &variables); err != nil {
			return fmt.Errorf("variables must be a JSON object: %v", err)
		}
		if text, ok := variables.(string); ok {
			if err := json.Unmarshal([]byte(text), &variables); err != nil {
				return fmt.Errorf("variables must be a JSON object: %v", err)
			}
		}
		if _, ok := variables.(map[string]any); !ok && variables != nil {
			return fmt.Errorf("variables must be a JSON object")
		}
		current.Variables = variables
	}
	if strings.TrimSpace(current.Query) == "" {
		return fmt.Errorf("a GraphQL request needs a query")
	}
	if current.Variables == nil {
		current.Variables = map[string]any{}
	}
	content, err := json.MarshalIndent(map[string]any{"query": current.Query, "variables": current.Variables}, "", "  ")
	if err != nil {
		return err
	}
	request["bodyContent"] = string(content)
	return nil
}

func mcpDefaultRequestName(request map[string]any) string {
	url := stringValue(request, "url")
	if i := strings.IndexAny(url, "?#"); i >= 0 {
		url = url[:i]
	}
	url = mcpSchemeHostRe.ReplaceAllString(url, "")
	url = mcpLeadingVarRe.ReplaceAllString(url, "$1")
	if url == "" {
		url = "/"
	}
	method := stringValue(request, "method")
	if stringValue(request, "requestType") == "graphql" {
		method = "GraphQL"
	}
	return strings.TrimSpace(method + " " + url)
}

func (s *mcpServer) toolDeleteRequest(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Request string `json:"request"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	return s.mutate(func(st *mcpStore) (func() any, error) {
		request, _, err := st.request(args.Request)
		if err != nil {
			return nil, err
		}
		id := stringValue(request, "id")
		result := map[string]any{"deleted": st.requestPath(request), "id": id, "file": st.requestFile(request)}
		kept := st.requests[:0]
		for _, item := range st.requests {
			if stringValue(item, "id") != id {
				kept = append(kept, item)
			}
		}
		st.requests = kept
		return func() any { return result }, nil
	})
}

type mcpLastRun struct {
	request  cliSavedRequest
	response model.HttpResponse
	secrets  []string
}

var mcpSensitiveHeaders = map[string]bool{"set-cookie": true, "cookie": true, "authorization": true, "proxy-authorization": true}

func (s *mcpServer) toolSaveExample(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Request     string         `json:"request"`
		Name        string         `json:"name"`
		Notes       string         `json:"notes"`
		Status      int            `json:"status"`
		Body        *mcpTextArg    `json:"body"`
		Headers     map[string]any `json:"headers"`
		ContentType string         `json:"contentType"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	return s.mutate(func(st *mcpStore) (func() any, error) {
		request, saved, err := st.request(args.Request)
		if err != nil {
			return nil, err
		}
		var response map[string]any
		source := "manual"
		if args.Status == 0 && args.Body == nil {
			last, ok := s.lastRuns[saved.ID]
			if !ok {
				return nil, fmt.Errorf("%s has not been run in this session; call run_request first, or pass status and body", mcpRequestPath(saved))
			}
			if last.response.StatusCode == 0 {
				return nil, fmt.Errorf("the last run of %s got no response to save", mcpRequestPath(saved))
			}
			response = mcpExampleResponse(last.response, last.secrets)
			source = "captured"
		} else {
			response = mcpManualExampleResponse(args.Status, args.Body.ptr(), args.Headers, args.ContentType)
		}
		example := mcpAddExample(request, response, args.Name, args.Notes, source)
		return func() any {
			return map[string]any{
				"request": st.requestPath(request),
				"example": example["name"],
				"id":      stringValue(example, "id"),
				"status":  response["statusCode"],
				"source":  source,
			}
		}, nil
	})
}

func mcpAddExample(request, response map[string]any, name, notes, source string) map[string]any {
	name = strings.TrimSpace(name)
	if name == "" {
		name = defaultString(stringValue(response, "status"), fmt.Sprint(response["statusCode"]))
	}
	example := map[string]any{
		"id":        "example-" + uuid.NewString(),
		"requestId": stringValue(request, "id"),
		"name":      name,
		"source":    source,
		"createdAt": time.Now().UnixMilli(),
		"snapshot": map[string]any{
			"method":      defaultString(stringValue(request, "method"), "GET"),
			"url":         stringValue(request, "url"),
			"params":      mcpPublicRows(request["params"]),
			"headers":     mcpPublicRows(request["headers"]),
			"bodyType":    defaultString(stringValue(request, "bodyType"), "none"),
			"bodyContent": stringValue(request, "bodyContent"),
		},
		"response": response,
		"match":    map[string]any{"pathTemplate": mcpPathTemplate(stringValue(request, "url"))},
	}
	if notes = strings.TrimSpace(notes); notes != "" {
		example["notes"] = notes
	}
	var examples []any
	switch typed := request["examples"].(type) {
	case []any:
		examples = typed
	case []map[string]any:
		for _, item := range typed {
			examples = append(examples, item)
		}
	}
	request["examples"] = append(examples, example)
	return example
}

func mcpPublicRows(value any) []any {
	rows, _ := value.([]any)
	out := make([]any, 0, len(rows))
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if !ok || boolValue(row["secret"]) {
			continue
		}
		out = append(out, cloneMap(row))
	}
	return out
}

func mcpExampleResponse(resp model.HttpResponse, secrets []string) map[string]any {
	headers := make([]any, 0, len(resp.Headers))
	for i, header := range resp.Headers {
		value := redactSecrets(header.Value, secrets)
		if mcpSensitiveHeaders[strings.ToLower(header.Key)] {
			value = ""
		}
		headers = append(headers, map[string]any{"id": i + 1, "enabled": true, "key": header.Key, "value": value})
	}
	body := ""
	if !resp.BodyIsBinary {
		body = redactSecrets(resp.Body, secrets)
	}
	return map[string]any{
		"statusCode":    resp.StatusCode,
		"status":        resp.Status,
		"headers":       headers,
		"body":          body,
		"bodyMediaType": mcpMediaType(headerLookup(resp.Headers, "Content-Type")),
		"durationMs":    resp.Duration,
	}
}

func mcpManualExampleResponse(status int, body *string, headerArgs map[string]any, contentType string) map[string]any {
	if status == 0 {
		status = 200
	}
	text := ""
	if body != nil {
		text = *body
	}
	names := make([]string, 0, len(headerArgs))
	for name := range headerArgs {
		names = append(names, name)
	}
	sort.Strings(names)
	headers := make([]any, 0, len(names)+1)
	for _, name := range names {
		if strings.EqualFold(name, "Content-Type") && contentType == "" {
			contentType = jsonCellToString(headerArgs[name])
			continue
		}
		headers = append(headers, map[string]any{"id": len(headers) + 1, "enabled": true, "key": name, "value": jsonCellToString(headerArgs[name])})
	}
	if contentType == "" && text != "" {
		contentType = "text/plain"
		if json.Valid([]byte(text)) {
			contentType = "application/json"
		}
	}
	if contentType != "" {
		headers = append([]any{map[string]any{"id": 0, "enabled": true, "key": "Content-Type", "value": contentType}}, headers...)
		for i, header := range headers {
			header.(map[string]any)["id"] = i + 1
		}
	}
	statusText := fmt.Sprint(status)
	if reason := http.StatusText(status); reason != "" {
		statusText += " " + reason
	}
	return map[string]any{
		"statusCode":    status,
		"status":        statusText,
		"headers":       headers,
		"body":          text,
		"bodyMediaType": mcpMediaType(contentType),
	}
}

type mcpTextArg string

func (t *mcpTextArg) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*t = mcpTextArg(text)
		return nil
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, data, "", "  "); err != nil {
		return err
	}
	*t = mcpTextArg(buf.String())
	return nil
}

func (t *mcpTextArg) ptr() *string {
	if t == nil {
		return nil
	}
	text := string(*t)
	return &text
}

func mcpMediaType(contentType string) string {
	media, _, _ := strings.Cut(contentType, ";")
	return strings.ToLower(strings.TrimSpace(media))
}

var (
	mcpSchemeHostRe    = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://[^/]*`)
	mcpLeadingVarRe    = regexp.MustCompile(`^\{\{[^{}]*\}\}(/|$)`)
	mcpNumericSegment  = regexp.MustCompile(`^\d+$`)
	mcpUUIDSegment     = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	mcpQueryOrFragment = regexp.MustCompile(`[?#]`)
	mcpMethodRe        = regexp.MustCompile(`^[A-Z]+$`)
)

func mcpPathTemplate(url string) string {
	withoutQuery := mcpQueryOrFragment.Split(url, 2)[0]
	trimmed := mcpSchemeHostRe.ReplaceAllString(withoutQuery, "")
	if trimmed == withoutQuery {
		if loc := mcpLeadingVarRe.FindStringSubmatchIndex(trimmed); loc != nil {
			trimmed = trimmed[loc[2]:]
		}
	}
	if trimmed == "" || trimmed == "/" {
		return "/"
	}
	segments := strings.Split(trimmed, "/")
	for i, segment := range segments {
		if segment == "" || strings.Contains(segment, "{{") {
			continue
		}
		if mcpNumericSegment.MatchString(segment) || mcpUUIDSegment.MatchString(segment) {
			segments[i] = ":id"
		}
	}
	if joined := strings.Join(segments, "/"); joined != "" {
		return joined
	}
	return "/"
}

func (s *mcpServer) toolSetVariable(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Environment string  `json:"environment"`
		Key         string  `json:"key"`
		Value       string  `json:"value"`
		Description *string `json:"description"`
		Workspace   string  `json:"workspace"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	key := strings.TrimSpace(args.Key)
	envName := strings.TrimSpace(defaultString(strings.TrimSpace(args.Environment), s.opts.env))
	if key == "" {
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "key is required"}
	}
	if envName == "" {
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "environment is required"}
	}
	return s.mutate(func(st *mcpStore) (func() any, error) {
		var environment map[string]any
		for _, candidate := range st.environments {
			if strings.EqualFold(strings.TrimSpace(stringValue(candidate, "name")), envName) {
				if environment != nil {
					return nil, fmt.Errorf("more than one environment is named %q", envName)
				}
				environment = candidate
			}
		}
		created := false
		if environment == nil {
			workspace, err := st.workspace(args.Workspace)
			if err != nil {
				return nil, err
			}
			environment = map[string]any{
				"id":          "environment-" + uuid.NewString(),
				"workspaceId": stringValue(workspace, "id"),
				"name":        envName,
				"values":      []any{},
			}
			st.environments = append(st.environments, environment)
			created = true
		}
		if boolValue(environment["protected"]) {
			return nil, fmt.Errorf("environment %s is protected; change its variables in Kurlo", stringValue(environment, "name"))
		}
		rows, _ := environment["values"].([]any)
		var target map[string]any
		maxID := 0
		for _, raw := range rows {
			row, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if id, err := strconv.Atoi(rowIDValue(row)); err == nil && id > maxID {
				maxID = id
			}
			if strings.TrimSpace(stringValue(row, "key")) == key {
				target = row
			}
		}
		previous := ""
		if target != nil {
			if boolValue(target["secret"]) {
				return nil, fmt.Errorf("%s in %s is a secret; change it in Kurlo", key, stringValue(environment, "name"))
			}
			previous = stringValue(target, "value")
			target["value"] = args.Value
			target["enabled"] = true
		} else {
			target = map[string]any{"id": maxID + 1, "enabled": true, "key": key, "value": args.Value, "description": ""}
			rows = append(rows, target)
			environment["values"] = rows
		}
		if args.Description != nil {
			target["description"] = *args.Description
		}
		if scope := s.session[strings.ToLower(strings.TrimSpace(stringValue(environment, "name")))]; scope != nil {
			delete(scope.set, key)
			delete(scope.removed, key)
		}
		return func() any {
			result := map[string]any{
				"environment": stringValue(environment, "name"),
				"key":         key,
				"value":       args.Value,
				"file":        path.Join(fileStoreWorkspacesDir, stringValue(st.workspaceByID(stringValue(environment, "workspaceId")), filesystemNameField), fileStoreEnvironmentsDir, stringValue(environment, filesystemNameField)+fileStoreYAMLExt),
			}
			if created {
				result["createdEnvironment"] = true
			}
			if previous != "" {
				result["previousValue"] = previous
			}
			return result
		}, nil
	})
}

func mcpServerWriteTools() []map[string]any {
	str := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description}
	}
	rows := func(description string) map[string]any {
		return map[string]any{
			"type":        "array",
			"description": description,
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"key":         str("Name."),
					"value":       str("Value; may use {{variables}}."),
					"description": str("What it is for."),
					"enabled":     map[string]any{"type": "boolean", "description": "Defaults to true."},
				},
				"required": []string{"key"},
			},
		}
	}
	workspace := str("Workspace name, when the folder holds more than one.")
	write := map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}
	destructive := map[string]any{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}

	return []map[string]any{
		{
			"name":        "create_collection",
			"title":       "Create a collection",
			"description": "Create an empty collection in the workspace for save_request to put requests in.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":        str("Collection name, for example the service or API it covers."),
					"description": str("Optional description."),
					"workspace":   workspace,
				},
				"required": []string{"name"},
			},
			"annotations": write,
		},
		{
			"name":  "save_request",
			"title": "Create or change a saved request",
			"description": "Create a saved HTTP or GraphQL request, or change one. Without request it creates a new one; with request (id or path) it changes that one, and only the fields you pass are changed. " +
				"params, headers and form replace the whole list. Use {{variables}} for anything that differs per environment, such as {{baseUrl}}. " +
				"Secrets are never written: auth tokens and passwords must be {{variable}} references. Test scripts are JavaScript with the Postman pm.* API, for example pm.test(\"status is 200\", () => pm.response.to.have.status(200)).",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"request":       str("Id or path (Collection/Folder/Name) of the request to change. Omit to create one."),
					"collection":    str("Collection to create the request in, or to move it to. Optional when there is only one."),
					"folder":        str("Folder path inside the collection, slash-separated, for example Users/Admin. An empty string moves the request to the top."),
					"name":          str("Request name. Defaults to the method and path."),
					"type":          map[string]any{"type": "string", "enum": []string{"http", "graphql"}, "description": "Defaults to http."},
					"method":        str("HTTP method (default GET). Ignored for GraphQL, which is always POST."),
					"url":           str("URL; may use {{variables}}. Required for a new request."),
					"params":        rows("Query parameters. Replaces the existing list."),
					"pathVariables": rows("Values for :name segments in the URL path, such as id for /users/:id. Replaces the existing list."),
					"headers":       rows("Request headers. Replaces the existing list."),
					"body":          str("Request body. JSON is stored as a JSON body, anything else as text, unless bodyType says otherwise."),
					"bodyType":      map[string]any{"type": "string", "enum": []string{"none", "json", "text", "xml", "html", "urlencoded", "form"}},
					"form":          rows("Form fields for a urlencoded or form (multipart) body. Replaces the existing list."),
					"query":         str("GraphQL query or mutation."),
					"variables":     map[string]any{"type": "object", "description": "GraphQL variables."},
					"auth": map[string]any{
						"type":        "object",
						"description": "Authentication. Secret parts (token, password, value) must be {{variable}} references. Defaults to inherit, which uses the collection's auth.",
						"properties": map[string]any{
							"type":     map[string]any{"type": "string", "enum": []string{"inherit", "none", "bearer", "basic", "apikey"}},
							"token":    str("Bearer token, as a {{variable}}."),
							"username": str("Basic auth user name."),
							"password": str("Basic auth password, as a {{variable}}."),
							"key":      str("API key header or query parameter name (default X-API-Key)."),
							"value":    str("API key, as a {{variable}}."),
							"in":       map[string]any{"type": "string", "enum": []string{"header", "query"}},
						},
						"required": []string{"type"},
					},
					"preRequestScript": str("JavaScript run before the request is sent."),
					"testScript":       str("JavaScript run on the response; pm.test assertions become the request's tests."),
					"notes":            str("Notes shown with the request."),
				},
			},
			"annotations": write,
		},
		{
			"name":        "delete_request",
			"title":       "Delete a saved request",
			"description": "Delete a saved request and its examples from the workspace. In a Git workspace the deletion shows up in the next commit and can be restored from history.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"request": str("Request id or path (Collection/Folder/Name)."),
				},
				"required": []string{"request"},
			},
			"annotations": destructive,
		},
		{
			"name":  "save_example",
			"title": "Save a response as an example",
			"description": "Save an example response on a saved request. Kurlo's mock server serves examples, and live responses can be compared against them. " +
				"Without status and body it saves the response of the last run_request of that request in this session; secrets and cookies are removed from it. With status and body it saves the response you describe.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"request":     str("Request id or path (Collection/Folder/Name)."),
					"name":        str("Example name, for example \"Created\" or \"Not found\". Defaults to the status."),
					"notes":       str("Optional notes."),
					"status":      map[string]any{"type": "integer", "description": "HTTP status code of a described response."},
					"body":        str("Body of a described response."),
					"contentType": str("Content-Type of a described response. Defaults to application/json for JSON bodies."),
					"headers": map[string]any{
						"type":                 "object",
						"description":          "Other headers of a described response, as name to value.",
						"additionalProperties": map[string]any{"type": "string"},
					},
				},
				"required": []string{"request"},
			},
			"annotations": write,
		},
		{
			"name":        "set_variable",
			"title":       "Set an environment variable",
			"description": "Set a non-secret variable in an environment, creating the environment if it does not exist. The value is written to the environment's file, so it is shared through Git; never use it for a secret. Secret variables and protected environments can only be changed in Kurlo.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"environment": str("Environment name. Defaults to the one the server was started with."),
					"key":         str("Variable name, used in requests as {{key}}."),
					"value":       str("Value."),
					"description": str("What the variable is for."),
					"workspace":   workspace,
				},
				"required": []string{"key", "value"},
			},
			"annotations": write,
		},
	}
}

package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

const mcpImportLimit = 8 << 20

type mcpImportArgs struct {
	ImportID   string `json:"importId"`
	Offset     int    `json:"offset"`
	Limit      int    `json:"limit"`
	Format     string `json:"format"`
	File       string `json:"file"`
	URL        string `json:"url"`
	Content    string `json:"content"`
	Attachment string `json:"attachment"`
	Workspace  string `json:"workspace"`
	Collection string `json:"collection"`
	Name       string `json:"name"`
}

type workspaceImport struct {
	name           string
	description    string
	defaults       map[string]any
	folders        []any
	folderDefaults []any
	requests       []map[string]any
	environments   []map[string]any
	warnings       []string
}

type mcpImportPlan struct {
	id     string
	before map[string][]byte
	after  map[string][]byte
	result map[string]any
}

func (s *mcpServer) importSource(ctx context.Context, args mcpImportArgs) (string, string, error) {
	count := 0
	for _, field := range []string{args.File, args.URL, args.Content, args.Attachment} {
		if field != "" {
			count++
		}
	}
	if count != 1 {
		return "", "", fmt.Errorf("provide exactly one of file, url, content or attachment")
	}
	switch {
	case args.File != "":
		root := defaultString(s.opts.projectRoot, s.opts.workspace)
		body, err := readKnowledgeFile(root, args.File, mcpImportLimit)
		return string(body), filepath.Base(args.File), err
	case args.Attachment != "":
		item, err := s.attachment(args.Attachment)
		if err != nil {
			return "", "", err
		}
		if item.mediaType != "" {
			return "", "", fmt.Errorf("an image cannot be imported as a request collection")
		}
		return string(item.data), item.name, nil
	case args.URL != "":
		if args.Format != "" && args.Format != "openapi" && args.Format != "swagger" {
			return "", "", fmt.Errorf("URL import supports OpenAPI and Swagger documents")
		}
		parsed, err := url.Parse(args.URL)
		if err != nil || !importHTTPURL(parsed) {
			return "", "", fmt.Errorf("provide an HTTP or HTTPS URL without embedded credentials")
		}
		client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 || !importHTTPURL(req.URL) || !strings.EqualFold(req.URL.Hostname(), parsed.Hostname()) {
				return fmt.Errorf("spec URL redirected outside the approved host or exceeded five redirects")
			}
			return nil
		}}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
		if err != nil {
			return "", "", err
		}
		resp, err := client.Do(req)
		if err != nil {
			return "", "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return "", "", fmt.Errorf("spec URL returned HTTP %d", resp.StatusCode)
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, mcpImportLimit+1))
		return string(body), filepath.Base(resp.Request.URL.Path), err
	default:
		return args.Content, "", nil
	}
}

func importHTTPURL(u *url.URL) bool {
	return u != nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil
}

func decodeWorkspaceImport(content, format, name string) (workspaceImport, error) {
	content = strings.TrimPrefix(strings.TrimSpace(content), "\ufeff")
	if content == "" || len(content) > mcpImportLimit || !utf8.ValidString(content) {
		return workspaceImport{}, fmt.Errorf("import source must be nonempty UTF-8 text of at most 8 MiB")
	}
	format = strings.ToLower(strings.TrimSpace(format))
	name = strings.TrimSuffix(name, filepath.Ext(name))
	if format == "curl" || (format == "" && strings.HasPrefix(content, "curl ")) {
		req, err := importCurl(content)
		return workspaceImport{name: defaultString(name, "cURL import"), requests: []map[string]any{req}}, err
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(content), &doc); err != nil {
		decoder := yaml.NewDecoder(strings.NewReader(content))
		if decoder.Decode(&doc) != nil || decoder.Decode(new(yaml.Node)) != io.EOF {
			return workspaceImport{}, fmt.Errorf("expected a single JSON or YAML document")
		}
		doc, _ = normalizeImportYAML(doc).(map[string]any)
	}
	if format == "" {
		switch {
		case doc["openapi"] != nil || doc["swagger"] != nil:
			format = "openapi"
		case doc["resources"] != nil:
			format = "insomnia"
		case doc["log"] != nil:
			format = "har"
		case doc["info"] != nil || doc["values"] != nil:
			format = "postman"
		}
	}
	switch format {
	case "openapi", "swagger":
		return importOpenAPI(doc, defaultString(name, "OpenAPI import"))
	case "postman":
		return importPostman(doc, defaultString(name, "Postman import"))
	case "insomnia":
		return importInsomnia(doc, defaultString(name, "Insomnia import"))
	case "har":
		return importHAR(doc, defaultString(name, "HAR import"))
	}
	return workspaceImport{}, fmt.Errorf("expected OpenAPI, Swagger, Postman, Insomnia, HAR or cURL")
}

func normalizeImportYAML(value any) any {
	switch node := value.(type) {
	case map[string]any:
		for key, child := range node {
			node[key] = normalizeImportYAML(child)
		}
	case map[any]any:
		out := make(map[string]any, len(node))
		for key, child := range node {
			out[fmt.Sprint(key)] = normalizeImportYAML(child)
		}
		return out
	case []any:
		for i, child := range node {
			node[i] = normalizeImportYAML(child)
		}
	}
	return value
}

func (s *mcpServer) toolImportPreview(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args mcpImportArgs
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if args.Offset < 0 || args.Limit < 0 || args.Limit > 40 {
		return nil, fmt.Errorf("offset must be nonnegative and limit must be between 1 and 40")
	}
	if args.ImportID != "" {
		if s.importPlan == nil || s.importPlan.id != args.ImportID {
			return nil, fmt.Errorf("preview this import again to obtain a current importId")
		}
		return s.importPlan.page(args.Offset, args.Limit), nil
	}
	content, name, err := s.importSource(ctx, args)
	if err != nil {
		return nil, err
	}
	if args.URL != "" {
		args.Format = "openapi"
	}
	bundle, err := decodeWorkspaceImport(content, args.Format, name)
	if err != nil {
		return nil, err
	}
	if args.URL != "" {
		base, _ := url.Parse(args.URL)
		for _, row := range mapSlice(bundle.defaults["variables"]) {
			if row["key"] == "baseUrl" {
				row["value"] = resolveImportURL(base, stringValue(row, "value"))
			}
		}
		for _, request := range bundle.requests {
			request["url"] = resolveImportURL(base, stringValue(request, "url"))
		}
	}
	if len(bundle.requests)+len(bundle.environments) == 0 {
		return nil, fmt.Errorf("no supported requests or environments were found")
	}
	if data, err := json.Marshal(bundle.requests); err != nil || len(data) > 16<<20 {
		return nil, fmt.Errorf("the expanded import is larger than 16 MiB")
	}
	if len(bundle.requests) > 1000 || len(bundle.environments) > 50 {
		return nil, fmt.Errorf("preview at most 1000 requests and 50 environments at a time")
	}
	unlock, err := lockWorkspaceWrites(s.opts.workspace)
	if err != nil {
		return nil, err
	}
	defer unlock()
	st, err := s.loadStore()
	if err != nil {
		return nil, err
	}
	result, err := applyImportBundle(st, bundle, args)
	if err != nil {
		return nil, err
	}
	before, err := readWorkspaceFileContents(st.root)
	if err != nil {
		return nil, err
	}
	after, err := stageMCPStore(st, before)
	if err != nil {
		return nil, err
	}
	changes := diffWorkspaceFiles(before, after)
	if len(changes) == 0 {
		return nil, fmt.Errorf("the import has no changes")
	}
	plan := mcpImportPlan{id: uuid.NewString(), before: map[string][]byte{}, after: map[string][]byte{}, result: result}
	for _, change := range changes {
		if data, ok := before[change.Path]; ok {
			plan.before[change.Path] = data
		}
		if data, ok := after[change.Path]; ok {
			plan.after[change.Path] = data
		}
	}
	s.importPlan = &plan
	return plan.page(args.Offset, args.Limit), nil
}

func (plan *mcpImportPlan) page(offset, limit int) map[string]any {
	changes := diffWorkspaceFiles(plan.before, plan.after)
	offset = min(offset, len(changes))
	if limit == 0 {
		limit = 40
	}
	end, size := offset, 0
	for end < len(changes) && end-offset < limit {
		change := changes[end]
		bytes := len(plan.before[change.Path]) + len(plan.after[change.Path])
		if end > offset && bytes > 48000-size {
			break
		}
		size += bytes
		end++
	}
	result := map[string]any{
		"importId": plan.id, "summary": plan.result, "changes": changes[offset:end],
		"changedFiles": len(changes), "previewTruncated": end < len(changes),
	}
	if end < len(changes) {
		result["nextOffset"] = end
	}
	return result
}

func resolveImportURL(base *url.URL, target string) string {
	if strings.Contains(target, "{{") {
		return target
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.IsAbs() {
		return target
	}
	return base.ResolveReference(parsed).String()
}

func (s *mcpServer) toolImportApply(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		ImportID string `json:"importId"`
		Confirm  bool   `json:"confirm"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	plan := s.importPlan
	if plan == nil || plan.id != args.ImportID {
		return nil, fmt.Errorf("preview this import again to obtain a current importId")
	}
	changes := diffWorkspaceFiles(plan.before, plan.after)
	if review := mcpReviewFrom(ctx); review != nil {
		if err := review(changes); err != nil {
			return nil, err
		}
	} else if !args.Confirm {
		return nil, fmt.Errorf("review the preview and pass confirm: true to apply it")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	unlock, err := lockWorkspaceWrites(s.opts.workspace)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if err := applyWorkspaceFiles(s.opts.workspace, plan.before, plan.after); err != nil {
		return nil, err
	}
	s.importPlan = nil
	if record := mcpRecordFrom(ctx); record != nil {
		record.changes = changes
	}
	if s.onWrite != nil {
		s.onWrite(s.opts.workspace, changes)
	}
	return plan.result, nil
}

func applyImportBundle(st *mcpStore, bundle workspaceImport, args mcpImportArgs) (map[string]any, error) {
	var collection, workspace map[string]any
	if args.Collection != "" {
		var err error
		collection, err = st.collection(args.Collection)
		if err != nil {
			return nil, err
		}
		workspace = st.workspaceByID(stringValue(collection, "workspaceId"))
		if args.Workspace != "" {
			expected, err := st.workspace(args.Workspace)
			if err != nil {
				return nil, err
			}
			if stringValue(expected, "id") != stringValue(workspace, "id") {
				return nil, fmt.Errorf("collection does not belong to the selected workspace")
			}
		}
	} else {
		var err error
		workspace, err = st.workspace(args.Workspace)
		if err != nil {
			return nil, err
		}
	}
	workspaceID := stringValue(workspace, "id")
	name := defaultString(strings.TrimSpace(args.Name), bundle.name)
	if collection == nil && len(bundle.requests) > 0 {
		base := name
		used := map[string]bool{}
		for _, existing := range st.collections {
			if stringValue(existing, "workspaceId") == workspaceID {
				used[strings.ToLower(stringValue(existing, "name"))] = true
			}
		}
		for i := 2; used[strings.ToLower(name)]; i++ {
			name = fmt.Sprintf("%s (%d)", base, i)
		}
		collection = map[string]any{"id": uuid.NewString(), "workspaceId": workspaceID, "name": name, "description": bundle.description}
		if len(bundle.defaults) > 0 {
			collection["defaults"] = bundle.defaults
		}
		if len(bundle.folderDefaults) > 0 {
			collection["folderDefaults"] = bundle.folderDefaults
		}
		for _, folder := range bundle.folders {
			mcpEnsureFolder(collection, mcpFolderPath(folder))
		}
		scrubImportValue(collection)
		if err := validateWorkspaceFileContract("collection", collection); err != nil {
			return nil, err
		}
		st.collections = append(st.collections, collection)
	} else if collection != nil {
		if len(bundle.defaults) > 0 || len(bundle.folderDefaults) > 0 {
			addImportVariables(collection, mapSlice(bundle.defaults["variables"]))
			bundle.warnings = append(bundle.warnings, "Nonconflicting variables are added. Imported requests that inherit auth or scripts use the destination's defaults.")
		}
		name = stringValue(collection, "name")
		for _, folder := range bundle.folders {
			mcpEnsureFolder(collection, mcpFolderPath(folder))
		}
	}
	for _, req := range bundle.requests {
		req["collectionId"] = stringValue(collection, "id")
		scrubImportValue(req)
		if err := validateMCPWorkspaceInput(req); err != nil {
			return nil, err
		}
		if err := validateWorkspaceFileContract("request", req); err != nil {
			return nil, fmt.Errorf("request %q: %w", stringValue(req, "name"), err)
		}
		for _, example := range mapSlice(req["examples"]) {
			if err := validateWorkspaceFileContract("example", example); err != nil {
				return nil, fmt.Errorf("example %q: %w", stringValue(example, "name"), err)
			}
		}
		mcpEnsureFolder(collection, mcpFolderPath(req["folderPath"]))
		st.requests = append(st.requests, req)
	}
	for _, env := range bundle.environments {
		env["workspaceId"] = workspaceID
		base := stringValue(env, "name")
		name := base
		for i := 2; slices.ContainsFunc(st.environments, func(existing map[string]any) bool {
			return stringValue(existing, "workspaceId") == workspaceID && strings.EqualFold(stringValue(existing, "name"), name)
		}); i++ {
			name = fmt.Sprintf("%s (%d)", base, i)
		}
		env["name"] = name
		scrubImportValue(env)
		if err := validateWorkspaceFileContract("environment", env); err != nil {
			return nil, err
		}
		st.environments = append(st.environments, env)
	}
	return map[string]any{"collection": name, "collectionId": stringValue(collection, "id"), "requests": len(bundle.requests), "environments": len(bundle.environments), "warnings": bundle.warnings}, nil
}

func addImportVariables(collection map[string]any, imported []map[string]any) {
	if len(imported) == 0 {
		return
	}
	defaults := nestedMap(collection, "defaults")
	if defaults == nil {
		defaults = map[string]any{}
		collection["defaults"] = defaults
	}
	rows := importArray(defaults["variables"])
	names := map[string]bool{}
	for _, row := range mapSlice(rows) {
		names[strings.ToLower(stringValue(row, "key"))] = true
	}
	for _, row := range imported {
		key := strings.ToLower(stringValue(row, "key"))
		if names[key] {
			continue
		}
		scrubImportValue(row)
		rows = append(rows, row)
		names[key] = true
	}
	defaults["variables"] = rows
}

func importText(value any) string {
	if value == nil {
		return ""
	}
	return jsonCellToString(value)
}

func importArray(value any) []any {
	items, _ := value.([]any)
	return items
}

func importRow(key, value string) map[string]any {
	return map[string]any{"id": uuid.NewString(), "key": key, "value": value, "enabled": true}
}

func importRows(value any) []any {
	rows := []any{}
	for _, item := range mapSlice(value) {
		key := defaultString(stringValue(item, "key"), stringValue(item, "name"))
		if key == "" || strings.HasPrefix(key, ":") {
			continue
		}
		row := importRow(key, importText(item["value"]))
		row["enabled"] = item["disabled"] != true && item["enabled"] != false
		if desc := importDescription(item["description"]); desc != "" {
			row["description"] = desc
		}
		if item["type"] == "secret" || item["secret"] == true {
			row["secret"] = true
		}
		if item["type"] == "file" {
			row["isFile"] = true
			row["value"] = ""
		}
		rows = append(rows, row)
	}
	return rows
}

func importDescription(value any) string {
	if obj, ok := value.(map[string]any); ok {
		return stringValue(obj, "content")
	}
	text, _ := value.(string)
	return text
}

func importRequest(name, method, target string) map[string]any {
	method = strings.ToUpper(defaultString(method, "GET"))
	kind := "http"
	if strings.HasPrefix(strings.ToLower(target), "ws://") || strings.HasPrefix(strings.ToLower(target), "wss://") {
		kind = "ws"
	}
	return map[string]any{
		"id": uuid.NewString(), "name": defaultString(name, method+" "+target), "method": method,
		"url": target, "requestType": kind, "auth": map[string]any{"type": "inherit"}, "bodyType": "none",
	}
}

func importSetBody(req map[string]any, mediaType, text string) {
	mediaType, _, _ = mime.ParseMediaType(mediaType)
	kind := "text"
	switch {
	case strings.Contains(mediaType, "json") || json.Valid([]byte(text)):
		kind = "json"
	case strings.Contains(mediaType, "xml"):
		kind = "xml"
	case strings.Contains(mediaType, "html"):
		kind = "html"
	case mediaType == "application/graphql":
		kind = "graphql"
		req["requestType"], req["method"] = "graphql", "POST"
		text = importJSON(map[string]string{"query": text, "variables": ""})
	}
	req["bodyType"], req["bodyContent"] = kind, text
}

func importJSON(value any) string {
	encoded, _ := json.MarshalIndent(value, "", "  ")
	return string(encoded)
}

func importExample(req map[string]any, name, source string, status int, media, body string, headers []any) map[string]any {
	target := stringValue(req, "url")
	query := map[string]any{}
	for _, row := range mapSlice(req["params"]) {
		if boolValue(row["enabled"]) {
			key, value := stringValue(row, "key"), stringValue(row, "value")
			if !importSensitiveName(key) {
				query[key] = value
			}
		}
	}
	snapshot := map[string]any{"method": req["method"], "url": target}
	for _, field := range []string{"params", "headers", "bodyType", "bodyContent"} {
		if value, ok := req[field]; ok {
			snapshot[field] = value
		}
	}
	return map[string]any{
		"id": uuid.NewString(), "name": defaultString(name, strconv.Itoa(status)), "source": source,
		"snapshot": snapshot,
		"match":    map[string]any{"pathTemplate": mcpPathTemplate(target), "query": query},
		"response": map[string]any{"statusCode": status, "status": http.StatusText(status), "bodyMediaType": media, "body": body, "headers": headers},
	}
}

func scrubImportValue(value any) {
	switch node := value.(type) {
	case map[string]any:
		key := stringValue(node, "key")
		if boolValue(node["secret"]) || mcpSensitiveHeaders[strings.ToLower(key)] || importSensitiveName(key) || strings.EqualFold(key, "set-cookie") {
			if raw := stringValue(node, "value"); secretFieldNeedsVault(raw) {
				node["value"] = importPlaceholder(key)
			}
		}
		for key, child := range node {
			if raw, ok := child.(string); ok {
				switch {
				case strings.Contains(raw, "{{kurloSecret:"):
					node[key] = importPlaceholder(key)
				case (slices.Contains(requestAuthSecretFields, key) || slices.Contains(requestSettingSecretFields, key)) && secretFieldNeedsVault(raw):
					node[key] = importPlaceholder(key)
				case key == "url" || key == "oauth2TokenURL" || key == "oauth2AuthURL" || key == "proxyUrl" || (key == "value" && stringValue(node, "key") == "baseUrl"):
					node[key] = scrubImportURL(raw)
				case key == "body" || key == "bodyContent":
					var body any
					if json.Unmarshal([]byte(raw), &body) == nil && scrubImportJSON(body) {
						node[key] = importJSON(body)
					}
				}
			} else {
				scrubImportValue(child)
			}
		}
	case []any:
		for _, child := range node {
			scrubImportValue(child)
		}
	}
}

func importSensitiveName(key string) bool {
	if mcpCredentialName(key) {
		return true
	}
	key = strings.NewReplacer("-", "", "_", "", " ", "").Replace(strings.ToLower(key))
	switch key {
	case "password", "passwd", "clientsecret", "secret", "secretkey", "privatekey", "jwt", "accesstoken", "refreshtoken", "sessionid":
		return true
	}
	return false
}

func scrubImportJSON(value any) bool {
	changed := false
	switch node := value.(type) {
	case map[string]any:
		for key, child := range node {
			if raw, ok := child.(string); ok && importSensitiveName(key) && secretFieldNeedsVault(raw) {
				node[key] = importPlaceholder(key)
				changed = true
			} else if scrubImportJSON(child) {
				changed = true
			}
		}
	case []any:
		for _, child := range node {
			if scrubImportJSON(child) {
				changed = true
			}
		}
	}
	return changed
}

func importPlaceholder(key string) string {
	var name strings.Builder
	for _, ch := range key {
		if ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' {
			name.WriteRune(ch)
		} else {
			name.WriteByte('_')
		}
	}
	return "{{" + defaultString(name.String(), "importSecret") + "}}"
}

func scrubImportURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return raw
	}
	changed := parsed.User != nil
	parsed.User = nil
	values := parsed.Query()
	for key := range values {
		if importSensitiveName(key) {
			values.Set(key, importPlaceholder(key))
			changed = true
		}
	}
	if !changed {
		return raw
	}
	parsed.RawQuery = strings.ReplaceAll(strings.ReplaceAll(values.Encode(), "%7B", "{"), "%7D", "}")
	return parsed.String()
}

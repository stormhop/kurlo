package api

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	stdhtml "html"
	"html/template"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/pkg/browser"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/util"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"golang.org/x/net/http/httpguts"
)

//go:embed docsassets/kurlo.png
var docsIcon []byte

//go:embed docsassets/kurlo-mark.png
var docsMark []byte

//go:embed docsassets/index.html
var collectionDocsSource string

//go:embed docsassets/reference.css
var docsCSS string

//go:embed docsassets/reference.js
var docsReaderScript string

//go:embed docsassets/variable-reader.js
var docsVariableScript string

var docsScript = docsVariableScript + "\n" + docsReaderScript

var docsMarkdown = goldmark.New(goldmark.WithParserOptions(parser.WithAutoHeadingID()), goldmark.WithExtensions(extension.Table, extension.Strikethrough, extension.TaskList))

func docsImageURL(data []byte) template.URL {
	return template.URL("data:image/png;base64," + base64.StdEncoding.EncodeToString(data))
}

var collectionDocsTemplate = template.Must(template.New("docs").Funcs(template.FuncMap{
	"css":    func() template.CSS { return template.CSS(docsCSS) },
	"script": func() template.JS { return template.JS(docsScript) },
	"scriptDigest": func() string {
		digest := sha256.Sum256([]byte(strings.ReplaceAll(docsScript, "\r\n", "\n")))
		return base64.StdEncoding.EncodeToString(digest[:])
	},
	"icon":       func() template.URL { return docsImageURL(docsIcon) },
	"mark":       func() template.URL { return docsImageURL(docsMark) },
	"variableID": func(name string) string { return "variable-" + base64.RawURLEncoding.EncodeToString([]byte(name)) },
	"markdown":   renderDocsMarkdown,
	"bodyHTML":   renderDocsBody,
	"hasText":    func(s string) bool { return strings.TrimSpace(s) != "" },
}).Parse(collectionDocsSource))

func docsNeedsLinkBase(destination []byte) bool {
	if len(destination) == 0 || destination[0] == '#' {
		return false
	}
	target, err := url.Parse(string(destination))
	return err == nil && !target.IsAbs() && target.Host == ""
}

func (a *App) DocsRelativeLinkScopes(notes map[string][]string) []string {
	scopes := []string{}
	for scope, sources := range notes {
		for _, source := range sources {
			if !strings.Contains(source, "[") {
				continue
			}
			document := docsMarkdown.Parser().Parse(text.NewReader([]byte(source)))
			found := false
			ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
				if link, ok := node.(*ast.Link); entering && ok && docsNeedsLinkBase(link.Destination) {
					found = true
					return ast.WalkStop, nil
				}
				return ast.WalkContinue, nil
			})
			if found {
				scopes = append(scopes, scope)
				break
			}
		}
	}
	return scopes
}

func renderDocsMarkdown(scope, source string, base *url.URL) (template.HTML, error) {
	data := []byte(source)
	document := docsMarkdown.Parser().Parse(text.NewReader(data))
	anchors := map[string]string{}
	var links []*ast.Link
	ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			switch n := node.(type) {
			case *ast.Heading:
				if value, ok := n.AttributeString("id"); ok {
					id := string(value.([]byte))
					scoped := scope + "-heading-" + id
					n.SetAttributeString("id", []byte(scoped))
					anchors["#"+id] = "#" + scoped
				}
			case *ast.Link:
				links = append(links, n)
			}
		}
		return ast.WalkContinue, nil
	})
	for _, link := range links {
		if target, ok := anchors[string(link.Destination)]; ok {
			link.Destination = []byte(target)
			continue
		}
		target, err := url.Parse(string(link.Destination))
		if err != nil || strings.HasPrefix(string(link.Destination), "#") {
			continue
		}
		if !target.IsAbs() {
			switch {
			case target.Host != "":
				target.Scheme = "https"
			case base != nil && docsNeedsLinkBase(link.Destination):
				target = base.ResolveReference(target)
			default:
				continue
			}
			link.Destination = []byte(target.String())
		}
		if target.Scheme == "https" || target.Scheme == "http" {
			link.SetAttributeString("target", []byte("_blank"))
			link.SetAttributeString("rel", []byte("noopener noreferrer"))
		}
	}
	var out bytes.Buffer
	err := docsMarkdown.Renderer().Render(&out, data, document)
	return template.HTML(out.String()), err
}

type docsTable struct {
	Title string
	Rows  []cliKV
}

func (table docsTable) HasDescription() bool {
	for _, row := range table.Rows {
		if row.Description != "" {
			return true
		}
	}
	return false
}

type docsMessage struct {
	Method, Address, Body, Media string
	Tables                       []docsTable
}

type docsExample struct {
	Name, Notes, Status, Curl string
	Request, Response         docsMessage
}

type docsProperty struct {
	Label, Value string
}

type docsAI struct {
	Provider, Model, Prompt, System string
	Settings                        []docsProperty
}

func aiReference(req cliSavedRequest) *docsAI {
	provider := req.AiProvider
	switch provider {
	case "openai":
		provider = "OpenAI"
	case "anthropic":
		provider = "Anthropic"
	case "kurlo":
		provider = "Kurlo"
	}
	ai := &docsAI{Provider: provider, Model: req.AiModel, Prompt: req.AiPrompt, System: req.AiSystem}
	for _, setting := range []docsProperty{
		{"Temperature", req.AiTemperature}, {"Top P", req.AiTopP}, {"Max tokens", req.AiMaxTokens},
		{"Max steps", req.AiMaxSteps}, {"Thinking", req.AiThinking}, {"Idle timeout (s)", req.AiIdleTimeoutSec},
	} {
		if setting.Value != "" {
			ai.Settings = append(ai.Settings, setting)
		}
	}
	if req.AiStream != nil {
		stream := "Off"
		if *req.AiStream {
			stream = "On"
		}
		ai.Settings = append(ai.Settings, docsProperty{"Streaming", stream})
	}
	return ai
}

type docsEndpoint struct {
	AI              *docsAI
	Previous, Next  *docsLink
	ID, Name, Notes string
	Curl            string
	Message         docsMessage
	Examples        []docsExample
}

func (message docsMessage) curl(bodyType string) string {
	if bodyType == "form" || bodyType == "urlencoded" || bodyType == "binary" {
		return ""
	}
	if message.Address == "" {
		return ""
	}
	method := "--request " + message.Method
	switch message.Method {
	case "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE":
	case "HEAD":
		if message.Body == "" {
			method = "--head"
		}
	default:
		return ""
	}
	address := message.Address
	var query []string
	var headers []string
	hasContentType := false
	for _, table := range message.Tables {
		switch table.Title {
		case "Path parameters":
			rows := make([]model.KeyValue, 0, len(table.Rows))
			var placeholders []string
			for _, row := range table.Rows {
				rows = append(rows, model.KeyValue{Key: row.Key, Value: row.Value, Enabled: true})
				placeholders = append(placeholders, templatePattern.FindAllString(row.Value, -1)...)
			}
			address = applyPathParams(address, rows)
			for _, placeholder := range placeholders {
				address = strings.ReplaceAll(address, util.EscapePathParamValue(placeholder), placeholder)
			}
		case "Query parameters":
			for _, row := range table.Rows {
				part := docsQueryEscape(row.Key)
				if !row.bareQuery {
					part += "=" + docsQueryEscape(row.Value)
				}
				query = append(query, part)
			}
		case "Headers":
			for _, row := range table.Rows {
				if !isReservedFramingHeader(row.Key) && httpguts.ValidHeaderFieldName(row.Key) && httpguts.ValidHeaderFieldValue(row.Value) {
					headers = append(headers, "--header "+shellQuote(row.Key+": "+row.Value))
					hasContentType = hasContentType || strings.EqualFold(row.Key, "Content-Type")
				}
			}
		}
	}
	if len(query) != 0 {
		address += "?" + strings.Join(query, "&")
	}
	args := []string{method, "--url " + shellQuote(address)}
	args = append(args, headers...)
	if message.Body != "" {
		if media := rawBodyContentTypes[message.Media]; media != "" && !hasContentType {
			args = append(args, "--header "+shellQuote("Content-Type: "+media))
		}
		args = append(args, "--data-raw "+shellQuote(message.Body))
	}
	return "curl --globoff --proto '=http,https' \\\n  " + strings.Join(args, " \\\n  ")
}

func docsQueryEscape(value string) string {
	var result strings.Builder
	end := 0
	for _, match := range templatePattern.FindAllStringIndex(value, -1) {
		result.WriteString(url.QueryEscape(value[end:match[0]]))
		result.WriteString(value[match[0]:match[1]])
		end = match[1]
	}
	result.WriteString(url.QueryEscape(value[end:]))
	return result.String()
}

func (ep docsEndpoint) Detail() string {
	if ep.AI != nil {
		return defaultString(ep.AI.Model, ep.AI.Provider)
	}
	return ep.Message.Address
}

func (ep docsEndpoint) Kind() string {
	switch ep.Message.Method {
	case "AI":
		return "AI request"
	case "WS":
		return "WebSocket connection"
	case "gRPC":
		return "gRPC method"
	case "MCP":
		return "MCP request"
	case "Socket.IO":
		return "Socket.IO connection"
	case "GraphQL":
		return "GraphQL operation"
	default:
		return "HTTP request"
	}
}

type docsGroup struct {
	Root      bool
	Label     string
	Children  []*docsGroup
	Name      string
	Endpoints []docsEndpoint
}

type docsPage struct {
	Name, Description        string
	Count, Folders, Examples int
	Variables                docsVariables
	Environments             []docsEnvironment
	Defaults                 docsMessage
	Auth                     string
	Groups                   []*docsGroup
	Navigation               []*docsGroup
	LinkBase                 *url.URL
}

func docsLinkBase(value string) (*url.URL, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	base, err := url.Parse(strings.TrimSpace(value))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Hostname() == "" || base.User != nil {
		return nil, fmt.Errorf("enter an HTTP or HTTPS documentation URL without credentials")
	}
	base.RawQuery, base.Fragment, base.RawFragment, base.ForceQuery = "", "", "", false
	return base, nil
}

var docsCamelBoundary = regexp.MustCompile(`([a-z0-9])([A-Z])`)
var docsSensitiveKey = regexp.MustCompile(`(?i)(^|[-_ .])(authorization|cookie|password|passwd|pwd|secret|token|api[-_ ]?key|private[-_ ]?key|session|jwt)([-_ .]|$)`)

func docsSensitive(key string) bool {
	return importSensitiveName(key) || docsSensitiveKey.MatchString(docsCamelBoundary.ReplaceAllString(key, "${1}_${2}"))
}

func docsMaskedValue(value string) string {
	if pureVariableReferenceRe.MatchString(value) && !strings.Contains(value, "{{kurloSecret:") {
		return value
	}
	return "••••"
}

func (m *docsMessage) addRows(title string, rows []cliKV) {
	var visible []cliKV
	for _, row := range rows {
		if !row.Enabled || strings.TrimSpace(row.Key) == "" {
			continue
		}
		if row.Secret || docsSensitive(row.Key) {
			row.Value = docsMaskedValue(row.Value)
		} else if row.IsFile {
			row.Value = "File upload"
		}
		visible = append(visible, row)
	}
	if len(visible) > 0 {
		m.Tables = append(m.Tables, docsTable{title, visible})
	}
}

func docsAddress(raw string, params []cliKV) (string, []cliKV) {
	raw, _, _ = strings.Cut(strings.TrimSpace(raw), "#")
	address, query, _ := strings.Cut(raw, "?")
	start := 0
	if scheme := strings.Index(address, "://"); scheme >= 0 {
		start = scheme + 3
	} else if strings.HasPrefix(address, "//") {
		start = 2
	}
	host, _, _ := strings.Cut(address[start:], "/")
	if at := strings.LastIndexByte(host, '@'); at >= 0 {
		address = address[:start] + address[start+at+1:]
	}
	mirrored := map[[2]string]int{}
	secretKeys := map[string]bool{}
	for _, row := range params {
		mirrored[[2]string{row.Key, row.Value}]++
		if row.Secret {
			secretKeys[row.Key] = true
		}
	}
	rows := append([]cliKV(nil), params...)
	for _, part := range strings.Split(query, "&") {
		key, value, hasValue := strings.Cut(part, "=")
		key, err := url.QueryUnescape(key)
		if err != nil || key == "" {
			continue
		}
		value, err = url.QueryUnescape(value)
		if err != nil {
			continue
		}
		pair := [2]string{key, value}
		if mirrored[pair] > 0 {
			mirrored[pair]--
			continue
		}
		rows = append(rows, cliKV{Key: key, Value: value, Enabled: true, Secret: secretKeys[key], bareQuery: !hasValue})
	}
	return address, rows
}

func maskDocsJSON(value any, credentials map[string]bool) bool {
	changed := false
	switch node := value.(type) {
	case map[string]any:
		for key, child := range node {
			if docsSensitive(key) {
				raw, text := child.(string)
				if credentials != nil {
					if text {
						collectDocsVariables(credentials, raw)
					} else if nested, err := json.Marshal(child); err == nil {
						collectDocsVariables(credentials, string(nested))
					}
				}
				node[key] = docsMaskedValue(raw)
				changed = true
			} else if maskDocsJSON(child, credentials) {
				changed = true
			}
		}
	case []any:
		for _, child := range node {
			if maskDocsJSON(child, credentials) {
				changed = true
			}
		}
	}
	return changed
}

func docsBody(body string, credentials map[string]bool) string {
	if !json.Valid([]byte(body)) {
		return body
	}
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) == nil && maskDocsJSON(value, credentials) {
		return importJSON(value)
	}
	return body
}

var docsJSONTokens = regexp.MustCompile(`"(?:\\.|[^"\\])*"[[:space:]]*:|"(?:\\.|[^"\\])*"|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null`)

func renderDocsBody(body string) template.HTML {
	if len(body) > 64*1024 || !json.Valid([]byte(body)) {
		return template.HTML(stdhtml.EscapeString(body))
	}
	var out strings.Builder
	last := 0
	for _, match := range docsJSONTokens.FindAllStringIndex(body, -1) {
		out.WriteString(stdhtml.EscapeString(body[last:match[0]]))
		token := body[match[0]:match[1]]
		class := "json-value"
		if strings.HasSuffix(token, ":") {
			class = "json-key"
		} else if strings.HasPrefix(token, `"`) {
			class = "json-string"
		}
		fmt.Fprintf(&out, `<span class="%s">%s</span>`, class, stdhtml.EscapeString(token))
		last = match[1]
	}
	out.WriteString(stdhtml.EscapeString(body[last:]))
	return template.HTML(out.String())
}

func docsRequest(method, rawURL string, path, params, headers []cliKV, bodyType, body string, form []cliKV, credentials map[string]bool) docsMessage {
	address, query := docsAddress(rawURL, params)
	m := docsMessage{Method: method, Address: address}
	m.addRows("Path parameters", path)
	m.addRows("Query parameters", query)
	m.addRows("Headers", headers)
	switch bodyType {
	case "form", "urlencoded":
		m.addRows("Form fields", form)
	case "none", "binary":
	default:
		m.Body = docsBody(body, credentials)
		m.Media = bodyType
	}
	return m
}

func collectionDocsEndpoint(req cliSavedRequest, credentials map[string]bool) docsEndpoint {
	method := strings.ToUpper(defaultString(req.Method, "GET"))
	switch kind := mcpRequestType(req); {
	case isGraphQLRequest(req):
		method = "GraphQL"
	case kind == "ws" || kind == "http" && (strings.HasPrefix(req.URL, "ws://") || strings.HasPrefix(req.URL, "wss://")):
		method = "WS"
	case kind == "grpc":
		method = "gRPC"
	case kind == "socketio":
		method = "Socket.IO"
	case kind != "http":
		method = strings.ToUpper(kind)
	}
	if method == "AI" {
		req.BodyType, req.BodyContent = "none", ""
		req.PathParams = nil
	}
	message := docsRequest(method, req.URL, req.PathParams, req.Params, req.Headers, req.BodyType, req.BodyContent, req.FormRows, credentials)
	switch req.RequestType {
	case "grpc":
		if req.GrpcMethod != "" && message.Address == "" {
			message.addRows("RPC method", []cliKV{{Key: "Method", Value: req.GrpcMethod, Enabled: true}})
		} else if req.GrpcMethod != "" {
			message.Address = strings.TrimRight(message.Address, "/") + "/" + strings.TrimLeft(req.GrpcMethod, "/")
		}
		message.addRows("Metadata", req.GrpcMetadata)
	case "mcp":
		message.addRows("MCP operation", []cliKV{
			{Key: "Method", Value: req.McpMethod, Enabled: req.McpMethod != ""},
			{Key: "Name", Value: req.McpName, Enabled: req.McpName != ""},
		})
		if (req.McpMethod == "tools/call" || req.McpMethod == "prompts/get") && req.McpArguments != "" {
			message.Body = docsBody(req.McpArguments, credentials)
			message.Media = "application/json"
		}
	}
	name := req.Name
	if name == "" || req.NameAuto {
		name = defaultString(message.Address, "Untitled request")
	}
	endpoint := docsEndpoint{
		ID:   "request-" + base64.RawURLEncoding.EncodeToString([]byte(req.ID)),
		Name: name, Notes: req.RequestNotes, Message: message,
	}
	endpoint.Curl = message.curl(req.BodyType)
	if method == "AI" {
		endpoint.AI = aiReference(req)
		if req.NameAuto || req.Name == "" {
			endpoint.Name = defaultString(endpoint.Detail(), "AI request")
		}
	}
	for _, example := range req.Examples {
		endpoint.Examples = append(endpoint.Examples, collectionDocsExample(example, credentials))
	}
	return endpoint
}

func collectionDocsExample(example cliExample, credentials map[string]bool) docsExample {
	snap, res := example.Snapshot, example.Response
	status := res.Status
	if res.StatusCode != 0 && !strings.HasPrefix(status, fmt.Sprint(res.StatusCode)) {
		status = strings.TrimSpace(fmt.Sprintf("%d %s", res.StatusCode, status))
	}
	response := docsMessage{Body: docsBody(res.Body, credentials), Media: res.BodyMediaType}
	response.addRows("Response headers", res.Headers)
	request := docsRequest(snap.Method, snap.URL, nil, snap.Params, snap.Headers, snap.BodyType, snap.BodyContent, nil, credentials)
	return docsExample{
		Curl: request.curl(snap.BodyType),
		Name: example.Name, Notes: example.Notes, Status: status, Response: response,
		Request: request,
	}
}

type docsLink struct {
	ID, Name string
}

func (m docsMessage) collectVariables(names map[string]bool) {
	collectDocsVariables(names, m.Address, m.Body)
	for _, table := range m.Tables {
		for _, row := range table.Rows {
			collectDocsVariables(names, row.Key, row.Value)
		}
	}
}

func collectDocsVariables(names map[string]bool, values ...string) {
	for _, text := range values {
		for _, match := range templatePattern.FindAllStringSubmatch(text, -1) {
			name := strings.TrimSpace(match[1])
			if name != "" && !strings.HasPrefix(name, "kurloSecret:") {
				names[name] = true
			}
		}
	}
}

func collectionDocsPage(collection cliCollection, requests []cliSavedRequest, environments []cliEnvironment, globals []cliKV) docsPage {
	page := docsPage{Name: collection.Name, Description: collection.Description, Variables: docsVariables{}}
	credentialNames := map[string]bool{}
	page.Variables.addDefinitions(collection.Defaults.Variables, docsVariableDefinition{Scope: "Collection", Source: collection.Name}, credentialNames)
	page.Defaults.addRows("Shared headers", collection.Defaults.Headers)
	if auth := collection.Defaults.Auth.Type; auth != "none" && auth != "inherit" {
		page.Auth = auth
	}
	credentialVariableNames(credentialNames, collection.Defaults.Headers, nil)
	collectDocsVariables(credentialNames, docsAuthCredentials(collection.Defaults.Auth)...)
	pinned := map[string]bool{}
	for _, id := range collection.EnvironmentIDs {
		pinned[strings.TrimSpace(id)] = true
	}
	byPath := map[string]*docsGroup{}
	var groups []*docsGroup
	groupFor := func(path []string) *docsGroup {
		var parent *docsGroup
		for depth := 1; depth <= max(1, len(path)); depth++ {
			name, label, key := "Collection root", "Collection root", ""
			if len(path) > 0 {
				name, label = strings.Join(path[:depth], " / "), path[depth-1]
				key = strings.Join(path[:depth], "\x00")
			}
			group := byPath[key]
			if group == nil {
				group = &docsGroup{Name: name, Label: label, Root: len(path) == 0}
				byPath[key] = group
				groups = append(groups, group)
				if parent == nil {
					page.Navigation = append(page.Navigation, group)
				} else {
					parent.Children = append(parent.Children, group)
				}
				if len(path) > 0 {
					page.Folders++
				}
			}
			parent = group
		}
		return parent
	}
	for _, req := range requests {
		if req.CollectionID != collection.ID || req.IsDraft {
			continue
		}
		req = applyCollectionDefaults(req, &collection)
		endpoint := collectionDocsEndpoint(req, credentialNames)
		page.Variables.addDefinitions(req.Vars, docsVariableDefinition{Scope: "Request", Source: endpoint.Name, SourceID: endpoint.ID}, credentialNames)
		group := groupFor(req.FolderPath)
		group.Endpoints = append(group.Endpoints, endpoint)
		names := map[string]bool{}
		collectDocsVariables(names, docsAuthCredentials(req.Auth)...)
		for key := range names {
			credentialNames[key] = true
		}
		_, params := docsAddress(req.URL, req.Params)
		for _, rows := range [][]cliKV{req.Headers, params, req.PathParams, req.FormRows, req.GrpcMetadata} {
			credentialVariableNames(credentialNames, rows, names)
		}
		for _, example := range req.Examples {
			_, params := docsAddress(example.Snapshot.URL, example.Snapshot.Params)
			credentialVariableNames(credentialNames, params, names)
			credentialVariableNames(credentialNames, example.Snapshot.Headers, names)
			credentialVariableNames(credentialNames, example.Response.Headers, names)
		}
		collectDocsVariables(names, endpoint.Notes)
		endpoint.Message.collectVariables(names)
		if ai := endpoint.AI; ai != nil {
			collectDocsVariables(names, ai.Prompt, ai.System, ai.Model, ai.Provider)
			for _, setting := range ai.Settings {
				collectDocsVariables(names, setting.Value)
			}
		}
		for _, ex := range endpoint.Examples {
			collectDocsVariables(names, ex.Notes)
			ex.Request.collectVariables(names)
			ex.Response.collectVariables(names)
		}
		for name := range names {
			variable := page.Variables.variable(name)
			variable.Uses = append(variable.Uses, docsLink{endpoint.ID, endpoint.Name})
		}
		page.Examples += len(endpoint.Examples)
		page.Count++
	}
	keep := map[string]bool{}
	for key := range page.Variables {
		keep[key] = true
	}
	for _, env := range environments {
		if env.WorkspaceID != collection.WorkspaceID || (len(pinned) > 0 && !pinned[env.ID]) {
			continue
		}
		rows := page.Variables.addDefinitions(env.Values, docsVariableDefinition{Scope: "Environment", Source: env.Name, EnvironmentID: env.ID, Masked: env.Protected}, credentialNames)
		if pinned[env.ID] {
			for _, row := range rows {
				keep[row.Name] = true
			}
			page.Environments = append(page.Environments, docsEnvironment{ID: env.ID, Name: env.Name, Definitions: rows})
		}
	}
	page.Variables.addDefinitions(globals, docsVariableDefinition{Scope: "Global"}, credentialNames)
	page.Variables.maskCredentials(credentialNames)
	page.Variables.keepReferenced(keep)
	sort.SliceStable(page.Environments, func(i, j int) bool { return page.Environments[i].Name < page.Environments[j].Name })
	for _, path := range collection.FolderPaths {
		if len(path) > 0 {
			groupFor(path)
		}
	}
	var previous *docsEndpoint
	for _, group := range groups {
		for i := range group.Endpoints {
			current := &group.Endpoints[i]
			if previous != nil {
				current.Previous = &docsLink{previous.ID, previous.Name}
				previous.Next = &docsLink{current.ID, current.Name}
			}
			previous = current
		}
		if len(group.Endpoints) != 0 || len(group.Children) == 0 {
			page.Groups = append(page.Groups, group)
		}
	}
	return page
}

func writeCollectionDocs(path string, page docsPage, mode os.FileMode) (string, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	var output bytes.Buffer
	if err := collectionDocsTemplate.Execute(&output, page); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return "", err
	}
	if err := replaceFileAtomicMode(path, output.Bytes(), mode); err != nil {
		return "", err
	}
	return path, nil
}

func docsHTMLPath(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".html", ".htm":
		return true
	default:
		return false
	}
}

func openCollectionDocs(path string) error {
	file := filepath.ToSlash(path)
	if !strings.HasPrefix(file, "/") {
		file = "/" + file
	}
	target := url.URL{Scheme: "file", Path: file}
	if err := browser.OpenURL(target.String()); err != nil {
		return fmt.Errorf("documentation was built at %s, but the browser could not open it: %w", path, err)
	}
	return nil
}

func (a *App) ExportCollectionDocs(payload string) error {
	return exportCollectionDocs(payload, func(options runtime.SaveDialogOptions) (string, error) {
		if a.ctx == nil {
			return "", fmt.Errorf("the save dialog is unavailable")
		}
		return runtime.SaveFileDialog(a.ctx, options)
	})
}

func exportCollectionDocs(payload string, choosePath func(runtime.SaveDialogOptions) (string, error)) error {
	var data struct {
		Collection   cliCollection
		Requests     []cliSavedRequest
		Environments []cliEnvironment
		Globals      []cliKV
		LinkBaseURL  string `json:"linkBaseUrl"`
	}
	if err := json.Unmarshal([]byte(payload), &data); err != nil {
		return err
	}
	if data.Collection.ID == "" {
		return fmt.Errorf("select a collection to build")
	}
	base, err := docsLinkBase(data.LinkBaseURL)
	if err != nil {
		return err
	}
	name := defaultString(fileNameForName(data.Collection.Name), "Collection") + "-documentation.html"
	options := runtime.SaveDialogOptions{
		Title: "Save collection documentation", DefaultFilename: name, CanCreateDirectories: true,
		Filters: []runtime.FileFilter{{DisplayName: "HTML document", Pattern: "*.html;*.htm"}},
	}
	for {
		path, err := choosePath(options)
		if err != nil || path == "" {
			return err
		}
		if !docsHTMLPath(path) {
			options.DefaultDirectory = filepath.Dir(path)
			options.DefaultFilename = filepath.Base(path) + ".html"
			options.Title = "Save documentation with an HTML extension"
			continue
		}
		page := collectionDocsPage(data.Collection, data.Requests, flattenCLIEnvironments(data.Environments), data.Globals)
		page.LinkBase = base
		saved, err := writeCollectionDocs(path, page, 0600)
		if err != nil {
			return fmt.Errorf("could not save documentation: %w", err)
		}
		return openCollectionDocs(saved)
	}
}

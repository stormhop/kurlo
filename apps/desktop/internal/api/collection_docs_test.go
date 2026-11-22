package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	stdhtml "html"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	wails "github.com/wailsapp/wails/v2/pkg/runtime"
)

func TestDocsBuildFromYAML(t *testing.T) {
	root, out := t.TempDir(), filepath.Join(t.TempDir(), "docs")
	collections := []map[string]any{
		{"id": "orders", "workspaceId": "w", "name": "Orders API", "description": "## Getting started\n\nUse **sandbox** data.\n\n<script>alert(1)</script>"},
		{"id": "admin", "workspaceId": "w", "name": "Private collection"},
	}
	requests := []map[string]any{
		{"id": "r1", "collectionId": "orders", "name": "Find <order>", "requestType": "http", "method": "GET",
			"url": "https://user:private-user-info@example.test/orders/:id?tag=a&tag=b&api_key=private-query", "requestNotes": "Pass the `id` from checkout. See [access](/handbook#keys) or [the provider's guide](https://provider.example/handbook#keys).",
			"folderPath": []string{"Store", "Orders"}, "pathParams": []any{map[string]any{"key": "id", "enabled": true, "value": "{{orderId}}", "description": "Order number"}},
			"headers": []any{map[string]any{"key": "X-Service", "enabled": true, "secret": true, "value": "private-header"}, map[string]any{"key": "Hidden-Header", "enabled": false}},
			"examples": []any{map[string]any{"id": "ex-1", "name": "Paid order", "requestId": "r1", "notes": "A **paid** order.",
				"snapshot": map[string]any{"method": "GET", "url": "{{baseUrl}}/orders/42", "bodyType": "json", "bodyContent": "{\"note\":\"snapshot payload\"}"},
				"response": map[string]any{"status": "OK", "statusCode": 200, "bodyMediaType": "application/json", "body": "{\"amount\":9007199254740993,\"token\":\"private-example\"}"},
			}},
		},
		{"id": "r2", "collectionId": "admin", "name": "Private endpoint", "method": "DELETE"},
	}
	if err := writeYAMLWorkspaceStore(root, []map[string]any{{"id": "w", "name": "Team"}}, collections, requests, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	args := []string{"build", "--workspace", root, "Orders API", "--out", out}
	if code := RunDocsCLI(args, &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, &stderr)
	}
	path := filepath.Join(out, "index.html")
	if strings.TrimSpace(stdout.String()) != path {
		t.Fatal(stdout.String())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Orders API", `href="#request-directory"><b>1</b><span>Request`, "Store / Orders", "Find &lt;order&gt;", "<strong>sandbox</strong>", "<code>id</code>", "{{orderId}}", "Order number", "https://example.test/orders/:id", "Query parameters", "Copy cURL", "curl --globoff", "X-Service", "••••", "Paid order", "<strong>paid</strong>", "{{baseUrl}}/orders/42", "snapshot payload", "200 OK", "application/json", "9007199254740993", "id=\"request-cjE\"", "href=\"#request-cjE\""} {
		if !bytes.Contains(data, []byte(want)) {
			t.Errorf("site missing %q", want)
		}
	}
	for _, unwanted := range []string{"private-user-info", "private-query", "private-header", "private-example", "Hidden-Header", "Private endpoint", "Private collection", "<script>alert(1)"} {
		if bytes.Contains(data, []byte(unwanted)) {
			t.Errorf("unexpected %q in site", unwanted)
		}
	}
	for _, want := range []string{`<a href="/handbook#keys">access</a>`, `<a href="https://provider.example/handbook#keys" target="_blank" rel="noopener noreferrer">`} {
		if !bytes.Contains(data, []byte(want)) {
			t.Errorf("site missing %q", want)
		}
	}
	named := filepath.Join(out, "Custom reference.HTML")
	stdout.Reset()
	if code := RunDocsCLI([]string{"build", "orders", "--workspace", root, "--out", named}, &stdout, &stderr); code != 0 || strings.TrimSpace(stdout.String()) != named {
		t.Fatal(code, stdout.String(), stderr.String())
	}
	if custom, err := os.ReadFile(named); err != nil || !bytes.Equal(custom, data) {
		t.Fatal("named HTML output differs", err)
	}
	stdout.Reset()
	if code := RunDocsCLI([]string{"build", "orders", "--workspace", root, "--out", named, "--docs-base-url", "https://docs.example.test"}, &stdout, &stderr); code != 0 {
		t.Fatal(code, stderr.String())
	}
	if withBase, err := os.ReadFile(named); err != nil || !bytes.Contains(withBase, []byte(`href="https://docs.example.test/handbook#keys"`)) {
		t.Fatal("relative documentation link did not resolve", err)
	}
	for _, selector := range [][]string{nil, {"unknown"}, {"orders", "extra"}, {"orders", "--collection", "admin"}} {
		if code := RunDocsCLI(append([]string{"build", "--workspace", root, "--out", out}, selector...), &stdout, &stderr); code == 0 {
			t.Errorf("unexpected success for %v", selector)
		}
	}
	if after, err := os.ReadFile(path); err != nil || !bytes.Equal(after, data) {
		t.Fatal("failed build changed the previous site")
	}
	if code := RunDocsCLI([]string{"build", "admin", "--workspace", root, "--out", out}, &stdout, &stderr); code != 0 {
		t.Fatal(stderr.String())
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Contains(after, []byte("Private endpoint")) || bytes.Contains(after, []byte("Paid order")) {
		t.Fatal("rebuild did not replace the site")
	}
}

func TestDocsRelativeLinkScopes(t *testing.T) {
	scopes := (&App{}).DocsRelativeLinkScopes(map[string][]string{
		"":        {"[guide][manual]\n\n[manual]: ../guide"},
		"request": {"[external](https://docs.test)", "[query](?page=2)"},
		"other":   {"[anchor](#next) [host](//docs.test/guide) [mail](mailto:test@example.test)", "`[code](/guide)`", "![image](icon.png)", "[unused]: relative"},
	})
	sort.Strings(scopes)
	if strings.Join(scopes, "|") != "|request" {
		t.Fatal(scopes)
	}
}

func TestDocsMarkdownResolvesSourceLinks(t *testing.T) {
	source := "## Paging\n\n[Paging](#paging), [**Access**](/manuals#%D0%B4), [Guide](guide/), [External](https://external.example/), [Hosting](//external.example/path)"
	withoutBase, err := renderDocsMarkdown("request", source, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`<a href="#request-heading-paging">Paging</a>`, `<a href="/manuals#%D0%B4"><strong>Access</strong></a>`, `<a href="guide/">Guide</a>`} {
		if !strings.Contains(string(withoutBase), want) {
			t.Errorf("missing %q in %s", want, withoutBase)
		}
	}
	base, err := docsLinkBase("https://docs.example.test/api/index.html?private=discarded")
	if err != nil {
		t.Fatal(err)
	}
	rendered, err := renderDocsMarkdown("request", source, base)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`href="#request-heading-paging"`, `href="https://docs.example.test/manuals#%D0%B4"`, `href="https://docs.example.test/api/guide/"`, `target="_blank"`, `href="https://external.example/path"`} {
		if !strings.Contains(string(rendered), want) {
			t.Errorf("missing %q in %s", want, rendered)
		}
	}
	if _, err := docsLinkBase("https://user:pass@docs.example.test"); err == nil {
		t.Fatal("expected credentials to be rejected")
	}
}

func TestDocsBuildSelectorsAndDrafts(t *testing.T) {
	one := cliCollection{ID: "1", Name: "Team"}
	two := cliCollection{ID: "2", Name: "Team"}
	if col, err := docsCollection([]cliCollection{one}, ""); err != nil || col.ID != "1" {
		t.Fatal(col, err)
	}
	if _, err := docsCollection([]cliCollection{one, two}, "Team"); err == nil {
		t.Fatal("ambiguous name accepted")
	}
	page := collectionDocsPage(one, []cliSavedRequest{{ID: "draft", IsDraft: true, CollectionID: "1"}}, nil, nil)
	if page.Count != 0 || len(page.Groups) != 0 {
		t.Fatal("draft in documentation")
	}
}

func TestDocsPreserveRepeatedQueryAndRedactSensitiveInputs(t *testing.T) {
	address, rows := docsAddress("someone:secret@example.test/path?tag=one&tag=two", []cliKV{{Key: "tag", Value: "one", Enabled: true}})
	if address != "example.test/path" || len(rows) != 2 || rows[0].Value != "one" || rows[1].Value != "two" {
		t.Fatal(address, rows)
	}
	message := docsMessage{}
	message.addRows("Headers", []cliKV{{Key: "X-Service-Secret", Enabled: true, Value: "masked"}})
	if message.Tables[0].Rows[0].Value != "••••" {
		t.Fatal("unmasked secret header")
	}
	body := docsBody(`{"pwd":"masked","fields":[{"privateKey":["masked"]}],"api_key":1234,"token":"{{token}}","count":9007199254740993}`, nil)
	if strings.Contains(body, "masked") || strings.Contains(body, "1234") || !strings.Contains(body, "{{token}}") || !strings.Contains(body, "9007199254740993") {
		t.Fatal(body)
	}
}

func TestDocsCurlUsesRedactedRequestTemplate(t *testing.T) {
	req := cliSavedRequest{
		Method: "HEAD", URL: "https://user:private-login@example.test/orders/:id?verbose&tag=one&tag=two",
		PathParams: []cliKV{{Key: "id", Value: "{{ order ID }}", Enabled: true}},
		Headers: []cliKV{
			{Key: "Content-Length", Value: "42", Enabled: true},
			{Key: "Authorization", Value: "private-token", Enabled: true},
			{Key: "X-Title", Value: "O'Connor", Enabled: true},
		},
		BodyType: "json", BodyContent: `{"session":"private-session","active":true}`,
	}
	command := collectionDocsEndpoint(req, nil).Curl
	for _, want := range []string{
		"--request HEAD", "orders/{{ order ID }}?verbose&tag=one&tag=two",
		"Authorization: ••••", shellQuote("X-Title: O'Connor"), "--data-raw", "application/json",
	} {
		if !strings.Contains(command, want) {
			t.Errorf("command missing %q: %s", want, command)
		}
	}
	for _, unwanted := range []string{"--head ", "Content-Length", "private-login", "private-token", "private-session"} {
		if strings.Contains(command, unwanted) {
			t.Errorf("unexpected %q in cURL", unwanted)
		}
	}
	req.BodyType = "none"
	if head := collectionDocsEndpoint(req, nil).Curl; !strings.Contains(head, "--head") || strings.Contains(head, "--data-raw") {
		t.Fatal("wrong bodyless HEAD command", head)
	}
	req.BodyType = "binary"
	if curl := collectionDocsEndpoint(req, nil).Curl; curl != "" {
		t.Fatal("unexpected binary command", curl)
	}
}

func TestDesktopSavesAndOpensChosenHTML(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("this test captures the platform browser command on macOS and Linux")
	}
	root := t.TempDir()
	t.Setenv("HOME", root)
	selected := filepath.Join(root, "Chosen # folder", "My reference.HTML")
	t.Setenv("PATH", root)
	t.Setenv("DOCS_OPEN_LOG", filepath.Join(root, "opened"))
	command := "open"
	if runtime.GOOS == "linux" {
		command = "xdg-open"
	}
	if err := os.WriteFile(filepath.Join(root, command), []byte("#!/bin/sh\nprintf '%s' \"$1\" > \"$DOCS_OPEN_LOG\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	payload := `{"collection":{"id":"../catalog","workspaceId":"ws","name":"Catalog"},"requests":[{"id":"lookup","collectionId":"../catalog","name":"Look up a book"}]}`
	if err := exportCollectionDocs(payload, func(opts wails.SaveDialogOptions) (string, error) {
		if opts.DefaultFilename != "Catalog-documentation.html" || len(opts.Filters) != 1 || !opts.CanCreateDirectories {
			t.Fatal(opts)
		}
		return selected, nil
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(root, "opened"))
	if err != nil {
		t.Fatal(err)
	}
	target, err := url.Parse(string(raw))
	if err != nil || target.Scheme != "file" || target.Fragment != "" || target.Path != selected {
		t.Fatal(string(raw), err)
	}
	data, err := os.ReadFile(target.Path)
	if err != nil || !bytes.Contains(data, []byte("Look up a book")) {
		t.Fatal("browser did not receive generated site", err)
	}
	info, err := os.Stat(target.Path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("unexpected export permissions", info, err)
	}
}

func TestDocsCancelAndWriteFailure(t *testing.T) {
	dest := t.TempDir()
	payload := `{"collection":{"id":"col","name":"Guide"}}`
	calls := 0
	err := exportCollectionDocs(payload, func(opts wails.SaveDialogOptions) (string, error) {
		calls++
		if calls == 1 {
			return filepath.Join(dest, "guide"), nil
		}
		if opts.DefaultDirectory != dest || opts.DefaultFilename != "guide.html" {
			t.Fatal(opts)
		}
		return "", nil
	})
	files, readErr := os.ReadDir(dest)
	if err != nil || readErr != nil || calls != 2 || len(files) != 0 {
		t.Fatal(err, readErr, files)
	}
	blocked := filepath.Join(dest, "dir.html")
	if err := os.Mkdir(blocked, 0700); err != nil {
		t.Fatal(err)
	}
	err = exportCollectionDocs(payload, func(wails.SaveDialogOptions) (string, error) { return blocked, nil })
	if err == nil || !strings.Contains(err.Error(), "could not save") {
		t.Fatal(err)
	}
}

func TestDocsEndpointProtocolAndAutoNames(t *testing.T) {
	for _, tc := range []struct {
		req             cliSavedRequest
		method, address string
	}{
		{cliSavedRequest{RequestType: "grpc", URL: "  ", GrpcMethod: "/Library/Get"}, "gRPC", ""},
		{cliSavedRequest{BodyType: "graphql", URL: "{{baseUrl}}/graphql"}, "GraphQL", "{{baseUrl}}/graphql"},
		{cliSavedRequest{URL: "wss://example.test/feed"}, "WS", "wss://example.test/feed"},
		{cliSavedRequest{RequestType: "grpc", URL: "example.test:443", GrpcMethod: "/Library/Get"}, "gRPC", "example.test:443/Library/Get"},
	} {
		tc.req.NameAuto = true
		tc.req.Name = "auto-title-with-an-inline-token"
		ep := collectionDocsEndpoint(tc.req, nil)
		if ep.Message.Method != tc.method || ep.Message.Address != tc.address || ep.Name != defaultString(tc.address, "Untitled request") {
			t.Fatal(ep)
		}
	}
}

func TestReferenceNavigationAndEnvironmentScope(t *testing.T) {
	collection := cliCollection{
		ID: "library", WorkspaceID: "workspace", Name: "Library",
		EnvironmentIDs: []string{" staging ", "preview", "other-workspace"},
		FolderPaths:    [][]string{{"Store"}, {"Empty"}},
	}
	request := cliSavedRequest{
		ID: "find", CollectionID: collection.ID, Name: "Find", FolderPath: []string{"Store", "Catalog"},
		URL: "{{baseUrl}}/books", Headers: []cliKV{{Key: "Authorization", Value: "literal-secret", Enabled: true}},
		Examples: []cliExample{{
			Name:     "Books found",
			Response: cliExampleResponse{StatusCode: 200, Status: "OK", Body: "[\"Atlas\"]", BodyMediaType: "application/json"},
		}},
		Vars: []cliKV{
			{Key: "baseUrl", Value: "https://catalog.example", Enabled: true}, {Key: "baseUrl", Value: "https://sandbox.example", Enabled: false},
			{Key: "region", Value: "early", Enabled: true}, {Key: "area", Value: "{{region}}", Enabled: true}, {Key: "region", Value: "late", Enabled: true},
			{Key: "empty", Value: "", Enabled: true},
		},
		RequestNotes: "## Paging\n\n[Read about paging](#paging)\n\nArea {{area}}, empty {{empty}}, shard {{shard}}, key {{someKey}}.",
	}
	request.Examples[0].Snapshot.Method = "GET"
	request.Examples[0].Snapshot.URL = "{{baseUrl}}/books?page=1"
	missing := request.Examples[0]
	missing.Name = "Missing book"
	missing.Snapshot.URL = "{{baseUrl}}/books/404"
	missing.Response = cliExampleResponse{StatusCode: 404, Body: "No matching book"}
	missing.Notes = "## Missing scenario"
	request.Examples = append(request.Examples, missing)
	envs := []cliEnvironment{
		{ID: "staging", WorkspaceID: "workspace", Name: "Staging", Values: []cliKV{{Key: "shard", Value: "west", Enabled: true}, {Key: "baseUrl", Value: "https://staging.example", Enabled: true}, {Key: "someKey", Value: "private-env-value", Enabled: true, Secret: true}}},
		{ID: "other-workspace", WorkspaceID: "another", Name: "Private environment"},
		{ID: "preview", WorkspaceID: "workspace", Name: "Preview", Values: []cliKV{{Key: "shard", Value: "east", Enabled: true}}},
		{ID: "personal", WorkspaceID: "workspace", Name: "Personal environment"},
	}
	brief := cliSavedRequest{
		ID: "brief", CollectionID: collection.ID, FolderPath: request.FolderPath, RequestType: "ai", Name: "Write a brief",
		URL: "https://editor.example.test", AiModel: "{{model}}", AiProvider: "openai", AiSystem: "For {{audience}} at {{baseUrl}}",
		AiPrompt: "\nReview <book> {{title}}.", AiMaxTokens: "600", BodyType: "text", BodyContent: "stale-http-body",
		AiConnectionID: "local-connection-id", Vars: []cliKV{{Key: "baseUrl", Value: "https://brief.example", Enabled: true}},
	}
	sparse := cliSavedRequest{
		ID: "sparse", CollectionID: collection.ID, FolderPath: request.FolderPath, Name: "AI-request", RequestType: "ai",
		URL: "  ", AiPrompt: "  \n", RequestNotes: "My note.",
	}
	page := collectionDocsPage(collection, []cliSavedRequest{request, brief, sparse}, envs, nil)
	for _, variable := range []string{"model", "audience", "title"} {
		if links := page.Variables[variable].Uses; len(links) != 1 || links[0].Name != brief.Name {
			t.Fatalf("missing AI variable %s", variable)
		}
	}
	if page.Folders != 3 || len(page.Navigation) != 2 || len(page.Navigation[0].Children) != 1 || len(page.Groups) != 2 {
		t.Fatal("incorrect nested navigation", page)
	}
	if len(page.Variables["baseUrl"].Uses) != 2 || len(page.Environments) != 2 || page.Environments[1].Name != "Staging" {
		t.Fatal(page.Variables, page.Environments)
	}
	var out bytes.Buffer
	if err := collectionDocsTemplate.Execute(&out, page); err != nil {
		t.Fatal(err)
	}
	html := out.String()
	for _, unwanted := range []string{"literal-secret", "private-env-value", "Private environment", "Personal environment", "ZgotmplZ", "stale-http-body", "local-connection-id", "<book>"} {
		if strings.Contains(html, unwanted) {
			t.Fatalf("unexpected %q", unwanted)
		}
	}
	scriptStart, scriptEnd := strings.Index(html, "<script>"), strings.Index(html, "</script>")
	if scriptStart < 0 || scriptEnd <= scriptStart {
		t.Fatal("missing reference script")
	}
	source := strings.ReplaceAll(html[scriptStart+len("<script>"):scriptEnd], "\r\n", "\n")
	hash := sha256.Sum256([]byte(source))
	csp := "sha256-" + base64.StdEncoding.EncodeToString(hash[:])
	id := page.Variables["baseUrl"].Uses[0].ID + "-heading-paging"
	if !strings.Contains(stdhtml.UnescapeString(html), csp) || !strings.Contains(html, `href="#`+id+`"`) || !strings.Contains(html, `id="`+id+`"`) {
		t.Fatal("broken CSP or Markdown anchor")
	}
	t.Run("offline browser", func(t *testing.T) {
		if os.Getenv("KURLO_DOCS_BROWSER_TEST") != "1" {
			t.Skip("set KURLO_DOCS_BROWSER_TEST=1 to run Chromium")
		}
		path := filepath.Join(t.TempDir(), "index.html")
		if err := os.WriteFile(path, out.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("node", "testdata/collection-reference-browser.mjs", path)
		cmd.Env = playwrightTestEnv(os.Environ())
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, output)
		}
	})
}

func TestDocsVariablesAcrossScopes(t *testing.T) {
	collection := cliCollection{ID: "c", WorkspaceID: "w", Name: "Orders", Defaults: cliCollectionDefaults{Variables: []cliKV{
		{Key: "unused", Value: "declared-only", Enabled: false}, {Key: "baseUrl", Value: "collection-host", Enabled: true},
		{Key: "urlWithLogin", Value: "https://user:secret-uri-part@example.test", Enabled: true},
		{Key: "alias", Value: "{{origin}}", Enabled: true}, {Key: "credential", Value: "{{source}}", Enabled: true},
		{Key: "source", Value: "literal-source", Enabled: true}, {Key: "blank", Enabled: true}, {Key: "database", Value: "{{kurloSecret:local-id}}", Enabled: true},
	}}}
	reqs := []cliSavedRequest{{ID: "r", CollectionID: "c", Name: "Read", URL: "{{baseUrl}}/{{unknown}}", Headers: []cliKV{{Key: "Authorization", Value: "Bearer {{credential}}", Enabled: true}}, Vars: []cliKV{
		{Key: "baseUrl", Value: "request-host", Enabled: true}, {Key: "Authorization", Value: "literal-auth", Enabled: true},
	}}}
	envs := flattenCLIEnvironments([]cliEnvironment{
		{ID: "parent", WorkspaceID: "w", Name: "Parent", Values: []cliKV{
			{Key: "baseUrl", Value: "parent-host", Enabled: true}, {Key: "onlyPinned", Value: "staging-only", Enabled: true},
			{Key: "origin", Value: "resolved-origin", Enabled: true}, {Key: "private", Value: "private-literal", Secret: true, Enabled: true},
		}},
		{ID: "child", ParentID: "parent", Name: "Staging", WorkspaceID: "w"},
		{ID: "prod", WorkspaceID: "w", Protected: true, Name: "Production", Values: []cliKV{{Key: "baseUrl", Value: "protected-host", Enabled: true}}},
		{ID: "other", WorkspaceID: "other", Values: []cliKV{{Key: "baseUrl", Value: "foreign-host", Enabled: true}}},
	})
	globals := []cliKV{{Key: "unknown", Value: "global-value", Enabled: true}, {Key: "unrelatedGlobal", Value: "unrelated-value", Enabled: true}}
	for _, pins := range [][]string{nil, {"child", "prod"}} {
		collection.EnvironmentIDs = pins
		page := collectionDocsPage(collection, reqs, envs, globals)
		var html bytes.Buffer
		if err := collectionDocsTemplate.Execute(&html, page); err != nil {
			t.Fatal(err)
		}
		for _, hidden := range []string{"foreign-host", "literal-source", "secret-uri-part", "protected-host", "unrelated-value", "literal-auth", "private-literal", "{{kurloSecret:local-id}}"} {
			if strings.Contains(html.String(), hidden) {
				t.Fatal("unexpected exported value", hidden)
			}
		}
		for _, want := range []string{"request-host", "resolved-origin", "declared-only", "collection-host", "parent-host", "global-value", "Empty string", "Disabled", "Hidden value"} {
			if !strings.Contains(html.String(), want) {
				t.Fatal("missing value or state", want)
			}
		}
		if (page.Variables["onlyPinned"] != nil) != (len(pins) != 0) || len(page.Variables["unused"].Uses) != 0 || len(page.Variables["baseUrl"].Uses) != 1 {
			t.Fatal("incorrect declaration or usage scope", pins)
		}
	}
}

func TestDocsSnippetsIncludeAuthInEveryLanguage(t *testing.T) {
	req := cliSavedRequest{
		ID: "create", Name: "Create order", Method: "POST", URL: "https://api.example.test/orders?limit=10",
		Headers:  []cliKV{{Key: "X-Title", Value: "O'Connor \"quoted\"", Enabled: true}},
		BodyType: "json", BodyContent: `{"paid":true,"note":null,"label":"true"}`,
		Auth: cliAuth{Type: "bearer", BearerToken: "{{token}}"},
	}
	endpoint := collectionDocsEndpoint(req, nil)
	if endpoint.Auth != "Bearer token" || len(endpoint.Snippets) != 3 || endpoint.Curl != endpoint.Snippets[0].Code {
		t.Fatal(endpoint.Auth, endpoint.Snippets)
	}
	languages := map[string]string{}
	for _, snippet := range endpoint.Snippets {
		languages[snippet.Label] = snippet.Code
	}
	checks := map[string][]string{
		"cURL":       {"--header 'Authorization: Bearer {{token}}'", "--url 'https://api.example.test/orders?limit=10'", "Content-Type: application/json"},
		"JavaScript": {`await fetch("https://api.example.test/orders?limit=10"`, `method: "POST"`, `"Authorization": "Bearer {{token}}"`, `"X-Title": "O'Connor \"quoted\""`, "body: JSON.stringify({\"paid\":true"},
		"Python":     {`url = "https://api.example.test/orders?limit=10"`, `"Authorization": "Bearer {{token}}",`, `payload = {"paid":True,"note":None,"label":"true"}`, `requests.request("POST", url, headers=headers, json=payload)`},
	}
	for language, wants := range checks {
		for _, want := range wants {
			if !strings.Contains(languages[language], want) {
				t.Errorf("%s snippet missing %q:\n%s", language, want, languages[language])
			}
		}
	}
	if strings.Contains(languages["Python"], "Content-Type") {
		t.Error("Python snippet should let requests set the JSON content type")
	}

	req.Auth = cliAuth{Type: "bearer", BearerToken: "literal-bearer"}
	req.Headers = append(req.Headers, cliKV{Key: "authorization", Value: "{{custom}}", Enabled: true})
	req.BodyType, req.BodyContent = "text", "plain \"body\""
	endpoint = collectionDocsEndpoint(req, nil)
	for _, snippet := range endpoint.Snippets {
		if strings.Contains(snippet.Code, "literal-bearer") || strings.Count(strings.ToLower(snippet.Code), "authorization") != 1 {
			t.Errorf("%s snippet leaked or duplicated authorization:\n%s", snippet.Label, snippet.Code)
		}
	}
	if python := endpoint.Snippets[2].Code; !strings.Contains(python, `payload = "plain \"body\""`) || !strings.Contains(python, "data=payload.encode()") {
		t.Error(python)
	}

	req.Headers = nil
	req.Auth = cliAuth{Type: "apikey", APIKeyName: "api key", APIKeyIn: "query", APIKeyValue: "literal-key"}
	endpoint = collectionDocsEndpoint(req, nil)
	if endpoint.Auth != "API key in query · api key" || !strings.Contains(endpoint.Curl, "orders?limit=10&api+key=••••") || strings.Contains(endpoint.Curl, "literal-key") {
		t.Fatal(endpoint.Auth, endpoint.Curl)
	}
	req.Auth = cliAuth{Type: "apikey", APIKeyName: "X-Key", APIKeyIn: "header", APIKeyValue: "{{apiKey}}"}
	if curl := collectionDocsEndpoint(req, nil).Curl; !strings.Contains(curl, "'X-Key: {{apiKey}}'") {
		t.Fatal(curl)
	}

	req.Method, req.BodyType, req.BodyContent, req.Auth = "HEAD", "none", "", cliAuth{Type: "basic", BasicUser: "u", BasicPass: "p"}
	endpoint = collectionDocsEndpoint(req, nil)
	if endpoint.Auth != "Basic auth" || !strings.Contains(endpoint.Snippets[1].Code, "response.headers") || strings.Contains(endpoint.Snippets[2].Code, "payload") {
		t.Fatal(endpoint.Auth, endpoint.Snippets)
	}
	req.BodyType = "form"
	if endpoint = collectionDocsEndpoint(req, nil); endpoint.Snippets != nil || endpoint.Curl != "" {
		t.Fatal("form requests have no snippets", endpoint.Snippets)
	}
}

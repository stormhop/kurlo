package api

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"gopkg.in/yaml.v3"
)

func workspaceSchemaPathForTest(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "schemas", "kurlo-workspace-yaml-v1.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func compileWorkspaceSchemaForTest(t *testing.T) *jsonschema.Schema {
	t.Helper()
	data, err := os.ReadFile(workspaceSchemaPathForTest(t))
	if err != nil {
		t.Fatal(err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("schema is not JSON: %v", err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft7)
	if err := compiler.AddResource("kurlo.schema.json", document); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile("kurlo.schema.json")
	if err != nil {
		t.Fatalf("schema does not compile: %v", err)
	}
	return schema
}

func richWorkspacePayloadForTest(t *testing.T) string {
	t.Helper()
	store, err := decodeJSONMap(kurloSaveFlowPayload("https://api.example.test/users", "token-a", []string{"req-main"}, "session"))
	if err != nil {
		t.Fatal(err)
	}
	base := mapSlice(store["requests"])[0]
	row := func(id int, key, value string) map[string]any {
		return map[string]any{"id": id, "enabled": true, "key": key, "value": value, "description": "note"}
	}
	variant := func(id, requestType, method string, changes map[string]any) map[string]any {
		request := cloneMap(base)
		request["id"], request["name"], request["filesystemName"] = id, id, id
		request["requestType"], request["method"] = requestType, method
		request["folderPath"] = []any{}
		for key, value := range changes {
			request[key] = value
		}
		return request
	}
	auth := func(fields map[string]any) map[string]any {
		value := cloneMap(nestedMap(base, "auth"))
		for key, field := range fields {
			value[key] = field
		}
		return value
	}
	var examples []any
	if err := json.Unmarshal([]byte(createdExample), &examples); err != nil {
		t.Fatal(err)
	}
	requests := []any{
		base,
		variant("post-json", "http", "POST", map[string]any{
			"params": []any{row(1, "page", "2")}, "headers": []any{row(2, "X-Trace", "on")},
			"bodyType": "json", "bodyContent": "{\n  \"a\": 1\n}", "requestTab": "examples",
			"auth":              auth(map[string]any{"type": "basic", "basicUser": "u", "basicPass": "p"}),
			"settings":          map[string]any{"timeoutMs": 5000, "followRedirects": false, "httpVersion": "2"},
			"settingsOverrides": map[string]any{"timeoutMs": true},
			"preRequestScript":  "pm.environment.set('a', 1)", "testScript": "pm.test('ok', () => {})",
			"examples": examples,
		}),
		variant("form", "http", "PUT", map[string]any{"bodyType": "urlencoded", "formRows": []any{row(3, "a", "b")}, "auth": auth(map[string]any{"type": "apikey", "apiKeyName": "k", "apiKeyValue": "v", "apiKeyIn": "query"})}),
		variant("oauth", "http", "DELETE", map[string]any{"auth": auth(map[string]any{"type": "oauth2", "oauth2GrantType": "password", "oauth2TokenURL": "https://id.example.test/token", "oauth2ClientID": "c"})}),
		variant("aws", "http", "PATCH", map[string]any{"auth": auth(map[string]any{"type": "aws", "awsAccessKey": "AKIA", "awsSecretKey": "s", "awsRegion": "eu-west-1", "awsService": "s3"})}),
		variant("digest", "http", "HEAD", map[string]any{"auth": auth(map[string]any{"type": "digest", "basicUser": "u", "basicPass": "p"})}),
		variant("inherit", "http", "OPTIONS", map[string]any{"auth": auth(map[string]any{"type": "inherit"})}),
		variant("stream", "http", "SSE", nil),
		variant("graph", "graphql", "POST", map[string]any{"bodyType": "graphql", "bodyContent": "query { me { id } }", "requestTab": "query"}),
		variant("socket", "ws", "GET", map[string]any{"url": "wss://ws.example.test", "requestTab": "body"}),
		variant("sio", "socketio", "GET", map[string]any{"url": "https://sio.example.test", "sioEventName": "ping", "sioAck": true, "sioEvents": []any{row(4, "pong", "")}, "sioArgs": []any{map[string]any{"id": "1", "content": "{}", "bodyType": "json", "encoding": "base64"}}}),
		variant("rpc", "grpc", "POST", map[string]any{"url": "grpc.example.test:443", "grpcMethod": "pkg.Service/Call", "grpcMetadata": []any{row(5, "x-id", "1")}, "requestTab": "service"}),
		variant("tools", "mcp", "POST", map[string]any{"url": "https://mcp.example.test", "mcpMethod": "tools/call", "mcpName": "search", "mcpArguments": "{}"}),
	}
	store["requests"] = requests
	collection := mapSlice(store["collections"])[0]
	collection["folderPaths"] = []any{[]any{"Auth"}}
	collection["defaults"] = map[string]any{
		"headers":          []any{row(6, "X-Team", "api")},
		"variables":        []any{row(7, "base", "https://api.example.test")},
		"auth":             auth(map[string]any{"type": "bearer", "bearerToken": "{{token}}"}),
		"settings":         map[string]any{"timeoutMs": 10000},
		"preRequestScript": "console.log(1)",
	}
	environment := mapSlice(store["environments"])[0]
	environment["values"] = []any{row(8, "host", "localhost"), map[string]any{"id": 9, "enabled": true, "key": "token", "value": "secret", "secret": true}}
	payload, err := json.Marshal(store)
	if err != nil {
		t.Fatal(err)
	}
	return string(payload)
}

func TestEveryFileKurloWritesMatchesThePublishedSchema(t *testing.T) {
	withRequestStoreTestKey(t)
	schema := compileWorkspaceSchemaForTest(t)
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	if err := saveKurloStorePayload(filepath.Join(dir, "requests.json"), root, richWorkspacePayloadForTest(t)); err != nil {
		t.Fatal(err)
	}
	checked := map[string]int{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(path) != fileStoreYAMLExt {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var document any
		if err := yaml.Unmarshal(data, &document); err != nil {
			return err
		}
		asJSON, err := json.Marshal(document)
		if err != nil {
			return err
		}
		instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(asJSON))
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		if err := schema.Validate(instance); err != nil {
			t.Errorf("%s does not match the schema:\n%v\n%s", rel, err, data)
		}
		section := workspaceYAMLSection(rel)
		if section == "" {
			section = "root"
		}
		checked[section]++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"root", "workspace", "collection", "request", "environment", "example"} {
		if checked[kind] == 0 {
			t.Errorf("no %s file was checked: %v", kind, checked)
		}
	}
}

func TestSchemaEnumsMatchTheAppTypes(t *testing.T) {
	data, err := os.ReadFile(workspaceSchemaPathForTest(t))
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatal(err)
	}
	models, err := os.ReadFile(filepath.Join("..", "..", "frontend", "src", "lib", "types", "models.ts"))
	if err != nil {
		t.Fatal(err)
	}
	union := func(name string) []string {
		match := regexp.MustCompile(`export type ` + name + ` = ([^;]+);`).FindSubmatch(models)
		if match == nil {
			t.Fatalf("type %s not found in models.ts", name)
		}
		var values []string
		for _, literal := range regexp.MustCompile(`'([^']*)'`).FindAllSubmatch(match[1], -1) {
			values = append(values, string(literal[1]))
		}
		sort.Strings(values)
		return values
	}
	enum := func(definition, property string) []string {
		node := nestedMap(nestedMap(nestedMap(schema, "definitions"), definition), "properties")
		var values []string
		for _, value := range nestedMap(node, property)["enum"].([]any) {
			values = append(values, value.(string))
		}
		sort.Strings(values)
		return values
	}
	for _, pair := range []struct{ typeName, definition, property string }{
		{"RequestType", "request", "requestType"},
		{"Method", "request", "method"},
		{"RequestTab", "request", "requestTab"},
		{"BodyType", "request", "bodyType"},
		{"RawBodyType", "request", "rawBodyType"},
		{"AuthType", "auth", "type"},
		{"OAuth2GrantType", "auth", "oauth2GrantType"},
		{"HttpVersion", "requestSettings", "httpVersion"},
		{"SocketIOClientVersion", "requestSettings", "sioClientVersion"},
	} {
		if got, want := enum(pair.definition, pair.property), union(pair.typeName); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("schema %s.%s = %v, but %s in models.ts = %v", pair.definition, pair.property, got, pair.typeName, want)
		}
	}
}

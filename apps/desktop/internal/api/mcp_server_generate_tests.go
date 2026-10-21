package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	mcpSchemaMaxDepth    = 12
	mcpSchemaArraySample = 50
)

type mcpGenerateTestsArgs struct {
	Request          string          `json:"request"`
	From             string          `json:"from"`
	Environment      string          `json:"environment"`
	Variables        map[string]any  `json:"variables"`
	Status           int             `json:"status"`
	Body             *mcpTextArg     `json:"body"`
	ContentType      string          `json:"contentType"`
	Schema           json.RawMessage `json:"schema"`
	SaveExample      *bool           `json:"saveExample"`
	ExampleName      string          `json:"exampleName"`
	Replace          bool            `json:"replace"`
	AllowErrorStatus bool            `json:"allowErrorStatus"`
}

type mcpGeneratedTests struct {
	Request         string   `json:"request"`
	File            string   `json:"file"`
	From            string   `json:"from"`
	Status          int      `json:"status"`
	Tests           []string `json:"tests"`
	KeptExisting    []string `json:"keptExisting,omitempty"`
	Replaced        bool     `json:"replaced,omitempty"`
	SchemaFields    int      `json:"schemaFields,omitempty"`
	Example         string   `json:"example,omitempty"`
	ExampleReplaced bool     `json:"exampleReplaced,omitempty"`
	Warnings        []string `json:"warnings,omitempty"`
}

type mcpGeneratedTest struct {
	name string
	code string
}

type mcpObservedResponse struct {
	status    int
	mediaType string
	body      string
	hasBody   bool
	schema    map[string]any
	example   map[string]any
}

func (s *mcpServer) toolGenerateTests(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args mcpGenerateTestsArgs
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.Request) == "" {
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "request is required"}
	}
	from := strings.ToLower(defaultString(strings.TrimSpace(args.From), "run"))
	var observed mcpObservedResponse
	var warnings []string
	var err error
	switch from {
	case "run":
		observed, warnings, err = s.observeByRunning(ctx, args)
	case "example":
		observed, err = mcpObserveDescribed(args)
	default:
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "from must be run or example"}
	}
	if err != nil {
		return nil, err
	}
	tests, fields, err := mcpBuildTests(observed)
	if err != nil {
		return nil, err
	}
	saveExample := args.SaveExample == nil || *args.SaveExample
	if saveExample && observed.example == nil {
		warnings = append(warnings, "no example was saved: pass body to describe the response")
	}

	return s.mutate(func(st *mcpStore) (func() any, error) {
		request, saved, err := st.request(args.Request)
		if err != nil {
			return nil, err
		}
		if kind := mcpRequestType(saved); kind != "http" && kind != "graphql" {
			return nil, fmt.Errorf("%s is a %s request; tests can only be generated for HTTP and GraphQL requests", mcpRequestPath(saved), kind)
		}
		result := mcpGeneratedTests{From: from, Status: observed.status, SchemaFields: fields, Warnings: warnings, Replaced: args.Replace}
		existing := stringValue(request, "testScriptJs")
		if !args.Replace {
			if expected := mcpExpectedStatus(existing); expected != 0 && expected != observed.status {
				tests = nil
				result.Warnings = append(result.Warnings, fmt.Sprintf("the request's tests already expect status %d, so no tests were added for this %d response; it is kept as an example only. Pass replace: true to make %d the expected status", expected, observed.status, observed.status))
			}
		}
		var blocks []string
		for _, test := range tests {
			if !args.Replace && strings.Contains(existing, "pm.test("+strconv.Quote(test.name)) {
				result.KeptExisting = append(result.KeptExisting, test.name)
				continue
			}
			blocks = append(blocks, test.code)
			result.Tests = append(result.Tests, test.name)
		}
		script := strings.Join(blocks, "\n\n")
		if !args.Replace && strings.TrimSpace(existing) != "" {
			script = strings.TrimRight(existing, "\n")
			if len(blocks) > 0 {
				script += "\n\n" + strings.Join(blocks, "\n\n")
			}
		}
		if script != "" {
			script += "\n"
		}
		request["testScriptJs"] = script
		if saveExample && observed.example != nil {
			name := strings.TrimSpace(args.ExampleName)
			if name == "" {
				name = defaultString(stringValue(observed.example, "status"), fmt.Sprint(observed.status))
			}
			result.Example = name
			result.ExampleReplaced = mcpReplaceExample(request, name, observed.example)
			if !result.ExampleReplaced {
				mcpAddExample(request, observed.example, name, "", mcpExampleSource(from))
			}
		}
		return func() any {
			result.Request = st.requestPath(request)
			result.File = st.requestFile(request)
			return result
		}, nil
	})
}

var mcpStatusTestRe = regexp.MustCompile(`pm\.test\("status is (\d{3})"`)

func mcpExpectedStatus(script string) int {
	if match := mcpStatusTestRe.FindStringSubmatch(script); match != nil {
		status, _ := strconv.Atoi(match[1])
		return status
	}
	return 0
}

func mcpExampleSource(from string) string {
	if from == "run" {
		return "captured"
	}
	return "manual"
}

func mcpReplaceExample(request map[string]any, name string, response map[string]any) bool {
	var examples []map[string]any
	switch typed := request["examples"].(type) {
	case []any:
		for _, raw := range typed {
			if example, ok := raw.(map[string]any); ok {
				examples = append(examples, example)
			}
		}
	case []map[string]any:
		examples = typed
	}
	for _, example := range examples {
		if strings.EqualFold(strings.TrimSpace(stringValue(example, "name")), name) {
			example["response"] = response
			return true
		}
	}
	return false
}

func (s *mcpServer) observeByRunning(ctx context.Context, args mcpGenerateTestsArgs) (mcpObservedResponse, []string, error) {
	ws, err := s.loadWorkspace()
	if err != nil {
		return mcpObservedResponse{}, nil, err
	}
	req, err := mcpFindRequest(ws.requests, args.Request)
	if err != nil {
		return mcpObservedResponse{}, nil, err
	}
	if !cliRunnable(req) {
		return mcpObservedResponse{}, nil, fmt.Errorf("%s is a %s request; only HTTP and GraphQL requests can be run here", mcpRequestPath(req), mcpRequestType(req))
	}
	for i := range ws.collections {
		if ws.collections[i].ID == req.CollectionID {
			req = applyCollectionDefaults(req, &ws.collections[i])
			break
		}
	}
	run, err := s.prepareRun(ws, args.Environment, args.Variables)
	if err != nil {
		return mcpObservedResponse{}, nil, err
	}
	result, resp := s.execute(ctx, run, req)
	s.lastRuns[req.ID] = mcpLastRun{request: req, response: resp, secrets: run.secrets}
	s.remember(run)
	if resp.StatusCode == 0 {
		message := fmt.Sprintf("%s got no response: %s", mcpRequestPath(req), defaultString(redactSecrets(defaultString(result.Error, resp.Error), run.secrets), "the request failed"))
		if missing := mcpUnresolvedVariables(req, run); len(missing) > 0 {
			message += fmt.Sprintf(". Nothing sets %s in environment %s", strings.Join(missing, ", "), defaultString(run.envName, "(none)"))
		}
		return mcpObservedResponse{}, nil, fmt.Errorf("%s. If the server is not running, call generate_tests with from: example and the status and body the code returns", message)
	}
	if resp.StatusCode >= 400 && !args.AllowErrorStatus {
		return mcpObservedResponse{}, nil, fmt.Errorf("%s answered %s, so the tests would assert a failure. Fix the request first (diagnose_last_failure or run_request shows why), or pass allowErrorStatus: true when this error response is what you want to test", mcpRequestPath(req), defaultString(resp.Status, fmt.Sprint(resp.StatusCode)))
	}
	observed := mcpObservedResponse{
		status:    resp.StatusCode,
		mediaType: mcpMediaType(headerLookup(resp.Headers, "Content-Type")),
		example:   mcpExampleResponse(resp, run.secrets),
	}
	var warnings []string
	if resp.BodyIsBinary {
		warnings = append(warnings, "the body is binary, so no schema test was written")
	} else {
		observed.body, observed.hasBody = resp.Body, resp.Body != ""
	}
	if len(args.Schema) > 0 {
		if observed.schema, err = mcpSchemaArgument(args.Schema); err != nil {
			return mcpObservedResponse{}, nil, err
		}
	}
	return observed, warnings, nil
}

func mcpObserveDescribed(args mcpGenerateTestsArgs) (mcpObservedResponse, error) {
	if args.Status == 0 && args.Body == nil && len(args.Schema) == 0 {
		return mcpObservedResponse{}, &mcpServerError{code: mcpRPCInvalidParams, message: "from: example needs the status, and a body or schema, of the response the code returns"}
	}
	status := args.Status
	if status == 0 {
		status = 200
	}
	if status < 100 || status > 599 {
		return mcpObservedResponse{}, &mcpServerError{code: mcpRPCInvalidParams, message: fmt.Sprintf("status %d is not an HTTP status", status)}
	}
	observed := mcpObservedResponse{status: status, mediaType: mcpMediaType(args.ContentType)}
	if args.Body != nil {
		observed.body, observed.hasBody = string(*args.Body), string(*args.Body) != ""
		observed.example = mcpManualExampleResponse(status, args.Body.ptr(), nil, args.ContentType)
		observed.mediaType = stringValue(observed.example, "bodyMediaType")
	}
	if len(args.Schema) > 0 {
		schema, err := mcpSchemaArgument(args.Schema)
		if err != nil {
			return mcpObservedResponse{}, err
		}
		observed.schema = schema
		if observed.mediaType == "" {
			observed.mediaType = "application/json"
		}
	}
	return observed, nil
}

func mcpSchemaArgument(raw json.RawMessage) (map[string]any, error) {
	var schema any
	if err := json.Unmarshal(raw, &schema); err != nil {
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "schema must be a JSON Schema object: " + err.Error()}
	}
	if text, ok := schema.(string); ok {
		if err := json.Unmarshal([]byte(text), &schema); err != nil {
			return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "schema must be a JSON Schema object: " + err.Error()}
		}
	}
	object, ok := schema.(map[string]any)
	if !ok {
		return nil, &mcpServerError{code: mcpRPCInvalidParams, message: "schema must be a JSON Schema object"}
	}
	return object, nil
}

func mcpBuildTests(observed mcpObservedResponse) ([]mcpGeneratedTest, int, error) {
	tests := []mcpGeneratedTest{{
		name: fmt.Sprintf("status is %d", observed.status),
		code: fmt.Sprintf("pm.response.to.have.status(%d);", observed.status),
	}}
	if observed.mediaType != "" {
		tests = append(tests, mcpGeneratedTest{
			name: "Content-Type is " + observed.mediaType,
			code: fmt.Sprintf("pm.expect(pm.response.headers.get(\"Content-Type\")).to.include(%s);", strconv.Quote(observed.mediaType)),
		})
	}
	schema := observed.schema
	var body any
	bodyIsJSON := false
	if observed.hasBody && json.Valid([]byte(observed.body)) {
		bodyIsJSON = true
		_ = json.Unmarshal([]byte(observed.body), &body)
		if schema == nil {
			schema = mcpInferSchema(body, 0)
		}
	}
	fields := 0
	if len(schema) > 0 {
		if err := mcpCheckSchema(schema, observed.body, bodyIsJSON); err != nil {
			return nil, 0, err
		}
		encoded, err := mcpIndentedJSON(schema)
		if err != nil {
			return nil, 0, err
		}
		tests = append(tests, mcpGeneratedTest{name: "body matches the response schema", code: "pm.response.to.have.jsonSchema(" + encoded + ");"})
		fields = mcpSchemaFieldCount(schema)
	}
	for i, test := range tests {
		tests[i].code = fmt.Sprintf("pm.test(%s, function () {\n  %s\n});", strconv.Quote(test.name), test.code)
	}
	return tests, fields, nil
}

func mcpIndentedJSON(value any) (string, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("  ", "  ")
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

func mcpCheckSchema(schema map[string]any, body string, bodyIsJSON bool) error {
	encoded, err := json.Marshal(schema)
	if err != nil {
		return err
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource("mem:///response.schema.json", doc); err != nil {
		return fmt.Errorf("the schema is not valid JSON Schema: %v", err)
	}
	compiled, err := compiler.Compile("mem:///response.schema.json")
	if err != nil {
		return fmt.Errorf("the schema is not valid JSON Schema: %v", err)
	}
	if !bodyIsJSON {
		return nil
	}
	value, err := jsonschema.UnmarshalJSON(strings.NewReader(body))
	if err != nil {
		return err
	}
	if err := compiled.Validate(value); err != nil {
		return fmt.Errorf("the schema does not match the response body, so the test would fail at once: %v", err)
	}
	return nil
}

func mcpInferSchema(value any, depth int) map[string]any {
	if depth > mcpSchemaMaxDepth {
		return map[string]any{}
	}
	switch typed := value.(type) {
	case map[string]any:
		schema := map[string]any{"type": "object"}
		if len(typed) == 0 {
			return schema
		}
		properties := map[string]any{}
		required := make([]string, 0, len(typed))
		for key, child := range typed {
			properties[key] = mcpInferSchema(child, depth+1)
			required = append(required, key)
		}
		sort.Strings(required)
		schema["properties"] = properties
		schema["required"] = required
		return schema
	case []any:
		schema := map[string]any{"type": "array"}
		if len(typed) == 0 {
			return schema
		}
		items := mcpInferSchema(typed[0], depth+1)
		for i := 1; i < len(typed) && i < mcpSchemaArraySample; i++ {
			items = mcpMergeSchemas(items, mcpInferSchema(typed[i], depth+1))
		}
		if len(items) > 0 {
			schema["items"] = items
		}
		return schema
	case string:
		return map[string]any{"type": "string"}
	case float64, json.Number:
		return map[string]any{"type": "number"}
	case bool:
		return map[string]any{"type": "boolean"}
	default:
		return map[string]any{}
	}
}

func mcpMergeSchemas(a, b map[string]any) map[string]any {
	if len(a) == 0 || len(b) == 0 || a["type"] != b["type"] {
		return map[string]any{}
	}
	switch a["type"] {
	case "object":
		aProps, _ := a["properties"].(map[string]any)
		bProps, _ := b["properties"].(map[string]any)
		properties := map[string]any{}
		for key, schema := range aProps {
			properties[key] = schema
		}
		for key, schema := range bProps {
			if existing, ok := properties[key].(map[string]any); ok {
				properties[key] = mcpMergeSchemas(existing, schema.(map[string]any))
			} else {
				properties[key] = schema
			}
		}
		inB := map[string]bool{}
		for _, key := range mcpSchemaRequired(b["required"]) {
			inB[key] = true
		}
		required := []string{}
		for _, key := range mcpSchemaRequired(a["required"]) {
			if inB[key] {
				required = append(required, key)
			}
		}
		merged := map[string]any{"type": "object"}
		if len(properties) > 0 {
			merged["properties"] = properties
		}
		if len(required) > 0 {
			merged["required"] = required
		}
		return merged
	case "array":
		aItems, aOK := a["items"].(map[string]any)
		bItems, bOK := b["items"].(map[string]any)
		merged := map[string]any{"type": "array"}
		switch {
		case aOK && bOK:
			if items := mcpMergeSchemas(aItems, bItems); len(items) > 0 {
				merged["items"] = items
			}
		case aOK:
			merged["items"] = aItems
		case bOK:
			merged["items"] = bItems
		}
		return merged
	default:
		return a
	}
}

func mcpSchemaRequired(value any) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok {
				out = append(out, text)
			}
		}
		return out
	}
	return nil
}

func mcpSchemaFieldCount(schema map[string]any) int {
	count := 0
	if properties, ok := schema["properties"].(map[string]any); ok {
		for _, child := range properties {
			count++
			if nested, ok := child.(map[string]any); ok {
				count += mcpSchemaFieldCount(nested)
			}
		}
	}
	if items, ok := schema["items"].(map[string]any); ok {
		count += mcpSchemaFieldCount(items)
	}
	return count
}

func mcpGenerateTestsTool() map[string]any {
	str := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description}
	}
	return map[string]any{
		"name":  "generate_tests",
		"title": "Generate tests for a saved request",
		"description": "Write pm.test assertions into a saved request from a real or described response: its status, its Content-Type and a JSON schema of its body (types and required fields, never values), and save the response as an example the mock server serves. " +
			"from: run (default) sends the request, so it creates what a POST creates. from: example takes the status and body, or schema, the code returns, for an API that is not running anywhere yet. " +
			"Tests the request already has are kept; a test with the same name is not added twice.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"request":          str("Request id or path (Collection/Folder/Name)."),
				"from":             map[string]any{"type": "string", "enum": []string{"run", "example"}, "description": "run sends the request and tests its response; example tests the response you describe. Defaults to run."},
				"environment":      str("With from: run, the environment to send it with. Defaults to the one the server was started with."),
				"variables":        map[string]any{"type": "object", "description": "With from: run, variable overrides for this call.", "additionalProperties": map[string]any{"type": "string"}},
				"status":           map[string]any{"type": "integer", "description": "With from: example, the status the code returns (default 200)."},
				"body":             str("With from: example, a representative response body."),
				"contentType":      str("With from: example, the Content-Type. Defaults to application/json for a JSON body."),
				"schema":           map[string]any{"type": "object", "description": "A JSON Schema for the body to use instead of one inferred from the response, for example built from the response type in the code."},
				"saveExample":      map[string]any{"type": "boolean", "description": "Save the response as an example (default true). An example of the same name is replaced."},
				"exampleName":      str("Example name. Defaults to the status, for example \"200 OK\"."),
				"replace":          map[string]any{"type": "boolean", "description": "Replace the request's test script instead of adding to it."},
				"allowErrorStatus": map[string]any{"type": "boolean", "description": "With from: run, write tests even when the response is 4xx or 5xx, to test an error case on purpose."},
			},
			"required": []string{"request"},
		},
		"annotations": map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true},
	}
}

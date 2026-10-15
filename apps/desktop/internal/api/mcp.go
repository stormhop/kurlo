package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/script"
)

const (
	mcpMethodDiscover      = "server/discover"
	mcpMethodToolsList     = "tools/list"
	mcpMethodToolsCall     = "tools/call"
	mcpMethodResourcesList = "resources/list"
	mcpMethodResourcesRead = "resources/read"
	mcpMethodPromptsList   = "prompts/list"
	mcpMethodPromptsGet    = "prompts/get"
)

const (
	mcpMetaProtocolVersion = "io.modelcontextprotocol/protocolVersion"
	mcpMetaClientInfo      = "io.modelcontextprotocol/clientInfo"
	mcpMetaClientCaps      = "io.modelcontextprotocol/clientCapabilities"
	mcpMetaServerInfo      = "io.modelcontextprotocol/serverInfo"
)

const mcpBase64Prefix = "=?base64?"
const mcpBase64Suffix = "?="

func McpMethods() []string {
	return []string{
		mcpMethodDiscover,
		mcpMethodToolsList,
		mcpMethodToolsCall,
		mcpMethodResourcesList,
		mcpMethodResourcesRead,
		mcpMethodPromptsList,
		mcpMethodPromptsGet,
	}
}

func mcpMethodIsKnown(method string) bool {
	for _, known := range McpMethods() {
		if known == method {
			return true
		}
	}
	return false
}

func mcpMethodNeedsName(method string) bool {
	switch method {
	case mcpMethodToolsCall, mcpMethodResourcesRead, mcpMethodPromptsGet:
		return true
	}
	return false
}

func mcpMethodTakesCursor(method string) bool {
	switch method {
	case mcpMethodToolsList, mcpMethodResourcesList, mcpMethodPromptsList:
		return true
	}
	return false
}

func mcpProtocolVersion(req model.HttpRequest) string {
	if version := strings.TrimSpace(req.McpProtocolVersion); version != "" {
		return version
	}
	return model.McpDefaultProtocolVersion
}

func mcpRequestMeta(req model.HttpRequest) map[string]any {
	return map[string]any{
		mcpMetaProtocolVersion: mcpProtocolVersion(req),
		mcpMetaClientInfo: map[string]any{
			"name":    "Kurlo",
			"version": appVersion,
		},
		mcpMetaClientCaps: map[string]any{
			"elicitation": map[string]any{},
		},
	}
}

func mcpDecodeJSONObject(text, label string) (map[string]any, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil, nil
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(trimmed), &decoded); err != nil {
		return nil, fmt.Errorf("%s is not a JSON object: %w", label, err)
	}
	return decoded, nil
}

func mcpBuildParams(req model.HttpRequest) (map[string]any, error) {
	params := map[string]any{"_meta": mcpRequestMeta(req)}

	name := strings.TrimSpace(req.McpName)
	if mcpMethodNeedsName(req.McpMethod) && name == "" {
		return nil, fmt.Errorf("%s needs a name", req.McpMethod)
	}
	switch req.McpMethod {
	case mcpMethodResourcesRead:
		params["uri"] = name
	case mcpMethodToolsCall, mcpMethodPromptsGet:
		params["name"] = name
	}

	arguments, err := mcpDecodeJSONObject(req.McpArguments, "the arguments")
	if err != nil {
		return nil, err
	}
	if req.McpMethod == mcpMethodToolsCall {
		if arguments == nil {
			arguments = map[string]any{}
		}
		params["arguments"] = arguments
	} else if arguments != nil && req.McpMethod == mcpMethodPromptsGet {
		params["arguments"] = arguments
	}

	if mcpMethodTakesCursor(req.McpMethod) {
		if cursor := strings.TrimSpace(req.McpCursor); cursor != "" {
			params["cursor"] = cursor
		}
	}

	inputResponses, err := mcpDecodeJSONObject(req.McpInputResponses, "the input responses")
	if err != nil {
		return nil, err
	}
	if len(inputResponses) > 0 {
		params["inputResponses"] = inputResponses
		if state := strings.TrimSpace(req.McpRequestState); state != "" {
			params["requestState"] = state
		}
	}

	return params, nil
}

func mcpBuildEnvelope(req model.HttpRequest, id int) ([]byte, error) {
	params, err := mcpBuildParams(req)
	if err != nil {
		return nil, err
	}
	envelope := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  req.McpMethod,
		"params":  params,
	}
	return json.MarshalIndent(envelope, "", "  ")
}

func mcpHeaderValueNeedsEncoding(value string) bool {
	if value == "" {
		return false
	}
	if strings.HasPrefix(value, mcpBase64Prefix) && strings.HasSuffix(value, mcpBase64Suffix) {
		return true
	}
	if strings.TrimSpace(value) != value {
		return true
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x20 || value[i] > 0x7E {
			return true
		}
	}
	return false
}

func mcpEncodeHeaderValue(value string) string {
	if !mcpHeaderValueNeedsEncoding(value) {
		return value
	}
	return mcpBase64Prefix + base64.StdEncoding.EncodeToString([]byte(value)) + mcpBase64Suffix
}

func mcpDecodeHeaderValue(value string) string {
	if !strings.HasPrefix(value, mcpBase64Prefix) || !strings.HasSuffix(value, mcpBase64Suffix) {
		return value
	}
	inner := strings.TrimSuffix(strings.TrimPrefix(value, mcpBase64Prefix), mcpBase64Suffix)
	decoded, err := base64.StdEncoding.DecodeString(inner)
	if err != nil {
		return value
	}
	return string(decoded)
}

func mcpIsHTTPToken(value string) bool {
	if value == "" {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0:
		default:
			return false
		}
	}
	return true
}

type mcpHeaderParam struct {
	header string
	path   []string
	kind   string
}

func mcpSchemaPrimitiveKind(property map[string]any) string {
	switch declared := property["type"].(type) {
	case string:
		switch declared {
		case "string", "integer", "boolean":
			return declared
		}
	case []any:
		found := ""
		for _, entry := range declared {
			name, ok := entry.(string)
			if !ok || name == "null" {
				continue
			}
			switch name {
			case "string", "integer", "boolean":
				if found != "" && found != name {
					return ""
				}
				found = name
			default:
				return ""
			}
		}
		return found
	}
	return ""
}

func mcpCollectHeaderParams(schema map[string]any, path []string, out *[]mcpHeaderParam, seen map[string]string) error {
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(properties))
	for name := range properties {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		property, ok := properties[name].(map[string]any)
		if !ok {
			continue
		}
		next := append(append([]string{}, path...), name)
		if raw, present := property["x-mcp-header"]; present {
			header, ok := raw.(string)
			if !ok || header == "" {
				return fmt.Errorf("x-mcp-header on %q must be a non-empty string", strings.Join(next, "."))
			}
			if !mcpIsHTTPToken(header) {
				return fmt.Errorf("x-mcp-header %q on %q is not a valid HTTP header name", header, strings.Join(next, "."))
			}
			lowered := strings.ToLower(header)
			if previous, clash := seen[lowered]; clash {
				return fmt.Errorf("x-mcp-header %q is used by both %q and %q", header, previous, strings.Join(next, "."))
			}
			kind := mcpSchemaPrimitiveKind(property)
			if kind == "" {
				return fmt.Errorf("x-mcp-header %q on %q must name a string, integer or boolean", header, strings.Join(next, "."))
			}
			seen[lowered] = strings.Join(next, ".")
			*out = append(*out, mcpHeaderParam{header: header, path: next, kind: kind})
		}
		if err := mcpCollectHeaderParams(property, next, out, seen); err != nil {
			return err
		}
	}
	return nil
}

func mcpUnreachableAnnotation(node any, inProperties bool) bool {
	switch typed := node.(type) {
	case map[string]any:
		for key, value := range typed {
			if key == "x-mcp-header" && !inProperties {
				return true
			}
			if key == "properties" {
				if nested, ok := value.(map[string]any); ok {
					for _, property := range nested {
						if mcpUnreachableAnnotation(property, true) {
							return true
						}
					}
					continue
				}
			}
			if key == "x-mcp-header" {
				continue
			}
			if mcpUnreachableAnnotation(value, false) {
				return true
			}
		}
	case []any:
		for _, entry := range typed {
			if mcpUnreachableAnnotation(entry, false) {
				return true
			}
		}
	}
	return false
}

func McpToolRejection(inputSchemaJSON string) string {
	trimmed := strings.TrimSpace(inputSchemaJSON)
	if trimmed == "" {
		return ""
	}
	var schema map[string]any
	if err := json.Unmarshal([]byte(trimmed), &schema); err != nil {
		return "its input schema is not a JSON object"
	}
	var params []mcpHeaderParam
	if err := mcpCollectHeaderParams(schema, nil, &params, map[string]string{}); err != nil {
		return err.Error()
	}
	if mcpUnreachableAnnotation(schema, false) {
		return "an x-mcp-header annotation sits somewhere the specification does not allow it to be read from"
	}
	return ""
}

func mcpValueAtPath(arguments map[string]any, path []string) (any, bool) {
	var current any = arguments
	for _, segment := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[segment]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

func mcpParamHeaderValue(value any, kind string) (string, bool) {
	switch kind {
	case "string":
		text, ok := value.(string)
		return text, ok
	case "boolean":
		flag, ok := value.(bool)
		if !ok {
			return "", false
		}
		return strconv.FormatBool(flag), true
	case "integer":
		switch number := value.(type) {
		case float64:
			if number != float64(int64(number)) {
				return "", false
			}
			return strconv.FormatInt(int64(number), 10), true
		case json.Number:
			return number.String(), true
		}
	}
	return "", false
}

func mcpParamHeaders(inputSchemaJSON string, arguments map[string]any) ([]model.KeyValue, error) {
	trimmed := strings.TrimSpace(inputSchemaJSON)
	if trimmed == "" || len(arguments) == 0 {
		return nil, nil
	}
	var schema map[string]any
	if err := json.Unmarshal([]byte(trimmed), &schema); err != nil {
		return nil, nil
	}
	var params []mcpHeaderParam
	if err := mcpCollectHeaderParams(schema, nil, &params, map[string]string{}); err != nil {
		return nil, err
	}
	rows := make([]model.KeyValue, 0, len(params))
	for _, param := range params {
		value, found := mcpValueAtPath(arguments, param.path)
		if !found || value == nil {
			continue
		}
		text, ok := mcpParamHeaderValue(value, param.kind)
		if !ok {
			continue
		}
		rows = append(rows, model.KeyValue{
			Key:     "Mcp-Param-" + param.header,
			Value:   mcpEncodeHeaderValue(text),
			Enabled: true,
		})
	}
	return rows, nil
}

func mcpProtocolHeaders(req model.HttpRequest) ([]model.KeyValue, error) {
	rows := []model.KeyValue{
		{Key: "Accept", Value: "application/json, text/event-stream", Enabled: true},
		{Key: "MCP-Protocol-Version", Value: mcpProtocolVersion(req), Enabled: true},
		{Key: "Mcp-Method", Value: req.McpMethod, Enabled: true},
	}
	if mcpMethodNeedsName(req.McpMethod) {
		rows = append(rows, model.KeyValue{
			Key:     "Mcp-Name",
			Value:   mcpEncodeHeaderValue(strings.TrimSpace(req.McpName)),
			Enabled: true,
		})
	}
	if req.McpMethod == mcpMethodToolsCall {
		arguments, err := mcpDecodeJSONObject(req.McpArguments, "the arguments")
		if err != nil {
			return nil, err
		}
		params, err := mcpParamHeaders(req.McpInputSchema, arguments)
		if err != nil {
			return nil, err
		}
		rows = append(rows, params...)
	}
	return rows, nil
}

func mcpApplyHeaders(existing []model.KeyValue, protocol []model.KeyValue) ([]model.KeyValue, []string) {
	owned := make(map[string]bool, len(protocol))
	for _, row := range protocol {
		owned[strings.ToLower(row.Key)] = true
	}
	kept := make([]model.KeyValue, 0, len(existing)+len(protocol))
	var replaced []string
	for _, row := range existing {
		key := strings.ToLower(strings.TrimSpace(row.Key))
		if owned[key] || strings.HasPrefix(key, "mcp-param-") {
			if row.Enabled && row.Key != "" {
				replaced = append(replaced, http.CanonicalHeaderKey(row.Key))
			}
			continue
		}
		kept = append(kept, row)
	}
	kept = append(kept, protocol...)

	var warnings []string
	if len(replaced) > 0 {
		sort.Strings(replaced)
		warnings = append(warnings, fmt.Sprintf(
			"MCP derives %s from the request body, so the header you set was replaced.",
			strings.Join(replaced, ", ")))
	}
	return kept, warnings
}

func mcpValidateCall(req model.HttpRequest) (model.HttpRequest, error) {
	if strings.TrimSpace(req.URL) == "" {
		return req, fmt.Errorf("this request has no MCP endpoint")
	}
	req.McpMethod = strings.TrimSpace(req.McpMethod)
	if req.McpMethod == "" {
		return req, fmt.Errorf("choose a method to send")
	}
	if !mcpMethodIsKnown(req.McpMethod) {
		return req, fmt.Errorf("%q is not a method Kurlo knows how to send", req.McpMethod)
	}
	return req, nil
}

func mcpPrepareRequest(req model.HttpRequest, id int) (model.HttpRequest, []string, error) {
	req, err := mcpValidateCall(req)
	if err != nil {
		return req, nil, err
	}
	if req.McpMethod == mcpMethodToolsCall {
		if reason := McpToolRejection(req.McpInputSchema); reason != "" {
			return req, nil, fmt.Errorf("this tool cannot be called: %s", reason)
		}
	}

	envelope, err := mcpBuildEnvelope(req, id)
	if err != nil {
		return req, nil, err
	}
	protocol, err := mcpProtocolHeaders(req)
	if err != nil {
		return req, nil, err
	}
	headers, warnings := mcpApplyHeaders(req.Headers, protocol)

	req.Method = "POST"
	req.BodyType = "json"
	req.Body = string(envelope)
	req.BodyFilePath = ""
	req.FormData = nil
	req.Headers = headers
	return req, warnings, nil
}

func mcpParseEventStream(body string) []string {
	normalized := strings.ReplaceAll(body, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")

	var frames []string
	var data []string
	flush := func() {
		if len(data) > 0 {
			frames = append(frames, strings.Join(data, "\n"))
			data = nil
		}
	}
	for _, line := range strings.Split(normalized, "\n") {
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			field, value = line, ""
		}
		value = strings.TrimPrefix(value, " ")
		if field == "data" {
			data = append(data, value)
		}
	}
	flush()
	return frames
}

type mcpEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
	Error   *mcpRPCError    `json:"error"`
}

type mcpRPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func mcpPrettyJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var buffer strings.Builder
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return string(raw)
	}
	encoder := json.NewEncoder(&buffer)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return string(raw)
	}
	return strings.TrimRight(buffer.String(), "\n")
}

func mcpStringField(object map[string]any, key string) string {
	if value, ok := object[key].(string); ok {
		return value
	}
	return ""
}

func mcpRawField(object map[string]any, key string) string {
	value, ok := object[key]
	if !ok || value == nil {
		return ""
	}
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return ""
	}
	return string(encoded)
}

func mcpToolsFromResult(result map[string]any) []model.McpTool {
	raw, ok := result["tools"].([]any)
	if !ok {
		return nil
	}
	tools := make([]model.McpTool, 0, len(raw))
	for _, entry := range raw {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		tool := model.McpTool{
			Name:         mcpStringField(object, "name"),
			Title:        mcpStringField(object, "title"),
			Description:  mcpStringField(object, "description"),
			InputSchema:  mcpRawField(object, "inputSchema"),
			OutputSchema: mcpRawField(object, "outputSchema"),
			Annotations:  mcpRawField(object, "annotations"),
		}
		tool.Rejected = McpToolRejection(tool.InputSchema)
		tools = append(tools, tool)
	}
	return tools
}

func mcpResourcesFromResult(result map[string]any) []model.McpResource {
	raw, ok := result["resources"].([]any)
	if !ok {
		return nil
	}
	resources := make([]model.McpResource, 0, len(raw))
	for _, entry := range raw {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		resources = append(resources, model.McpResource{
			URI:         mcpStringField(object, "uri"),
			Name:        mcpStringField(object, "name"),
			Title:       mcpStringField(object, "title"),
			Description: mcpStringField(object, "description"),
			MimeType:    mcpStringField(object, "mimeType"),
		})
	}
	return resources
}

func mcpPromptsFromResult(result map[string]any) []model.McpPrompt {
	raw, ok := result["prompts"].([]any)
	if !ok {
		return nil
	}
	prompts := make([]model.McpPrompt, 0, len(raw))
	for _, entry := range raw {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		prompts = append(prompts, model.McpPrompt{
			Name:        mcpStringField(object, "name"),
			Title:       mcpStringField(object, "title"),
			Description: mcpStringField(object, "description"),
			Arguments:   mcpRawField(object, "arguments"),
		})
	}
	return prompts
}

func mcpContentFromResult(result map[string]any) []model.McpContent {
	raw, ok := result["content"].([]any)
	if !ok {
		if raw, ok = result["contents"].([]any); !ok {
			return nil
		}
	}
	blocks := make([]model.McpContent, 0, len(raw))
	for _, entry := range raw {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if nested, ok := object["resource"].(map[string]any); ok && mcpStringField(object, "type") == "resource" {
			blocks = append(blocks, model.McpContent{
				Type:     "resource",
				URI:      mcpStringField(nested, "uri"),
				MimeType: mcpStringField(nested, "mimeType"),
				Text:     mcpStringField(nested, "text"),
				Data:     mcpStringField(nested, "blob"),
			})
			continue
		}
		blockType := mcpStringField(object, "type")
		if blockType == "" && mcpStringField(object, "uri") != "" {
			blockType = "resource"
		}
		blocks = append(blocks, model.McpContent{
			Type:        blockType,
			Text:        mcpStringField(object, "text"),
			Data:        mcpStringField(object, "data"),
			MimeType:    mcpStringField(object, "mimeType"),
			URI:         mcpStringField(object, "uri"),
			Name:        mcpStringField(object, "name"),
			Description: mcpStringField(object, "description"),
		})
	}
	return blocks
}

func mcpCapabilityNames(result map[string]any) []string {
	capabilities, ok := result["capabilities"].(map[string]any)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(capabilities))
	for name := range capabilities {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func mcpStringList(result map[string]any, key string) []string {
	raw, ok := result[key].([]any)
	if !ok {
		return nil
	}
	values := make([]string, 0, len(raw))
	for _, entry := range raw {
		if text, ok := entry.(string); ok {
			values = append(values, text)
		}
	}
	return values
}

func mcpInt64Field(result map[string]any, key string) int64 {
	if value, ok := result[key].(float64); ok {
		return int64(value)
	}
	return 0
}

func mcpValidateStructuredContent(outputSchemaJSON string, structured any) []string {
	trimmed := strings.TrimSpace(outputSchemaJSON)
	if trimmed == "" || structured == nil {
		return nil
	}
	var schema any
	if err := json.Unmarshal([]byte(trimmed), &schema); err != nil {
		return nil
	}
	failures := script.ValidateJSONSchema(schema, structured)
	if len(failures) == 0 {
		return nil
	}
	warnings := make([]string, 0, len(failures)+1)
	warnings = append(warnings, "The server's structuredContent does not match the outputSchema it published:")
	warnings = append(warnings, failures...)
	return warnings
}

func mcpApplyResult(out *model.McpResponse, req model.HttpRequest, raw json.RawMessage) {
	out.Result = mcpPrettyJSON(raw)

	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		return
	}

	out.ResultType = mcpStringField(result, "resultType")
	out.NextCursor = mcpStringField(result, "nextCursor")
	out.CacheScope = mcpStringField(result, "cacheScope")
	out.TTLMs = mcpInt64Field(result, "ttlMs")
	out.Instructions = mcpStringField(result, "instructions")
	out.SupportedVersions = mcpStringList(result, "supportedVersions")
	out.Capabilities = mcpCapabilityNames(result)
	out.Tools = mcpToolsFromResult(result)
	out.Resources = mcpResourcesFromResult(result)
	out.Prompts = mcpPromptsFromResult(result)
	out.Content = mcpContentFromResult(result)

	if meta, ok := result["_meta"].(map[string]any); ok {
		if info, ok := meta[mcpMetaServerInfo].(map[string]any); ok {
			out.ServerName = mcpStringField(info, "name")
			out.ServerVersion = mcpStringField(info, "version")
		}
	}
	if info, ok := result["serverInfo"].(map[string]any); ok && out.ServerName == "" {
		out.ServerName = mcpStringField(info, "name")
		out.ServerVersion = mcpStringField(info, "version")
	}

	if flag, ok := result["isError"].(bool); ok {
		out.IsError = flag
	}
	if structured, ok := result["structuredContent"]; ok && structured != nil {
		out.StructuredContent = mcpRawField(result, "structuredContent")
		out.Warnings = append(out.Warnings, mcpValidateStructuredContent(req.McpOutputSchema, structured)...)
	}
	if out.ResultType == "input_required" {
		out.InputRequests = mcpRawField(result, "inputRequests")
		out.RequestState = mcpStringField(result, "requestState")
	}
}

func mcpDecodeBody(out *model.McpResponse, req model.HttpRequest, contentType, body string) {
	frames := []string{strings.TrimSpace(body)}
	if strings.Contains(strings.ToLower(contentType), "text/event-stream") {
		frames = mcpParseEventStream(body)
	}

	found := false
	for _, frame := range frames {
		if strings.TrimSpace(frame) == "" {
			continue
		}
		var envelope mcpEnvelope
		if err := json.Unmarshal([]byte(frame), &envelope); err != nil {
			continue
		}
		if envelope.Method != "" {
			out.Notifications = append(out.Notifications, model.McpNotification{
				Method: envelope.Method,
				Params: mcpPrettyJSON(envelope.Params),
			})
			continue
		}
		if envelope.Error != nil {
			found = true
			out.RPCErrorCode = envelope.Error.Code
			out.RPCErrorMessage = envelope.Error.Message
			out.RPCErrorData = mcpPrettyJSON(envelope.Error.Data)
			continue
		}
		if len(envelope.Result) > 0 {
			found = true
			mcpApplyResult(out, req, envelope.Result)
		}
	}

	if !found && out.Error == "" {
		if strings.TrimSpace(body) == "" {
			out.Error = "the server answered with an empty body rather than a JSON-RPC response"
			return
		}
		out.Error = "the server's answer is not a JSON-RPC response"
	}
}

func mcpResponseContentType(headers []model.KeyValue) string {
	for _, header := range headers {
		if strings.EqualFold(header.Key, "Content-Type") {
			return header.Value
		}
	}
	return ""
}

func requestReadsEventStream(req model.HttpRequest) bool {
	return strings.TrimSpace(req.McpMethod) != ""
}

func (a *App) SendMcpRequest(req model.HttpRequest) model.McpResponse {
	baseCtx := context.Background()
	if a.ctx != nil {
		baseCtx = a.ctx
	}
	ctx, cancel := context.WithCancel(baseCtx)
	seq := a.registerRequestCancel(req.RequestID, cancel)
	defer func() {
		cancel()
		a.unregisterRequestCancel(req.RequestID, seq)
	}()

	transport := func(prepared model.HttpRequest) model.HttpResponse {
		return sendRequest(ctx, prepared, a.state, a.cookieJars, a.preflightCache)
	}
	return model.NormalizeMcpResponse(a.mcpSessions.send(req, transport))
}

func mcpSendStateless(req model.HttpRequest, transport mcpTransport) model.McpResponse {
	prepared, warnings, err := mcpPrepareRequest(req, 1)
	if err != nil {
		return model.McpResponse{Error: err.Error()}
	}
	out := mcpResponseFrom(prepared, transport(prepared), warnings)
	out.ProtocolVersion = mcpProtocolVersion(req)
	return out
}

func mcpResponseFrom(req model.HttpRequest, httpResponse model.HttpResponse, warnings []string) model.McpResponse {
	out := model.McpResponse{HTTP: httpResponse, Warnings: warnings}
	if httpResponse.Error != "" {
		out.Error = httpResponse.Error
		return out
	}
	mcpDecodeBody(&out, req, mcpResponseContentType(httpResponse.Headers), httpResponse.Body)
	return out
}

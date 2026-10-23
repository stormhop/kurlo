package api

var savedRequestFieldDefaults = map[string]any{
	"isDraft":           false,
	"isPinned":          false,
	"nameAuto":          false,
	"sioAck":            false,
	"grpcUseReflection": true,
	"aiStream":          true,
}

var savedRequestSettingDefaults = map[string]any{
	"httpVersion":                  "auto",
	"enableSSLVerification":        true,
	"followRedirects":              true,
	"followOriginalMethod":         false,
	"followAuthorizationHeader":    false,
	"removeRefererHeader":          false,
	"encodeUrlAutomatically":       true,
	"disableCookieJar":             false,
	"maxRedirects":                 float64(10),
	"timeoutMs":                    float64(30000),
	"proxyUrl":                     "",
	"browserEmulation":             false,
	"browserOrigin":                "",
	"browserWithCredentials":       false,
	"browserEnforceCORS":           false,
	"browserEnforceCSP":            false,
	"browserCSP":                   "",
	"wsHandshakeTimeoutMs":         float64(0),
	"wsReconnectAttempts":          float64(0),
	"wsReconnectIntervalMs":        float64(5000),
	"wsMaxMessageSizeMb":           float64(10),
	"wsKeepAliveIntervalMs":        float64(0),
	"sseDisableReconnect":          false,
	"sseReconnectIntervalMs":       float64(0),
	"sioClientVersion":             "v3",
	"sioPath":                      "/socket.io",
	"sioNamespace":                 "/",
	"grpcUseTls":                   false,
	"grpcUseReflection":            true,
	"grpcServerName":               "",
	"grpcIncludeDefaultValues":     true,
	"grpcMaxResponseMessageSizeMb": float64(10),
}

var collectionFieldDefaults = map[string]any{
	"collapsed": false,
}

var authActiveFields = map[string][]string{
	"none":    nil,
	"inherit": nil,
	"bearer":  {"bearerToken"},
	"basic":   {"basicUser", "basicPass"},
	"digest":  {"basicUser", "basicPass"},
	"apikey":  {"apiKeyName", "apiKeyValue", "apiKeyIn"},
	"oauth2": {
		"oauth2GrantType", "oauth2AuthURL", "oauth2DeviceAuthURL", "oauth2TokenURL",
		"oauth2ClientID", "oauth2Secret", "oauth2Scope", "oauth2Audience",
		"oauth2Token", "oauth2RefreshToken", "oauth2TokenExpiry", "oauth2UsePKCE",
		"oauth2Username", "oauth2Password", "oauth2ClientAuth",
		"oauth2AssertionAlgorithm", "oauth2AssertionPrivateKey",
		"oauth2AssertionKeyID", "oauth2AssertionAudience",
	},
	"aws": {"awsAccessKey", "awsSecretKey", "awsSessionToken", "awsRegion", "awsService"},
}

var authTypesWithoutFields = map[string]bool{"inherit": true}

var requestRowFieldsForStrip = []string{"params", "pathParams", "headers", "formRows", "sioEvents", "grpcMetadata"}

var requestSettingFields = []string{
	"sseDisableReconnect",
	"sseReconnectIntervalMs",
	"httpVersion",
	"enableSSLVerification",
	"followRedirects",
	"followOriginalMethod",
	"followAuthorizationHeader",
	"removeRefererHeader",
	"encodeUrlAutomatically",
	"disableCookieJar",
	"maxRedirects",
	"timeoutMs",
	"proxyUrl",
	"browserEmulation",
	"browserOrigin",
	"browserWithCredentials",
	"browserEnforceCORS",
	"browserEnforceCSP",
	"browserCSP",
	"wsHandshakeTimeoutMs",
	"wsReconnectAttempts",
	"wsReconnectIntervalMs",
	"wsMaxMessageSizeMb",
	"wsKeepAliveIntervalMs",
	"sioClientVersion",
	"sioPath",
	"sioNamespace",
	"grpcUseTls",
	"grpcUseReflection",
	"grpcServerName",
	"grpcIncludeDefaultValues",
	"grpcMaxResponseMessageSizeMb",
}

var httpRequestSettingFields = []string{
	"sseDisableReconnect",
	"sseReconnectIntervalMs",
	"httpVersion",
	"enableSSLVerification",
	"followRedirects",
	"followOriginalMethod",
	"followAuthorizationHeader",
	"removeRefererHeader",
	"encodeUrlAutomatically",
	"disableCookieJar",
	"maxRedirects",
	"timeoutMs",
	"proxyUrl",
	"browserEmulation",
	"browserOrigin",
	"browserWithCredentials",
	"browserEnforceCORS",
	"browserEnforceCSP",
	"browserCSP",
}

var webSocketRequestSettingFields = []string{
	"enableSSLVerification",
	"encodeUrlAutomatically",
	"disableCookieJar",
	"proxyUrl",
	"browserEmulation",
	"browserOrigin",
	"browserWithCredentials",
	"browserEnforceCORS",
	"browserEnforceCSP",
	"browserCSP",
	"wsHandshakeTimeoutMs",
	"wsReconnectAttempts",
	"wsReconnectIntervalMs",
	"wsMaxMessageSizeMb",
	"wsKeepAliveIntervalMs",
}

var socketIORequestSettingFields = append(append([]string{}, webSocketRequestSettingFields...),
	"sioClientVersion",
	"sioPath",
	"sioNamespace",
)

var grpcRequestSettingFields = []string{
	"enableSSLVerification",
	"timeoutMs",
	"grpcUseTls",
	"grpcServerName",
	"grpcIncludeDefaultValues",
	"grpcMaxResponseMessageSizeMb",
}

var httpRequestSettingFieldSet = stringSet(httpRequestSettingFields)
var webSocketRequestSettingFieldSet = stringSet(webSocketRequestSettingFields)
var socketIORequestSettingFieldSet = stringSet(socketIORequestSettingFields)
var grpcRequestSettingFieldSet = stringSet(grpcRequestSettingFields)

func stripRequestForFilesystem(request map[string]any) {
	stripTimestamps(request)
	requestType := stringValue(request, "requestType")
	stripBodyFieldsForType(request, requestType)
	stripRealtimeFieldsForType(request, requestType)
	stripMethodForType(request, requestType)
	stripRequestTabForType(request, requestType)
	stripRequestSettingsForType(request, requestType)

	for _, field := range requestRowFieldsForStrip {
		stripNonSecretRowIDs(request[field])
	}
	stripSioArgRowIDs(request["sioArgs"])
	stripEmptySioArgs(request)

	stripAuthForFilesystem(request)
	stripNestedDefaults(request, "settings", savedRequestSettingDefaults)

	stripEmptyAndDefaults(request, savedRequestFieldDefaults)
}

func stripBodyFieldsForType(request map[string]any, requestType string) {
	if requestType == "socketio" {
		delete(request, "bodyType")
		delete(request, "rawBodyType")
		delete(request, "bodyContent")
		delete(request, "bodyFilePath")
		delete(request, "bodyFileName")
		delete(request, "formRows")
		return
	}
	if requestType == "ws" {
		delete(request, "bodyFilePath")
		delete(request, "bodyFileName")
		delete(request, "formRows")
	}
	bodyType := stringValue(request, "bodyType")
	switch bodyType {
	case "", "none":
		delete(request, "bodyContent")
		delete(request, "bodyFilePath")
		delete(request, "bodyFileName")
		delete(request, "rawBodyType")
		delete(request, "formRows")
	default:
		if bodyType != "form" && bodyType != "urlencoded" {
			delete(request, "formRows")
		}
	}
}

func stripRealtimeFieldsForType(request map[string]any, requestType string) {
	if requestType != "socketio" {
		delete(request, "sioEvents")
		delete(request, "sioEventName")
		delete(request, "sioArgs")
		delete(request, "sioAck")
	}
	if requestType != "grpc" {
		delete(request, "grpcMethod")
		delete(request, "grpcMetadata")
		delete(request, "grpcUseReflection")
		delete(request, "grpcProtoFilePath")
		delete(request, "grpcProtoFileName")
		delete(request, "grpcProtoImportPaths")
	}
	if requestType != "mcp" {
		delete(request, "mcpMethod")
		delete(request, "mcpName")
		delete(request, "mcpArguments")
		delete(request, "mcpProtocolVersion")
	}
	if requestType != "ai" {
		for _, field := range aiRequestFields {
			delete(request, field)
		}
	}
	if requestType != "graphql" {
		delete(request, "graphqlSchema")
	}
}

var aiRequestFields = []string{
	"aiProvider", "aiModel", "aiSystem", "aiPrompt", "aiTemperature", "aiTopP",
	"aiMaxTokens", "aiMaxSteps", "aiIdleTimeoutSec", "aiThinking", "aiStream", "aiToolRequestIds",
}

func stripMethodForType(request map[string]any, requestType string) {
	method := stringValue(request, "method")
	switch requestType {
	case "ws", "socketio", "grpc", "mcp", "ai":
		delete(request, "method")
	case "graphql":
		if method == "POST" {
			delete(request, "method")
		}
	default:
		if method == "GET" {
			delete(request, "method")
		}
	}
}

func stripRequestTabForType(request map[string]any, requestType string) {
	tab := stringValue(request, "requestTab")
	defaultTab := "params"
	switch requestType {
	case "ws", "socketio", "grpc", "mcp", "ai":
		defaultTab = "body"
	case "graphql":
		defaultTab = "query"
	}
	if tab == defaultTab {
		delete(request, "requestTab")
	}
}

func stripEmptySioArgs(request map[string]any) {
	rows, ok := request["sioArgs"].([]any)
	if !ok {
		return
	}
	kept := make([]any, 0, len(rows))
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if stringValue(row, "content") == "" {
			continue
		}
		kept = append(kept, row)
	}
	if len(kept) == 0 {
		delete(request, "sioArgs")
		return
	}
	request["sioArgs"] = kept
}

func stripRequestSettingsForType(request map[string]any, requestType string) {
	allowed := requestSettingFieldsForType(requestType)
	if len(allowed) == 0 {
		return
	}
	if settings, ok := request["settings"].(map[string]any); ok {
		stripRequestSettingMapForType(settings, allowed)
	}
	if overrides, ok := request["settingsOverrides"].(map[string]any); ok {
		stripRequestSettingMapForType(overrides, allowed)
		stripFalseSettingsOverrides(request, overrides)
	}
}

func requestSettingFieldsForType(requestType string) map[string]bool {
	switch requestType {
	case "", "http", "graphql", "mcp", "ai":
		return httpRequestSettingFieldSet
	case "ws":
		return webSocketRequestSettingFieldSet
	case "socketio":
		return socketIORequestSettingFieldSet
	case "grpc":
		return grpcRequestSettingFieldSet
	default:
		return nil
	}
}

func stripRequestSettingMapForType(settings map[string]any, allowed map[string]bool) {
	for _, key := range requestSettingFields {
		if !allowed[key] {
			delete(settings, key)
		}
	}
}

func stripFalseSettingsOverrides(request map[string]any, overrides map[string]any) {
	for key, value := range overrides {
		if !boolValue(value) {
			delete(overrides, key)
		}
	}
	if len(overrides) == 0 {
		delete(request, "settingsOverrides")
	}
}

func stringSet(values []string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

func stripWorkspaceForFilesystem(workspace map[string]any) {
	stripTimestamps(workspace)
	delete(workspace, "theme")
	stripEmptyAndDefaults(workspace, nil)
}

func stripCollectionForFilesystem(collection map[string]any) {
	stripTimestamps(collection)
	stripCollectionDefaultsForFilesystem(collection)
	stripEmptyAndDefaults(collection, collectionFieldDefaults)
}

func stripCollectionDefaultsForFilesystem(collection map[string]any) {
	defaults, ok := collection["defaults"].(map[string]any)
	if !ok {
		return
	}
	stripNonSecretRowIDs(defaults["headers"])
	stripNonSecretRowIDs(defaults["variables"])
	stripAuthForFilesystem(defaults)
	stripNestedDefaults(defaults, "settings", savedRequestSettingDefaults)
	stripEmptyAndDefaults(defaults, nil)
	if len(defaults) == 0 {
		delete(collection, "defaults")
	}
}

func stripEnvironmentForFilesystem(environment map[string]any) {
	stripTimestamps(environment)
	stripNonSecretRowIDs(environment["values"])
	stripEmptyAndDefaults(environment, nil)
}

func sanitizeWorkspacesForFilesystem(workspaces []map[string]any) []map[string]any {
	sanitized := make([]map[string]any, 0, len(workspaces))
	for _, workspace := range workspaces {
		next := cloneMap(workspace)
		stripWorkspaceForFilesystem(next)
		sanitized = append(sanitized, next)
	}
	return sanitized
}

func sanitizeCollectionsForFilesystem(collections []map[string]any, existingSecrets, secrets map[string]string) []map[string]any {
	sanitized := make([]map[string]any, 0, len(collections))
	for _, collection := range collections {
		next := cloneMap(collection)
		sanitizeCollectionSecrets(next, existingSecrets, secrets)
		stripCollectionForFilesystem(next)
		sanitized = append(sanitized, next)
	}
	return sanitized
}

func stripAuthForFilesystem(request map[string]any) {
	auth, ok := request["auth"].(map[string]any)
	if !ok {
		return
	}
	authType := stringValue(auth, "type")
	if authType == "" || authType == "none" {
		delete(request, "auth")
		return
	}
	keep := map[string]bool{"type": true}
	for _, field := range authActiveFields[authType] {
		keep[field] = true
	}
	for key, value := range auth {
		if !keep[key] {
			delete(auth, key)
			continue
		}
		if key == "type" {
			continue
		}
		if str, ok := value.(string); ok && str == "" {
			delete(auth, key)
		}
	}
	if len(auth) <= 1 && !authTypesWithoutFields[authType] {
		delete(request, "auth")
	}
}

func stripNestedDefaults(parent map[string]any, key string, defaults map[string]any) {
	nested, ok := parent[key].(map[string]any)
	if !ok {
		return
	}
	for childKey, value := range nested {
		if defaultValue, hasDefault := defaults[childKey]; hasDefault && valuesEqual(value, defaultValue) {
			delete(nested, childKey)
			continue
		}
		if isEmptyValue(value) {
			delete(nested, childKey)
		}
	}
	if len(nested) == 0 {
		delete(parent, key)
	}
}

func stripEmptyAndDefaults(item map[string]any, defaults map[string]any) {
	for key, value := range item {
		if defaultValue, hasDefault := defaults[key]; hasDefault && valuesEqual(value, defaultValue) {
			delete(item, key)
			continue
		}
		if isEmptyValue(value) {
			delete(item, key)
		}
	}
}

func stripNonSecretRowIDs(value any) {
	rows, ok := value.([]any)
	if !ok {
		return
	}
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if boolValue(row["secret"]) {
			continue
		}
		delete(row, "id")
	}
}

func stripSioArgRowIDs(value any) {
	rows, ok := value.([]any)
	if !ok {
		return
	}
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		delete(row, "id")
	}
}

func isEmptyValue(value any) bool {
	switch v := value.(type) {
	case nil:
		return true
	case string:
		return v == ""
	case []any:
		return len(v) == 0
	case map[string]any:
		return len(v) == 0
	}
	return false
}

func valuesEqual(a, b any) bool {
	switch va := a.(type) {
	case bool:
		vb, ok := b.(bool)
		return ok && va == vb
	case string:
		vb, ok := b.(string)
		return ok && va == vb
	case float64:
		switch vb := b.(type) {
		case float64:
			return va == vb
		case int:
			return va == float64(vb)
		case int64:
			return va == float64(vb)
		}
	case int:
		switch vb := b.(type) {
		case int:
			return va == vb
		case float64:
			return float64(va) == vb
		case int64:
			return int64(va) == vb
		}
	case int64:
		switch vb := b.(type) {
		case int64:
			return va == vb
		case int:
			return va == int64(vb)
		case float64:
			return float64(va) == vb
		}
	}
	return false
}

func stripTimestamps(item map[string]any) {
	delete(item, "createdAt")
	delete(item, "updatedAt")
}

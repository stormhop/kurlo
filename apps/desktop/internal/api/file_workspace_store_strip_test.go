package api

import "testing"

func TestStripRequestForFilesystemPrunesTypeSpecificFields(t *testing.T) {
	tests := []struct {
		name                  string
		request               map[string]any
		wantSettings          []string
		absentSettings        []string
		wantOverrides         []string
		absentOverrides       []string
		wantFields            []string
		absentFields          []string
		wantMissingMethod     bool
		wantMissingRequestTab bool
	}{
		{
			name:            "sse keeps http settings and drops realtime and grpc state",
			request:         stripTestRequest("http", "SSE", "params", "none"),
			wantSettings:    []string{"timeoutMs"},
			absentSettings:  []string{"wsReconnectAttempts", "sioPath", "grpcUseTls", "grpcServerName"},
			wantOverrides:   []string{"timeoutMs"},
			absentOverrides: []string{"wsReconnectAttempts", "sioPath", "grpcUseTls", "grpcServerName"},
			wantFields:      []string{"method"},
			absentFields:    []string{"sioEvents", "sioArgs", "graphqlSchema", "grpcMethod", "grpcMetadata", "grpcUseReflection", "grpcProtoFilePath", "mcpMethod", "mcpName", "mcpArguments", "aiProvider", "aiPrompt", "aiToolRequestIds"},
		},
		{
			name:                  "graphql keeps schema and drops realtime and grpc state",
			request:               stripTestRequest("graphql", "POST", "query", "graphql"),
			wantSettings:          []string{"timeoutMs"},
			absentSettings:        []string{"wsReconnectAttempts", "sioPath", "grpcUseTls", "grpcServerName"},
			wantOverrides:         []string{"timeoutMs"},
			absentOverrides:       []string{"wsReconnectAttempts", "sioPath", "grpcUseTls", "grpcServerName"},
			wantFields:            []string{"graphqlSchema"},
			absentFields:          []string{"sioEvents", "sioArgs", "grpcMethod", "grpcMetadata", "grpcUseReflection", "grpcProtoFilePath", "mcpMethod", "mcpName", "mcpArguments", "aiProvider", "aiPrompt", "aiToolRequestIds"},
			wantMissingMethod:     true,
			wantMissingRequestTab: true,
		},
		{
			name:                  "websocket keeps websocket settings only",
			request:               stripTestRequest("ws", "GET", "body", "text"),
			wantSettings:          []string{"wsReconnectAttempts", "wsMaxMessageSizeMb"},
			absentSettings:        []string{"followRedirects", "timeoutMs", "sioPath", "grpcUseTls", "grpcServerName"},
			wantOverrides:         []string{"wsReconnectAttempts"},
			absentOverrides:       []string{"timeoutMs", "sioPath", "grpcUseTls", "grpcServerName"},
			absentFields:          []string{"method", "sioEvents", "sioArgs", "graphqlSchema", "grpcMethod", "grpcMetadata", "grpcUseReflection", "grpcProtoFilePath", "mcpMethod", "mcpName", "mcpArguments", "aiProvider", "aiPrompt", "aiToolRequestIds"},
			wantMissingMethod:     true,
			wantMissingRequestTab: true,
		},
		{
			name:                  "socketio keeps socketio and websocket settings",
			request:               stripTestRequest("socketio", "GET", "body", "none"),
			wantSettings:          []string{"wsReconnectAttempts", "wsMaxMessageSizeMb", "sioPath"},
			absentSettings:        []string{"followRedirects", "timeoutMs", "grpcUseTls", "grpcServerName"},
			wantOverrides:         []string{"wsReconnectAttempts", "sioPath"},
			absentOverrides:       []string{"timeoutMs", "grpcUseTls", "grpcServerName"},
			wantFields:            []string{"sioEvents", "sioEventName", "sioArgs", "sioAck"},
			absentFields:          []string{"method", "graphqlSchema", "grpcMethod", "grpcMetadata", "grpcUseReflection", "grpcProtoFilePath", "mcpMethod", "mcpName", "mcpArguments", "aiProvider", "aiPrompt", "aiToolRequestIds"},
			wantMissingMethod:     true,
			wantMissingRequestTab: true,
		},
		{
			name:                  "grpc keeps grpc state and drops http websocket and socketio settings",
			request:               stripTestRequest("grpc", "POST", "body", "json"),
			wantSettings:          []string{"timeoutMs", "grpcUseTls", "grpcServerName", "grpcIncludeDefaultValues"},
			absentSettings:        []string{"followRedirects", "wsReconnectAttempts", "sioPath", "grpcUseReflection"},
			wantOverrides:         []string{"timeoutMs", "grpcUseTls", "grpcServerName"},
			absentOverrides:       []string{"followRedirects", "wsReconnectAttempts", "sioPath", "grpcUseReflection"},
			wantFields:            []string{"grpcMethod", "grpcMetadata", "grpcUseReflection", "grpcProtoFilePath"},
			absentFields:          []string{"method", "sioEvents", "sioArgs", "graphqlSchema", "mcpMethod", "mcpName", "mcpArguments"},
			wantMissingMethod:     true,
			wantMissingRequestTab: true,
		},
		{
			name:                  "mcp keeps the call and drops every other transport's state",
			request:               stripTestRequest("mcp", "POST", "body", "none"),
			wantSettings:          []string{"timeoutMs"},
			absentSettings:        []string{"wsReconnectAttempts", "sioPath", "grpcUseTls", "grpcServerName"},
			wantOverrides:         []string{"timeoutMs"},
			absentOverrides:       []string{"wsReconnectAttempts", "sioPath", "grpcUseTls", "grpcServerName"},
			wantFields:            []string{"mcpMethod", "mcpName", "mcpArguments", "mcpProtocolVersion"},
			absentFields:          []string{"method", "sioEvents", "sioArgs", "graphqlSchema", "grpcMethod", "grpcMetadata", "aiProvider", "aiModel", "aiPrompt", "aiStream", "aiToolRequestIds"},
			wantMissingMethod:     true,
			wantMissingRequestTab: true,
		},
		{
			name:                  "ai keeps the prompt and model and drops every other transport's state",
			request:               stripTestRequest("ai", "POST", "body", "none"),
			wantSettings:          []string{"timeoutMs"},
			absentSettings:        []string{"wsReconnectAttempts", "sioPath", "grpcUseTls", "grpcServerName"},
			wantOverrides:         []string{"timeoutMs"},
			absentOverrides:       []string{"wsReconnectAttempts", "sioPath", "grpcUseTls", "grpcServerName"},
			wantFields:            []string{"aiProvider", "aiModel", "aiPrompt", "aiStream", "aiToolRequestIds"},
			absentFields:          []string{"method", "sioEvents", "sioArgs", "graphqlSchema", "grpcMethod", "grpcMetadata", "mcpMethod", "mcpName", "mcpArguments"},
			wantMissingMethod:     true,
			wantMissingRequestTab: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stripRequestForFilesystem(tt.request)

			settings := nestedMap(tt.request, "settings")
			assertMapHasKeys(t, settings, tt.wantSettings)
			assertMapMissingKeys(t, settings, tt.absentSettings)

			overrides := nestedMap(tt.request, "settingsOverrides")
			assertMapHasKeys(t, overrides, tt.wantOverrides)
			assertMapMissingKeys(t, overrides, tt.absentOverrides)

			assertMapHasKeys(t, tt.request, tt.wantFields)
			assertMapMissingKeys(t, tt.request, tt.absentFields)
			if tt.wantMissingMethod {
				assertMapMissingKeys(t, tt.request, []string{"method"})
			}
			if tt.wantMissingRequestTab {
				assertMapMissingKeys(t, tt.request, []string{"requestTab"})
			}
		})
	}
}

func TestSanitizeRequestsForFilesystemTreatsOAuthRefreshTokenAsSecret(t *testing.T) {
	secrets := map[string]string{}
	requests := []map[string]any{
		{
			"id":          "req-oauth",
			"requestType": "http",
			"method":      "GET",
			"auth": map[string]any{
				"type":               "oauth2",
				"oauth2GrantType":    "authorization_code",
				"oauth2AuthURL":      "https://auth.example.test/authorize",
				"oauth2TokenURL":     "https://auth.example.test/token",
				"oauth2ClientID":     "stormhop",
				"oauth2Secret":       "client-secret",
				"oauth2Scope":        "openid profile",
				"oauth2Token":        "access-token",
				"oauth2RefreshToken": "refresh-token",
				"oauth2TokenExpiry":  float64(1760000000000),
				"oauth2UsePKCE":      true,
			},
		},
	}

	sanitized := sanitizeRequestsForFilesystem(requests, map[string]string{}, secrets)
	auth, ok := sanitized[0]["auth"].(map[string]any)
	if !ok {
		t.Fatalf("sanitized auth missing or wrong type: %#v", sanitized[0]["auth"])
	}

	refreshKey := "request.req-oauth.auth.oauth2RefreshToken"
	if got, want := auth["oauth2RefreshToken"], kurloSecretPlaceholder(refreshKey); got != want {
		t.Fatalf("oauth2RefreshToken = %q, want %q", got, want)
	}
	if got, want := secrets[refreshKey], "refresh-token"; got != want {
		t.Fatalf("stored refresh token = %q, want %q", got, want)
	}
	if got, want := auth["oauth2Secret"], kurloSecretPlaceholder("request.req-oauth.auth.oauth2Secret"); got != want {
		t.Fatalf("oauth2Secret = %q, want %q", got, want)
	}
	if got, want := auth["oauth2Token"], kurloSecretPlaceholder("request.req-oauth.auth.oauth2Token"); got != want {
		t.Fatalf("oauth2Token = %q, want %q", got, want)
	}

	for _, field := range []string{"oauth2GrantType", "oauth2AuthURL", "oauth2TokenURL", "oauth2ClientID", "oauth2Scope", "oauth2TokenExpiry", "oauth2UsePKCE"} {
		if _, ok := auth[field]; !ok {
			t.Fatalf("expected OAuth2 field %q to survive filesystem strip: %#v", field, auth)
		}
	}
}

func stripTestRequest(requestType, method, requestTab, bodyType string) map[string]any {
	return map[string]any{
		"id":           "req-main",
		"name":         "Main",
		"requestType":  requestType,
		"collectionId": "collection-main",
		"method":       method,
		"url":          "https://example.test",
		"requestTab":   requestTab,
		"params":       []any{},
		"headers":      []any{},
		"auth":         map[string]any{"type": "none"},
		"bodyType":     bodyType,
		"rawBodyType":  "json",
		"bodyContent":  stripTestBody(bodyType),
		"formRows":     []any{},
		"settings": map[string]any{
			"followRedirects":              false,
			"timeoutMs":                    float64(60000),
			"wsReconnectAttempts":          float64(3),
			"wsMaxMessageSizeMb":           float64(32),
			"sioPath":                      "/custom.io",
			"grpcUseTls":                   true,
			"grpcUseReflection":            false,
			"grpcServerName":               "api.example.test",
			"grpcIncludeDefaultValues":     false,
			"grpcMaxResponseMessageSizeMb": float64(10),
		},
		"settingsOverrides": map[string]any{
			"followRedirects":     true,
			"timeoutMs":           true,
			"wsReconnectAttempts": true,
			"sioPath":             true,
			"grpcUseTls":          true,
			"grpcUseReflection":   true,
			"grpcServerName":      true,
			"browserEmulation":    false,
		},
		"sioEvents":            []any{map[string]any{"id": float64(1), "enabled": true, "key": "message", "value": "", "description": ""}},
		"sioEventName":         "message",
		"sioArgs":              []any{map[string]any{"id": "1", "content": `{"ok":true}`, "bodyType": "json", "encoding": "base64"}},
		"sioAck":               true,
		"graphqlSchema":        "type Query { ok: Boolean }",
		"grpcMethod":           "demo.Service/Get",
		"grpcMetadata":         []any{map[string]any{"id": float64(2), "enabled": true, "key": "authorization", "value": "Bearer token", "description": ""}},
		"grpcUseReflection":    false,
		"grpcProtoFilePath":    "api.proto",
		"grpcProtoFileName":    "api.proto",
		"grpcProtoImportPaths": []any{"proto"},
		"mcpMethod":            "tools/call",
		"mcpName":              "get_weather",
		"mcpArguments":         `{"location":"Seattle"}`,
		"mcpProtocolVersion":   "2026-07-28",
		"aiProvider":           "anthropic",
		"aiModel":              "claude-sonnet-5-5",
		"aiPrompt":             "Hello {{name}}",
		"aiStream":             false,
		"aiToolRequestIds":     []any{"req-tools"},
	}
}

func stripTestBody(bodyType string) string {
	switch bodyType {
	case "graphql":
		return `{"query":"query { ok }"}`
	case "json":
		return "{}"
	case "text":
		return "ping"
	default:
		return ""
	}
}

func assertMapHasKeys(t *testing.T, item map[string]any, keys []string) {
	t.Helper()
	for _, key := range keys {
		if _, ok := item[key]; !ok {
			t.Fatalf("expected key %q in %#v", key, item)
		}
	}
}

func assertMapMissingKeys(t *testing.T, item map[string]any, keys []string) {
	t.Helper()
	for _, key := range keys {
		if _, ok := item[key]; ok {
			t.Fatalf("did not expect key %q in %#v", key, item)
		}
	}
}

func TestSanitizeRequestsForFilesystemKeepsSecretRowsOutOfTheYAML(t *testing.T) {
	secrets := map[string]string{}
	requests := []map[string]any{
		{
			"id":          "req-sio",
			"requestType": "socketio",
			"sioEvents":   []any{map[string]any{"id": "ev-1", "key": "auth", "value": "sio-secret", "enabled": true, "secret": true}},
		},
		{
			"id":           "req-grpc",
			"requestType":  "grpc",
			"grpcMetadata": []any{map[string]any{"id": "md-1", "key": "authorization", "value": "grpc-secret", "enabled": true, "secret": true}},
		},
		{
			"id":          "req-no-id",
			"requestType": "http",
			"method":      "GET",
			"headers": []any{
				map[string]any{"key": "Accept", "value": "*/*", "enabled": true},
				map[string]any{"key": "X-Token", "value": "imported-secret", "enabled": true, "secret": true},
			},
		},
	}

	sanitized := sanitizeRequestsForFilesystem(requests, map[string]string{}, secrets)

	for _, tt := range []struct {
		index int
		field string
		row   int
		key   string
		value string
	}{
		{0, "sioEvents", 0, "request.req-sio.sioEvents.row.ev-1.value", "sio-secret"},
		{1, "grpcMetadata", 0, "request.req-grpc.grpcMetadata.row.md-1.value", "grpc-secret"},
		{2, "headers", 1, "request.req-no-id.headers.row.index-1.value", "imported-secret"},
	} {
		rows, ok := sanitized[tt.index][tt.field].([]any)
		if !ok || len(rows) <= tt.row {
			t.Fatalf("%s rows missing: %#v", tt.field, sanitized[tt.index][tt.field])
		}
		row := rows[tt.row].(map[string]any)
		if got, want := row["value"], kurloSecretPlaceholder(tt.key); got != want {
			t.Fatalf("%s value = %q, want %q", tt.field, got, want)
		}
		if got := secrets[tt.key]; got != tt.value {
			t.Fatalf("stored %s secret = %q, want %q", tt.field, got, tt.value)
		}
	}
}

func TestSanitizeRequestsForFilesystemKeepsOAuth1SecretsOutOfTheYAML(t *testing.T) {
	secrets := map[string]string{}
	requests := []map[string]any{{
		"id":          "req-oauth1",
		"requestType": "http",
		"method":      "GET",
		"auth": map[string]any{
			"type":                  "oauth1",
			"oauth1ConsumerKey":     "consumer-key",
			"oauth1ConsumerSecret":  "consumer-secret",
			"oauth1Token":           "access-token",
			"oauth1TokenSecret":     "token-secret",
			"oauth1PrivateKey":      "-----BEGIN PRIVATE KEY-----",
			"oauth1SignatureMethod": "HMAC-SHA256",
			"oauth1AddTo":           "query",
			"awsSecretKey":          "left-over",
		},
	}}

	sanitized := sanitizeRequestsForFilesystem(requests, map[string]string{}, secrets)
	auth := sanitized[0]["auth"].(map[string]any)
	for _, field := range []string{"oauth1ConsumerSecret", "oauth1Token", "oauth1TokenSecret", "oauth1PrivateKey"} {
		key := "request.req-oauth1.auth." + field
		if got, want := auth[field], kurloSecretPlaceholder(key); got != want {
			t.Fatalf("%s = %q, want %q", field, got, want)
		}
		if secrets[key] == "" {
			t.Fatalf("%s was not stored in the local secrets", field)
		}
	}
	for field, want := range map[string]string{"oauth1ConsumerKey": "consumer-key", "oauth1SignatureMethod": "HMAC-SHA256", "oauth1AddTo": "query"} {
		if auth[field] != want {
			t.Fatalf("%s = %v, want %q", field, auth[field], want)
		}
	}
	if _, ok := auth["awsSecretKey"]; ok {
		t.Fatalf("fields of another auth type must be stripped: %#v", auth)
	}
}

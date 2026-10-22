package api

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestWorkspaceAuthSurvivesRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		auth map[string]any
	}{
		{"inherit", map[string]any{"type": "inherit"}},
		{"aws with session token", map[string]any{
			"type": "aws", "awsAccessKey": "AK", "awsSecretKey": "SK",
			"awsSessionToken": "ST", "awsRegion": "eu-west-1", "awsService": "s3",
		}},
		{"oauth2 password grant", map[string]any{
			"type": "oauth2", "oauth2GrantType": "password", "oauth2TokenURL": "https://token",
			"oauth2Username": "user", "oauth2Password": "pass", "oauth2ClientID": "cid",
		}},
		{"oauth2 device code", map[string]any{
			"type": "oauth2", "oauth2GrantType": "device_code", "oauth2TokenURL": "https://token",
			"oauth2DeviceAuthURL": "https://device", "oauth2ClientID": "cid", "oauth2Audience": "https://api",
		}},
		{"oauth2 private key jwt", map[string]any{
			"type": "oauth2", "oauth2GrantType": "client_credentials", "oauth2TokenURL": "https://token",
			"oauth2ClientID": "cid", "oauth2ClientAuth": "private_key_jwt",
			"oauth2AssertionAlgorithm": "RS256", "oauth2AssertionPrivateKey": "{{signingKey}}",
			"oauth2AssertionKeyID": "kid-1", "oauth2AssertionAudience": "https://token",
		}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			root := t.TempDir()
			workspaces := []map[string]any{{"id": "w1", "name": "WS"}}
			collections := []map[string]any{{"id": "c1", "workspaceId": "w1", "name": "Col"}}
			requests := []map[string]any{{
				"id": "r1", "workspaceId": "w1", "collectionId": "c1", "name": "Req",
				"method": "GET", "url": "https://example.com",
				"auth": cloneMap(testCase.auth),
			}}

			secrets := map[string]string{}
			sanitized := sanitizeRequestsForFilesystem(requests, map[string]string{}, secrets)
			if err := writeYAMLWorkspaceStore(root, workspaces, collections, sanitized, nil, nil, nil); err != nil {
				t.Fatalf("write: %v", err)
			}
			_, _, loaded, _, _, _, err := loadYAMLWorkspaceStoreWithDiagnostics(root, secrets)
			if err != nil {
				t.Fatalf("load: %v", err)
			}
			if len(loaded) != 1 {
				t.Fatalf("expected 1 request back, got %d", len(loaded))
			}
			gotAuth, _ := loaded[0]["auth"].(map[string]any)
			if gotAuth == nil {
				t.Fatalf("auth block was dropped entirely; a request set to %q now sends no auth", testCase.auth["type"])
			}
			for key, want := range testCase.auth {
				got, ok := gotAuth[key]
				if !ok {
					t.Errorf("auth field %q was dropped by the workspace writer", key)
					continue
				}
				if got != want {
					t.Errorf("auth field %q = %v, want %v", key, got, want)
				}
			}
		})
	}
}

func TestAuthActiveFieldsCoverAuthState(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "frontend", "src", "lib", "utils.ts"))
	if err != nil {
		t.Skipf("frontend sources unavailable: %v", err)
	}

	block := regexp.MustCompile(`(?s)export function emptyAuthState\(\) \{.*?\n\}`).Find(source)
	if block == nil {
		t.Fatal("could not find emptyAuthState() in frontend/src/lib/utils.ts")
	}

	covered := map[string]bool{"type": true}
	for _, fields := range authActiveFields {
		for _, field := range fields {
			covered[field] = true
		}
	}

	var missing []string
	for _, match := range regexp.MustCompile(`(?m)[\{\s,]([A-Za-z][A-Za-z0-9]*):\s`).FindAllSubmatch(block, -1) {
		field := string(match[1])
		if !covered[field] {
			missing = append(missing, field)
		}
	}
	if len(missing) > 0 {
		t.Errorf("auth fields missing from authActiveFields (they would be dropped on every save): %s", strings.Join(missing, ", "))
	}
}

func TestClientKeyPassphraseIsStoredAsASecret(t *testing.T) {
	requests := []map[string]any{{
		"id": "r1", "workspaceId": "w1", "collectionId": "c1", "name": "MTLS",
		"method": "GET", "url": "https://example.com",
		"settings": map[string]any{
			"clientCertPath":    "/certs/client.pem",
			"clientKeyPath":     "/certs/client.key",
			"clientKeyPassword": "super-secret-passphrase",
		},
	}}

	secrets := map[string]string{}
	sanitized := sanitizeRequestsForFilesystem(requests, map[string]string{}, secrets)

	settings, _ := sanitized[0]["settings"].(map[string]any)
	written := stringFromAny(settings["clientKeyPassword"])
	if strings.Contains(written, "super-secret-passphrase") {
		t.Fatalf("passphrase written to the workspace file in plain text: %q", written)
	}
	if _, ok := kurloSecretKeyFromPlaceholder(written); !ok {
		t.Fatalf("expected a local secret placeholder, got %q", written)
	}
	if secrets[requestSettingSecretKey("r1", "clientKeyPassword")] != "super-secret-passphrase" {
		t.Fatal("passphrase did not reach the local secret store")
	}

	mergeRequestSecrets(sanitized[0], secrets)
	restored, _ := sanitized[0]["settings"].(map[string]any)
	if stringFromAny(restored["clientKeyPassword"]) != "super-secret-passphrase" {
		t.Fatal("passphrase was not restored from the local secret store")
	}
}

func TestRealtimeTuningSettingsSurviveRoundTrip(t *testing.T) {
	root := t.TempDir()
	workspaces := []map[string]any{{"id": "w1", "name": "WS"}}
	collections := []map[string]any{{"id": "c1", "workspaceId": "w1", "name": "Col"}}
	requests := []map[string]any{
		{
			"id": "r1", "workspaceId": "w1", "collectionId": "c1", "name": "Stream",
			"method": "SSE", "url": "https://example.com/events", "requestType": "http",
			"settings": map[string]any{"sseDisableReconnect": true, "sseReconnectIntervalMs": float64(2500)},
		},
		{
			"id": "r2", "workspaceId": "w1", "collectionId": "c1", "name": "Socket",
			"url": "wss://example.com/ws", "requestType": "ws",
			"settings": map[string]any{"wsKeepAliveIntervalMs": float64(15000)},
		},
	}

	secrets := map[string]string{}
	sanitized := sanitizeRequestsForFilesystem(requests, map[string]string{}, secrets)
	if err := writeYAMLWorkspaceStore(root, workspaces, collections, sanitized, nil, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, _, loaded, _, _, _, err := loadYAMLWorkspaceStoreWithDiagnostics(root, secrets)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	byID := map[string]map[string]any{}
	for _, request := range loaded {
		byID[stringValue(request, "id")] = request
	}
	sse, _ := byID["r1"]["settings"].(map[string]any)
	if sse["sseDisableReconnect"] != true || numberValue(sse["sseReconnectIntervalMs"]) != 2500 {
		t.Errorf("SSE reconnect settings did not survive: %+v", sse)
	}
	ws, _ := byID["r2"]["settings"].(map[string]any)
	if numberValue(ws["wsKeepAliveIntervalMs"]) != 15000 {
		t.Errorf("WebSocket keep-alive interval did not survive: %+v", ws)
	}
}

func numberValue(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	}
	return 0
}

func TestUnknownBodyTypeKeepsTheBodyOnLoad(t *testing.T) {
	root := t.TempDir()
	workspaces := []map[string]any{{"id": "w1", "name": "WS"}}
	collections := []map[string]any{{"id": "c1", "workspaceId": "w1", "name": "Col"}}
	requests := []map[string]any{
		{"id": "r1", "workspaceId": "w1", "collectionId": "c1", "name": "Raw", "method": "POST", "url": "https://example.com", "requestType": "http"},
		{"id": "r2", "workspaceId": "w1", "collectionId": "c1", "name": "Plain", "method": "POST", "url": "https://example.com", "requestType": "http"},
		{"id": "r3", "workspaceId": "w1", "collectionId": "c1", "name": "Empty", "method": "POST", "url": "https://example.com", "requestType": "http"},
	}
	secrets := map[string]string{}
	if err := writeYAMLWorkspaceStore(root, workspaces, collections, sanitizeRequestsForFilesystem(requests, map[string]string{}, secrets), nil, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	bodies := map[string]string{
		"Raw":   "    bodyType: raw\n    rawBodyType: json\n    bodyContent: '{\"a\":1}'\n",
		"Plain": "    bodyType: plain\n    bodyContent: hello\n",
		"Empty": "    bodyType: plain\n",
	}
	for name, extra := range bodies {
		matches, _ := filepath.Glob(filepath.Join(root, "workspaces", "*", "collections", "*", "requests", name+".yml"))
		if len(matches) != 1 {
			t.Fatalf("request file for %s: %v", name, matches)
		}
		data, err := os.ReadFile(matches[0])
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(matches[0], append(data, extra...), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	_, _, loaded, _, _, _, err := loadYAMLWorkspaceStoreWithDiagnostics(root, secrets)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	byID := map[string]map[string]any{}
	for _, request := range loaded {
		byID[stringValue(request, "id")] = request
	}
	if got := stringValue(byID["r1"], "bodyType"); got != "json" || stringValue(byID["r1"], "bodyContent") != `{"a":1}` {
		t.Errorf("raw body loaded as %q with %q", got, stringValue(byID["r1"], "bodyContent"))
	}
	if got := stringValue(byID["r2"], "bodyType"); got != "text" || stringValue(byID["r2"], "bodyContent") != "hello" {
		t.Errorf("unknown body type with content loaded as %q", got)
	}
	if got := stringValue(byID["r3"], "bodyType"); got != "plain" {
		t.Errorf("unknown body type without content changed to %q", got)
	}
}

package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMCPWorkspaceAuthorizesAllOAuth2Grants(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	mux := http.NewServeMux()
	mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("code_challenge") == "" {
			t.Error("PKCE challenge is missing")
		}
		http.Redirect(w, r, q.Get("redirect_uri")+"?code=approved&state="+q.Get("state"), http.StatusFound)
	})
	mux.HandleFunc("/device", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"device_code":"device","user_code":"ABCD","verification_uri":"https://example.test/device","expires_in":30,"interval":1}`)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("grant_type") == "authorization_code" && r.Form.Get("code_verifier") == "" {
			t.Error("PKCE verifier is missing")
		}
		_, _ = io.WriteString(w, `{"access_token":"oauth-token-private","expires_in":120,"refresh_token":"refresh-token-private"}`)
	})
	mux.HandleFunc("/resource", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer oauth-token-private" {
			w.WriteHeader(http.StatusUnauthorized)
		}
		_, _ = io.WriteString(w, r.Header.Get("Authorization"))
	})
	provider := httptest.NewServer(mux)
	defer provider.Close()
	root := writeYAMLWorkspace(t, provider.URL)
	s := newMCPServer(mcpServerOptions{workspace: root}, io.Discard)
	s.openOAuthBrowser = func(target string) error {
		if strings.HasPrefix(target, provider.URL) {
			resp, err := provider.Client().Get(target)
			if err != nil {
				return err
			}
			resp.Body.Close()
		}
		return nil
	}
	call := func(tool string, args map[string]any) string {
		t.Helper()
		data, _ := json.Marshal(map[string]any{"name": tool, "arguments": args})
		reply, err := s.callTool(context.Background(), data)
		if err != nil {
			t.Fatal(err)
		}
		text, failed := mcpResultPlainText(reply)
		if failed || strings.Contains(text, "oauth-token-private") || strings.Contains(text, "refresh-token-private") {
			t.Fatalf("%s failed or exposed a token: %s", tool, text)
		}
		return text
	}
	for _, grant := range []string{"client_credentials", "password", "authorization_code", "device_code"} {
		t.Run(grant, func(t *testing.T) {
			call("patch_request", map[string]any{"request": "req-ok", "patch": map[string]any{
				"url": provider.URL + "/resource",
				"auth": map[string]any{
					"type": "oauth2", "oauth2GrantType": grant, "oauth2ClientID": "client", "oauth2Username": "user",
					"oauth2AuthURL": provider.URL + "/authorize", "oauth2TokenURL": provider.URL + "/token",
					"oauth2DeviceAuthURL": provider.URL + "/device", "oauth2UsePKCE": true,
				},
			}})
			call("authorize_oauth2", map[string]any{"request": "req-ok"})
			var result mcpRequestOutcome
			if err := json.Unmarshal([]byte(call("run_request", map[string]any{"request": "req-ok"})), &result); err != nil || result.Status != 200 || !strings.Contains(result.Body, "[secret]") {
				t.Fatalf("run = %+v, error = %v", result, err)
			}
		})
	}
}

package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const exportPayload = `{
  "loadTest": {
    "id": "lt-1", "name": "Orders smoke",
    "scenarios": [{"id": "sc", "name": "Flow", "executor": {"type": "constant-vus", "vus": 2, "durationMs": 60000},
      "steps": [{"id": "st-1", "requestId": "req-orders"}, {"id": "st-2", "requestId": "req-draft"}]}],
    "data": {"path": "data/users.csv", "mode": "random"},
    "settings": {}
  },
  "collection": {
    "id": "col", "name": "Shop API",
    "defaults": {
      "headers": [{"key": "X-Team", "value": "{{team}}", "enabled": true}],
      "variables": [{"key": "team", "value": "checkout", "enabled": true}, {"key": "host", "value": "https://collection.test", "enabled": true}],
      "auth": {"type": "bearer", "bearerToken": "{{token}}"}
    }
  },
  "requests": [
    {"id": "req-orders", "name": "List orders", "requestType": "http", "method": "get", "url": "{{host}}/orders",
     "params": [{"key": "limit", "value": "5", "enabled": true}, {"key": "off", "value": "1", "enabled": false}],
     "auth": {"type": "inherit"}, "settings": {"enableSSLVerification": false},
     "testScriptJs": "pm.test('ok', () => {})"},
    {"id": "req-draft", "name": "Draft", "requestType": "http", "method": "GET", "url": "https://draft.test", "isDraft": true}
  ],
  "environment": {"name": "staging", "values": [
    {"key": "host", "value": "https://staging.test", "enabled": true},
    {"key": "token", "value": "env-secret-token", "enabled": true, "secret": true}
  ]},
  "globals": [{"key": "team", "value": "global-team", "enabled": true}]
}`

func TestLoadTestPlanUsesCollectionDefaultsAndVariablePrecedence(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "data", "users.csv"), []byte("email\nada@shop.test\n"), 0644); err != nil {
		t.Fatal(err)
	}
	plan, err := loadTestPlanFromPayload(exportPayload, root)
	if err != nil {
		t.Fatal(err)
	}
	request, ok := plan.Requests["req-orders"]
	if !ok {
		t.Fatalf("the request should be in the plan: %+v", plan.Requests)
	}
	if _, ok := plan.Requests["req-draft"]; ok {
		t.Error("a draft request is not part of a load test")
	}
	if request.Method != "GET" || request.Auth.Type != "bearer" || request.Auth.Token != "{{token}}" {
		t.Errorf("the request should inherit the collection auth and keep templates: %+v", request)
	}
	if len(request.Headers) != 1 || request.Headers[0].Key != "X-Team" {
		t.Errorf("the collection default header should be merged in: %+v", request.Headers)
	}
	if len(request.Query) != 1 || request.Query[0].Key != "limit" {
		t.Errorf("only enabled params are sent: %+v", request.Query)
	}
	if request.VerifyTLS || !request.HasScripts {
		t.Errorf("TLS and script flags should carry over: %+v", request)
	}
	values := map[string]string{}
	secret := map[string]bool{}
	for _, variable := range plan.Variables {
		values[variable.Name] = variable.Value
		secret[variable.Name] = variable.Secret
	}
	if values["host"] != "https://staging.test" || values["team"] != "checkout" || !secret["token"] {
		t.Errorf("environment beats collection beats globals: %+v", plan.Variables)
	}
	if len(plan.Data) != 1 || plan.Data[0]["email"] != "ada@shop.test" || plan.DataError != "" {
		t.Errorf("the data file should be read from the workspace: %+v %q", plan.Data, plan.DataError)
	}
}

func TestLoadTestDataOutsideTheWorkspaceIsRefused(t *testing.T) {
	root := t.TempDir()
	payload := strings.Replace(exportPayload, `"data/users.csv"`, `"../secrets.csv"`, 1)
	plan, err := loadTestPlanFromPayload(payload, root)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Data != nil || plan.DataError == "" {
		t.Fatalf("a path outside the workspace must not be read: %+v %q", plan.Data, plan.DataError)
	}
}

func TestExportLoadTestK6(t *testing.T) {
	result := (&App{}).ExportLoadTestK6(exportPayload, false)
	if result.Error != "" {
		t.Fatal(result.Error)
	}
	if result.FileName != "orders-smoke.k6.js" {
		t.Errorf("file name = %q", result.FileName)
	}
	if strings.Contains(result.Script, "env-secret-token") {
		t.Error("the secret token must not be written into the script")
	}
	for _, want := range []string{`"host": "https://staging.test"`, `"X-Team": t("{{team}}")`, `"Authorization": t("Bearer {{token}}")`, "insecureSkipTLSVerify: true"} {
		if !strings.Contains(result.Script, want) {
			t.Errorf("script is missing %s:\n%s", want, result.Script)
		}
	}
	if withSecret := (&App{}).ExportLoadTestK6(exportPayload, true); !strings.Contains(withSecret.Script, "env-secret-token") {
		t.Error("the secret should be written when asked")
	}
	if broken := (&App{}).ExportLoadTestK6("{", false); broken.Error == "" || broken.Warnings == nil {
		t.Errorf("a broken payload should return an error and an empty warning list: %+v", broken)
	}
}

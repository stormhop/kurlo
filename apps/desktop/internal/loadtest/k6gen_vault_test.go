package loadtest

import (
	"strings"
	"testing"
)

func TestGenerateReadsVaultTemplatesAsVariables(t *testing.T) {
	plan := checkoutPlan()
	login := plan.Requests["req-login"]
	login.Body = `{"email":"{{email}}","password":"{{vault:password}}"}`
	plan.Requests["req-login"] = login
	result := GenerateK6(plan, Options{})
	if !strings.Contains(result.Script, `key.trim().replace(/^vault:\s*/, '')`) {
		t.Fatalf("t() does not strip vault:\n%s", result.Script)
	}
	if strings.Contains(warningMessages(result), "vault:password") {
		t.Fatalf("vault:password is reported as unknown: %s", warningMessages(result))
	}
}

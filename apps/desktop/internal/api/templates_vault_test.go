package api

import (
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/script"
)

func TestVaultTemplatesReadTheVariable(t *testing.T) {
	values := map[string]string{"apiToken": "{{kurloRef:abc}}", "vault:literal": "exact", "literal": "alias"}
	cases := map[string]string{
		"Bearer {{vault:apiToken}}":       "Bearer {{kurloRef:abc}}",
		"{{ vault: apiToken }}":           "{{kurloRef:abc}}",
		"{{vault:literal}}":               "exact",
		"{{vault:missing}}":               "{{vault:missing}}",
		"{{apiToken}}/{{vault:apiToken}}": "{{kurloRef:abc}}/{{kurloRef:abc}}",
	}
	for in, want := range cases {
		if got := resolveTemplateValue(in, values); got != want {
			t.Errorf("resolveTemplateValue(%q) = %q, want %q", in, got, want)
		}
	}
	if model.TemplateVariableKey(" vault: x ") != "x" || model.TemplateVariableKey("vaulty") != "vaulty" {
		t.Fatal("TemplateVariableKey")
	}
	if !variableMentioned([]string{"Authorization: Bearer {{vault:apiToken}}"}, "apiToken") || variableMentioned([]string{"{{vault:apiTokenX}}"}, "apiToken") {
		t.Fatal("variableMentioned does not see {{vault:apiToken}}")
	}
	if got := substituteKnownVariables("{{vault:apiToken}}", map[string]string{"apiToken": "v"}); got != "v" {
		t.Fatalf("substituteKnownVariables = %q", got)
	}
	if got := templateNames("x {{vault:db}} {{plain}}"); len(got) != 2 || got[0] != "db" || got[1] != "plain" {
		t.Fatalf("templateNames = %v", got)
	}
	ctx := script.NewContext(map[string]string{"apiToken": "t"}, map[string]string{})
	if got := ctx.ReplaceIn("{{vault:apiToken}}"); got != "t" {
		t.Fatalf("ReplaceIn = %q", got)
	}
}

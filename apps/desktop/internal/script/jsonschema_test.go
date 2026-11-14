package script

import (
	"strings"
	"testing"
)

func schemaCheck(t *testing.T, schemaJSON, dataJSON string) []string {
	t.Helper()
	errs, err := ValidateJSONSchemaText(schemaJSON, dataJSON)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	return errs
}

func TestSchemaAcceptsAValidDocument(t *testing.T) {
	t.Parallel()

	schema := `{
		"type": "object",
		"required": ["id", "name", "tags"],
		"properties": {
			"id": {"type": "integer", "minimum": 1},
			"name": {"type": "string", "minLength": 1, "pattern": "^[A-Z]"},
			"tags": {"type": "array", "items": {"type": "string"}, "minItems": 1, "uniqueItems": true},
			"role": {"enum": ["admin", "user"]}
		},
		"additionalProperties": false
	}`
	if errs := schemaCheck(t, schema, `{"id":7,"name":"Ada","tags":["a","b"],"role":"admin"}`); len(errs) != 0 {
		t.Fatalf("expected no errors, got %v", errs)
	}
}

func TestSchemaReportsEveryFailure(t *testing.T) {
	t.Parallel()

	schema := `{
		"type": "object",
		"required": ["id", "name"],
		"properties": {
			"id": {"type": "integer", "minimum": 1},
			"name": {"type": "string", "maxLength": 3}
		},
		"additionalProperties": false
	}`
	errs := schemaCheck(t, schema, `{"id":"seven","name":"Grace","extra":true}`)
	joined := strings.Join(errs, " | ")
	for _, want := range []string{"/id: expected integer", "/name: string is longer", `property "extra" is not allowed`} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in %q", want, joined)
		}
	}
}

func TestSchemaChecksNestedArraysAndRefs(t *testing.T) {
	t.Parallel()

	schema := `{
		"definitions": {"item": {"type": "object", "required": ["sku"], "properties": {"sku": {"type": "string"}}}},
		"type": "object",
		"properties": {"items": {"type": "array", "items": {"$ref": "#/definitions/item"}}}
	}`
	errs := schemaCheck(t, schema, `{"items":[{"sku":"a"},{"name":"b"}]}`)
	if len(errs) != 1 || !strings.Contains(errs[0], "/items/1: missing required property \"sku\"") {
		t.Fatalf("errors = %v", errs)
	}
}

func TestSchemaIntegerIsAlsoANumberButNotTheReverse(t *testing.T) {
	t.Parallel()

	if errs := schemaCheck(t, `{"type":"number"}`, `4`); len(errs) != 0 {
		t.Fatalf("an integer should satisfy number: %v", errs)
	}
	if errs := schemaCheck(t, `{"type":"integer"}`, `4.5`); len(errs) != 1 {
		t.Fatalf("4.5 should not satisfy integer: %v", errs)
	}
}

func TestSchemaCombinators(t *testing.T) {
	t.Parallel()

	oneOf := `{"oneOf":[{"type":"string"},{"type":"number"}]}`
	if errs := schemaCheck(t, oneOf, `"text"`); len(errs) != 0 {
		t.Fatalf("errors = %v", errs)
	}
	if errs := schemaCheck(t, oneOf, `true`); len(errs) != 1 {
		t.Fatalf("a boolean matches neither branch: %v", errs)
	}
	if errs := schemaCheck(t, `{"anyOf":[{"type":"string"},{"type":"null"}]}`, `null`); len(errs) != 0 {
		t.Fatalf("errors = %v", errs)
	}
	if errs := schemaCheck(t, `{"not":{"type":"string"}}`, `"x"`); len(errs) != 1 {
		t.Fatalf("errors = %v", errs)
	}
}

func TestSchemaHonoursOpenAPINullable(t *testing.T) {
	t.Parallel()

	if errs := schemaCheck(t, `{"type":"string","nullable":true}`, `null`); len(errs) != 0 {
		t.Fatalf("errors = %v", errs)
	}
}

func TestSchemaSaysWhenItStoppedListingFailures(t *testing.T) {
	t.Parallel()

	items := make([]string, 0, 30)
	for i := 0; i < 30; i++ {
		items = append(items, `1`)
	}
	errs := schemaCheck(t, `{"type":"array","items":{"type":"string"}}`, "["+strings.Join(items, ",")+"]")
	if len(errs) != maxSchemaErrors+1 {
		t.Fatalf("expected %d failures plus a notice, got %d", maxSchemaErrors, len(errs))
	}
	last := errs[len(errs)-1]
	if !strings.Contains(last, "10 more failures") {
		t.Fatalf("last line does not report the suppressed failures: %q", last)
	}
}

func TestSchemaRejectsMalformedInput(t *testing.T) {
	t.Parallel()

	if _, err := ValidateJSONSchemaText(`{`, `{}`); err == nil {
		t.Fatal("expected an error for a malformed schema")
	}
	if _, err := ValidateJSONSchemaText(`{}`, `not json`); err == nil {
		t.Fatal("expected an error for malformed data")
	}
}

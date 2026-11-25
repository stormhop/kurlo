package api

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed kurlo-workspace-yaml-v1.schema.json
var workspaceFileContract []byte

var compiledWorkspaceFileContract = sync.OnceValues(func() (map[string]*jsonschema.Schema, error) {
	const location = "https://kurlo.dev/schemas/kurlo-workspace-yaml-v1.schema.json"
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(workspaceFileContract))
	if err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource(location, document); err != nil {
		return nil, err
	}
	schemas := make(map[string]*jsonschema.Schema)
	for _, section := range []string{"workspace", "request", "collection", "environment", "example"} {
		schema, err := compiler.Compile(location + "#/definitions/" + section + "File")
		if err != nil {
			return nil, err
		}
		schemas[section] = schema
	}
	return schemas, nil
})

func validateWorkspaceFileContract(section string, fields map[string]any) error {
	return validateWorkspaceDocument(section, map[string]any{"version": fileStoreVersion, section: fields})
}

func validateWorkspaceDocument(section string, value any) error {
	schemas, err := compiledWorkspaceFileContract()
	if err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		return err
	}
	if err := schemas[section].Validate(document); err != nil {
		return fmt.Errorf("%s does not match the workspace YAML schema: %w", section, err)
	}
	if section == "request" {
		doc, _ := document.(map[string]any)
		request := nestedMap(doc, "request")
		seen := map[string]bool{strings.TrimSpace(stringValue(request, "activeBodyVariant")): true}
		for _, variant := range mapSlice(request["bodyVariants"]) {
			name := strings.TrimSpace(stringValue(variant, "name"))
			if seen[name] {
				return fmt.Errorf("body variant name %q is already in use", name)
			}
			seen[name] = true
		}
	}
	return nil
}

func validateStoredBodyVariants(request map[string]any) error {
	_, hasActive := request["activeBodyVariant"]
	_, hasVariants := request["bodyVariants"]
	if !hasActive && !hasVariants {
		return nil
	}
	fields := map[string]any{"id": request["id"]}
	for _, key := range []string{"requestType", "url", "bodyType", "activeBodyVariant", "bodyVariants"} {
		if value, ok := request[key]; ok {
			fields[key] = value
		}
	}
	return validateWorkspaceFileContract("request", fields)
}

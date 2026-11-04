package api

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
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
	for _, section := range []string{"request", "collection", "environment", "example"} {
		schema, err := compiler.Compile(location + "#/definitions/" + section + "File")
		if err != nil {
			return nil, err
		}
		schemas[section] = schema
	}
	return schemas, nil
})

func validateWorkspaceFileContract(section string, fields map[string]any) error {
	schemas, err := compiledWorkspaceFileContract()
	if err != nil {
		return err
	}
	data, err := json.Marshal(map[string]any{"version": fileStoreVersion, section: fields})
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
	return nil
}

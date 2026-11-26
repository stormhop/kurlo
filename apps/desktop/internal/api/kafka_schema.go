package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"gopkg.in/yaml.v3"
)

type kafkaSchema struct {
	compiled *jsonschema.Schema
	err      error
}

func kafkaSchemaObject(root map[string]any, value any) (map[string]any, error) {
	for depth := 0; depth < 32; depth++ {
		obj, ok := value.(map[string]any)
		if !ok {
			return nil, errors.New("expected a schema object")
		}
		ref, ok := obj["$ref"].(string)
		if !ok {
			return obj, nil
		}
		if !strings.HasPrefix(ref, "#/") {
			return nil, fmt.Errorf("unsupported external reference %s", ref)
		}
		value = root
		for _, key := range strings.Split(ref[2:], "/") {
			node, _ := value.(map[string]any)
			value = node[strings.NewReplacer("~1", "/", "~0", "~").Replace(key)]
		}
	}
	return nil, errors.New("circular AsyncAPI reference")
}

func kafkaPayloadSchema(doc map[string]any, topic string) (any, error) {
	if doc["asyncapi"] == nil {
		return doc, nil
	}
	channels, _ := doc["channels"].(map[string]any)
	for name, value := range channels {
		channel, err := kafkaSchemaObject(doc, value)
		if err != nil {
			continue
		}
		if address, ok := channel["address"].(string); ok {
			name = address
		}
		if name != topic {
			continue
		}
		var messages []any
		for _, op := range []string{"publish", "subscribe"} {
			if channel[op] != nil {
				obj, err := kafkaSchemaObject(doc, channel[op])
				if err != nil {
					return nil, err
				}
				messages = append(messages, obj["message"])
			}
		}
		if entries, ok := channel["messages"].(map[string]any); ok {
			for _, msg := range entries {
				messages = append(messages, msg)
			}
		}
		var schemas []any
		for _, msg := range messages {
			obj, err := kafkaSchemaObject(doc, msg)
			if err != nil {
				return nil, err
			}
			alternatives, ok := obj["oneOf"].([]any)
			if !ok {
				alternatives = []any{obj}
			}
			for _, alternative := range alternatives {
				message, err := kafkaSchemaObject(doc, alternative)
				if err != nil {
					return nil, err
				}
				if payload, ok := message["payload"]; ok {
					schemas = append(schemas, payload)
				}
			}
		}
		if len(schemas) == 0 {
			return nil, errors.New("channel has no JSON payload schema")
		}
		return map[string]any{"anyOf": schemas, "components": doc["components"]}, nil
	}
	return nil, fmt.Errorf("no AsyncAPI channel for %s", topic)
}

func loadKafkaSchema(root, path, topic string) kafkaSchema {
	if path == "" {
		return kafkaSchema{}
	}
	filePath := resolveRequestFilePath(root, path)
	info, err := os.Stat(filePath)
	if err != nil {
		return kafkaSchema{err: err}
	}
	if !info.Mode().IsRegular() || info.Size() > 4<<20 {
		return kafkaSchema{err: errors.New("schema must be a regular file under 4 MiB")}
	}
	f, err := os.Open(filePath)
	if err != nil {
		return kafkaSchema{err: err}
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, (4<<20)+1))
	if err != nil {
		return kafkaSchema{err: err}
	}
	if len(data) > 4<<20 {
		return kafkaSchema{err: errors.New("schema exceeds 4 MiB")}
	}
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return kafkaSchema{err: err}
	}
	payload, err := kafkaPayloadSchema(doc, topic)
	if err != nil {
		return kafkaSchema{err: err}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return kafkaSchema{err: err}
	}
	resource, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
	if err != nil {
		return kafkaSchema{err: err}
	}
	c := jsonschema.NewCompiler()
	c.UseLoader(jsonschema.SchemeURLLoader{})
	const location = "urn:kurlo:kafka:schema"
	if err = c.AddResource(location, resource); err != nil {
		return kafkaSchema{err: err}
	}
	schema, err := c.Compile(location)
	return kafkaSchema{schema, err}
}

func (s kafkaSchema) validate(record *kafkaRecord) {
	if s.err != nil {
		record.Validation = "Unvalidated"
		record.SchemaIssue = s.err.Error()
		return
	}
	if s.compiled == nil {
		return
	}
	if record.Value == nil || record.Encoding != "" {
		record.Validation = "Unvalidated"
		record.SchemaIssue = "Expected a JSON payload"
		return
	}
	value, err := jsonschema.UnmarshalJSON(strings.NewReader(*record.Value))
	if err == nil {
		err = s.compiled.Validate(value)
	}
	if err != nil {
		record.Validation = "Invalid"
		record.SchemaIssue = err.Error()
		return
	}
	record.Validation = "Valid"
}

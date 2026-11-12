package api

import (
	"bytes"
	"reflect"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

var yamlBlockIndentIndicator = regexp.MustCompile(`[:-] [|>][0-9]`)

type yamlQuotedString string

func (s yamlQuotedString) MarshalYAML() (any, error) {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Style: yaml.DoubleQuotedStyle, Value: string(s)}, nil
}

func marshalWorkspaceYAML(value any) ([]byte, error) {
	data, err := yaml.Marshal(value)
	if err != nil {
		return nil, err
	}
	if !bytes.ContainsRune(data, '\t') && !yamlBlockIndentIndicator.Match(data) {
		return data, nil
	}
	return yaml.Marshal(quoteUnsafeYAMLStrings(value))
}

func blockScalarUnsafe(value string) bool {
	if !strings.Contains(value, "\n") {
		return false
	}
	return strings.HasPrefix(value, " ") || strings.HasPrefix(value, "\n") || strings.HasPrefix(value, "\t")
}

func quoteUnsafeYAMLStrings(value any) any {
	switch v := value.(type) {
	case nil:
		return nil
	case string:
		if blockScalarUnsafe(v) {
			return yamlQuotedString(v)
		}
		return v
	case map[string]any:
		return quoteUnsafeYAMLMap(v)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = quoteUnsafeYAMLStrings(item)
		}
		return out
	case []map[string]any:
		out := make([]map[string]any, len(v))
		for i, item := range v {
			out[i] = quoteUnsafeYAMLMap(item)
		}
		return out
	case map[string]string:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = quoteUnsafeYAMLStrings(item)
		}
		return out
	case []string:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = quoteUnsafeYAMLStrings(item)
		}
		return out
	}
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Pointer:
		if rv.IsNil() || rv.Elem().Kind() != reflect.Struct {
			return value
		}
		copied := reflect.New(rv.Elem().Type())
		copied.Elem().Set(quoteUnsafeYAMLStruct(rv.Elem()))
		return copied.Interface()
	case reflect.Struct:
		return quoteUnsafeYAMLStruct(rv).Interface()
	}
	return value
}

func quoteUnsafeYAMLMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for key, item := range in {
		out[key] = quoteUnsafeYAMLStrings(item)
	}
	return out
}

func quoteUnsafeYAMLStruct(rv reflect.Value) reflect.Value {
	copied := reflect.New(rv.Type()).Elem()
	copied.Set(rv)
	for i := 0; i < rv.NumField(); i++ {
		field := copied.Field(i)
		if !field.CanSet() || !rv.Type().Field(i).IsExported() {
			continue
		}
		if field.Kind() == reflect.Interface && field.IsNil() {
			continue
		}
		replaced := quoteUnsafeYAMLStrings(field.Interface())
		if replaced == nil {
			continue
		}
		next := reflect.ValueOf(replaced)
		if next.Type().AssignableTo(field.Type()) {
			field.Set(next)
		}
	}
	return copied
}

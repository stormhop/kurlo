package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

type orderedObject struct {
	keys   []string
	values map[string]any
}

func newOrderedObject() *orderedObject {
	return &orderedObject{values: map[string]any{}}
}

func (o *orderedObject) get(key string) (any, bool) {
	value, ok := o.values[key]
	return value, ok
}

func (o *orderedObject) set(key string, value any) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

func (o *orderedObject) remove(key string) bool {
	if _, ok := o.values[key]; !ok {
		return false
	}
	delete(o.values, key)
	for i, existing := range o.keys {
		if existing == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
	return true
}

func (o *orderedObject) object(key string) (*orderedObject, error) {
	value, ok := o.values[key]
	if !ok || value == nil {
		child := newOrderedObject()
		o.set(key, child)
		return child, nil
	}
	child, ok := value.(*orderedObject)
	if !ok {
		return nil, fmt.Errorf("%q is not an object", key)
	}
	return child, nil
}

func parseOrderedJSON(data []byte) (*orderedObject, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return newOrderedObject(), nil
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := decodeOrderedValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("unexpected content after the JSON value")
	}
	object, ok := value.(*orderedObject)
	if !ok {
		return nil, fmt.Errorf("the file does not hold a JSON object")
	}
	return object, nil
}

func decodeOrderedValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch delim := token.(type) {
	case json.Delim:
		switch delim {
		case '{':
			object := newOrderedObject()
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("object key is not a string")
				}
				value, err := decodeOrderedValue(decoder)
				if err != nil {
					return nil, err
				}
				object.set(key, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return object, nil
		case '[':
			list := []any{}
			for decoder.More() {
				value, err := decodeOrderedValue(decoder)
				if err != nil {
					return nil, err
				}
				list = append(list, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return list, nil
		}
		return nil, fmt.Errorf("unexpected %q", delim)
	default:
		return token, nil
	}
}

func detectJSONIndent(data []byte) string {
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimLeft(line, " \t")
		if trimmed != "" && len(trimmed) < len(line) {
			return line[:len(line)-len(trimmed)]
		}
	}
	return "  "
}

func encodeOrderedJSON(value any, indent string) []byte {
	var out bytes.Buffer
	writeOrderedValue(&out, value, indent, "")
	out.WriteByte('\n')
	return out.Bytes()
}

func writeOrderedValue(out *bytes.Buffer, value any, indent, prefix string) {
	switch typed := value.(type) {
	case *orderedObject:
		if len(typed.keys) == 0 {
			out.WriteString("{}")
			return
		}
		out.WriteString("{\n")
		for i, key := range typed.keys {
			out.WriteString(prefix + indent)
			writeJSONString(out, key)
			out.WriteString(": ")
			writeOrderedValue(out, typed.values[key], indent, prefix+indent)
			if i < len(typed.keys)-1 {
				out.WriteByte(',')
			}
			out.WriteByte('\n')
		}
		out.WriteString(prefix + "}")
	case []any:
		if len(typed) == 0 {
			out.WriteString("[]")
			return
		}
		out.WriteString("[\n")
		for i, item := range typed {
			out.WriteString(prefix + indent)
			writeOrderedValue(out, item, indent, prefix+indent)
			if i < len(typed)-1 {
				out.WriteByte(',')
			}
			out.WriteByte('\n')
		}
		out.WriteString(prefix + "]")
	case []string:
		list := make([]any, 0, len(typed))
		for _, item := range typed {
			list = append(list, item)
		}
		writeOrderedValue(out, list, indent, prefix)
	case string:
		writeJSONString(out, typed)
	default:
		encoded, _ := json.Marshal(typed)
		out.Write(encoded)
	}
}

func writeJSONString(out *bytes.Buffer, value string) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	out.Write(bytes.TrimRight(buf.Bytes(), "\n"))
}

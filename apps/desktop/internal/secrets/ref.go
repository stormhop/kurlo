package secrets

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

const (
	markerPrefix = "{{kurloRef:"
	markerSuffix = "}}"
)

var markerPattern = regexp.MustCompile(`\{\{kurloRef:([A-Za-z0-9_-]+)\}\}`)

type Ref struct {
	Provider string `json:"p"`
	Path     string `json:"path"`
	Field    string `json:"f,omitempty"`
	Version  string `json:"v,omitempty"`
}

func (r Ref) Valid() bool {
	return strings.TrimSpace(r.Provider) != "" && strings.TrimSpace(r.Path) != ""
}

func (r Ref) String() string {
	out := r.Provider + ":" + r.Path
	if r.Field != "" {
		out += "#" + r.Field
	}
	if r.Version != "" {
		out += "@" + r.Version
	}
	return out
}

func RefFromMap(raw any) (Ref, bool) {
	item, ok := raw.(map[string]any)
	if !ok {
		return Ref{}, false
	}
	ref := Ref{
		Provider: strings.TrimSpace(stringField(item, "provider")),
		Path:     strings.TrimSpace(stringField(item, "path")),
		Field:    strings.TrimSpace(stringField(item, "field")),
		Version:  strings.TrimSpace(stringField(item, "version")),
	}
	return ref, ref.Valid()
}

func Marker(ref Ref) string {
	encoded, _ := json.Marshal(ref)
	return markerPrefix + base64.RawURLEncoding.EncodeToString(encoded) + markerSuffix
}

func DecodeMarker(marker string) (Ref, error) {
	if !strings.HasPrefix(marker, markerPrefix) || !strings.HasSuffix(marker, markerSuffix) {
		return Ref{}, errors.New("not a linked secret marker")
	}
	return decodePayload(marker[len(markerPrefix) : len(marker)-len(markerSuffix)])
}

func decodePayload(payload string) (Ref, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return Ref{}, err
	}
	var ref Ref
	if err := json.Unmarshal(decoded, &ref); err != nil {
		return Ref{}, err
	}
	if !ref.Valid() {
		return Ref{}, errors.New("linked secret marker has no provider or path")
	}
	return ref, nil
}

func ContainsMarker(text string) bool {
	return strings.Contains(text, markerPrefix)
}

func FindMarkers(text string) []Ref {
	if !ContainsMarker(text) {
		return nil
	}
	var refs []Ref
	for _, match := range markerPattern.FindAllStringSubmatch(text, -1) {
		if ref, err := decodePayload(match[1]); err == nil {
			refs = append(refs, ref)
		}
	}
	return refs
}

func ReplaceMarkers(text string, values map[Ref]string) string {
	if !ContainsMarker(text) {
		return text
	}
	return markerPattern.ReplaceAllStringFunc(text, func(match string) string {
		ref, err := DecodeMarker(match)
		if err != nil {
			return match
		}
		if value, ok := values[ref]; ok {
			return value
		}
		return match
	})
}

type Import struct {
	Provider string
	Path     string
	Version  string
	Prefix   string
	Keys     []string
}

func ImportFromMap(raw any) (Import, bool) {
	item, ok := raw.(map[string]any)
	if !ok {
		return Import{}, false
	}
	source := Import{
		Provider: strings.TrimSpace(stringField(item, "provider")),
		Path:     strings.TrimSpace(stringField(item, "path")),
		Version:  strings.TrimSpace(stringField(item, "version")),
		Prefix:   strings.TrimSpace(stringField(item, "prefix")),
	}
	if keys, ok := item["keys"].([]any); ok {
		seen := map[string]bool{}
		source.Keys = []string{}
		for _, key := range keys {
			name, _ := key.(string)
			if name = strings.TrimSpace(name); name != "" && !seen[name] {
				seen[name] = true
				source.Keys = append(source.Keys, name)
			}
		}
	}
	return source, source.Provider != "" && source.Path != ""
}

func ImportsFromAny(raw any) ([]Import, []int) {
	items, _ := raw.([]any)
	var sources []Import
	var invalid []int
	for index, item := range items {
		source, ok := ImportFromMap(item)
		if !ok {
			invalid = append(invalid, index)
			continue
		}
		sources = append(sources, source)
	}
	return sources, invalid
}

func (s Import) Ref(field string) Ref {
	return Ref{Provider: s.Provider, Path: s.Path, Field: field, Version: s.Version}
}

func (s Import) Filtered() bool {
	return s.Keys != nil
}

func (s Import) Allows(field string) bool {
	if field == "" {
		return false
	}
	if !s.Filtered() {
		return true
	}
	for _, key := range s.Keys {
		if key == field {
			return true
		}
	}
	return false
}

func (s Import) Matches(ref Ref) bool {
	return ref.Provider == s.Provider && ref.Path == s.Path && ref.Version == s.Version && s.Allows(ref.Field)
}

func (s Import) Variable(field string) string {
	return s.Prefix + field
}

func (s Import) Field(variable string) (string, bool) {
	if !strings.HasPrefix(variable, s.Prefix) {
		return "", false
	}
	field := strings.TrimPrefix(variable, s.Prefix)
	return field, s.Allows(field)
}

func (s Import) String() string {
	out := s.Provider + ":" + s.Path
	if s.Version != "" {
		out += "@" + s.Version
	}
	return out
}

package api

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

type yamlMarshalRow struct {
	Description string `yaml:"description"`
	Key         string `yaml:"key"`
}

type yamlMarshalDoc struct {
	Version int `yaml:"version"`
	Request struct {
		Params []yamlMarshalRow `yaml:"params"`
	} `yaml:"request"`
}

func TestMarshalWorkspaceYAMLRoundTripsTextThatYAMLv3CannotReadBack(t *testing.T) {
	for _, description := range []string{
		"\nИдентификатор бенефициара.\nЕсли параметр не передается, возвращаются все.",
		" leading space\nsecond line",
		"\tleading tab\nsecond line",
		"\n\n two blank lines first\n",
	} {
		doc := filesystemRequestFile{Version: fileStoreVersion, Request: map[string]any{
			"name":   "Request",
			"params": []any{map[string]any{"description": description, "key": "beneficiaryId"}},
			"tags":   []string{description},
		}}
		data, err := marshalWorkspaceYAML(doc)
		if err != nil {
			t.Fatalf("marshal %q: %v", description, err)
		}
		var back yamlMarshalDoc
		if err := yaml.Unmarshal(data, &back); err != nil {
			t.Fatalf("written YAML for %q does not load: %v\n%s", description, err, data)
		}
		if got := back.Request.Params[0].Description; got != description {
			t.Fatalf("description changed: got %q want %q", got, description)
		}
	}
}

func TestMarshalRequestWorkspaceYAMLUsesPlainOrDoubleQuotedStrings(t *testing.T) {
	request := filesystemRequestFile{Version: fileStoreVersion, Request: map[string]any{
		"id":            "r1",
		"safePlain":     "ordinary words",
		"colon":         "word: value",
		"commentMarker": "word # value",
		"booleanText":   "true",
		"numberText":    "007",
		"template":      "{{kurloSecret:request.token}}",
		"plainYes":      "yes",
		"multiline":     "\n leading line\nsecond line",
	}}
	data, err := marshalWorkspaceYAML(request)
	if err != nil {
		t.Fatal(err)
	}
	output := string(data)
	for _, part := range []string{
		"safePlain: ordinary words",
		"colon: \"word: value\"",
		"commentMarker: \"word # value\"",
		"booleanText: \"true\"",
		"numberText: \"007\"",
		"template: \"{{kurloSecret:request.token}}\"",
		`plainYes: "yes"`,
	} {
		if !strings.Contains(output, part) {
			t.Errorf("request YAML missing %q:\n%s", part, output)
		}
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		t.Fatalf("request YAML cannot be read back: %v\n%s", err, output)
	}
	var values any
	if err := doc.Decode(&values); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"version": 1,
		"request": map[string]any{
			"id": "r1", "safePlain": "ordinary words", "colon": "word: value", "commentMarker": "word # value",
			"booleanText": "true", "numberText": "007", "template": "{{kurloSecret:request.token}}",
			"plainYes": "yes", "multiline": "\n leading line\nsecond line",
		},
	}
	if !reflect.DeepEqual(values, want) {
		t.Fatalf("request YAML values changed:\ngot: %#v\nwant: %#v", values, want)
	}
}

func TestMarshalWorkspaceYAMLKeepsReadableBlocksUntouched(t *testing.T) {
	var doc yamlMarshalDoc
	doc.Version = 1
	doc.Request.Params = []yamlMarshalRow{
		{Description: "plain\nmultiline\n  indented code line", Key: "a"},
		{Description: "tab\tinside a line\nnext\n\ttabbed line", Key: "b"},
	}
	want, err := yaml.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	got, err := marshalWorkspaceYAML(doc)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("output changed for safe text:\n%s\nwant:\n%s", got, want)
	}
	if !strings.Contains(string(got), "description: |-") {
		t.Fatalf("safe multiline text should stay a literal block:\n%s", got)
	}
}

func TestWriteYAMLFileWritesRequestsThatLoadAgain(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request.yml")
	request := map[string]any{
		"id":   "r1",
		"name": "Получить результаты проверки",
		"params": []any{map[string]any{
			"key":         "beneficiaryId",
			"description": "\nИдентификатор бенефициара.\nЕсли параметр не передается, возвращаются все.",
		}},
	}
	if err := writeYAMLFile(path, filesystemRequestFile{Version: fileStoreVersion, Request: request}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := yaml.Unmarshal(raw, &back); err != nil {
		t.Fatalf("written request does not load: %v\n%s", err, raw)
	}
}

func TestFormRequestWriterMatchesBeautify(t *testing.T) {
	request := filesystemRequestFile{
		Version: fileStoreVersion,
		Request: map[string]any{
			"id":         "request-one",
			"name":       "Status",
			"url":        "https://api.example.test/{{tenant}}",
			"requestTab": "headers",
			"headers": []any{
				map[string]any{"key": "X-Enabled", "value": "true", "enabled": true, "description": ""},
				map[string]any{"key": "X-Disabled", "value": "false", "enabled": false, "description": "keep"},
			},
			"bodyContent":        "plain\ttext\rcontrol\nnext {{body}}",
			"preRequestScriptJs": "const token = '{{accessToken}}';\nconst label = \"two words\";",
			"settings":           map[string]any{"followRedirects": false},
		},
	}
	omitRequestEditorDefaults(request.Request.(map[string]any))
	data, err := marshalWorkspaceYAML(request)
	if err != nil {
		t.Fatal(err)
	}
	formatted := (&App{}).FormatRequestFileYAML(string(data))
	if !formatted.Ok {
		t.Fatalf("could not format form-written YAML: %s\n%s", formatted.Error, data)
	}
	if formatted.Content != string(data) {
		t.Fatalf("form writer output changed under Beautify:\nwriter:\n%s\nBeautify:\n%s", data, formatted.Content)
	}
	if strings.Contains(string(data), "requestTab:") || strings.Contains(string(data), "enabled: true") || strings.Contains(string(data), "description: \"\"") {
		t.Fatalf("form writer retained editor defaults:\n%s", data)
	}
	for _, expected := range []string{
		"enabled: false",
		"description: keep",
		"url: https://api.example.test/{{tenant}}",
	} {
		if !strings.Contains(string(data), expected) {
			t.Errorf("form writer omitted %q:\n%s", expected, data)
		}
	}
}

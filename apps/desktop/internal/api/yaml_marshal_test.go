package api

import (
	"os"
	"path/filepath"
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

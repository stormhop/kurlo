package api

import (
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestRequestDraftSchemaIssues(t *testing.T) {
	for _, tc := range []struct {
		field, value, want string
		line               int
	}{
		{"settings", "    allowSendRequest: \"false\"", "true or false", 5},
		{"settings", "    followRedirects: maybe", "settings.followRedirects", 5},
		{"headers", "    - enabled: yes", "headers.0.enabled", 5},
		{"settingsOverrides", "    followRedirects: 1", "true or false", 5},
		{"settings", "    timeoutMs: -1", "timeoutMs", 5},
		{"assertions", "    - enabled: 'true'", "assertions.0.enabled", 5},
		{"method", "    NONE", "request.method", 5},
		{"settings", "    allowSendRequest: false", "", 0},
		{"x-extra", "    enabled: anything", "", 0},
	} {
		input := "version: 1\nrequest:\n  id: r\n  " + tc.field + ":\n" + tc.value + "\n"
		result := checkWorkspaceYAML("collections/Core/requests/Get.yml", input)
		if result.Ok != (tc.want == "") || result.Line != tc.line || !strings.Contains(result.Message, tc.want) {
			t.Errorf("%s: %#v", tc.value, result)
		}
	}
}

func TestFormatRequestFileYAMLDraft(t *testing.T) {
	app := &App{}
	source := "# Keep this\r\nversion: 1\r\nrequest:\r\n  url: https://example.test # here\r\n  headers: [{key: B, enabled: false}, {key: A}]\r\n  bodyContent: |-\r\n    first\r\n    second\r\n  id: r\r\n  x-extra: yes\r\norder: 0\r\n"
	result := app.FormatRequestFileYAML(source)
	if !result.Ok {
		t.Fatal(result.Error)
	}
	for _, part := range []string{"# Keep this\r\nversion: 1\r\norder: 0\r\nrequest:\r\n", "    bodyContent: |-\r\n", "    headers:\r\n", "key: B", "key: A", "url: https://example.test # here", `x-extra: "yes"`} {
		if !strings.Contains(result.Content, part) {
			t.Errorf("missing %q in %s", part, result.Content)
		}
	}
	if strings.Index(result.Content, "key: B") > strings.Index(result.Content, "key: A") {
		t.Fatal("list reordered")
	}
	if again := app.FormatRequestFileYAML(result.Content); again.Content != result.Content {
		t.Fatal("formatter is not idempotent")
	}
	for _, bad := range []string{"", source + "---\n{}\n", "version: 1\nrequest: {id: r, isPinned: 'true'}", "version: [", "version: 1\nrequest: &r {id: r}"} {
		if got := app.FormatRequestFileYAML(bad); got.Ok || got.Error == "" || got.Content != "" {
			t.Fatalf("accepted invalid YAML: %#v", got)
		}
	}
}

func TestFormatLegacyRowsAndLocalTab(t *testing.T) {
	source := "version: 1\nrequest:\n  requestTab: headers # last tab\n  id: req-one\n  headers:\n    - key: kept\n      enabled: true # send this header\n      description: ''\n    - key: off\n      enabled: false\n      description: 'keep note'\n  x-extra: {enabled: true, description: ''}\n"
	app := &App{}
	got := app.FormatRequestFileYAML(source)
	if !got.Ok {
		t.Fatal(got.Error)
	}
	if strings.Contains(got.Content, "requestTab:") || strings.Count(got.Content, "enabled: true") != 1 || strings.Count(got.Content, "description:") != 2 {
		t.Fatal(got.Content)
	}
	for _, text := range []string{"enabled: false", "description: keep note", "# send this header", "# last tab"} {
		if !strings.Contains(got.Content, text) {
			t.Fatalf("missing %q in %s", text, got.Content)
		}
	}
	if next := app.FormatRequestFileYAML(got.Content); next.Content != got.Content {
		t.Fatalf("not idempotent: %s", next.Content)
	}
}

func TestFormatRequestFileYAMLUsesPlainOrDoubleQuotedStrings(t *testing.T) {
	source := "version: 1\nrequest:\n  id: r\n  safePlain: 'ordinary words'\n  colon: 'word: value'\n  commentMarker: 'word # value'\n  booleanText: 'true'\n  numberText: '007'\n  plainYes: 'yes'\n  explicit: !!str 'true'\n  apostrophe: \"don't\"\n  quote: 'say \"hello\"'\n  escaped: \"line\\nnext\"\n  multiline: |\n    first\n    second\n  flow: {word: 'plain', flag: 'false', template: '{{apiToken}}', boolean: false} # keep\n"
	result := (&App{}).FormatRequestFileYAML(source)
	if !result.Ok {
		t.Fatal(result.Error)
	}
	for _, part := range []string{
		"safePlain: ordinary words",
		"colon: \"word: value\"",
		"commentMarker: \"word # value\"",
		"booleanText: \"true\"",
		"numberText: \"007\"",
		`plainYes: "yes"`,
		"explicit: !!str \"true\"",
		"apostrophe: don't",
		"quote: say \"hello\"",
		"escaped: |",
		"multiline: |",
	} {
		if !strings.Contains(result.Content, part) {
			t.Errorf("formatted YAML missing %q:\n%s", part, result.Content)
		}
	}
	if !strings.Contains(result.Content, "# keep") {
		t.Fatalf("formatter dropped the comment from a flow mapping:\n%s", result.Content)
	}
	var before, after yaml.Node
	if err := yaml.Unmarshal([]byte(source), &before); err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal([]byte(result.Content), &after); err != nil {
		t.Fatalf("formatted YAML is invalid: %v\n%s", err, result.Content)
	}
	var beforeValues, afterValues any
	if err := before.Decode(&beforeValues); err != nil {
		t.Fatal(err)
	}
	if err := after.Decode(&afterValues); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(beforeValues, afterValues) {
		t.Fatalf("formatting changed YAML values:\nbefore: %#v\nafter: %#v", beforeValues, afterValues)
	}
	var hasSingleQuotedStyle func(*yaml.Node) bool
	hasSingleQuotedStyle = func(node *yaml.Node) bool {
		if node.Kind == yaml.ScalarNode && node.Style&yaml.SingleQuotedStyle != 0 {
			return true
		}
		for _, child := range node.Content {
			if hasSingleQuotedStyle(child) {
				return true
			}
		}
		return false
	}
	if hasSingleQuotedStyle(&after) {
		t.Fatalf("formatter left a single-quoted scalar:\n%s", result.Content)
	}
	if next := (&App{}).FormatRequestFileYAML(result.Content); next.Content != result.Content {
		t.Fatalf("formatter is not idempotent:\n%s\nwant:\n%s", next.Content, result.Content)
	}
}

func TestFormatRequestFileYAMLPreservesCommentsWhenSortingFlowMappings(t *testing.T) {
	source := "version: 1\nrequest:\n  x-quote-smoke: {word: 'plain', flag: 'false', template: '{{apiToken}}', boolean: false} # keep\n  nested: {outer: {inner: 'plain'}} # nested\n  rows: [{word: 'plain'}, {flag: 'false'}] # rows\n  id: r\n  method: GET\n  name: test\n  url: https://example.test\n"
	result := (&App{}).FormatRequestFileYAML(source)
	if !result.Ok {
		t.Fatal(result.Error)
	}
	for _, comment := range []string{"# keep", "# nested", "# rows"} {
		if !strings.Contains(result.Content, comment) {
			t.Fatalf("formatter dropped %q while sorting or expanding flow YAML:\n%s", comment, result.Content)
		}
	}
	if next := (&App{}).FormatRequestFileYAML(result.Content); next.Content != result.Content {
		t.Fatalf("formatter changed its own output:\n%s\nwant:\n%s", next.Content, result.Content)
	}
}

func BenchmarkRequestDraftCheck(b *testing.B) {
	for _, tc := range []struct {
		name string
		size int
	}{{"4KiB", 4096}, {"1MiB", 1 << 20}} {
		b.Run(tc.name, func(b *testing.B) {
			content := "version: 1\nrequest:\n  id: r\n  bodyContent: " + strings.Repeat("x", tc.size)
			b.ReportAllocs()
			for b.Loop() {
				_, check := checkedRequestDocument(content)
				if !check.Ok {
					b.Fatal(check)
				}
			}
		})
	}
}

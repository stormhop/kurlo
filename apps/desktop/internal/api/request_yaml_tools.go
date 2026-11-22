package api

import (
	"errors"
	"io"
	"reflect"
	"strconv"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
	"gopkg.in/yaml.v3"
)

func checkedRequestDocument(content string) (*yaml.Node, WorkspaceYAMLCheckResult) {
	decoder := yaml.NewDecoder(strings.NewReader(content))
	var doc, extra yaml.Node
	if err := decoder.Decode(&doc); err != nil {
		return nil, yamlErrorFailure(err)
	}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err != nil {
			return nil, yamlErrorFailure(err)
		}
		return nil, yamlCheckFailure(extra.Line, "A request file must contain one YAML document.")
	}
	if yamlHasAliasOrAnchor(&doc) {
		return nil, yamlCheckFailure(1, "YAML aliases and anchors are not supported in request files.")
	}
	root := doc.Content[0]
	var value any
	if err := root.Decode(&value); err != nil {
		return nil, yamlErrorFailure(err)
	}
	if err := validateWorkspaceDocument("request", value); err != nil {
		var failure *jsonschema.ValidationError
		if !errors.As(err, &failure) {
			return nil, yamlCheckFailure(root.Line, err.Error())
		}
		return nil, requestSchemaIssue(root, failure)
	}
	request := yamlMappingValue(root, "request")
	if id := yamlMappingValue(request, "id"); id != nil && strings.TrimSpace(id.Value) == "" {
		return nil, yamlCheckFailure(id.Line, "The request id is empty.")
	}
	return &doc, WorkspaceYAMLCheckResult{Ok: true}
}

func requestSchemaIssue(root *yaml.Node, failure *jsonschema.ValidationError) WorkspaceYAMLCheckResult {
	if len(failure.Causes) > 0 {
		var first WorkspaceYAMLCheckResult
		for _, child := range failure.Causes {
			issue := requestSchemaIssue(root, child)
			if first.Line == 0 || issue.Line < first.Line || (issue.Line == first.Line && issue.Message < first.Message) {
				first = issue
			}
		}
		return first
	}
	node := root
	for _, part := range failure.InstanceLocation {
		if node.Kind == yaml.SequenceNode {
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(node.Content) {
				break
			}
			node = node.Content[i]
		} else if child := yamlMappingValue(node, part); child != nil {
			node = child
		} else {
			break
		}
	}
	hint := failure.ErrorKind.LocalizedString(message.NewPrinter(language.English))
	if issue, ok := failure.ErrorKind.(*kind.Type); ok && len(issue.Want) == 1 && issue.Want[0] == "boolean" {
		hint = "Use true or false without quotes."
	}
	field := strings.Join(failure.InstanceLocation, ".")
	if field != "" {
		hint = field + ": " + hint
	}
	return yamlCheckFailure(node.Line, hint)
}

func (a *App) FormatRequestFileYAML(content string) RequestFileYAMLResult {
	doc, check := checkedRequestDocument(strings.ReplaceAll(content, "\r\n", "\n"))
	if !check.Ok {
		return RequestFileYAMLResult{Error: check.Message, Line: check.Line}
	}
	return formatRequestFileDocument(doc, content)
}

func formatRequestFileDocument(doc *yaml.Node, source string) RequestFileYAMLResult {
	var before map[string]any
	if err := doc.Decode(&before); err != nil {
		return RequestFileYAMLResult{Error: err.Error()}
	}
	omitRequestEditorDefaults(nestedMap(before, "request"))
	data, err := marshalWorkspaceYAML(before)
	if err != nil {
		return RequestFileYAMLResult{Error: err.Error()}
	}
	var formattedDoc yaml.Node
	if err := yaml.Unmarshal(data, &formattedDoc); err != nil {
		return RequestFileYAMLResult{Error: err.Error()}
	}
	root := formattedDoc.Content[0]
	var ordered []*yaml.Node
	for _, name := range []string{"version", "order", "request"} {
		if key := yamlMappingKey(root, name); key != nil {
			ordered = append(ordered, key, yamlMappingValue(root, name))
		}
	}
	root.Content = ordered
	restoreRequestComments(doc, &formattedDoc)
	doubleQuoteSingleQuotedStrings(&formattedDoc)
	data, err = yaml.Marshal(&formattedDoc)
	if err != nil {
		return RequestFileYAMLResult{Error: err.Error()}
	}
	var after map[string]any
	if err := yaml.Unmarshal(data, &after); err != nil || !reflect.DeepEqual(before, after) {
		return RequestFileYAMLResult{Error: "Formatting would change a YAML value."}
	}
	formatted := string(data)
	if strings.Contains(source, "\r\n") {
		formatted = strings.ReplaceAll(formatted, "\n", "\r\n")
	}
	return RequestFileYAMLResult{Ok: true, Content: formatted}
}

func restoreRequestComments(source, formatted *yaml.Node) {
	formatted.HeadComment = source.HeadComment
	formatted.LineComment = source.LineComment
	formatted.FootComment = source.FootComment
	if source.Kind != formatted.Kind {
		return
	}
	switch source.Kind {
	case yaml.MappingNode:
		original := make(map[string]int, len(source.Content)/2)
		for i := 0; i < len(source.Content); i += 2 {
			original[source.Content[i].Value] = i
		}
		for i := 0; i < len(formatted.Content); i += 2 {
			if j, ok := original[formatted.Content[i].Value]; ok {
				restoreRequestComments(source.Content[j], formatted.Content[i])
				restoreRequestComments(source.Content[j+1], formatted.Content[i+1])
				delete(original, formatted.Content[i].Value)
			}
		}
		if len(original) > 0 {
			var notes []string
			for i := 0; i < len(source.Content); i += 2 {
				if _, removed := original[source.Content[i].Value]; !removed {
					continue
				}
				for _, node := range source.Content[i : i+2] {
					for _, note := range []string{node.HeadComment, node.LineComment, node.FootComment} {
						if note != "" {
							notes = append(notes, note)
						}
					}
				}
			}
			target := formatted
			if len(formatted.Content) > 0 {
				target = formatted.Content[0]
			}
			if target.HeadComment != "" {
				notes = append(notes, target.HeadComment)
			}
			target.HeadComment = strings.Join(notes, "\n")
		}
	case yaml.SequenceNode, yaml.DocumentNode:
		for i, child := range formatted.Content {
			restoreRequestComments(source.Content[i], child)
		}
	case yaml.ScalarNode:
		if source.Style&yaml.TaggedStyle != 0 {
			formatted.Tag, formatted.Style, formatted.Value = source.Tag, source.Style, source.Value
		}
	}
	moveExpandedFlowLineComment(source, formatted)
}

func moveExpandedFlowLineComment(source, formatted *yaml.Node) {
	if source.Style&yaml.FlowStyle == 0 || formatted.Style&yaml.FlowStyle != 0 || source.LineComment == "" {
		return
	}
	target := formatted
	for target.Kind != yaml.ScalarNode && len(target.Content) > 0 {
		target = target.Content[len(target.Content)-1]
	}
	if target == formatted {
		return
	}
	target.LineComment = strings.TrimSpace(strings.Join([]string{target.LineComment, formatted.LineComment}, " "))
	formatted.LineComment = ""
}

package api

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type WorkspaceYAMLCheckResult struct {
	Ok      bool   `json:"ok"`
	Line    int    `json:"line"`
	Message string `json:"message"`
}

var yamlErrorLine = regexp.MustCompile(`line (\d+): (.*)`)

var yamlMessageLinePrefix = regexp.MustCompile(`^(?:yaml: )?line \d+(?::\d+)?: `)

var yamlMessageHints = []struct{ raw, hint string }{
	{"could not find expected ':'", "This line is not a key: value pair. Add a key with a colon, or remove the line."},
	{"mapping values are not allowed in this context", "A colon is in the wrong place. Put text with a colon in quotes, or fix the indentation."},
	{"did not find expected key", "The indentation does not line up with the lines around it."},
	{"did not find expected node content", "A value is missing or a bracket is not closed."},
	{"did not find expected ',' or ']'", "A [ list ] is not closed. Add the missing ] or put the text in quotes."},
	{"did not find expected ',' or '}'", "A { map } is not closed. Add the missing } or put the text in quotes."},
	{"found character that cannot start any token", "A tab or special character starts a value. YAML needs spaces for indentation; put special text in quotes."},
	{"found unexpected end of stream", "The file ends in the middle of a value, for example an unclosed quote."},
	{"did not find expected '-' indicator", "A list item is missing its - or is indented differently from the others."},
	{"block sequence entries are not allowed in this context", "A - list item is on the same line as a key. Move it to its own line."},
}

func friendlyYAMLMessage(message string) string {
	message = yamlMessageLinePrefix.ReplaceAllString(strings.TrimPrefix(message, "yaml: "), "")
	for _, known := range yamlMessageHints {
		if strings.Contains(message, known.raw) {
			return known.hint
		}
	}
	return message
}

func (a *App) CheckWorkspaceYAML(path string, content string) WorkspaceYAMLCheckResult {
	return checkWorkspaceYAML(path, content)
}

func workspaceYAMLSection(path string) string {
	clean := "/" + filepath.ToSlash(filepath.Clean(filepath.FromSlash(path)))
	switch filepath.Base(clean) {
	case fileStoreRootIndex:
		return ""
	case fileStoreRootFileName:
		return "workspace"
	case fileStoreCollection:
		return "collection"
	}
	switch {
	case strings.Contains(clean, "/"+fileStoreRequestsDir+"/"):
		return "request"
	case strings.Contains(clean, "/"+fileStoreEnvironmentsDir+"/"):
		return "environment"
	case strings.Contains(clean, "/"+fileStoreExamplesDir+"/"):
		return "example"
	case strings.Contains(clean, "/"+fileStoreLoadTestsDir+"/"):
		return "loadTest"
	}
	return ""
}

func yamlCheckFailure(line int, message string) WorkspaceYAMLCheckResult {
	if line < 1 {
		line = 1
	}
	return WorkspaceYAMLCheckResult{Line: line, Message: message}
}

func yamlErrorFailure(err error) WorkspaceYAMLCheckResult {
	var typeError *yaml.TypeError
	text := err.Error()
	if errors.As(err, &typeError) && len(typeError.Errors) > 0 {
		text = typeError.Errors[0]
	}
	text = strings.TrimPrefix(text, "yaml: ")
	if match := yamlErrorLine.FindStringSubmatch(text); match != nil {
		line, _ := strconv.Atoi(match[1])
		return yamlCheckFailure(line, friendlyYAMLMessage(match[2]))
	}
	return yamlCheckFailure(1, friendlyYAMLMessage(text))
}

func checkWorkspaceYAML(path, content string) WorkspaceYAMLCheckResult {
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(content), &document); err != nil {
		return yamlErrorFailure(err)
	}
	if len(document.Content) == 0 || document.Content[0].Kind != yaml.MappingNode {
		return yamlCheckFailure(1, "The file must be a YAML mapping that starts with version: 1")
	}
	top := document.Content[0]
	section := workspaceYAMLSection(path)
	var target any
	switch section {
	case "":
		target = &filesystemStoreRootFile{}
	case "workspace":
		target = &filesystemWorkspaceFile{}
	case "collection":
		target = &filesystemCollectionFile{}
	case "request":
		target = &filesystemRequestFile{}
	case "environment":
		target = &filesystemEnvironmentFile{}
	case "example":
		target = &filesystemExampleFile{}
	case "loadTest":
		target = &filesystemLoadTestFile{}
	}
	if err := top.Decode(target); err != nil {
		return yamlErrorFailure(err)
	}
	if version := yamlFileFormatVersion(target); version > fileStoreVersion {
		line := top.Line
		if node := yamlMappingKey(top, "version"); node != nil {
			line = node.Line
		}
		return yamlCheckFailure(line, fmt.Sprintf("File format version %d is newer than this Kurlo reads (%d).", version, fileStoreVersion))
	}
	if section == "" {
		return WorkspaceYAMLCheckResult{Ok: true}
	}
	sectionKey := yamlMappingKey(top, section)
	body := yamlMappingValue(top, section)
	if sectionKey == nil || body == nil || body.Kind != yaml.MappingNode {
		line := top.Line
		if sectionKey != nil {
			line = sectionKey.Line
		}
		return yamlCheckFailure(line, fmt.Sprintf("The file needs a %s: block with the %s's fields.", section, section))
	}
	idKey := yamlMappingKey(body, "id")
	id := yamlMappingValue(body, "id")
	if idKey == nil || id == nil {
		return yamlCheckFailure(sectionKey.Line, fmt.Sprintf("The %s has no id.", section))
	}
	if id.Kind != yaml.ScalarNode || id.Tag != "!!str" {
		return yamlCheckFailure(idKey.Line, fmt.Sprintf("The %s id must be text. Put it in quotes.", section))
	}
	if strings.TrimSpace(id.Value) == "" {
		return yamlCheckFailure(idKey.Line, fmt.Sprintf("The %s id is empty.", section))
	}
	return WorkspaceYAMLCheckResult{Ok: true}
}

func yamlMappingKey(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for index := 0; index+1 < len(node.Content); index += 2 {
		if node.Content[index].Value == key {
			return node.Content[index]
		}
	}
	return nil
}

package api

import (
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"gopkg.in/yaml.v3"
)

const agentChangeValueMax = 80

var agentChangeKinds = []string{"request", "collection", "environment", "example", "loadTest", "workspace"}

var agentChangeHiddenFields = map[string]bool{
	"id": true, "filesystemName": true, "nameAuto": true, "version": true, "order": true,
	"requestOrder": true, "collectionOrder": true, "collapsed": true, "isPinned": true, "requestTab": true,
	"collection": true, "folderPath": true, "graphqlSchema": true,
}

var agentChangeLabels = map[string]string{
	"name": "Name", "method": "Method", "url": "URL", "params": "Query params", "pathParams": "Path params",
	"headers": "Headers", "auth": "Auth", "bodyType": "Body type", "rawBodyType": "Body format", "bodyContent": "Body",
	"formRows": "Form fields", "bodyFilePath": "Body file", "testScriptJs": "Tests", "testScript": "Tests",
	"preRequestScriptJs": "Pre-request script", "preRequestScript": "Pre-request script", "requestNotes": "Docs",
	"docs": "Docs", "description": "Description", "settings": "Settings", "settingsOverrides": "Settings",
	"examples": "Examples", "values": "Variables", "protected": "Protected", "sandbox": "Sandbox for the agent", "color": "Color",
	"parentId": "Parent environment", "savedMessages": "Saved messages", "assertions": "Assertions", "defaults": "Defaults", "folders": "Folders", "variables": "Variables",
	"response": "Response", "status": "Status", "statusCode": "Status", "body": "Body",
}

var agentChangeScalarFields = map[string]bool{
	"name": true, "method": true, "url": true, "bodyType": true, "rawBodyType": true, "protected": true, "sandbox": true, "color": true,
	"status": true, "statusCode": true,
}

var agentChangeWordBoundary = regexp.MustCompile(`([a-z0-9])([A-Z])`)

func summarizeAgentChanges(changes []model.AgentFileChange, files ...map[string][]byte) {
	collections := map[string]string{}
	for _, set := range files {
		for rel, data := range set {
			if !strings.HasSuffix(rel, "/"+fileStoreCollection) {
				continue
			}
			kind, item := agentChangeDocument(string(data))
			if kind == "collection" && stringValue(item, "id") != "" {
				collections[stringValue(item, "id")] = stringValue(item, "name")
			}
		}
	}
	for index := range changes {
		changes[index].Summary = agentChangeSummary(changes[index], collections)
	}
}

func agentChangeSummary(change model.AgentFileChange, collections map[string]string) *model.AgentChangeSummary {
	if change.TooLarge || (change.Before == nil && change.After == nil) {
		return nil
	}
	if change.Path == "Profile globals" {
		return agentGlobalsSummary(change)
	}
	if !strings.HasSuffix(change.Path, fileStoreYAMLExt) {
		return nil
	}
	var beforeKind, afterKind string
	var before, after map[string]any
	if change.Before != nil {
		beforeKind, before = agentChangeDocument(*change.Before)
	}
	if change.After != nil {
		afterKind, after = agentChangeDocument(*change.After)
	}
	kind := afterKind
	item := after
	if kind == "" {
		kind, item = beforeKind, before
	}
	if kind == "" || (beforeKind != "" && afterKind != "" && beforeKind != afterKind) {
		return nil
	}
	summary := &model.AgentChangeSummary{Kind: kind, Name: stringValue(item, "name")}
	if kind == "request" {
		summary.Location = agentRequestLocation(item, collections)
		summary.Detail = strings.TrimSpace(strings.ToUpper(stringValue(item, "method")) + " " + stringValue(item, "url"))
	}
	if summary.Name == "" {
		summary.Name = strings.TrimSuffix(change.Path[strings.LastIndex(change.Path, "/")+1:], fileStoreYAMLExt)
	}
	if before != nil && after != nil {
		summary.Fields = agentChangeFields(kind, before, after)
	}
	return summary
}

func agentChangeDocument(text string) (string, map[string]any) {
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		return "", nil
	}
	for _, kind := range agentChangeKinds {
		if item, ok := doc[kind].(map[string]any); ok {
			return kind, item
		}
	}
	return "", nil
}

func agentRequestLocation(item map[string]any, collections map[string]string) string {
	parts := []string{}
	if name := collections[stringValue(item, "collectionId")]; name != "" {
		parts = append(parts, name)
	}
	if folders, ok := item["folderPath"].([]any); ok {
		for _, folder := range folders {
			if text := stringFromAny(folder); text != "" {
				parts = append(parts, text)
			}
		}
	}
	return strings.Join(parts, " / ")
}

func agentChangeFields(kind string, before, after map[string]any) []model.AgentChangeField {
	keys := map[string]bool{}
	for key := range before {
		keys[key] = true
	}
	for key := range after {
		keys[key] = true
	}
	sorted := make([]string, 0, len(keys))
	for key := range keys {
		if agentChangeHiddenFields[key] || strings.HasSuffix(key, "Id") && key != "parentId" {
			continue
		}
		sorted = append(sorted, key)
	}
	sort.Strings(sorted)
	fields := []model.AgentChangeField{}
	for _, key := range sorted {
		old, hadOld := before[key]
		next, hasNext := after[key]
		if !agentChangeHasValue(old) {
			hadOld = false
		}
		if !agentChangeHasValue(next) {
			hasNext = false
		}
		if !hadOld && !hasNext || reflect.DeepEqual(old, next) {
			continue
		}
		if kind == "environment" && key == "values" {
			fields = append(fields, agentVariableFields(mapSlice(old), mapSlice(next))...)
			continue
		}
		field := model.AgentChangeField{Label: agentChangeLabel(key), Change: "changed"}
		switch {
		case !hadOld:
			field.Change = "added"
		case !hasNext:
			field.Change = "removed"
		}
		if agentChangeScalarFields[key] {
			field.Before = agentChangeValue(old)
			field.After = agentChangeValue(next)
		}
		fields = append(fields, field)
	}
	return fields
}

func agentVariableFields(before, after []map[string]any) []model.AgentChangeField {
	rows := func(items []map[string]any) map[string]map[string]any {
		out := map[string]map[string]any{}
		for _, item := range items {
			if key := stringValue(item, "key"); key != "" {
				out[key] = item
			}
		}
		return out
	}
	old, next := rows(before), rows(after)
	keys := map[string]bool{}
	for key := range old {
		keys[key] = true
	}
	for key := range next {
		keys[key] = true
	}
	sorted := make([]string, 0, len(keys))
	for key := range keys {
		sorted = append(sorted, key)
	}
	sort.Strings(sorted)
	fields := []model.AgentChangeField{}
	for _, key := range sorted {
		previous, hadOld := old[key]
		current, hasNext := next[key]
		label := "Variable " + key
		switch {
		case !hadOld:
			fields = append(fields, model.AgentChangeField{Label: label, Change: "added"})
		case !hasNext:
			fields = append(fields, model.AgentChangeField{Label: label, Change: "removed"})
		case !reflect.DeepEqual(previous, current):
			fields = append(fields, model.AgentChangeField{Label: label, Change: "changed"})
		}
	}
	return fields
}

func agentGlobalsSummary(change model.AgentFileChange) *model.AgentChangeSummary {
	parse := func(text *string) []map[string]any {
		if text == nil {
			return nil
		}
		var rows []map[string]any
		if err := yaml.Unmarshal([]byte(*text), &rows); err != nil {
			return nil
		}
		return rows
	}
	return &model.AgentChangeSummary{Kind: "globals", Name: "Globals", Fields: agentVariableFields(parse(change.Before), parse(change.After))}
}

func agentChangeHasValue(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case string:
		return v != ""
	case []any:
		return len(v) > 0
	case map[string]any:
		return len(v) > 0
	}
	return true
}

func agentChangeValue(value any) string {
	if value == nil {
		return ""
	}
	text := strings.TrimSpace(fmt.Sprint(value))
	if strings.ContainsRune(text, '\n') {
		return ""
	}
	if runes := []rune(text); len(runes) > agentChangeValueMax {
		return string(runes[:agentChangeValueMax-1]) + "…"
	}
	return text
}

func agentChangeLabel(key string) string {
	if label, ok := agentChangeLabels[key]; ok {
		return label
	}
	words := strings.ToLower(agentChangeWordBoundary.ReplaceAllString(key, "$1 $2"))
	runes := []rune(words)
	if len(runes) == 0 {
		return key
	}
	runes[0] = unicode.ToUpper(runes[0])
	return string(runes)
}

package api

import (
	"reflect"
	"regexp"
	"strings"

	secretmgr "github.com/stormhop/kurlo/apps/desktop/internal/secrets"
)

type cliSecretTarget struct {
	names      []string
	scripts    string
	variables  map[string]string
	collection map[string]string
}

func templateNames(text string) []string {
	var names []string
	if strings.Contains(text, "{{") {
		for _, match := range templatePattern.FindAllStringSubmatch(text, -1) {
			if name := strings.TrimSpace(match[1]); name != "" {
				names = append(names, name)
			}
		}
	}
	return names
}

func (l *cliLinkedSecrets) onlyFor(req *cliSavedRequest) *cliLinkedSecrets {
	l.filtered = true
	target := cliSecretTarget{
		variables:  cliRequestVariableValues(req.Vars, nil),
		collection: req.CollectionVariables,
		scripts:    req.PreRequestScriptJs + "\n" + req.TestScriptJs,
	}
	add := func(text string) { target.names = append(target.names, templateNames(text)...) }
	rows := func(items []cliKV) {
		for _, row := range items {
			if row.Enabled && strings.TrimSpace(row.Key) != "" {
				add(row.Key)
				add(row.Value)
				add(row.FileName)
			}
		}
	}

	add(req.URL)
	add(target.scripts)
	rows(req.Params)
	rows(req.PathParams)
	rows(req.Headers)
	rows(req.PostResponseVars)
	for _, item := range req.Assertions {
		if item.Enabled {
			add(item.Target)
			add(item.Value)
		}
	}
	auth := reflect.ValueOf(req.Auth)
	for _, field := range authActiveFields[req.Auth.Type] {
		v := auth.FieldByNameFunc(func(name string) bool { return strings.EqualFold(name, field) })
		if v.Kind() == reflect.String {
			add(v.String())
		}
	}
	for _, slot := range linkedStringSlots(&req.Settings) {
		add(slot.value)
	}
	switch {
	case req.BodyType == "form" || req.BodyType == "urlencoded":
		rows(req.FormRows)
	case req.BodyType == "binary":
		add(req.BodyFilePath)
	case rawBodyContentTypes[req.BodyType] != "" || isGraphQLRequest(*req):
		add(req.BodyContent)
	}
	if !cliRunnable(*req) {
		rows(req.GrpcMetadata)
		rows(req.SIOEvents)
		for _, value := range []string{req.BodyContent, req.GrpcMethod, req.GrpcProtoFilePath, req.McpMethod, req.McpName, req.McpArguments, req.AiSystem, req.AiPrompt, req.AiModel} {
			add(value)
		}
	}
	l.targets = append(l.targets, target)
	return l
}

var scriptSecretRead = regexp.MustCompile(`\b(pm\.(?:environment|variables)|request\.environment|insomnia\.environment)\s*\.\s*(?:get|has)\s*\(\s*["'` + "`" + `]([^"'` + "`" + `\r\n]+)["'` + "`" + `]\s*\)`)

func (l *cliLinkedSecrets) needed(defined map[string]string, linked map[string]secretmgr.Ref) map[string]bool {
	needed := map[string]bool{}
	for _, target := range l.targets {
		if len(l.dataRows) == 0 {
			target.collect(needed, defined, linked, l.globals, nil)
			continue
		}
		for _, row := range l.dataRows {
			target.collect(needed, defined, linked, l.globals, row)
		}
	}
	return needed
}

func (target cliSecretTarget) collect(needed map[string]bool, defined map[string]string, linked map[string]secretmgr.Ref, globals, data map[string]string) {
	type lookup struct {
		name    string
		envOnly bool
	}
	var pending []lookup
	for _, name := range target.names {
		pending = append(pending, lookup{name: name})
	}
	if strings.TrimSpace(target.scripts) != "" {
		for _, match := range scriptSecretRead.FindAllStringSubmatch(target.scripts, -1) {
			pending = append(pending, lookup{name: match[2], envOnly: match[1] != "pm.variables"})
		}
		for name := range linked {
			if _, local := target.variables[name]; !local && strings.Contains(target.scripts, name) && variableMentioned([]string{target.scripts}, name) {
				pending = append(pending, lookup{name: name})
			}
		}
	}
	visited := map[lookup]bool{}
	for len(pending) > 0 {
		key := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if visited[key] || key.name == "" || strings.HasPrefix(key.name, "$") {
			continue
		}
		visited[key] = true
		value, ok := defined[key.name]
		if !key.envOnly {
			if _, explicit := linked[key.name]; !ok && !explicit {
				value, ok = target.collection[key.name]
				if !ok {
					value, ok = globals[key.name]
				}
			}
			if local, exists := target.variables[key.name]; exists {
				value, ok = local, true
			}
			if iteration, exists := data[key.name]; exists {
				value, ok = iteration, true
			}
		}
		if !ok {
			needed[key.name] = true
			continue
		}
		for _, dep := range templateNames(value) {
			pending = append(pending, lookup{name: dep, envOnly: dep == key.name})
		}
	}
}

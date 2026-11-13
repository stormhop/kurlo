package api

import (
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

var openAPIImportVariable = regexp.MustCompile(`^baseUrl\d*$`)
var openAPIServerPlaceholder = regexp.MustCompile(`\{([^{}]+)\}`)

type openAPIImportServer struct {
	url         string
	description string
}

type openAPIImportServers struct {
	variables  []any
	operations map[string]openAPIOperationServer
}

type openAPIOperationServer struct {
	base string
	vars []any
}

func openAPIDeclaredServers(item map[string]any) []openAPIImportServer {
	var servers []openAPIImportServer
	for _, server := range mapSlice(item["servers"]) {
		variables := nestedMap(server, "variables")
		target := openAPIServerPlaceholder.ReplaceAllStringFunc(stringValue(server, "url"), func(match string) string {
			key := match[1 : len(match)-1]
			variable, _ := variables[key].(map[string]any)
			if value := variable["default"]; value != nil {
				return importText(value)
			}
			if values := importArray(variable["enum"]); len(values) > 0 && values[0] != nil {
				return importText(values[0])
			}
			return "{{" + key + "}}"
		})
		if target = strings.TrimSpace(target); target != "" {
			servers = append(servers, openAPIImportServer{target, strings.TrimSpace(stringValue(server, "description"))})
		}
	}
	return servers
}

func newOpenAPIImportServers(doc map[string]any, sourceURL ...string) openAPIImportServers {
	root := openAPIDeclaredServers(doc)
	if len(root) == 0 {
		host, basePath := stringValue(doc, "host"), stringValue(doc, "basePath")
		base := basePath
		if host != "" {
			scheme := "https"
			if schemes := importArray(doc["schemes"]); len(schemes) > 0 {
				scheme = importText(schemes[0])
			}
			base = scheme + "://" + host + basePath
		}
		if base != "" {
			root = []openAPIImportServer{{url: base}}
		}
	}
	groups := [][]openAPIImportServer{root}
	operationGroups := map[string]int{}
	reserved := map[string]bool{}
	reserve := func(text string) {
		for _, match := range openAPIServerPlaceholder.FindAllStringSubmatch(text, -1) {
			reserved[match[1]] = true
		}
	}
	paths := nestedMap(doc, "paths")
	for _, path := range sortedKeysAny(paths) {
		reserve(path)
		item := openAPIObject(doc, paths[path])
		for _, method := range importMethods {
			operation := openAPIObject(doc, item[method])
			if operation == nil {
				continue
			}
			group := openAPIDeclaredServers(operation)
			if len(group) == 0 {
				group = openAPIDeclaredServers(item)
			}
			index := 0
			if len(group) > 0 {
				index = len(groups)
				groups = append(groups, group)
			}
			operationGroups[method+" "+path] = index
		}
	}
	for _, group := range groups {
		for _, server := range group {
			reserve(server.url)
		}
	}
	key := "baseUrl"
	for sequence := 2; reserved[key]; sequence++ {
		key = fmt.Sprintf("baseUrl%d", sequence)
	}
	rowsFor := func(group []openAPIImportServer) []any {
		var rows []any
		labels := map[string][]string{}
		byValue := map[string]map[string]any{}
		for _, server := range group {
			target := server.url
			if len(sourceURL) > 0 && sourceURL[0] != "" {
				if base, err := url.Parse(sourceURL[0]); err == nil {
					target = resolveImportURL(base, target)
				}
			}
			target = strings.TrimRight(target, "/")
			if byValue[target] == nil {
				row := importRow(key, target)
				row["enabled"] = len(rows) == 0
				byValue[target] = row
				rows = append(rows, row)
			}
			if server.description != "" && !slices.Contains(labels[target], server.description) {
				labels[target] = append(labels[target], server.description)
			}
		}
		for _, raw := range rows {
			row := raw.(map[string]any)
			if names := labels[stringValue(row, "value")]; len(names) > 0 {
				row["description"] = strings.Join(names, ", ") + " server from the spec"
			} else {
				row["description"] = "Server from the spec"
			}
		}
		return rows
	}
	sameRows := func(left, right []any) bool {
		if len(left) != len(right) {
			return false
		}
		for i := range left {
			if stringValue(left[i].(map[string]any), "value") != stringValue(right[i].(map[string]any), "value") {
				return false
			}
		}
		return true
	}
	out := openAPIImportServers{variables: rowsFor(groups[0]), operations: map[string]openAPIOperationServer{}}
	for operation, index := range operationGroups {
		rows := rowsFor(groups[index])
		if len(rows) == 0 {
			continue
		}
		server := openAPIOperationServer{base: "{{" + key + "}}"}
		if index != 0 && !sameRows(rows, out.variables) {
			server.vars = rows
		}
		out.operations[operation] = server
	}
	return out
}

package api

import (
	"encoding/xml"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var openAPIPathParam = regexp.MustCompile(`\{([A-Za-z0-9_.-]+)\}`)

var importMethods = []string{"get", "post", "put", "patch", "delete", "head", "options"}

func importOpenAPI(doc map[string]any, name string, sourceURL ...string) (workspaceImport, error) {
	paths := nestedMap(doc, "paths")
	if len(paths) == 0 || (doc["openapi"] == nil && doc["swagger"] == nil) {
		return workspaceImport{}, fmt.Errorf("expected an OpenAPI or Swagger document with paths")
	}
	info := nestedMap(doc, "info")
	out := workspaceImport{name: defaultString(stringValue(info, "title"), name), description: stringValue(info, "description"), defaults: map[string]any{}}
	schemes := nestedMap(nestedMap(doc, "components"), "securitySchemes")
	if len(schemes) == 0 {
		schemes = nestedMap(doc, "securityDefinitions")
	}
	if auth := openAPIAuth(doc, schemes, doc["security"]); auth != nil {
		out.defaults["auth"] = auth
	}
	servers := newOpenAPIImportServers(doc, sourceURL...)
	if len(servers.variables) > 0 {
		out.defaults["variables"] = servers.variables
	}
	for _, path := range sortedKeysAny(paths) {
		item := openAPIObject(doc, paths[path])
		for _, verb := range importMethods {
			operation := openAPIObject(doc, item[verb])
			if operation == nil {
				continue
			}
			server := servers.operations[verb+" "+path]
			target := server.base + openAPIPathParam.ReplaceAllString(path, ":${1}")
			if len(sourceURL) > 0 && server.base == "" {
				if base, err := url.Parse(sourceURL[0]); err == nil {
					target = resolveImportURL(base, target)
				}
			}
			req := importRequest(defaultString(stringValue(operation, "summary"), stringValue(operation, "operationId")), verb, target)
			req["requestNotes"] = stringValue(operation, "description")
			req["openapi"] = openAPIOperationKey(verb, path)
			if len(server.vars) > 0 {
				req["vars"] = server.vars
			}
			if tags := importArray(operation["tags"]); len(tags) > 0 && importText(tags[0]) != "" {
				req["folderPath"] = []any{importText(tags[0])}
			}
			if security, exists := operation["security"]; exists {
				if auth := openAPIAuth(doc, schemes, security); auth != nil {
					req["auth"] = auth
				} else {
					req["auth"] = map[string]any{"type": "none"}
				}
			}
			params := map[string]map[string]any{}
			for _, raw := range append(append([]any{}, importArray(item["parameters"])...), importArray(operation["parameters"])...) {
				param := openAPIObject(doc, raw)
				params[stringValue(param, "in")+"\x00"+stringValue(param, "name")] = param
			}
			for _, key := range sortedKeysAny(params) {
				param := params[key]
				name := stringValue(param, "name")
				location := stringValue(param, "in")
				value := openAPIExample(doc, param, 0)
				if value == nil {
					value = openAPIExample(doc, param["schema"], 0)
				}
				switch location {
				case "query", "header", "path", "formData":
					field := map[string]string{"query": "params", "header": "headers", "path": "pathParams", "formData": "formRows"}[location]
					row := importRow(name, importText(value))
					row["description"] = stringValue(param, "description")
					if location == "formData" {
						req["bodyType"] = "form"
						if openAPIFirstMedia(operation, doc, "consumes", "") == "application/x-www-form-urlencoded" {
							req["bodyType"] = "urlencoded"
						}
						if stringValue(param, "type") == "file" {
							row["isFile"] = true
						}
					}
					req[field] = append(importArray(req[field]), row)
				case "body":
					if value != nil {
						media := openAPIFirstMedia(operation, doc, "consumes", "application/json")
						importSetBody(req, media, openAPIBodyText(value, media))
					}
				}
			}
			existingPaths := map[string]bool{}
			for _, row := range mapSlice(req["pathParams"]) {
				existingPaths[stringValue(row, "key")] = true
			}
			for _, match := range openAPIPathParam.FindAllStringSubmatch(path, -1) {
				if !existingPaths[match[1]] {
					req["pathParams"] = append(importArray(req["pathParams"]), importRow(match[1], "{{"+match[1]+"}}"))
					existingPaths[match[1]] = true
				}
			}
			body := openAPIObject(doc, operation["requestBody"])
			media, value := openAPIMedia(doc, nestedMap(body, "content"))
			if media != "" {
				switch media {
				case "multipart/form-data", "application/x-www-form-urlencoded":
					req["bodyType"] = "form"
					if media == "application/x-www-form-urlencoded" {
						req["bodyType"] = "urlencoded"
					}
					obj, _ := value.(map[string]any)
					for _, key := range sortedKeysAny(obj) {
						row := importRow(key, importText(obj[key]))
						mediaSpec := openAPIObject(doc, nestedMap(body, "content")[media])
						schema := openAPIObject(doc, mediaSpec["schema"])
						property := openAPIObject(doc, nestedMap(schema, "properties")[key])
						if stringValue(property, "format") == "binary" {
							row["isFile"], row["value"] = true, ""
						}
						req["formRows"] = append(importArray(req["formRows"]), row)
					}
				default:
					if value != nil {
						importSetBody(req, media, openAPIBodyText(value, media))
					}
				}
			}
			responses := nestedMap(operation, "responses")
			for _, code := range sortedKeysAny(responses) {
				status, err := strconv.Atoi(code)
				if err != nil || status < 100 || status > 599 {
					continue
				}
				response := openAPIObject(doc, responses[code])
				media, value := openAPIMedia(doc, nestedMap(response, "content"))
				if media == "" {
					examples := nestedMap(response, "examples")
					for _, key := range sortedKeysAny(examples) {
						media, value = key, examples[key]
						break
					}
				}
				if media == "" && response["schema"] != nil {
					media = openAPIFirstMedia(operation, doc, "produces", "application/json")
					value = openAPIExample(doc, response["schema"], 0)
				}
				headers := []any{}
				responseHeaders := nestedMap(response, "headers")
				for _, key := range sortedKeysAny(responseHeaders) {
					header := openAPIObject(doc, responseHeaders[key])
					value := openAPIExample(doc, header, 0)
					if value == nil {
						value = openAPIExample(doc, header["schema"], 0)
					}
					headers = append(headers, importRow(key, importText(value)))
				}
				req["examples"] = append(importArray(req["examples"]), importExample(req, code+" "+http.StatusText(status), "openapi", status, media, openAPIBodyText(value, media), headers))
			}
			out.requests = append(out.requests, req)
		}
	}
	if openAPIHasExternalRef(doc) {
		out.warnings = append(out.warnings, "External OpenAPI references were skipped. Bundle the specification into one file to include them.")
	}
	return out, nil
}

func openAPIHasExternalRef(value any) bool {
	switch node := value.(type) {
	case map[string]any:
		if ref := stringValue(node, "$ref"); ref != "" && !strings.HasPrefix(ref, "#/") {
			return true
		}
		for _, child := range node {
			if openAPIHasExternalRef(child) {
				return true
			}
		}
	case []any:
		for _, child := range node {
			if openAPIHasExternalRef(child) {
				return true
			}
		}
	}
	return false
}

func openAPIObject(doc map[string]any, value any) map[string]any {
	seen := map[string]bool{}
	for {
		obj, _ := value.(map[string]any)
		ref := stringValue(obj, "$ref")
		if ref == "" {
			return obj
		}
		if !strings.HasPrefix(ref, "#/") || seen[ref] || len(seen) >= 32 {
			return nil
		}
		seen[ref] = true
		value = doc
		for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
			key, _ := url.PathUnescape(part)
			key = strings.ReplaceAll(strings.ReplaceAll(key, "~1", "/"), "~0", "~")
			container, _ := value.(map[string]any)
			value = container[key]
		}
	}
}

func openAPIExample(doc map[string]any, value any, depth int) any {
	budget := 256
	return openAPIExampleWithin(doc, value, depth, &budget)
}

func openAPIExampleWithin(doc map[string]any, value any, depth int, budget *int) any {
	*budget--
	if depth > 12 || *budget < 0 {
		return nil
	}
	schema := openAPIObject(doc, value)
	if schema == nil {
		return nil
	}
	for _, field := range []string{"example", "default", "const"} {
		if item, ok := schema[field]; ok {
			return item
		}
	}
	for _, field := range []string{"examples", "enum", "oneOf", "anyOf"} {
		items := importArray(schema[field])
		if len(items) == 0 {
			continue
		}
		if field == "oneOf" || field == "anyOf" {
			return openAPIExampleWithin(doc, items[0], depth+1, budget)
		}
		return items[0]
	}
	properties := nestedMap(schema, "properties")
	if len(properties) > 0 || schema["allOf"] != nil || stringValue(schema, "type") == "object" {
		out := map[string]any{}
		for _, raw := range importArray(schema["allOf"]) {
			if child, ok := openAPIExampleWithin(doc, raw, depth+1, budget).(map[string]any); ok {
				for key, val := range child {
					out[key] = val
				}
			}
		}
		for _, key := range sortedKeysAny(properties) {
			if *budget <= 0 {
				break
			}
			property := properties[key]
			out[key] = openAPIExampleWithin(doc, property, depth+1, budget)
		}
		return out
	}
	switch stringValue(schema, "type") {
	case "array":
		return []any{openAPIExampleWithin(doc, schema["items"], depth+1, budget)}
	case "integer", "number":
		return 0
	case "boolean":
		return false
	case "string":
		return "string"
	}
	return nil
}

func openAPIBodyText(value any, media string) string {
	if value == nil {
		return ""
	}
	if strings.Contains(media, "json") {
		return importJSON(value)
	}
	if strings.Contains(media, "xml") {
		if text, ok := value.(string); ok && strings.HasPrefix(strings.TrimSpace(text), "<") {
			return text
		}
		var buffer strings.Builder
		encoder := xml.NewEncoder(&buffer)
		encoder.Indent("", "  ")
		if encodeOpenAPIXML(encoder, "root", value) == nil && encoder.Flush() == nil {
			return buffer.String()
		}
	}
	return importText(value)
}

var openAPIXMLName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`)

func encodeOpenAPIXML(encoder *xml.Encoder, name string, value any) error {
	if !openAPIXMLName.MatchString(name) {
		name = "item"
	}
	start := xml.StartElement{Name: xml.Name{Local: name}}
	if err := encoder.EncodeToken(start); err != nil {
		return err
	}
	switch node := value.(type) {
	case map[string]any:
		for _, key := range sortedKeysAny(node) {
			if err := encodeOpenAPIXML(encoder, key, node[key]); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range node {
			if err := encodeOpenAPIXML(encoder, "item", child); err != nil {
				return err
			}
		}
	default:
		if err := encoder.EncodeToken(xml.CharData(importText(node))); err != nil {
			return err
		}
	}
	return encoder.EncodeToken(start.End())
}

func openAPIMedia(doc map[string]any, content map[string]any) (string, any) {
	keys := sortedKeysAny(content)
	for _, preferred := range []string{"application/json", "application/x-www-form-urlencoded", "multipart/form-data", "application/xml", "text/plain"} {
		if content[preferred] != nil {
			keys = append([]string{preferred}, keys...)
			break
		}
	}
	for _, media := range keys {
		obj := openAPIObject(doc, content[media])
		if obj == nil {
			continue
		}
		if value, ok := obj["example"]; ok {
			return media, value
		}
		examples := nestedMap(obj, "examples")
		for _, key := range sortedKeysAny(examples) {
			if example := openAPIObject(doc, examples[key]); example != nil {
				if value, ok := example["value"]; ok {
					return media, value
				}
			}
		}
		return media, openAPIExample(doc, obj["schema"], 0)
	}
	return "", nil
}

func openAPIFirstMedia(operation, doc map[string]any, key, fallback string) string {
	for _, source := range []map[string]any{operation, doc} {
		if values := importArray(source[key]); len(values) > 0 {
			return importText(values[0])
		}
	}
	return fallback
}

func openAPIAuth(doc, schemes map[string]any, requirements any) map[string]any {
	for _, entry := range mapSlice(requirements) {
		for _, name := range sortedKeysAny(entry) {
			scheme := openAPIObject(doc, schemes[name])
			switch strings.ToLower(stringValue(scheme, "type")) {
			case "apikey":
				location := stringValue(scheme, "in")
				if location == "header" || location == "query" {
					return map[string]any{"type": "apikey", "apiKeyName": stringValue(scheme, "name"), "apiKeyIn": location, "apiKeyValue": importPlaceholder(name)}
				}
			case "basic", "http":
				switch strings.ToLower(defaultString(stringValue(scheme, "scheme"), stringValue(scheme, "type"))) {
				case "basic", "digest":
					return map[string]any{"type": strings.ToLower(defaultString(stringValue(scheme, "scheme"), "basic")), "basicUser": "{{username}}", "basicPass": "{{password}}"}
				case "bearer":
					return map[string]any{"type": "bearer", "bearerToken": "{{token}}"}
				}
			case "oauth2":
				flows := nestedMap(scheme, "flows")
				for _, flow := range []struct{ key, grant string }{{"authorizationCode", "authorization_code"}, {"clientCredentials", "client_credentials"}, {"password", "password"}, {"implicit", ""}} {
					if config := nestedMap(flows, flow.key); config != nil && flow.grant != "" {
						return map[string]any{"type": "oauth2", "oauth2GrantType": flow.grant, "oauth2TokenURL": stringValue(config, "tokenUrl"), "oauth2AuthURL": stringValue(config, "authorizationUrl"), "oauth2ClientID": "{{clientId}}", "oauth2Secret": "{{clientSecret}}", "oauth2Token": "{{token}}"}
					}
				}
				return map[string]any{"type": "bearer", "bearerToken": "{{token}}"}
			}
		}
	}
	return nil
}

func sortedKeysAny[V any](items map[string]V) []string {
	keys := make(map[string]string, len(items))
	for key := range items {
		keys[key] = ""
	}
	return sortedKeys(keys)
}

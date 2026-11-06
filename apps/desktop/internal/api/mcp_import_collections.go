package api

import (
	"fmt"
	"mime"
	"net/url"
	"path"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

func importPostman(doc map[string]any, fallback string) (workspaceImport, error) {
	info := nestedMap(doc, "info")
	name := defaultString(stringValue(info, "name"), defaultString(stringValue(doc, "name"), fallback))
	out := workspaceImport{name: name, description: importDescription(info["description"]), defaults: map[string]any{}}
	if doc["item"] == nil {
		if doc["values"] == nil {
			return out, fmt.Errorf("expected a Postman collection or environment")
		}
		out.environments = append(out.environments, map[string]any{"id": uuid.NewString(), "name": name, "values": importRows(doc["values"])})
		return out, nil
	}
	out.defaults["variables"] = importRows(doc["variable"])
	if auth := importPostmanAuth(doc["auth"]); auth != nil {
		out.defaults["auth"] = auth
	}
	importPostmanScripts(out.defaults, doc["event"])
	var walk func(any, []any, int)
	walk = func(items any, folder []any, depth int) {
		if depth > 64 {
			return
		}
		for _, item := range mapSlice(items) {
			if len(out.requests) > 1000 {
				return
			}
			name := stringValue(item, "name")
			if item["item"] != nil {
				child := append(append([]any{}, folder...), defaultString(name, "Folder"))
				out.folders = append(out.folders, child)
				defaults := map[string]any{"id": uuid.NewString(), "path": child}
				if auth := importPostmanAuth(item["auth"]); auth != nil {
					defaults["auth"] = auth
				}
				importPostmanScripts(defaults, item["event"])
				if len(defaults) > 2 {
					out.folderDefaults = append(out.folderDefaults, defaults)
				}
				walk(item["item"], child, depth+1)
				continue
			}
			source := nestedMap(item, "request")
			target, params, pathParams := importPostmanURL(source["url"])
			if text, ok := item["request"].(string); ok {
				target, params, pathParams = importPostmanURL(text)
			}
			if target == "" {
				continue
			}
			req := importRequest(name, stringValue(source, "method"), target)
			if len(folder) > 0 {
				req["folderPath"] = folder
			}
			req["params"], req["pathParams"], req["headers"] = params, pathParams, importRows(source["header"])
			req["requestNotes"] = defaultString(importDescription(source["description"]), importDescription(item["description"]))
			if auth := importPostmanAuth(source["auth"]); auth != nil {
				req["auth"] = auth
			}
			importPostmanScripts(req, item["event"], source["event"])
			body := nestedMap(source, "body")
			switch stringValue(body, "mode") {
			case "raw":
				language := stringValue(nestedMap(nestedMap(body, "options"), "raw"), "language")
				importSetBody(req, "application/"+language, stringValue(body, "raw"))
			case "urlencoded", "formdata":
				mode := stringValue(body, "mode")
				req["bodyType"] = "form"
				if mode == "urlencoded" {
					req["bodyType"] = mode
				}
				req["formRows"] = importRows(body[mode])
			case "graphql":
				req["requestType"], req["bodyType"], req["method"] = "graphql", "graphql", "POST"
				req["bodyContent"] = importJSON(nestedMap(body, "graphql"))
			case "file":
				req["bodyType"] = "binary"
				out.warnings = append(out.warnings, "Choose a local body file for imported binary requests.")
			}
			extension := nestedMap(item, "x-kurlo")
			if extension == nil {
				extension = nestedMap(source, "x-kurlo")
			}
			importProtocolExtension(req, extension)
			if profile := nestedMap(item, "protocolProfileBehavior"); profile != nil {
				settings := nestedMap(req, "settings")
				if settings == nil {
					settings = map[string]any{}
				}
				if value, ok := profile["followRedirects"].(bool); ok {
					settings["followRedirects"] = value
				}
				if value, ok := profile["disableCookies"].(bool); ok {
					settings["disableCookieJar"] = value
				}
				if value, ok := profile["strictSSL"].(bool); ok {
					settings["enableSSLVerification"] = value
				}
				req["settings"] = settings
			}
			for _, response := range mapSlice(item["response"]) {
				status := importInt(response["code"])
				if status < 100 || status > 599 {
					continue
				}
				headers := importRows(response["header"])
				snapshot := req
				if original := nestedMap(response, "originalRequest"); original != nil {
					target, _, _ := importPostmanURL(original["url"])
					if target != "" {
						snapshot = importRequest("", defaultString(stringValue(original, "method"), stringValue(req, "method")), target)
					}
				}
				example := importExample(snapshot, stringValue(response, "name"), "postman", status, importContentType(headers), stringValue(response, "body"), headers)
				req["examples"] = append(importArray(req["examples"]), example)
			}
			out.requests = append(out.requests, req)
		}
	}
	walk(doc["item"], nil, 0)
	return out, nil
}

func importPostmanURL(value any) (string, []any, []any) {
	if raw, ok := value.(string); ok {
		url, query := importURLQuery(raw)
		return url, query, []any{}
	}
	obj, _ := value.(map[string]any)
	target := stringValue(obj, "raw")
	if target == "" {
		host := importText(obj["host"])
		if parts := importArray(obj["host"]); len(parts) > 0 {
			var words []string
			for _, part := range parts {
				words = append(words, importText(part))
			}
			host = strings.Join(words, ".")
		}
		target = host
		if port := stringValue(obj, "port"); port != "" {
			target += ":" + port
		}
		if proto := stringValue(obj, "protocol"); proto != "" {
			target = proto + "://" + target
		}
		if parts := importArray(obj["path"]); len(parts) > 0 {
			for _, part := range parts {
				target += "/" + importText(part)
			}
		} else if part := stringValue(obj, "path"); part != "" {
			target += "/" + strings.TrimLeft(part, "/")
		}
	}
	target, rawQuery := importURLQuery(target)
	query := importRows(obj["query"])
	if obj["query"] == nil {
		query = rawQuery
	}
	return target, query, importRows(obj["variable"])
}

func importURLQuery(raw string) (string, []any) {
	target, _, _ := strings.Cut(raw, "#")
	target, query, _ := strings.Cut(target, "?")
	rows := []any{}
	for _, pair := range strings.Split(query, "&") {
		key, value, _ := strings.Cut(pair, "=")
		decodedKey, err := url.QueryUnescape(key)
		if err == nil {
			key = decodedKey
		}
		decodedValue, err := url.QueryUnescape(value)
		if err == nil {
			value = decodedValue
		}
		if key != "" {
			rows = append(rows, importRow(key, value))
		}
	}
	return target, rows
}

func importPostmanScripts(target map[string]any, values ...any) {
	for _, events := range values {
		for _, event := range mapSlice(events) {
			field := map[string]string{"prerequest": "preRequestScriptJs", "test": "testScriptJs"}[stringValue(event, "listen")]
			if field == "" || event["disabled"] == true {
				continue
			}
			raw := nestedMap(event, "script")["exec"]
			var script string
			if lines := importArray(raw); lines != nil {
				var text []string
				for _, line := range lines {
					text = append(text, importText(line))
				}
				script = strings.Join(text, "\n")
			} else {
				script = importText(raw)
			}
			if script != "" {
				target[field] = joinScripts(stringValue(target, field), script)
			}
		}
	}
}

func importPostmanAuth(value any) map[string]any {
	auth, _ := value.(map[string]any)
	kind := strings.ToLower(stringValue(auth, "type"))
	if kind == "" {
		return nil
	}
	values := map[string]any{}
	for _, item := range mapSlice(auth[kind]) {
		values[stringValue(item, "key")] = item["value"]
	}
	return importAuth(kind, values)
}

func importAuth(kind string, values map[string]any) map[string]any {
	out := map[string]any{"type": kind}
	var keys map[string]string
	switch kind {
	case "basic", "digest", "ntlm":
		keys = map[string]string{"username": "basicUser", "password": "basicPass"}
	case "bearer":
		keys = map[string]string{"token": "bearerToken"}
	case "apikey":
		keys = map[string]string{"key": "apiKeyName", "name": "apiKeyName", "value": "apiKeyValue", "in": "apiKeyIn", "addTo": "apiKeyIn"}
	case "awsv4", "aws":
		out["type"] = "aws"
		keys = map[string]string{"accessKey": "awsAccessKey", "secretKey": "awsSecretKey", "sessionToken": "awsSessionToken", "region": "awsRegion", "service": "awsService"}
	case "oauth1":
		keys = map[string]string{"consumerKey": "oauth1ConsumerKey", "consumerSecret": "oauth1ConsumerSecret", "token": "oauth1Token", "tokenSecret": "oauth1TokenSecret", "signatureMethod": "oauth1SignatureMethod", "privateKey": "oauth1PrivateKey", "realm": "oauth1Realm", "callback": "oauth1Callback", "verifier": "oauth1Verifier", "addTo": "oauth1AddTo"}
	case "oauth2":
		keys = map[string]string{"accessToken": "oauth2Token", "token": "oauth2Token", "clientId": "oauth2ClientID", "clientSecret": "oauth2Secret", "accessTokenUrl": "oauth2TokenURL", "tokenUrl": "oauth2TokenURL", "authUrl": "oauth2AuthURL", "authorizationUrl": "oauth2AuthURL", "redirectUri": "oauth2RedirectURL", "scope": "oauth2Scope", "refreshToken": "oauth2RefreshToken", "username": "oauth2Username", "password": "oauth2Password"}
		switch grant := strings.ToLower(strings.ReplaceAll(importText(values["grant_type"]), "-", "_")); grant {
		case "client_credentials", "password", "device_code", "authorization_code":
			out["oauth2GrantType"] = grant
		default:
			switch importText(values["grantType"]) {
			case "client_credentials", "clientCredentials":
				out["oauth2GrantType"] = "client_credentials"
			case "password":
				out["oauth2GrantType"] = "password"
			default:
				out["oauth2GrantType"] = "authorization_code"
			}
		}
		out["oauth2UsePKCE"] = strings.Contains(strings.ToLower(importText(values["grant_type"])), "pkce") || values["usePkce"] == true
	default:
		out["type"] = "none"
	}
	for _, key := range sortedKeysAny(keys) {
		if raw := importText(values[key]); raw != "" {
			out[keys[key]] = raw
		}
	}
	return out
}

func importInsomnia(doc map[string]any, fallback string) (workspaceImport, error) {
	resources := mapSlice(doc["resources"])
	if len(resources) == 0 {
		return workspaceImport{}, fmt.Errorf("expected an Insomnia export with resources")
	}
	out := workspaceImport{name: fallback, defaults: map[string]any{}}
	byID := map[string]map[string]any{}
	for _, item := range resources {
		byID[stringValue(item, "_id")] = item
		if stringValue(item, "_type") == "workspace" {
			out.name = defaultString(stringValue(item, "name"), out.name)
			out.description = stringValue(item, "description")
		}
	}
	for _, item := range resources {
		kind := strings.ToLower(stringValue(item, "_type"))
		var folder []any
		seen := map[string]bool{}
		for parent := stringValue(item, "parentId"); parent != "" && !seen[parent]; {
			seen[parent] = true
			group := byID[parent]
			if stringValue(group, "_type") == "request_group" {
				folder = append([]any{defaultString(stringValue(group, "name"), "Folder")}, folder...)
			}
			parent = stringValue(group, "parentId")
		}
		switch kind {
		case "request_group":
			out.folders = append(out.folders, append(folder, defaultString(stringValue(item, "name"), "Folder")))
		case "environment":
			data := nestedMap(item, "data")
			rows := []any{}
			for _, key := range sortedKeysAny(data) {
				rows = append(rows, importRow(key, importText(data[key])))
			}
			out.environments = append(out.environments, map[string]any{"id": uuid.NewString(), "name": defaultString(stringValue(item, "name"), "Insomnia environment"), "values": rows})
		case "request", "websocket_request", "websocket", "socketio_request", "socketio", "grpc_request", "grpc":
			target := stringValue(item, "url")
			if target == "" {
				continue
			}
			req := importRequest(stringValue(item, "name"), stringValue(item, "method"), target)
			if len(folder) > 0 {
				req["folderPath"] = folder
			}
			req["params"], req["headers"], req["pathParams"] = importRows(item["parameters"]), importRows(item["headers"]), importRows(item["pathParameters"])
			req["requestNotes"] = stringValue(item, "description")
			req["preRequestScriptJs"], req["testScriptJs"] = stringValue(item, "preRequestScript"), stringValue(item, "afterResponseScript")
			if auth := nestedMap(item, "authentication"); auth != nil && auth["disabled"] != true {
				req["auth"] = importAuth(strings.ToLower(stringValue(auth, "type")), auth)
			}
			body := nestedMap(item, "body")
			importMediaBody(req, body)
			switch {
			case strings.HasPrefix(kind, "grpc"):
				req["requestType"], req["method"], req["grpcMethod"] = "grpc", "POST", defaultString(stringValue(item, "protoMethodName"), stringValue(item, "grpcMethod"))
				req["grpcMetadata"] = importRows(item["metadata"])
			case strings.HasPrefix(kind, "websocket"):
				req["requestType"] = "ws"
			case strings.HasPrefix(kind, "socketio"):
				req["requestType"] = "socketio"
			}
			extension := nestedMap(item, "kurlo")
			if extension == nil {
				extension = nestedMap(item, "x-kurlo")
			}
			importProtocolExtension(req, extension)
			out.requests = append(out.requests, req)
		}
	}
	return out, nil
}

func importProtocolExtension(req, extension map[string]any) {
	switch kind := stringValue(extension, "requestType"); kind {
	case "http", "graphql", "ws", "socketio", "grpc", "mcp", "ai":
		req["requestType"] = kind
	}
	for _, key := range []string{"url", "requestTab", "grpcMethod", "grpcUseReflection", "sioEventName", "sioArgs", "sioAck", "mcpMethod", "mcpName", "mcpArguments", "aiProvider", "aiModel", "aiPrompt", "aiSystem"} {
		if value, ok := extension[key]; ok {
			req[key] = value
		}
	}
	for _, key := range []string{"grpcMetadata", "sioEvents"} {
		if value, ok := extension[key]; ok {
			req[key] = importRows(value)
		}
	}
	if full := stringValue(extension, "fullMethod"); full != "" && req["grpcMethod"] == nil {
		req["grpcMethod"] = full
	}
	if message := stringValue(extension, "message"); message != "" {
		req["bodyContent"] = message
	}
	if settings := nestedMap(extension, "settings"); settings != nil {
		delete(settings, "clientCertPath")
		delete(settings, "clientKeyPath")
		delete(settings, "clientKeyPassword")
		req["settings"] = settings
	}
	if req["requestType"] == "grpc" {
		req["method"], req["bodyType"] = "POST", "json"
	}
	if kind := stringValue(req, "requestType"); kind == "ws" || kind == "socketio" {
		if parsed, err := url.Parse(stringValue(req, "url")); err == nil && strings.Contains(parsed.Path, "/socket.io") {
			req["requestType"] = "socketio"
			params := []any{}
			for _, row := range mapSlice(req["params"]) {
				switch strings.ToLower(stringValue(row, "key")) {
				case "eio", "transport", "sid", "t":
				default:
					params = append(params, row)
				}
			}
			req["params"] = params
			settings := nestedMap(req, "settings")
			if settings == nil {
				settings = map[string]any{}
			}
			settings["sioPath"] = parsed.Path
			if parsed.Query().Get("EIO") == "3" {
				settings["sioClientVersion"] = "v2"
			}
			req["settings"] = settings
		}
	}
}

func importMediaBody(req, body map[string]any) {
	media := stringValue(body, "mimeType")
	switch {
	case strings.HasPrefix(media, "multipart/form-data"):
		req["bodyType"], req["formRows"] = "form", importRows(body["params"])
	case strings.HasPrefix(media, "application/x-www-form-urlencoded"):
		rows := importRows(body["params"])
		if len(rows) == 0 {
			_, rows = importURLQuery("?" + stringValue(body, "text"))
		}
		req["bodyType"], req["formRows"] = "urlencoded", rows
	case media == "application/octet-stream" && stringValue(body, "text") == "":
		req["bodyType"] = "binary"
	default:
		if text := stringValue(body, "text"); text != "" {
			importSetBody(req, media, text)
		}
	}
}

func importHAR(doc map[string]any, fallback string) (workspaceImport, error) {
	log := nestedMap(doc, "log")
	if log == nil || log["entries"] == nil {
		return workspaceImport{}, fmt.Errorf("expected a HAR log with entries")
	}
	out := workspaceImport{name: fallback}
	for _, entry := range mapSlice(log["entries"]) {
		source := nestedMap(entry, "request")
		raw := stringValue(source, "url")
		if raw == "" {
			continue
		}
		target, query := importURLQuery(raw)
		if len(importArray(source["queryString"])) > 0 {
			query = importRows(source["queryString"])
		}
		label := target
		if parsed, err := url.Parse(target); err == nil {
			label = defaultString(parsed.Path, parsed.Hostname())
		}
		req := importRequest(strings.ToUpper(defaultString(stringValue(source, "method"), "GET"))+" "+label, stringValue(source, "method"), target)
		req["params"], req["headers"] = query, importRows(source["headers"])
		for _, row := range mapSlice(req["headers"]) {
			if strings.EqualFold(stringValue(row, "key"), "upgrade") && strings.EqualFold(stringValue(row, "value"), "websocket") {
				req["requestType"] = "ws"
			}
		}
		importProtocolExtension(req, nil)
		importMediaBody(req, nestedMap(source, "postData"))
		response := nestedMap(entry, "response")
		code := importInt(response["status"])
		if code >= 100 && code <= 599 {
			content := nestedMap(response, "content")
			text := stringValue(content, "text")
			if stringValue(content, "encoding") == "base64" {
				text = ""
				out.warnings = append(out.warnings, "Binary HAR example bodies were omitted.")
			}
			example := importExample(req, "Captured response", "captured", code, stringValue(content, "mimeType"), text, importRows(response["headers"]))
			req["examples"] = []any{example}
		}
		out.requests = append(out.requests, req)
	}
	return out, nil
}

func importContentType(headers []any) string {
	for _, row := range mapSlice(headers) {
		if strings.EqualFold(stringValue(row, "key"), "content-type") {
			media, _, _ := mime.ParseMediaType(stringValue(row, "value"))
			return media
		}
	}
	return ""
}

func importRequestName(method, target string) string {
	parsed, err := url.Parse(target)
	if err != nil || parsed.Host == "" {
		return method + " " + target
	}
	return method + " " + path.Clean(defaultString(parsed.Path, "/"))
}

func importInt(value any) int {
	n, _ := strconv.Atoi(importText(value))
	return n
}

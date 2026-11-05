package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func (s *mcpServer) toolCodeSnippet(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Request  string `json:"request"`
		Language string `json:"language"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	st, err := s.loadStore()
	if err != nil {
		return nil, err
	}
	_, saved, err := st.request(args.Request)
	if err != nil {
		return nil, err
	}
	if !cliRunnable(saved) {
		return nil, fmt.Errorf("code snippets are available for saved HTTP and GraphQL requests")
	}
	collections, err := decodeMaps[cliCollection](st.collections)
	if err != nil {
		return nil, err
	}
	saved = (mcpWorkspace{collections: collections}).withDefaults(saved)
	req := buildHTTPRequest(saved, nil, nil, 0)
	lang := strings.ToLower(defaultString(args.Language, "curl"))
	snippet, warnings, err := buildMCPCodeSnippet(lang, req, agentActivitySecrets())
	if err != nil {
		return nil, err
	}
	return map[string]any{"request": mcpRequestPath(saved), "language": lang, "code": snippet, "warnings": warnings}, nil
}

type snippetField struct{ key, value string }

func buildMCPCodeSnippet(lang string, req model.HttpRequest, secrets []string) (string, []string, error) {
	warnings := []string{}
	quote := func(value string) string {
		switch lang {
		case "ruby":
			return strings.ReplaceAll(strconv.Quote(value), "#", "\\#")
		case "kotlin", "php":
			return strings.ReplaceAll(strconv.Quote(value), "$", "\\$")
		default:
			return strconv.Quote(value)
		}
	}
	shell := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
	scrub := func(text string) string { return redactSecrets(text, secrets) }
	target := scrub(scrubImportURL(applyPathParams(req.URL, req.PathParams)))
	method := req.Method
	params := url.Values{}
	headers := []snippetField{}
	for _, row := range req.Params {
		value := scrub(row.Value)
		if importSensitiveName(row.Key) && secretFieldNeedsVault(value) {
			value = importPlaceholder(row.Key)
		}
		params.Add(row.Key, value)
	}
	for _, row := range req.Headers {
		value := scrub(row.Value)
		if mcpSensitiveHeaders[strings.ToLower(row.Key)] || importSensitiveName(row.Key) {
			if secretFieldNeedsVault(value) {
				value = importPlaceholder(row.Key)
			}
		}
		headers = append(headers, snippetField{row.Key, value})
	}
	maskAuth := func(value, key string) string {
		if strings.Contains(value, "{{kurloSecret:") || secretFieldNeedsVault(value) {
			return importPlaceholder(key)
		}
		return value
	}
	auth := req.Auth
	switch auth.Type {
	case "bearer", "oauth2":
		token := maskAuth(defaultString(auth.Token, "{{token}}"), "token")
		headers = append(headers, snippetField{"Authorization", "Bearer " + token})
	case "basic":
		if lang == "curl" {
			warnings = append(warnings, "Fill in the username and password before running the command.")
		} else if auth.Password != "" && !secretFieldNeedsVault(auth.Password) && !strings.Contains(auth.Password, "{{") {
			headers = append(headers, snippetField{"Authorization", "Basic " + base64.StdEncoding.EncodeToString([]byte(scrub(auth.Username)+":"+auth.Password))})
		} else {
			headers = append(headers, snippetField{"Authorization", "Basic {{base64Credentials}}"})
			warnings = append(warnings, "Set base64Credentials to the base64 encoding of username:password.")
		}
	case "apikey":
		if auth.KeyName != "" {
			value := maskAuth(auth.KeyValue, "apiKey")
			if auth.KeyIn == "query" {
				params.Add(auth.KeyName, value)
			} else {
				headers = append(headers, snippetField{auth.KeyName, value})
			}
		}
	case "digest", "ntlm", "oauth1", "aws":
		if lang != "curl" || (auth.Type != "digest" && auth.Type != "ntlm") {
			warnings = append(warnings, "Configure "+auth.Type+" authentication in the selected HTTP library.")
		}
	}
	if encoded := params.Encode(); encoded != "" {
		sep := "?"
		if strings.Contains(target, "?") {
			sep = "&"
		}
		target += sep + strings.ReplaceAll(strings.ReplaceAll(encoded, "%7B", "{"), "%7D", "}")
	}
	body, media := scrub(req.Body), rawBodyContentTypes[req.BodyType]
	var data any
	if json.Unmarshal([]byte(body), &data) == nil && scrubImportJSON(data) {
		body = importJSON(data)
	}
	if req.BodyType == "none" {
		body = ""
	}
	if req.BodyType == "urlencoded" {
		values := url.Values{}
		for _, row := range req.FormData {
			value := scrub(row.Value)
			if importSensitiveName(row.Key) && secretFieldNeedsVault(value) {
				value = importPlaceholder(row.Key)
			}
			values.Add(row.Key, value)
		}
		body, media = values.Encode(), "application/x-www-form-urlencoded"
	}
	if strings.Contains(body, "{{kurloSecret:") {
		body = "{{body}}"
	}
	var special []string
	switch req.BodyType {
	case "form":
		body = ""
		var buffer strings.Builder
		writer := multipart.NewWriter(&buffer)
		_ = writer.SetBoundary("kurlo-snippet-boundary")
		for _, row := range req.FormData {
			value := scrub(row.Value)
			if importSensitiveName(row.Key) && secretFieldNeedsVault(value) {
				value = importPlaceholder(row.Key)
			}
			if row.IsFile {
				filename := filepath.Base(strings.ReplaceAll(defaultString(row.FileName, defaultString(row.Value, "upload.bin")), "\\", "/"))
				special = append(special, "--form "+shell(row.Key+"=@"+filename))
				part, err := writer.CreateFormFile(row.Key, filename)
				if err != nil {
					return "", nil, err
				}
				_, _ = io.WriteString(part, "{{file_content}}")
				if lang != "curl" {
					warnings = append(warnings, "Replace file_content with the file bytes using the HTTP library's multipart support.")
				}
			} else {
				special = append(special, "--form-string "+shell(row.Key+"="+value))
				_ = writer.WriteField(row.Key, value)
			}
		}
		_ = writer.Close()
		if lang != "curl" && len(req.FormData) > 0 {
			body, media = buffer.String(), writer.FormDataContentType()
		}
	case "binary":
		filename := filepath.Base(strings.ReplaceAll(defaultString(req.BodyFilePath, "body.bin"), "\\", "/"))
		special = append(special, "--data-binary "+shell("@"+filename))
		if lang != "curl" {
			body = "{{file_content}}"
			warnings = append(warnings, "Read the binary file with your language's file API and pass the bytes as the request body.")
		} else {
			body = ""
		}
		media = "application/octet-stream"
	}
	var selectedHeaders []snippetField
	contentType := false
	for _, header := range headers {
		if strings.EqualFold(header.key, "Content-Type") {
			if req.BodyType == "form" {
				continue
			}
			contentType = true
		}
		selectedHeaders = append(selectedHeaders, header)
	}
	headers = selectedHeaders
	if media != "" && !contentType {
		headers = append(headers, snippetField{"Content-Type", media})
	}
	if lang == "curl" {
		parts := []string{"curl --request " + shell(method), shell(target)}
		for _, header := range headers {
			parts = append(parts, "--header "+shell(header.key+": "+header.value))
		}
		if auth.Type == "basic" || auth.Type == "digest" || auth.Type == "ntlm" {
			if auth.Type != "basic" {
				parts = append(parts, "--"+auth.Type)
			}
			parts = append(parts, "--user "+shell(scrub(auth.Username)+":"+maskAuth(defaultString(auth.Password, "{{password}}"), "password")))
		}
		parts = append(parts, special...)
		if body != "" {
			parts = append(parts, "--data-raw "+shell(body))
		}
		return strings.Join(parts, " \\\n  "), warnings, nil
	}
	if lang == "httpie" {
		parts := []string{"http", shell(method), shell(target)}
		for _, header := range headers {
			parts = append(parts, shell(header.key+":"+header.value))
		}
		if body != "" {
			parts = append(parts, "--raw "+shell(body))
		}
		return strings.Join(parts, " "), warnings, nil
	}
	code, err := renderMCPSnippet(lang, method, target, body, headers, quote)
	return code, warnings, err
}

func renderMCPSnippet(lang, method, target, body string, headers []snippetField, quote func(string) string) (string, error) {
	qm, qu, qb := quote(method), quote(target), quote(body)
	jsPairs, rubyPairs, phpPairs := []string{}, []string{}, []string{}
	for _, header := range headers {
		key, value := quote(header.key), quote(header.value)
		jsPairs = append(jsPairs, key+": "+value)
		rubyPairs = append(rubyPairs, key+" => "+value)
		phpPairs = append(phpPairs, quote(header.key+": "+header.value))
	}
	object := "{" + strings.Join(jsPairs, ", ") + "}"
	var head, tail, headerFormat string
	switch lang {
	case "javascript", "node":
		data := ""
		if body != "" {
			data = ", body: " + qb
		}
		return "const response = await fetch(" + qu + ", { method: " + qm + ", headers: " + object + data + " });\nconsole.log(await response.text());", nil
	case "axios":
		data := ""
		if body != "" {
			data = ", data: " + qb
		}
		return "import axios from 'axios';\nconst response = await axios({ method: " + qm + ", url: " + qu + ", headers: " + object + data + " });\nconsole.log(response.data);", nil
	case "python":
		data := ""
		if body != "" {
			data = ", data=" + qb + ".encode('utf-8')"
		}
		return "import requests\n\nresponse = requests.request(" + qm + ", " + qu + ", headers=" + object + data + ")\nprint(response.text)", nil
	case "go":
		source := "nil"
		packages := "\t\"fmt\"\n\t\"io\"\n\t\"net/http\"\n"
		if body != "" {
			source = "strings.NewReader(" + qb + ")"
			packages += "\t\"strings\"\n"
		}
		head = "package main\n\nimport (\n" + packages + ")\n\nfunc main() {\n\treq, err := http.NewRequest(" + qm + ", " + qu + ", " + source + ")\n\tif err != nil { panic(err) }\n"
		headerFormat = "\treq.Header.Add(%s, %s)\n"
		tail = "\tresp, err := http.DefaultClient.Do(req)\n\tif err != nil { panic(err) }\n\tdefer resp.Body.Close()\n\tdata, err := io.ReadAll(resp.Body)\n\tif err != nil { panic(err) }\n\tfmt.Println(string(data))\n}"
	case "java":
		publisher := "HttpRequest.BodyPublishers.noBody()"
		if body != "" {
			publisher = "HttpRequest.BodyPublishers.ofString(" + qb + ")"
		}
		head = "import java.net.URI;\nimport java.net.http.*;\n\nvar request = HttpRequest.newBuilder(URI.create(" + qu + "))\n    .method(" + qm + ", " + publisher + ")\n"
		headerFormat = "    .header(%s, %s)\n"
		tail = "    .build();\nvar response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());\nSystem.out.println(response.body());"
	case "csharp":
		head = "using System;\nusing System.Net.Http;\nusing System.Text;\n\nusing var client = new HttpClient();\nusing var request = new HttpRequestMessage(new HttpMethod(" + qm + "), " + qu + ");\n"
		if body != "" {
			head += "request.Content = new ByteArrayContent(Encoding.UTF8.GetBytes(" + qb + "));\n"
		}
		for _, header := range headers {
			if body != "" && strings.EqualFold(header.key, "Content-Type") {
				head += fmt.Sprintf("request.Content.Headers.TryAddWithoutValidation(%s, %s);\n", quote(header.key), quote(header.value))
			} else {
				head += fmt.Sprintf("request.Headers.TryAddWithoutValidation(%s, %s);\n", quote(header.key), quote(header.value))
			}
		}
		return head + "using var response = await client.SendAsync(request);\nConsole.WriteLine(await response.Content.ReadAsStringAsync());", nil
	case "php":
		value := ""
		if body != "" {
			value = "    CURLOPT_POSTFIELDS => " + qb + ",\n"
		}
		return "<?php\n$request = curl_init(" + qu + ");\ncurl_setopt_array($request, [\n    CURLOPT_CUSTOMREQUEST => " + qm + ",\n    CURLOPT_RETURNTRANSFER => true,\n    CURLOPT_HTTPHEADER => [" + strings.Join(phpPairs, ", ") + "],\n" + value + "]);\necho curl_exec($request);\ncurl_close($request);", nil
	case "ruby":
		data := ""
		if body != "" {
			data = ", " + qb
		}
		return "require 'net/http'\nrequire 'uri'\n\nuri = URI(" + qu + ")\nresponse = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https') do |http|\n  http.send_request(" + qm + ", uri.request_uri" + defaultString(data, ", nil") + ", {" + strings.Join(rubyPairs, ", ") + "})\nend\nputs response.body", nil
	case "swift":
		head = "import Foundation\n\nvar request = URLRequest(url: URL(string: " + qu + ")!)\nrequest.httpMethod = " + qm + "\n"
		if body != "" {
			head += "request.httpBody = Data(" + qb + ".utf8)\n"
		}
		headerFormat = "request.addValue(%[2]s, forHTTPHeaderField: %[1]s)\n"
		tail = "let (data, _) = try await URLSession.shared.data(for: request)\nprint(String(decoding: data, as: UTF8.self))"
	case "kotlin":
		bodyArg := "null"
		if body != "" {
			bodyArg = qb + ".toRequestBody()"
		}
		if body == "" && (method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch) {
			bodyArg = "\"\".toRequestBody()"
		}
		head = "import okhttp3.*\nimport okhttp3.RequestBody.Companion.toRequestBody\n\nval request = Request.Builder().url(" + qu + ").method(" + qm + ", " + bodyArg + ")\n"
		headerFormat = "    .addHeader(%s, %s)\n"
		tail = "    .build()\nOkHttpClient().newCall(request).execute().use { println(it.body?.string()) }"
	case "rust":
		head = "let client = reqwest::Client::new();\nlet response = client.request(reqwest::Method::from_bytes(" + qm + ".as_bytes())?, " + qu + ")\n"
		headerFormat = "    .header(%s, %s)\n"
		if body != "" {
			tail = "    .body(" + qb + ")\n"
		}
		tail += "    .send().await?;\nprintln!(\"{}\", response.text().await?);"
	default:
		return "", fmt.Errorf("unknown snippet language; use curl, httpie, javascript, node, axios, python, go, java, csharp, php, ruby, swift, kotlin or rust")
	}
	for _, header := range headers {
		head += fmt.Sprintf(headerFormat, quote(header.key), quote(header.value))
	}
	return head + tail, nil
}

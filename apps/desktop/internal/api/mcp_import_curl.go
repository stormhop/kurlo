package api

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

func importCurl(content string) (map[string]any, error) {
	words, err := curlShellWords(content)
	if err != nil {
		return nil, err
	}
	if len(words) < 2 || words[0] != "curl" {
		return nil, fmt.Errorf("expected a curl command")
	}
	var method, target, body, media string
	headers, forms, query := []any{}, []any{}, []any{}
	settings := map[string]any{}
	auth := map[string]any{"type": "inherit"}
	getData, binary, rawData := false, false, false
	data := []string{}
	for i := 1; i < len(words); i++ {
		flag, value, inline := strings.Cut(words[i], "=")
		if !strings.HasPrefix(flag, "-") {
			if target != "" {
				return nil, fmt.Errorf("import one curl URL at a time")
			}
			target = words[i]
			continue
		}
		if !strings.HasPrefix(flag, "--") && len(flag) > 2 && strings.ContainsRune("XHduFbAxmTo", rune(flag[1])) {
			flag, value, inline = flag[:2], words[i][2:], true
		}
		switch flag {
		case "-G", "--get":
			getData = true
			continue
		case "-I", "--head":
			method = "HEAD"
			continue
		case "-k", "--insecure":
			settings["enableSSLVerification"] = false
			continue
		case "-L", "--location", "--location-trusted":
			settings["followRedirects"] = true
			continue
		case "--http1.1":
			settings["httpVersion"] = "1.1"
			continue
		case "--http2":
			settings["httpVersion"] = "2"
			continue
		case "-s", "--silent", "-S", "--show-error", "-sS", "-v", "--verbose", "--compressed", "-f", "--fail", "--fail-with-body", "-i", "--include", "--globoff", "-g", "--basic":
			continue
		case "--digest", "--ntlm":
			auth["type"] = strings.TrimPrefix(flag, "--")
			continue
		case "-X", "--request", "--url", "-H", "--header", "-d", "--data", "--data-raw", "--data-ascii", "--data-urlencode", "--data-binary", "--json",
			"-F", "--form", "--form-string", "-u", "--user", "--oauth2-bearer", "-b", "--cookie", "-A", "--user-agent", "-e", "--referer",
			"-m", "--max-time", "-x", "--proxy", "-T", "--upload-file", "-o", "--output", "--url-query":
		default:
			return nil, fmt.Errorf("unsupported curl option %s", flag)
		}
		if !inline {
			i++
			if i >= len(words) {
				return nil, fmt.Errorf("curl option %s needs a value", flag)
			}
			value = words[i]
		}
		switch flag {
		case "-X", "--request":
			method = strings.ToUpper(value)
		case "--url":
			if target != "" {
				return nil, fmt.Errorf("import one curl URL at a time")
			}
			target = value
		case "-H", "--header":
			if key, val, ok := strings.Cut(value, ":"); ok && strings.TrimSpace(key) != "" {
				headers = append(headers, importRow(strings.TrimSpace(key), strings.TrimSpace(val)))
			} else if strings.HasPrefix(value, "@") {
				return nil, fmt.Errorf("inline headers are required")
			}
		case "-d", "--data", "--data-ascii", "--data-raw", "--data-urlencode", "--data-binary", "--json":
			if flag != "--data-raw" && (strings.HasPrefix(value, "@") || flag == "--data-urlencode" && !strings.Contains(value, "=") && strings.Contains(value, "@")) {
				return nil, fmt.Errorf("inline request data is required; curl file references are not read")
			}
			if flag == "--json" {
				media = "application/json"
				rawData = true
			}
			if flag == "--data-raw" || flag == "--data-binary" {
				rawData = true
			}
			if flag == "--data-urlencode" {
				key, val, ok := strings.Cut(value, "=")
				if ok {
					value = key + "=" + url.QueryEscape(val)
				} else {
					value = url.QueryEscape(value)
				}
			}
			data = append(data, value)
		case "-F", "--form", "--form-string":
			key, val, ok := strings.Cut(value, "=")
			if !ok || key == "" {
				return nil, fmt.Errorf("curl form fields need name=value")
			}
			row := importRow(key, val)
			if flag != "--form-string" && (strings.HasPrefix(val, "@") || strings.HasPrefix(val, "<")) {
				row["value"] = ""
				row["isFile"] = true
			}
			forms = append(forms, row)
		case "-u", "--user":
			username, password, _ := strings.Cut(value, ":")
			if auth["type"] == "inherit" {
				auth["type"] = "basic"
			}
			auth["basicUser"], auth["basicPass"] = username, password
		case "--oauth2-bearer":
			auth = map[string]any{"type": "bearer", "bearerToken": value}
		case "-b", "--cookie":
			if !strings.Contains(value, "=") {
				return nil, fmt.Errorf("inline cookies are required")
			}
			headers = append(headers, importRow("Cookie", value))
		case "-A", "--user-agent":
			headers = append(headers, importRow("User-Agent", value))
		case "-e", "--referer":
			headers = append(headers, importRow("Referer", value))
		case "-m", "--max-time":
			if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds >= 0 && seconds <= 3600 {
				settings["timeoutMs"] = int(seconds * 1000)
			}
		case "-x", "--proxy":
			settings["proxyUrl"] = value
		case "-T", "--upload-file":
			binary = true
		case "--url-query":
			_, rows := importURLQuery("?" + value)
			query = append(query, rows...)
		}
	}
	if target == "" {
		return nil, fmt.Errorf("curl command needs a URL")
	}
	target, params := importURLQuery(target)
	params = append(params, query...)
	if method == "" {
		method = "GET"
		if binary {
			method = "PUT"
		} else if !getData && (len(data) > 0 || len(forms) > 0) {
			method = "POST"
		}
	}
	req := importRequest(importRequestName(method, target), method, target)
	req["auth"], req["params"], req["headers"], req["settings"] = auth, params, headers, settings
	media = defaultString(importContentType(headers), media)
	body = strings.Join(data, "&")
	switch {
	case binary:
		req["bodyType"] = "binary"
	case len(forms) > 0:
		req["bodyType"], req["formRows"] = "form", forms
	case getData && body != "":
		_, rows := importURLQuery("?" + body)
		req["params"] = append(params, rows...)
	case body != "":
		if media == "application/x-www-form-urlencoded" || (media == "" && !rawData && strings.Contains(body, "=")) {
			_, rows := importURLQuery("?" + body)
			req["bodyType"], req["formRows"] = "urlencoded", rows
		} else {
			importSetBody(req, media, body)
			if media == "application/json" && importContentType(headers) == "" {
				req["headers"] = append(headers, importRow("Content-Type", "application/json"))
			}
		}
	}
	importProtocolExtension(req, nil)
	return req, nil
}

func curlShellWords(input string) ([]string, error) {
	var words []string
	var word strings.Builder
	var quote rune
	ansi := false
	inWord, escaped := false, false
	flush := func() {
		if inWord {
			words = append(words, word.String())
			word.Reset()
			inWord = false
		}
	}
	for _, ch := range input {
		if escaped {
			escaped = false
			if ansi {
				if control, ok := map[rune]rune{'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'f': '\f', 'v': '\v', 'a': '\a'}[ch]; ok {
					ch = control
				}
				word.WriteRune(ch)
			} else if ch != '\n' {
				if quote == '"' && !strings.ContainsRune("\\\"$`", ch) {
					word.WriteRune('\\')
				}
				word.WriteRune(ch)
				inWord = true
			}
			continue
		}
		if ch == '\\' && (quote != '\'' || ansi) {
			escaped = true
			continue
		}
		if quote != 0 {
			if ch == quote {
				quote = 0
				ansi = false
			} else {
				word.WriteRune(ch)
			}
			continue
		}
		switch {
		case ch == '\'' || ch == '"':
			quote = ch
			if ch == '\'' && word.String() == "$" {
				word.Reset()
				ansi = true
			}
			inWord = true
		case unicode.IsSpace(ch):
			flush()
		case strings.ContainsRune(";|&><`", ch):
			return nil, fmt.Errorf("paste a single curl command without shell operators and quote special characters in the URL")
		default:
			word.WriteRune(ch)
			inWord = true
		}
	}
	if quote != 0 || escaped {
		return nil, fmt.Errorf("curl command has an unfinished quote or escape")
	}
	flush()
	return words, nil
}

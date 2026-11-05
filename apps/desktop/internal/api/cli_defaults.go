package api

import (
	"strings"
)

func applyCollectionDefaults(req cliSavedRequest, collection *cliCollection) cliSavedRequest {
	if collection == nil {
		if strings.EqualFold(req.Auth.Type, "inherit") {
			req.Auth = cliAuth{Type: "none"}
		}
		return req
	}
	req.WorkspaceID = collection.WorkspaceID
	defaults := collection.Defaults
	folders := folderDefaultsChain(collection, req.FolderPath)

	auth := defaults.Auth
	headers := defaults.Headers
	pre := []string{defaults.PreRequestScript}
	preJs := []string{defaults.PreRequestScriptJs}
	for _, folder := range folders {
		if folder.Auth.Type != "" && !strings.EqualFold(folder.Auth.Type, "inherit") {
			auth = folder.Auth
		}
		headers = mergeDefaultRows(headers, folder.Headers)
		pre = append(pre, folder.PreRequestScript)
		preJs = append(preJs, folder.PreRequestScriptJs)
	}
	tests := []string{req.TestScript}
	testsJs := []string{req.TestScriptJs}
	for i := len(folders) - 1; i >= 0; i-- {
		tests = append(tests, folders[i].TestScript)
		testsJs = append(testsJs, folders[i].TestScriptJs)
	}

	req.Auth = mergeCollectionAuth(auth, req.Auth)
	req.Headers = mergeDefaultRows(headers, req.Headers)
	req.PreRequestScript = joinScripts(append(pre, req.PreRequestScript)...)
	req.TestScript = joinScripts(append(tests, defaults.TestScript)...)
	req.PreRequestScriptJs = joinScripts(append(preJs, req.PreRequestScriptJs)...)
	req.TestScriptJs = joinScripts(append(testsJs, defaults.TestScriptJs)...)
	req.Settings = mergeCollectionSettings(defaults.Settings, req.Settings)
	req.Settings = mergeBrowserSettings(defaults.Settings, req.Settings, req.SettingsOverrides)
	return req
}

func folderDefaultsChain(collection *cliCollection, folderPath []string) []cliFolderDefaults {
	path := make([]string, 0, len(folderPath))
	for _, part := range folderPath {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			path = append(path, trimmed)
		}
	}
	chain := []cliFolderDefaults{}
	for depth := 1; depth <= len(path); depth++ {
		for _, folder := range collection.FolderDefaults {
			if sameFolderPath(folder.Path, path[:depth]) {
				chain = append(chain, folder)
				break
			}
		}
	}
	return chain
}

func sameFolderPath(left, right []string) bool {
	trimmed := make([]string, 0, len(left))
	for _, part := range left {
		if part = strings.TrimSpace(part); part != "" {
			trimmed = append(trimmed, part)
		}
	}
	if len(trimmed) != len(right) {
		return false
	}
	for i := range trimmed {
		if trimmed[i] != right[i] {
			return false
		}
	}
	return true
}

func mergeBrowserSettings(defaults, req cliSettings, overrides map[string]bool) cliSettings {
	ownValue := func(key string, differsFromDefault bool) bool {
		if overrides != nil {
			return overrides[key]
		}
		return differsFromDefault
	}
	if !ownValue("browserEmulation", req.BrowserEmulation) {
		req.BrowserEmulation = defaults.BrowserEmulation
	}
	if !ownValue("browserOrigin", req.BrowserOrigin != "") {
		req.BrowserOrigin = defaults.BrowserOrigin
	}
	if !ownValue("browserWithCredentials", req.BrowserWithCredentials) {
		req.BrowserWithCredentials = defaults.BrowserWithCredentials
	}
	if !ownValue("browserEnforceCORS", req.BrowserEnforceCORS) {
		req.BrowserEnforceCORS = defaults.BrowserEnforceCORS
	}
	if !ownValue("browserEnforceCSP", req.BrowserEnforceCSP) {
		req.BrowserEnforceCSP = defaults.BrowserEnforceCSP
	}
	if !ownValue("browserCSP", req.BrowserCSP != "") {
		req.BrowserCSP = defaults.BrowserCSP
	}
	return req
}

func mergeCollectionAuth(defaultAuth, requestAuth cliAuth) cliAuth {
	if !strings.EqualFold(requestAuth.Type, "inherit") {
		return requestAuth
	}
	if defaultAuth.Type != "" && !strings.EqualFold(defaultAuth.Type, "none") && !strings.EqualFold(defaultAuth.Type, "inherit") {
		return defaultAuth
	}
	return cliAuth{Type: "none"}
}

func mergeDefaultRows(defaultRows, requestRows []cliKV) []cliKV {
	taken := make(map[string]struct{}, len(requestRows))
	for _, row := range requestRows {
		if key := strings.ToLower(strings.TrimSpace(row.Key)); key != "" {
			taken[key] = struct{}{}
		}
	}
	merged := make([]cliKV, 0, len(defaultRows)+len(requestRows))
	for _, row := range defaultRows {
		key := strings.ToLower(strings.TrimSpace(row.Key))
		if key == "" {
			continue
		}
		if _, exists := taken[key]; exists {
			continue
		}
		merged = append(merged, row)
	}
	return append(merged, requestRows...)
}

func mergeCollectionSettings(defaults, req cliSettings) cliSettings {
	if req.HTTPVersion == "" {
		req.HTTPVersion = defaults.HTTPVersion
	}
	if req.EnableSSLVerification == nil {
		req.EnableSSLVerification = defaults.EnableSSLVerification
	}
	if req.FollowRedirects == nil {
		req.FollowRedirects = defaults.FollowRedirects
	}
	if !req.FollowOriginalMethod {
		req.FollowOriginalMethod = defaults.FollowOriginalMethod
	}
	if req.EncodeURLAutomatically == nil {
		req.EncodeURLAutomatically = defaults.EncodeURLAutomatically
	}
	if !req.DisableCookieJar {
		req.DisableCookieJar = defaults.DisableCookieJar
	}
	if req.MaxRedirects == 0 {
		req.MaxRedirects = defaults.MaxRedirects
	}
	if req.TimeoutMs == nil {
		req.TimeoutMs = defaults.TimeoutMs
	}
	if req.ScriptTimeoutMs == 0 {
		req.ScriptTimeoutMs = defaults.ScriptTimeoutMs
	}
	if !req.AllowSendRequest {
		req.AllowSendRequest = defaults.AllowSendRequest
	}
	if req.ProxyURL == "" {
		req.ProxyURL = defaults.ProxyURL
	}
	if req.ClientCertPath == "" {
		req.ClientCertPath = defaults.ClientCertPath
	}
	if req.ClientKeyPath == "" {
		req.ClientKeyPath = defaults.ClientKeyPath
	}
	if req.ClientKeyPassword == "" {
		req.ClientKeyPassword = defaults.ClientKeyPassword
	}
	return req
}

func joinScripts(parts ...string) string {
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			kept = append(kept, trimmed)
		}
	}
	return strings.Join(kept, "\n\n")
}

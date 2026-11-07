package api

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	agentMaxAllowedHosts   = 50
	agentBudgetMaxTokens   = 1_000_000_000
	agentBudgetMaxRequests = 100_000
)

var agentNeverAuto = map[string]bool{
	"git_push":         true,
	"authorize_oauth2": true,
	"start_load_test":  true,
	"clear_cookie_jar": true,
}

func agentNormalizeMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case model.AgentModeAsk:
		return model.AgentModeAsk
	case model.AgentModeAuto:
		return model.AgentModeAuto
	}
	return ""
}

func agentNormalizeHost(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if index := strings.Index(value, "://"); index >= 0 {
		value = value[index+3:]
	}
	if index := strings.IndexAny(value, "/?#"); index >= 0 {
		value = value[:index]
	}
	if index := strings.LastIndex(value, "@"); index >= 0 {
		value = value[index+1:]
	}
	if host, _, err := net.SplitHostPort(value); err == nil {
		value = host
	}
	value = strings.Trim(value, "[]")
	if value == "" || value == "*" || value == "*." || strings.ContainsAny(value, " \t{}") {
		return ""
	}
	if strings.Contains(value[1:], "*") || (strings.HasPrefix(value, "*") && !strings.HasPrefix(value, "*.")) {
		return ""
	}
	return value
}

func agentNormalizeHosts(hosts []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, raw := range hosts {
		for _, part := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '\n' || r == ' ' }) {
			host := agentNormalizeHost(part)
			if host == "" || seen[host] {
				continue
			}
			seen[host] = true
			out = append(out, host)
			if len(out) == agentMaxAllowedHosts {
				return out
			}
		}
	}
	return out
}

func agentHostAllowed(host string, allowed []string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if host == "" {
		return false
	}
	for _, pattern := range allowed {
		if strings.HasPrefix(pattern, "*.") {
			if strings.HasSuffix(host, pattern[1:]) || host == pattern[2:] {
				return true
			}
			continue
		}
		if host == pattern {
			return true
		}
	}
	return false
}

type agentRunTarget struct {
	env   string
	urls  []string
	known bool
}

func agentRunTargets(s *mcpServer, tool string, arguments json.RawMessage) agentRunTarget {
	var args struct {
		Request     string `json:"request"`
		Collection  string `json:"collection"`
		Folder      string `json:"folder"`
		URL         string `json:"url"`
		Environment string `json:"environment"`
		From        string `json:"from"`
	}
	_ = json.Unmarshal(arguments, &args)
	target := agentRunTarget{env: defaultString(strings.TrimSpace(args.Environment), s.opts.env)}
	ws, err := s.loadWorkspace()
	if err != nil {
		return target
	}
	var requests []cliSavedRequest
	switch tool {
	case "send_request":
		target.urls = []string{args.URL}
	case "run_request", "generate_tests":
		req, err := mcpFindRequest(ws.requests, args.Request)
		if err != nil {
			return target
		}
		requests = []cliSavedRequest{req}
	case "run_collection":
		selection := cliOptions{collection: args.Collection}
		for _, segment := range strings.Split(args.Folder, "/") {
			if segment = strings.TrimSpace(segment); segment != "" {
				selection.folder = append(selection.folder, segment)
			}
		}
		requests = selectRequestsForRun(ws.requests, selection, mcpRunnerRunnable)
	default:
		return target
	}
	globals, _ := mcpGlobalValues(s.opts.workspace, s.opts.loadAppSecrets)
	values, _, err := resolveCLIValues(cliOptions{env: target.env}, ws.collections, ws.environments, globals)
	if err != nil {
		return target
	}
	target.urls = append(target.urls, agentResolvedRequestURLs(ws, values, requests)...)
	if tool == "send_request" {
		target.urls = []string{substituteTemplates(args.URL, values)}
	}
	target.known = true
	return target
}

func agentResolvedRequestURLs(ws mcpWorkspace, values map[string]string, requests []cliSavedRequest) []string {
	urls := make([]string, 0, len(requests))
	for _, req := range requests {
		merged := map[string]string{}
		for _, collection := range ws.collections {
			if collection.ID != req.CollectionID {
				continue
			}
			for _, row := range collection.Defaults.Variables {
				if row.Enabled {
					merged[row.Key] = row.Value
				}
			}
		}
		for key, value := range values {
			merged[key] = value
		}
		urls = append(urls, substituteTemplates(req.URL, merged))
	}
	return urls
}

func agentWorkspaceUsesHost(s *mcpServer, env, host string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if host == "" {
		return false
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return false
	}
	matches := func(raw string) bool {
		return strings.Contains(raw, "://") && strings.EqualFold(agentURLHost(raw), host)
	}
	for _, environment := range ws.environments {
		for _, row := range environment.Values {
			if row.Enabled && matches(row.Value) {
				return true
			}
		}
	}
	for _, collection := range ws.collections {
		for _, row := range collection.Defaults.Variables {
			if row.Enabled && matches(row.Value) {
				return true
			}
		}
	}
	globals, _ := mcpGlobalValues(s.opts.workspace, s.opts.loadAppSecrets)
	for _, value := range globals {
		if matches(value) {
			return true
		}
	}
	values, _, err := resolveCLIValues(cliOptions{env: env}, ws.collections, ws.environments, globals)
	if err != nil {
		return false
	}
	for _, raw := range agentResolvedRequestURLs(ws, values, ws.requests) {
		if strings.EqualFold(agentURLHost(raw), host) {
			return true
		}
	}
	return false
}

func agentForeignSend(s *mcpServer, arguments json.RawMessage) (bool, string) {
	target := agentRunTargets(s, "send_request", arguments)
	if !target.known || len(target.urls) == 0 {
		return true, "Kurlo could not resolve the URL of this request to check where it goes."
	}
	host := agentURLHost(target.urls[0])
	if host == "" {
		return true, "Kurlo could not tell which host this request goes to."
	}
	if agentWorkspaceUsesHost(s, target.env, host) {
		return false, ""
	}
	return true, fmt.Sprintf("Sends a request to %s, a host no saved request or variable in this workspace uses.", host)
}

func agentURLHost(raw string) string {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	scheme, rest, _ := strings.Cut(raw, "://")
	if index := strings.IndexAny(rest, "/?#"); index >= 0 {
		rest = rest[:index]
	}
	if rest == "" || strings.Contains(rest, "{{") || strings.Contains(scheme, "{{") {
		return ""
	}
	raw = scheme + "://" + rest
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}

func (s *mcpServer) agentSandboxEnvironment(name string) bool {
	ws, err := s.loadWorkspace()
	if err != nil {
		return false
	}
	env, ok := findEnvironment(ws.environments, name)
	return ok && env.Sandbox && !env.Protected
}

func agentTrustedRun(s *mcpServer, tool string, arguments json.RawMessage, hosts []string) (bool, string) {
	target := agentRunTargets(s, tool, arguments)
	if !target.known {
		return false, ""
	}
	if target.env != "" && s.agentSandboxEnvironment(target.env) {
		return true, "Runs in the sandbox environment " + target.env + "."
	}
	if len(hosts) == 0 || len(target.urls) == 0 {
		return false, ""
	}
	for _, raw := range target.urls {
		if !agentHostAllowed(agentURLHost(raw), hosts) {
			return false, ""
		}
	}
	return true, "Sends only to trusted hosts."
}

func agentBudgetReached(chat model.AgentChat) error {
	loop := agentTurnLoop{priorUsage: chat.Usage, budgetLimit: chat.BudgetTokens}
	if err := loop.budgetError(model.AiUsage{}); err != nil {
		return err
	}
	if chat.BudgetRequests > 0 && chat.RequestsSent >= chat.BudgetRequests {
		return fmt.Errorf("This chat reached its budget of %d sent requests. Raise the budget in Chat details to continue.", chat.BudgetRequests)
	}
	return nil
}

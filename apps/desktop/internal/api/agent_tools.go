package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const agentToolServer = "Kurlo"

var agentReadTools = map[string]bool{
	"list_requests":         true,
	"get_request":           true,
	"list_environments":     true,
	"list_history":          true,
	"get_history_entry":     true,
	"diagnose_last_failure": true,
}

var agentRunTools = map[string]bool{
	"run_request":    true,
	"run_collection": true,
	"send_request":   true,
}

type agentDecision struct {
	kind    string
	ask     bool
	reason  string
	methods []string
}

func agentSafeMethod(method string) bool {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case "", http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return false
}

func agentRequestMethod(req cliSavedRequest) string {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		return http.MethodGet
	}
	return method
}

func agentUnsafeMethods(methods []string) []string {
	seen := map[string]bool{}
	var unsafe []string
	for _, method := range methods {
		method = strings.ToUpper(strings.TrimSpace(method))
		if method == "" {
			method = http.MethodGet
		}
		if agentSafeMethod(method) || seen[method] {
			continue
		}
		seen[method] = true
		unsafe = append(unsafe, method)
	}
	sort.Strings(unsafe)
	return unsafe
}

func agentRunMethods(s *mcpServer, tool string, arguments json.RawMessage) ([]string, error) {
	switch tool {
	case "send_request":
		var args struct {
			Method string `json:"method"`
		}
		_ = json.Unmarshal(arguments, &args)
		return []string{args.Method}, nil
	case "run_request", "generate_tests":
		var args struct {
			Request string `json:"request"`
			From    string `json:"from"`
		}
		_ = json.Unmarshal(arguments, &args)
		if tool == "generate_tests" && !strings.EqualFold(defaultString(strings.TrimSpace(args.From), "run"), "run") {
			return nil, nil
		}
		ws, err := s.loadWorkspace()
		if err != nil {
			return nil, err
		}
		req, err := mcpFindRequest(ws.requests, args.Request)
		if err != nil {
			return nil, nil
		}
		return []string{agentRequestMethod(req)}, nil
	case "run_collection":
		var args struct {
			Collection string `json:"collection"`
			Folder     string `json:"folder"`
		}
		_ = json.Unmarshal(arguments, &args)
		ws, err := s.loadWorkspace()
		if err != nil {
			return nil, err
		}
		selection := cliOptions{collection: args.Collection}
		for _, segment := range strings.Split(args.Folder, "/") {
			if segment = strings.TrimSpace(segment); segment != "" {
				selection.folder = append(selection.folder, segment)
			}
		}
		var methods []string
		for _, req := range selectCLIRequests(ws.requests, selection) {
			methods = append(methods, agentRequestMethod(req))
		}
		return methods, nil
	}
	return nil, nil
}

func agentDecide(s *mcpServer, tool string, arguments json.RawMessage) agentDecision {
	switch {
	case agentReadTools[tool]:
		return agentDecision{kind: model.AgentToolRead}
	case agentRunTools[tool], tool == "generate_tests":
		kind := model.AgentToolRun
		if tool == "generate_tests" {
			kind = model.AgentToolWrite
		}
		methods, err := agentRunMethods(s, tool, arguments)
		if err != nil {
			return agentDecision{kind: kind, ask: true, reason: "Kurlo could not read the workspace to check which methods this call sends."}
		}
		if unsafe := agentUnsafeMethods(methods); len(unsafe) > 0 {
			return agentDecision{kind: kind, ask: true, methods: unsafe, reason: fmt.Sprintf("Sends %s requests, which can change data on the server.", strings.Join(unsafe, ", "))}
		}
		return agentDecision{kind: kind, ask: kind == model.AgentToolWrite}
	}
	return agentDecision{kind: model.AgentToolWrite, ask: true, reason: "Changes the workspace files."}
}

type agentApprover func(ctx context.Context, approval model.AgentApproval) string

type agentToolBridge struct {
	server  *mcpServer
	chatID  string
	approve agentApprover
	onAllow func(tool string)

	mu      sync.Mutex
	allowed map[string]bool
	turnID  string
}

func newAgentToolBridge(opts mcpServerOptions, chatID string, allowed []string) *agentToolBridge {
	server := newMCPServer(opts, io.Discard)
	server.client = model.AgentClientName
	server.chatID = chatID
	bridge := &agentToolBridge{server: server, chatID: chatID, allowed: map[string]bool{}}
	for _, tool := range allowed {
		bridge.allowed[tool] = true
	}
	return bridge
}

func (b *agentToolBridge) isAllowed(tool string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.allowed[tool]
}

func (b *agentToolBridge) allow(tool string) {
	b.mu.Lock()
	b.allowed[tool] = true
	b.mu.Unlock()
	if b.onAllow != nil {
		b.onAllow(tool)
	}
}

func (b *agentToolBridge) setTurn(turnID string) {
	b.mu.Lock()
	b.turnID = turnID
	b.mu.Unlock()
}

func (b *agentToolBridge) currentTurn() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.turnID
}

func (b *agentToolBridge) tools() []aiTool {
	definitions := mcpServerTools(b.server.opts.readOnly)
	tools := make([]aiTool, 0, len(definitions))
	for _, definition := range definitions {
		name, _ := definition["name"].(string)
		description, _ := definition["description"].(string)
		schema, err := json.Marshal(definition["inputSchema"])
		if err != nil {
			schema = nil
		}
		tools = append(tools, aiTool{Original: name, Server: agentToolServer, ServerIndex: -1, Description: description, Schema: schema})
	}
	return tools
}

func (b *agentToolBridge) ask(ctx context.Context, approval model.AgentApproval) error {
	if b.approve == nil {
		return &mcpDeclinedError{message: "This call needs the user's approval, and there is no one to ask."}
	}
	approval.ID = uuid.NewString()
	approval.ChatID = b.chatID
	approval.TurnID = b.currentTurn()
	if approval.Changes == nil {
		approval.Changes = []model.AgentFileChange{}
	}
	decision := b.approve(ctx, approval)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if decision == "expired" {
		return errAgentApprovalExpired
	}
	switch decision {
	case model.AgentApprovalAllowChat:
		b.allow(approval.Tool)
		return nil
	case model.AgentApprovalAllow:
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if approval.Kind == model.AgentToolWrite && len(approval.Changes) > 0 {
		return &mcpDeclinedError{message: "The user declined this change, so nothing was written. Ask what they want changed before trying again."}
	}
	return &mcpDeclinedError{message: "The user declined this call, so it did not run. Ask what they want instead."}
}

func (b *agentToolBridge) call(ctx context.Context, tool aiTool, input, toolUseID string) (string, bool) {
	arguments := aiInputObject(input)
	params, err := json.Marshal(map[string]any{"name": tool.Original, "arguments": arguments})
	if err != nil {
		return err.Error(), true
	}
	gated := false
	ctx = withMcpGate(ctx, func(name string, args json.RawMessage) error {
		if b.isAllowed(name) {
			return nil
		}
		decision := agentDecide(b.server, name, args)
		if !decision.ask || (decision.kind == model.AgentToolWrite && len(decision.methods) == 0) {
			return nil
		}
		gated = true
		return b.ask(ctx, model.AgentApproval{ToolUseID: toolUseID, Tool: name, Kind: decision.kind, Arguments: string(args), Reason: decision.reason})
	})
	ctx = withMcpReview(ctx, func(changes []model.AgentFileChange) error {
		if b.isAllowed(tool.Original) {
			return nil
		}
		reason := "Changes the workspace files."
		if gated {
			reason = "Writes these changes to the workspace files."
		}
		return b.ask(ctx, model.AgentApproval{ToolUseID: toolUseID, Tool: tool.Original, Kind: model.AgentToolWrite, Arguments: string(arguments), Reason: reason, Changes: changes})
	})
	result, err := b.server.callTool(ctx, params)
	if err != nil {
		if ctx.Err() != nil {
			return "Cancelled before the tool finished.", true
		}
		return err.Error(), true
	}
	return mcpResultPlainText(result)
}

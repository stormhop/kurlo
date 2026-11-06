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
	"list_globals":          true,
	"list_history":          true,
	"get_history_entry":     true,
	"diagnose_last_failure": true,
	"git_status":            true,
	"git_diff":              true,
	"pull_request_url":      true,
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
	changes []model.AgentFileChange
	trusted string
	auto    bool
}

func mcpParallelTool(name string) bool {
	if agentReadTools[name] {
		return true
	}
	tool, ok := executionTools[name]
	return ok && tool.kind == model.AgentToolRead && !tool.live && !tool.write && name != "import_preview"
}

func (b *agentToolBridge) parallel(name string) bool {
	return mcpParallelTool(name)
}

func agentSafeMethod(method string) bool {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case "", http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return false
}

func agentRequestMethod(req cliSavedRequest) string {
	if isGraphQLRequest(req) {
		return http.MethodPost
	}
	if mcpRequestType(req) == "grpc" {
		return "GRPC"
	}
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
		switch mcpRequestType(req) {
		case "grpc", "mcp", "ai":
			return []string{strings.ToUpper(mcpRequestType(req))}, nil
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
		for _, req := range selectRequestsForRun(ws.requests, selection, mcpRunnerRunnable) {
			methods = append(methods, agentRequestMethod(req))
		}
		return methods, nil
	}
	return nil, nil
}

func agentDecide(s *mcpServer, tool string, arguments json.RawMessage) agentDecision {
	if tool == "import_preview" {
		var args mcpImportArgs
		_ = json.Unmarshal(arguments, &args)
		if args.ImportID == "" && args.URL != "" {
			return agentDecision{kind: model.AgentToolExternal, ask: true, reason: "Fetches the OpenAPI document from the supplied URL."}
		}
	}
	if entry, ok := executionTools[tool]; ok {
		return agentDecision{kind: entry.kind, ask: entry.reason != "", reason: entry.reason}
	}
	switch {
	case tool == "authorize_oauth2":
		return agentDecision{kind: model.AgentToolExternal, ask: true, reason: "Contacts the configured OAuth provider and may open a sign-in page."}
	case agentReadTools[tool]:
		return agentDecision{kind: model.AgentToolRead}
	case mcpGitWriteToolNames[tool]:
		return agentDecideGit(s, tool, arguments)
	case agentRunTools[tool], tool == "generate_tests":
		kind := model.AgentToolRun
		if tool == "generate_tests" {
			kind = model.AgentToolWrite
		}
		methods, err := agentRunMethods(s, tool, arguments)
		if err != nil {
			return agentDecision{kind: kind, ask: true, reason: "Kurlo could not read the workspace to check which methods this call sends."}
		}
		if tool == "run_request" && len(methods) == 1 {
			switch methods[0] {
			case "AI", "MCP", "GRPC":
				return agentDecision{kind: model.AgentToolExternal, ask: true, reason: fmt.Sprintf("Runs the saved %s request and contacts its configured server.", methods[0])}
			}
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

	mu        sync.Mutex
	allowed   map[string]bool
	turnID    string
	ownBranch bool
	branch    string
	chatTitle string
	onBranch  func(branch string)

	mode           string
	hosts          []string
	budgetRequests int
	requestsBase   int
	requestsSent   int
	plan           []*agentPlanGrant
	external       map[string]agentExternalTool
	externalDefs   []aiTool
}

func newAgentToolBridge(opts mcpServerOptions, chatID string, allowed []string) *agentToolBridge {
	server := newMCPServer(opts, io.Discard)
	server.client = model.AgentClientName
	server.chatID = chatID
	bridge := &agentToolBridge{server: server, chatID: chatID, allowed: map[string]bool{}}
	for _, tool := range allowed {
		bridge.allowed[tool] = true
	}
	server.afterWrite = bridge.commitOwnBranch
	return bridge
}

func (b *agentToolBridge) setChat(chat model.AgentChat, onBranch func(string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onBranch = onBranch
	b.ownBranch = chat.OwnBranch
	b.chatTitle = chat.Title
	b.mode = agentNormalizeMode(chat.Mode)
	b.hosts = agentNormalizeHosts(chat.AllowedHosts)
	b.budgetRequests = chat.BudgetRequests
	b.requestsBase = chat.RequestsSent
	b.requestsSent = 0
	if chat.Branch != "" {
		b.branch = chat.Branch
	}
}

func (b *agentToolBridge) commitOwnBranch(tool string, record *mcpCallRecord) string {
	b.mu.Lock()
	enabled := b.ownBranch
	branch := b.branch
	title := b.chatTitle
	b.mu.Unlock()
	if !enabled {
		return ""
	}
	if branch == "" {
		branch = agentBranchName(b.chatID, title)
	}
	root := b.server.opts.workspace
	gitOperationMu.Lock()
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		gitOperationMu.Unlock()
		return "Not committed to the agent branch: " + err.Error()
	}
	result, err := commitAgentChanges(root, branch, tool, title, record.changes)
	unlock()
	gitOperationMu.Unlock()
	if err != nil {
		return "Not committed to the agent branch: " + err.Error()
	}
	if result.Commit == "" {
		return ""
	}
	record.commit = result.Commit
	record.branch = result.Branch
	b.mu.Lock()
	changed := b.branch != result.Branch
	b.branch = result.Branch
	onBranch := b.onBranch
	b.mu.Unlock()
	if changed && onBranch != nil {
		onBranch(result.Branch)
	}
	return fmt.Sprintf("Committed as %s on branch %s.", result.Commit, result.Branch)
}

func agentAllowsChatApproval(tool string) bool {
	return tool != agentNotesTool && tool != agentPlanTool && tool != "apply_changes" && tool != "authorize_oauth2" && tool != "git_push" && tool != "clear_cookie_jar" && tool != "start_load_test" && tool != "open_session" && tool != "import_apply" && tool != "import_preview"
}

func agentDecideGit(s *mcpServer, tool string, arguments json.RawMessage) agentDecision {
	status := gitStatusForWorkspace(s.opts.workspace)
	branch := defaultString(strings.TrimSpace(status.Branch), "the current branch")
	switch tool {
	case "git_create_branch":
		var args struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(arguments, &args)
		return agentDecision{kind: model.AgentToolWrite, ask: true, reason: fmt.Sprintf("Creates branch %s from %s and switches the workspace to it.", strings.TrimSpace(args.Name), branch)}
	case "git_commit":
		var args struct {
			Message string   `json:"message"`
			Paths   []string `json:"paths"`
		}
		_ = json.Unmarshal(arguments, &args)
		changes, err := gitCommitPreview(s.opts.workspace, args.Paths)
		if err != nil {
			return agentDecision{kind: model.AgentToolWrite, ask: true, reason: fmt.Sprintf("Commits workspace files on %s.", branch)}
		}
		subject, _, _ := strings.Cut(strings.TrimSpace(args.Message), "\n")
		return agentDecision{kind: model.AgentToolWrite, ask: true, changes: changes, reason: fmt.Sprintf("Commits %d %s on %s: %s", len(changes), agentPlural(len(changes), "file", "files"), branch, subject)}
	}
	var args struct {
		Remote string `json:"remote"`
	}
	_ = json.Unmarshal(arguments, &args)
	remote := defaultString(strings.TrimSpace(args.Remote), gitPushRemote(status))
	return agentDecision{kind: model.AgentToolExternal, ask: true, reason: fmt.Sprintf("Pushes %s to %s. Everyone with access to %s sees these commits.", branch, remote, remote)}
}

func agentPlural(count int, one, many string) string {
	if count == 1 {
		return one
	}
	return many
}

func (b *agentToolBridge) isAllowed(tool string) bool {
	if !agentAllowsChatApproval(tool) {
		return false
	}
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

func (b *agentToolBridge) policy() (string, []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.mode, append([]string(nil), b.hosts...)
}

func (b *agentToolBridge) takeRequestsSent() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	sent := b.requestsSent
	b.requestsBase += sent
	b.requestsSent = 0
	return sent
}

func (b *agentToolBridge) reserveRequests(count int) error {
	if count <= 0 {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.budgetRequests > 0 && b.requestsBase+b.requestsSent+count > b.budgetRequests {
		return &mcpDeclinedError{message: fmt.Sprintf("This chat reached its budget of %d sent requests (%d sent so far), so the call did not run. Tell the user; they can raise the budget in Chat details.", b.budgetRequests, b.requestsBase+b.requestsSent)}
	}
	b.requestsSent += count
	return nil
}

func agentAutoWrites(tool string) bool {
	return !agentNeverAuto[tool]
}

func (b *agentToolBridge) decide(name string, arguments json.RawMessage) agentDecision {
	decision := agentDecide(b.server, name, arguments)
	mode, hosts := b.policy()
	if decision.ask && len(decision.methods) > 0 && mode != model.AgentModeAsk {
		if trusted, reason := agentTrustedRun(b.server, name, arguments, hosts); trusted {
			decision.methods = nil
			decision.trusted = reason
			if decision.kind == model.AgentToolRun {
				decision.ask = false
			}
		}
	}
	switch mode {
	case model.AgentModeAsk:
		if decision.kind == model.AgentToolRun && !decision.ask {
			decision.ask = true
			decision.reason = "This chat asks before every request it sends."
		}
	case model.AgentModeAuto:
		if decision.kind == model.AgentToolWrite && len(decision.methods) == 0 && agentAutoWrites(name) {
			decision.ask = false
			decision.auto = true
		}
	}
	return decision
}

func (b *agentToolBridge) autoWrites(tool string) bool {
	mode, _ := b.policy()
	return mode == model.AgentModeAuto && agentAutoWrites(tool)
}

func (b *agentToolBridge) setTurn(turnID string) {
	b.mu.Lock()
	b.turnID = turnID
	b.plan = nil
	b.mu.Unlock()
}

func (b *agentToolBridge) currentTurn() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.turnID
}

func agentRequestCount(s *mcpServer, tool string, arguments json.RawMessage) int {
	switch tool {
	case "send_request", "run_request":
		return 1
	case "generate_tests":
		var args struct {
			From string `json:"from"`
		}
		_ = json.Unmarshal(arguments, &args)
		if strings.EqualFold(defaultString(strings.TrimSpace(args.From), "run"), "run") {
			return 1
		}
	case "run_collection":
		methods, _ := agentRunMethods(s, tool, arguments)
		var args struct {
			Iterations int `json:"iterations"`
		}
		_ = json.Unmarshal(arguments, &args)
		return len(methods) * max(args.Iterations, 1)
	}
	return 0
}

func (b *agentToolBridge) toolDefinitions() []map[string]any {
	definitions := append(mcpServerTools(b.server.opts.readOnly), executionToolDefinitions(b.server.opts.readOnly, true)...)
	definitions = append(definitions, agentPlanDefinition())
	if !b.server.opts.readOnly {
		definitions = append(definitions, agentNotesDefinition())
	}
	return definitions
}

func (b *agentToolBridge) setExternal(tools map[string]agentExternalTool, defs []aiTool) {
	b.mu.Lock()
	b.external = tools
	b.externalDefs = defs
	b.mu.Unlock()
}

func (b *agentToolBridge) externalTool(original string) (agentExternalTool, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	tool, ok := b.external[original]
	return tool, ok
}

func (b *agentToolBridge) tools() []aiTool {
	definitions := b.toolDefinitions()
	b.mu.Lock()
	external := append([]aiTool(nil), b.externalDefs...)
	b.mu.Unlock()
	tools := make([]aiTool, 0, len(definitions)+len(external))
	tools = append(tools, external...)
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
		if (approval.Kind != model.AgentToolExternal || approval.External) && agentAllowsChatApproval(approval.Tool) {
			b.allow(approval.Tool)
		}
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
	if external, ok := b.externalTool(tool.Original); ok && tool.Server != agentToolServer {
		return b.callExternal(ctx, external, input, toolUseID)
	}
	switch tool.Original {
	case agentPlanTool:
		return b.proposePlan(ctx, input, toolUseID)
	case agentNotesTool:
		return b.updateAgentNotes(ctx, input, toolUseID)
	}
	arguments := aiInputObject(input)
	params, err := json.Marshal(map[string]any{"name": tool.Original, "arguments": arguments})
	if err != nil {
		return err.Error(), true
	}
	gated := false
	planned := false
	ctx = withMcpGate(ctx, func(name string, args json.RawMessage) error {
		if name != "run_request" && b.isAllowed(name) {
			return b.reserveRequests(agentRequestCount(b.server, name, args))
		}
		decision := b.decide(name, args)
		if name == "run_request" && decision.kind != model.AgentToolExternal && b.isAllowed(name) {
			return b.reserveRequests(agentRequestCount(b.server, name, args))
		}
		if !decision.ask || (decision.kind == model.AgentToolWrite && len(decision.methods) == 0 && mcpWriteToolNames[name]) {
			return b.reserveRequests(agentRequestCount(b.server, name, args))
		}
		if decision.kind != model.AgentToolExternal && b.planCovers(name, args) {
			planned = true
			return b.reserveRequests(agentRequestCount(b.server, name, args))
		}
		gated = true
		if err := b.ask(ctx, model.AgentApproval{ToolUseID: toolUseID, Tool: name, Kind: decision.kind, Arguments: string(args), Reason: decision.reason, Changes: decision.changes}); err != nil {
			return err
		}
		return b.reserveRequests(agentRequestCount(b.server, name, args))
	})
	ctx = withMcpReview(ctx, func(changes []model.AgentFileChange) error {
		if planned || b.isAllowed(tool.Original) || b.autoWrites(tool.Original) {
			return nil
		}
		if !gated && b.planCovers(tool.Original, arguments) {
			return nil
		}
		reason := "Changes the workspace files."
		if tool.Original == "apply_changes" || tool.Original == "import_apply" {
			reason = "Review all changes in this batch."
		} else if gated {
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

package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const agentCancelPrefix = "agent:"
const agentTurnCancelPrefix = "agent-turn:"

var errAgentApprovalExpired = errors.New("Approval expired after 30 minutes without a response. The turn was stopped without running the tool. Retry when you are ready.")

func agentContextError(ctx context.Context) string {
	if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) {
		return cause.Error()
	}
	return "Cancelled"
}

const (
	agentFullTurns           = 2
	agentOldToolResultTokens = 500
)

type agentPendingApproval struct {
	approval model.AgentApproval
	answer   chan string
	answered bool
}

type agentRuntime struct {
	app                 *App
	openOAuthBrowser    func(string) error
	onOAuthDevicePrompt func(model.OAuth2DevicePrompt)
	mu                  sync.Mutex
	bridges             map[string]*agentToolBridge
	running             map[string]bool
	approvals           map[string]*agentPendingApproval
	codexLogin          *codexLogin
	approvalTimeout     time.Duration
	codexIdleTimeout    time.Duration
	mcpClients          map[string]*agentMcpCached
}

func newAgentRuntime() *agentRuntime {
	return &agentRuntime{
		bridges:          map[string]*agentToolBridge{},
		approvalTimeout:  30 * time.Minute,
		codexIdleTimeout: aiDefaultIdleTimeout,
		running:          map[string]bool{},
		approvals:        map[string]*agentPendingApproval{},
	}
}

func (rt *agentRuntime) begin(chatID string) bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.running[chatID] {
		return false
	}
	rt.running[chatID] = true
	return true
}

func (rt *agentRuntime) end(chatID string) {
	rt.mu.Lock()
	delete(rt.running, chatID)
	delete(rt.bridges, chatID)
	rt.mu.Unlock()
}

func (rt *agentRuntime) bridge(chat model.AgentChat, root string) *agentToolBridge {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	bridge := rt.bridges[chat.ID]
	if bridge == nil || !sameWorkspaceRoot(bridge.server.opts.workspace, root) {
		bridge = newAgentToolBridge(mcpServerOptions{workspace: root, loadAppSecrets: true}, chat.ID, chat.AllowedTools)
		if rt.app != nil {
			if rt.app.mock != nil {
				bridge.server.executionApp = rt.app
			}
			if rt.app.cookieJars != nil {
				bridge.server.jars = rt.app.cookieJars
			}
		}
		bridge.server.onWrite = noteAgentWorkspaceWrite
		bridge.server.openOAuthBrowser = rt.openOAuthBrowser
		bridge.server.onOAuthDevicePrompt = rt.onOAuthDevicePrompt
		rt.bridges[chat.ID] = bridge
	}
	bridge.server.opts.env = strings.TrimSpace(chat.Environment)
	bridge.server.opts.projectRoot = chat.ProjectRoot
	bridge.server.opts.workspaceID = strings.TrimSpace(chat.WorkspaceID)
	chatID := chat.ID
	bridge.setChat(chat, func(branch string) {
		_, _ = updateAgentChat(chatID, func(saved *model.AgentChat) { saved.Branch = branch })
	})
	return bridge
}

func (rt *agentRuntime) forget(chatID string) {
	rt.mu.Lock()
	delete(rt.bridges, chatID)
	rt.mu.Unlock()
}

func (rt *agentRuntime) approve(emit aiEmitter, cancelTurn ...context.CancelCauseFunc) agentApprover {
	return func(ctx context.Context, approval model.AgentApproval) string {
		if ctx.Err() != nil {
			return model.AgentApprovalReject
		}
		timeout := rt.approvalTimeout
		if timeout <= 0 {
			timeout = 30 * time.Minute
		}
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		pending := &agentPendingApproval{approval: approval, answer: make(chan string, 1)}
		rt.mu.Lock()
		rt.approvals[approval.ID] = pending
		rt.mu.Unlock()
		if emit != nil {
			emit("agent:approval", approval)
		}
		decision := model.AgentApprovalReject
		select {
		case answer := <-pending.answer:
			decision = answer
		case <-ctx.Done():
		case <-timer.C:
			decision = "expired"
			if len(cancelTurn) > 0 {
				cancelTurn[0](errAgentApprovalExpired)
			}
		}
		rt.mu.Lock()
		delete(rt.approvals, approval.ID)
		rt.mu.Unlock()
		if emit != nil {
			emit("agent:approval-closed", model.AgentApprovalClosed{ID: approval.ID, ChatID: approval.ChatID, Decision: decision})
		}
		return decision
	}
}

func (rt *agentRuntime) answer(id, decision string) error {
	switch decision {
	case model.AgentApprovalAllow, model.AgentApprovalAllowChat, model.AgentApprovalReject:
	default:
		return fmt.Errorf("unknown decision %q", decision)
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	pending := rt.approvals[id]
	if pending == nil || pending.answered {
		return errors.New("this approval is no longer waiting")
	}
	pending.answered = true
	pending.answer <- decision
	return nil
}

func (rt *agentRuntime) pending(chatID string) []model.AgentApproval {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	out := []model.AgentApproval{}
	for _, pending := range rt.approvals {
		if chatID == "" || pending.approval.ChatID == chatID {
			out = append(out, pending.approval)
		}
	}
	return out
}

func noteAgentWorkspaceWrite(root string, changes []model.AgentFileChange) {
	files := make(map[string]string, len(changes))
	for _, change := range changes {
		switch {
		case change.TooLarge:
			data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(change.Path)))
			if err != nil {
				files[change.Path] = workspaceAgentDeletedMark
				continue
			}
			files[change.Path] = contentHash(data)
		case change.After == nil:
			files[change.Path] = workspaceAgentDeletedMark
		default:
			files[change.Path] = contentHash([]byte(*change.After))
		}
	}
	workspaceDisk.noteAgentWrite(root, files)
}

func agentCloseToolUses(messages []model.AiMessage) []model.AiMessage {
	if len(messages) == 0 {
		return messages
	}
	last := messages[len(messages)-1]
	if last.Role != "assistant" {
		return messages
	}
	var results []model.AiBlock
	for _, block := range last.Blocks {
		if block.Type == model.AiBlockToolUse {
			results = append(results, model.AiBlock{Type: model.AiBlockToolResult, ID: block.ID, Name: block.Name, Text: "Stopped before the tool ran.", IsError: true})
		}
	}
	if len(results) == 0 {
		return messages
	}
	return append(messages, model.AiMessage{Role: "tool", Blocks: results})
}

func agentTrimText(text string, tokens int) string {
	limit := tokens * 4
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + fmt.Sprintf("\n[trimmed: about %d more tokens from an earlier turn; call the tool again if you need them]", agentEstimateTokens(text[cut:]))
}

func agentHistoryForModel(messages []model.AiMessage, budget int) ([]model.AiMessage, bool) {
	var starts []int
	for index, message := range messages {
		if message.Role == "user" {
			starts = append(starts, index)
		}
	}
	recent := 0
	if len(starts) > agentFullTurns {
		recent = starts[len(starts)-agentFullTurns]
	}
	out := make([]model.AiMessage, 0, len(messages))
	for index, message := range messages {
		if message.Role == "user" && len(message.Attachments) > 0 && len(message.Blocks) == 1 && message.Blocks[0].Type == model.AiBlockText {
			message.Blocks = append([]model.AiBlock(nil), message.Blocks...)
			message.Blocks[0].Text = agentAttachmentPrompt(message.Blocks[0].Text, message.Attachments)
			message.Attachments = nil
		}
		if index >= recent {
			out = append(out, message)
			continue
		}
		blocks := make([]model.AiBlock, 0, len(message.Blocks))
		for _, block := range message.Blocks {
			switch block.Type {
			case model.AiBlockThinking, model.AiBlockRedacted:
				continue
			case model.AiBlockToolResult:
				block.Text = agentTrimText(block.Text, agentOldToolResultTokens)
			}
			blocks = append(blocks, block)
		}
		if len(blocks) == 0 {
			continue
		}
		out = append(out, model.AiMessage{Role: message.Role, Blocks: blocks})
	}
	if budget <= 0 {
		budget = agentContextBudget(agentDefaultContextTokens)
	}
	total := agentMessagesTokens(out)
	dropped := false
	for total > budget {
		next := -1
		for index := 1; index < len(out); index++ {
			if out[index].Role == "user" {
				next = index
				break
			}
		}
		if next < 0 {
			break
		}
		total -= agentMessagesTokens(out[:next])
		out = out[next:]
		dropped = true
	}
	return out, dropped
}

func agentConnection(id string) (savedAiConnection, error) {
	if strings.TrimSpace(id) == "" {
		return defaultSavedAiConnection()
	}
	connection, err := findSavedAiConnection(id)
	if errors.Is(err, errAiConnectionNotFound) {
		return connection, errors.New("This chat's AI connection was removed; choose another one in Settings → AI")
	}
	return connection, err
}

func agentTurnError(chat model.AgentChat, message string) model.AgentTurn {
	return normalizeAgentTurn(model.AgentTurn{Chat: chat, Error: message})
}

func normalizeAgentTurn(turn model.AgentTurn) model.AgentTurn {
	turn.Chat = agentChatPage(turn.Chat, -1)
	if turn.Messages == nil {
		turn.Messages = []model.AiMessage{}
	}
	if turn.Steps == nil {
		turn.Steps = []model.AiStep{}
	}
	for i := range turn.Steps {
		turn.Steps[i] = model.NormalizeAiStep(turn.Steps[i])
	}
	if turn.Warnings == nil {
		turn.Warnings = []string{}
	}
	return turn
}

func (a *App) agentRuntime() *agentRuntime {
	a.agentOnce.Do(func() {
		if a.agent == nil {
			a.agent = newAgentRuntime()
		}
		a.agent.app = a
		if a.ctx != nil {
			a.agent.openOAuthBrowser = a.openAuthorizeURL
			a.agent.onOAuthDevicePrompt = func(prompt model.OAuth2DevicePrompt) {
				go func() {
					_, _ = runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
						Type:    runtime.InfoDialog,
						Title:   "OAuth 2.0 device sign-in",
						Message: fmt.Sprintf("Enter the code %s at %s to authorize the agent request.", prompt.UserCode, prompt.VerificationURI),
					})
				}()
			}
		}
	})
	return a.agent
}

func (a *App) agentEmitter() aiEmitter {
	if a.agentEmit != nil {
		return a.agentEmit
	}
	return a.aiEventEmitter()
}

func (a *App) AgentChats(workspaceID string) []model.AgentChatSummary {
	chats, err := listAgentChats(agentWorkspaceKey(fileWorkspaceStorePath()), time.Now())
	if err != nil || chats == nil {
		return []model.AgentChatSummary{}
	}
	visible := []model.AgentChatSummary{}
	for _, chat := range chats {
		if chat.WorkspaceID == workspaceID {
			visible = append(visible, chat)
		}
	}
	return visible
}

func (a *App) AgentChat(id string) (model.AgentChat, error) {
	return loadAgentChat(id)
}

func (a *App) DeleteAgentChat(id string) model.AgentResult {
	a.StopAgent(id)
	if err := deleteAgentChat(id); err != nil {
		return model.AgentResult{Error: err.Error()}
	}
	a.agentRuntime().forget(id)
	return model.AgentResult{Ok: true}
}

func (a *App) RenameAgentChat(id, title string) model.AgentResult {
	if _, err := renameAgentChat(id, title); err != nil {
		return model.AgentResult{Error: err.Error()}
	}
	return model.AgentResult{Ok: true}
}

func (a *App) StopAgentTurn(turnID string) {
	if turnID != "" {
		a.CancelRequest(agentTurnCancelPrefix + turnID)
	}
}

func (a *App) StopAgent(chatID string) {
	a.CancelRequest(agentCancelPrefix + chatID)
}

func (a *App) AnswerAgentApproval(id, decision string) model.AgentResult {
	if err := a.agentRuntime().answer(id, decision); err != nil {
		return model.AgentResult{Error: err.Error()}
	}
	return model.AgentResult{Ok: true}
}

func (a *App) AgentPendingApprovals(chatID string) []model.AgentApproval {
	return a.agentRuntime().pending(chatID)
}

func (a *App) SendAgentMessage(input model.AgentSendInput) model.AgentTurn {
	if input.Driver == "codex" || input.Driver == "claude-code" {
		return a.sendExternalAgentMessage(input)
	}
	if input.Driver != "" {
		return agentTurnError(model.AgentChat{}, "Unknown agent type.")
	}
	text := strings.TrimSpace(input.Text)
	if text == "" {
		return agentTurnError(model.AgentChat{}, "Write a message first.")
	}
	if utf8.RuneCountInString(text) > model.AiMaxPromptChars {
		return agentTurnError(model.AgentChat{}, fmt.Sprintf("The message is longer than %d characters. Shorten it before sending.", model.AiMaxPromptChars))
	}
	files, err := loadAgentAttachments(input.Attachments)
	if err != nil {
		return agentTurnError(model.AgentChat{}, err.Error())
	}
	var projectRoot string
	if input.ProjectRoot != nil {
		projectRoot, err = agentProjectRoot(*input.ProjectRoot)
		if err != nil {
			return agentTurnError(model.AgentChat{}, err.Error())
		}
	}
	root := fileWorkspaceStorePath()
	workspaceDisk.ensureTracking(root)
	workspace := agentWorkspaceKey(root)
	userMessage := newAgentUserMessage(text, files)
	applyInput := func(chat *model.AgentChat) {
		if input.ProjectRoot != nil {
			chat.ProjectRoot = projectRoot
		}
		chat.Collection = strings.TrimSpace(input.Collection)
		chat.Environment = strings.TrimSpace(input.Environment)
		chat.ConnectionID = strings.TrimSpace(input.ConnectionID)
		chat.Model = strings.TrimSpace(input.Model)
		chat.OwnBranch = input.OwnBranch
		chat.Mode = agentNormalizeMode(input.Mode)
		chat.AllowedHosts = agentNormalizeHosts(input.AllowedHosts)
		chat.BudgetTokens = min(max(input.BudgetTokens, 0), agentBudgetMaxTokens)
		chat.BudgetRequests = min(max(input.BudgetRequests, 0), agentBudgetMaxRequests)
	}

	var chat model.AgentChat
	chatID := strings.TrimSpace(input.ChatID)
	if chatID == "" {
		chat = model.AgentChat{ID: uuid.NewString(), Title: agentChatTitle(text), Workspace: workspace, WorkspaceID: strings.TrimSpace(input.WorkspaceID)}
		applyInput(&chat)
		chat.Messages = []model.AiMessage{userMessage}
		if !a.agentRuntime().begin(chat.ID) {
			return agentTurnError(chat, "The agent is still working in this chat.")
		}
		defer a.agentRuntime().end(chat.ID)
		if chat, err = createAgentChat(chat, files...); err != nil {
			return agentTurnError(chat, "Kurlo could not save the chat: "+err.Error())
		}
	} else {
		existing, err := loadAgentChat(chatID)
		if err != nil {
			return agentTurnError(model.AgentChat{ID: chatID}, err.Error())
		}
		if existing.Driver != "" {
			return agentTurnError(existing, "Open this chat in Your agents.")
		}
		if existing.Workspace != workspace || existing.WorkspaceID != strings.TrimSpace(input.WorkspaceID) {
			return agentTurnError(existing, "This chat belongs to another workspace. Open that workspace to continue it.")
		}
		if !a.agentRuntime().begin(chatID) {
			return agentTurnError(existing, "The agent is still working in this chat. Stop it or wait for it to finish.")
		}
		defer a.agentRuntime().end(chatID)
		if input.EditFrom != nil {
			if err := agentCheckEditIndex(existing, *input.EditFrom); err != nil {
				return agentTurnError(existing, err.Error())
			}
		}
		if chat, err = updateAgentChat(chatID, func(chat *model.AgentChat) {
			applyInput(chat)
			if chat.Title == "" {
				chat.Title = agentChatTitle(text)
			}
			if input.EditFrom != nil && agentCheckEditIndex(*chat, *input.EditFrom) == nil {
				chat.Messages = chat.Messages[:*input.EditFrom]
			}
			chat.Messages = append(chat.Messages, userMessage)
		}, files...); err != nil {
			return agentTurnError(existing, "Kurlo could not save the chat: "+err.Error())
		}
	}

	connection, err := agentConnection(chat.ConnectionID)
	if err != nil {
		return agentTurnError(chat, err.Error())
	}
	if err := agentBudgetReached(chat); err != nil {
		return agentTurnError(chat, err.Error())
	}
	turnID := strings.TrimSpace(input.TurnID)
	if turnID == "" {
		turnID = uuid.NewString()
	}
	req := model.AiRequest{
		HTTP:     model.HttpRequest{RequestID: chat.ID, Method: "POST"},
		Model:    chat.Model,
		Settings: model.AiSettings{Stream: true, CachePrompt: true},
		MaxSteps: aiMaxSteps,
		TurnID:   turnID,
	}
	req, key, err := resolveAiConnectionRequest(req, connection)
	if err != nil {
		return agentTurnError(chat, err.Error())
	}

	rt := a.agentRuntime()
	emit := a.agentEmitter()
	bridge := rt.bridge(chat, root)
	bridge.server.attachments = files
	bridge.setTurn(turnID)
	bridge.onAllow = func(tool string) {
		_, _ = updateAgentChat(chat.ID, func(chat *model.AgentChat) {
			for _, existing := range chat.AllowedTools {
				if existing == tool {
					return
				}
			}
			chat.AllowedTools = append(chat.AllowedTools, tool)
		})
	}
	req.System = agentSystemPrompt(bridge.server, chat)
	window := agentContextWindow(connection, req.HTTP.URL, req.Model)
	fixed := agentEstimateTokens(req.System) + agentToolsTokens(bridge.tools())
	history, dropped := agentHistoryForModel(chat.Messages, agentContextBudget(window)-fixed)
	if images := agentImageBlocks(files); len(images) > 0 && len(history) > 0 {
		last := &history[len(history)-1]
		last.Blocks = append(append([]model.AiBlock(nil), last.Blocks...), images...)
	}
	req.Messages = history
	if dropped {
		req.System += "\n\nThe oldest messages of this chat were left out to fit the model's context. If the user refers to something you cannot see, ask them."
	}
	loop := &agentTurnLoop{chatID: chat.ID, turnID: turnID, window: window, budget: agentContextBudget(window), fixedTokens: fixed, priorUsage: chat.Usage, budgetLimit: chat.BudgetTokens, emit: emit}

	baseCtx := context.Background()
	if a.ctx != nil {
		baseCtx = a.ctx
	}
	ctx, cancel := context.WithCancelCause(baseCtx)
	bridge.server.live = newAgentLiveSessions(ctx, bridge.server.jars)
	defer bridge.server.live.close()
	externalTools, externalDefs, externalWarnings := rt.externalTools(ctx)
	bridge.setExternal(externalTools, externalDefs)
	if len(externalDefs) > 0 {
		extra := "\n\n" + agentExternalPrompt(externalDefs)
		req.System += extra
		loop.fixedTokens += agentEstimateTokens(extra) + agentToolsTokens(externalDefs)
	}
	bridge.approve = rt.approve(emit, cancel)
	stop := func() { cancel(context.Canceled) }
	turnKey := agentTurnCancelPrefix + turnID
	turnSeq := a.registerRequestCancel(turnKey, stop)
	defer a.unregisterRequestCancel(turnKey, turnSeq)
	cancelKey := agentCancelPrefix + chat.ID
	seq := a.registerRequestCancel(cancelKey, stop)
	defer func() {
		stop()
		a.unregisterRequestCancel(cancelKey, seq)
	}()

	if emit != nil {
		emit("ai:deltas", model.AiDeltaBatch{SessionID: chat.ID, TurnID: turnID, Deltas: []model.AiDeltaEvent{}, Attachments: userMessage.Attachments})
	}
	runner := aiRunner{
		ctx:      ctx,
		req:      req,
		provider: aiProviderFor(req.Provider),
		emit:     emit,
		send: func(stepCtx context.Context, prepared model.HttpRequest, sink responseBodySinkFactory) model.HttpResponse {
			return sendRequestWithBodySink(stepCtx, prepared, a.state, a.cookieJars, a.preflightCache, sink)
		},
		local:   bridge,
		now:     time.Now,
		prepare: loop.prepare,
	}
	out := redactAiResponseKey(model.NormalizeAiResponse(runner.run()), key)
	out.Warnings = append(externalWarnings, out.Warnings...)
	if loop.compactions > 0 {
		out.Warnings = append(out.Warnings, fmt.Sprintf("Kurlo shortened %d older tool %s in this turn to fit the model's context.", loop.compactions, agentPlural(loop.compactions, "result", "results")))
	}
	if ctx.Err() != nil {
		out.Error = agentContextError(ctx)
	}

	saved, saveErr := updateAgentChat(chat.ID, func(chat *model.AgentChat) {
		chat.Messages = agentCloseToolUses(append(chat.Messages, out.Messages...))
		chat.Usage.Add(out.Usage)
		chat.RequestsSent += bridge.takeRequestsSent()
		if loop.lastTokens > 0 {
			chat.ContextTokens = int64(loop.lastTokens)
		} else if last := len(out.Steps) - 1; last >= 0 && out.Steps[last].HasUsage {
			usage := out.Steps[last].Usage
			chat.ContextTokens = int64(usage.Input + usage.CacheRead + usage.CacheWrite)
		}
		chat.ContextWindow = int64(window)
	})
	if saveErr != nil {
		saved = chat
		out.Warnings = append(out.Warnings, "Kurlo could not save the chat: "+saveErr.Error())
	}
	return normalizeAgentTurn(model.AgentTurn{
		Chat:     saved,
		Messages: out.Messages,
		Steps:    out.Steps,
		Text:     out.Text,
		Usage:    out.Usage,
		HasUsage: out.HasUsage,
		Warnings: out.Warnings,
		Error:    out.Error,
	})
}

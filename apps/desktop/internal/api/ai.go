package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/script"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const aiDefaultIdleTimeout = 300 * time.Second

const aiMaxSteps = 50

type aiEmitter func(name string, payload any)

type aiRunner struct {
	ctx      context.Context
	req      model.AiRequest
	provider aiProvider
	emit     aiEmitter
	send     func(ctx context.Context, req model.HttpRequest, sink responseBodySinkFactory) model.HttpResponse
	mcp      func(req model.HttpRequest) model.McpResponse
	now      func() time.Time
}

func (a *App) SendAiRequest(req model.AiRequest) model.AiResponse {
	baseCtx := context.Background()
	if a.ctx != nil {
		baseCtx = a.ctx
	}
	ctx, cancel := context.WithCancel(baseCtx)
	seq := a.registerRequestCancel(req.HTTP.RequestID, cancel)
	defer func() {
		cancel()
		a.unregisterRequestCancel(req.HTTP.RequestID, seq)
	}()

	runner := aiRunner{
		ctx:      ctx,
		req:      req,
		provider: aiProviderFor(req.Provider),
		emit:     a.aiEventEmitter(),
		send: func(stepCtx context.Context, prepared model.HttpRequest, sink responseBodySinkFactory) model.HttpResponse {
			return sendRequestWithBodySink(stepCtx, prepared, a.state, a.cookieJars, a.preflightCache, sink)
		},
		mcp: func(prepared model.HttpRequest) model.McpResponse {
			transport := func(p model.HttpRequest) model.HttpResponse {
				return sendRequest(ctx, p, a.state, a.cookieJars, a.preflightCache)
			}
			return a.mcpSessions.send(prepared, transport)
		},
		now: time.Now,
	}
	out := runner.run()
	out = finishAiTests(ctx, req, out, a.state, a.cookieJars)
	return model.NormalizeAiResponse(out)
}

func (a *App) aiEventEmitter() aiEmitter {
	if a.ctx == nil {
		return nil
	}
	return func(name string, payload any) {
		runtime.EventsEmit(a.ctx, name, payload)
	}
}

func (r *aiRunner) publish(name string, payload any) {
	if r.emit != nil {
		r.emit(name, payload)
	}
}

func (r *aiRunner) sessionID() string {
	return r.req.HTTP.RequestID
}

func (r *aiRunner) run() model.AiResponse {
	start := r.now()
	out := model.AiResponse{}
	if strings.TrimSpace(r.req.Model) == "" {
		out.Error = "Choose a model before sending."
		return out
	}
	if strings.TrimSpace(r.req.HTTP.URL) == "" {
		out.Error = "Enter the provider's base URL before sending."
		return out
	}

	tools, toolWarnings := r.discoverTools()
	out.Warnings = append(out.Warnings, toolWarnings...)
	for _, tool := range tools {
		out.Tools = append(out.Tools, model.AiToolInfo{Name: tool.Name, OriginalName: tool.Original, Server: tool.Server, Description: tool.Description})
	}
	if r.ctx.Err() != nil {
		out.Error = "Cancelled"
		return out
	}

	maxSteps := r.req.MaxSteps
	if maxSteps <= 0 {
		maxSteps = model.AiDefaultMaxSteps
	}
	if maxSteps > aiMaxSteps {
		maxSteps = aiMaxSteps
	}

	conversation := append([]model.AiMessage{}, r.req.Messages...)
	for index := 0; index < maxSteps; index++ {
		step := r.runStep(index, conversation, tools)
		out.Steps = append(out.Steps, step)
		out.Usage.Add(step.Usage)
		out.HasUsage = out.HasUsage || step.HasUsage
		if index == 0 {
			out.FirstTokenMs = step.FirstTokenMs
		}
		out.StopReason = step.StopReason
		out.HTTP = step.HTTP
		if len(step.Blocks) > 0 {
			assistant := model.AiMessage{Role: "assistant", Blocks: step.Blocks}
			conversation = append(conversation, assistant)
			out.Messages = append(out.Messages, assistant)
		}
		if step.Error != "" {
			out.Error = step.Error
			break
		}
		if step.StopReason != model.AiStopToolUse || len(tools) == 0 {
			break
		}
		results := r.callTools(index, step.Blocks, tools)
		out.Steps[len(out.Steps)-1].ToolResults = results
		if len(results) == 0 {
			break
		}
		toolMessage := model.AiMessage{Role: "tool", Blocks: results}
		conversation = append(conversation, toolMessage)
		out.Messages = append(out.Messages, toolMessage)
		if r.ctx.Err() != nil {
			out.Error = "Cancelled"
			break
		}
		if index == maxSteps-1 {
			out.Warnings = append(out.Warnings, fmt.Sprintf("Stopped after %d steps: the model still wanted to call tools. Raise the step limit to let it finish.", maxSteps))
		}
	}
	for _, step := range out.Steps {
		if text := aiTextOf(step.Blocks); text != "" {
			out.Text = text
		}
	}
	out.DurationMs = r.now().Sub(start).Milliseconds()
	return out
}

func (r *aiRunner) stepRequest(index int, conversation []model.AiMessage, tools []aiTool) (model.HttpRequest, error) {
	body, headers, err := r.provider.build(r.req, conversation, tools)
	if err != nil {
		return model.HttpRequest{}, err
	}
	prepared := r.req.HTTP
	prepared.Method = http.MethodPost
	prepared.URL = r.provider.endpoint(r.req.HTTP.URL)
	prepared.BodyType = "json"
	prepared.Body = string(body)
	prepared.FormData = nil
	prepared.BodyFilePath = ""
	prepared.GraphQL = nil
	prepared.McpMethod = ""
	prepared.TimeoutMs = 0
	prepared.Headers = append(append([]model.KeyValue{}, r.req.HTTP.Headers...), headers...)
	prepared.TestScript = ""
	if index > 0 {
		prepared.PreRequestScript = ""
	}
	return prepared, nil
}

func (r *aiRunner) idleTimeout() time.Duration {
	if seconds := r.req.Settings.IdleTimeoutSec; seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	return aiDefaultIdleTimeout
}

type aiStreamSink struct {
	pipeWriter *io.PipeWriter
	done       chan struct{}
	touch      func()
}

func (s *aiStreamSink) Write(p []byte) (int, error) {
	s.touch()
	return s.pipeWriter.Write(p)
}

func (r *aiRunner) runStep(index int, conversation []model.AiMessage, tools []aiTool) model.AiStep {
	step := model.AiStep{Index: index}
	prepared, err := r.stepRequest(index, conversation, tools)
	if err != nil {
		step.Error = err.Error()
		return step
	}

	stepCtx, cancel := context.WithCancel(r.ctx)
	defer cancel()
	idle := r.idleTimeout()
	var idleMu sync.Mutex
	idleExpired := false
	timer := time.AfterFunc(idle, func() {
		idleMu.Lock()
		idleExpired = true
		idleMu.Unlock()
		cancel()
	})
	defer timer.Stop()
	touch := func() { timer.Reset(idle) }

	decoder := r.provider.decoder()
	started := r.now()
	var firstToken time.Time
	var firstMu sync.Mutex
	batcher := newEventBatcher[model.AiDeltaEvent](64, 50*time.Millisecond,
		func(ev model.AiDeltaEvent) {
			r.publish("ai:deltas", model.AiDeltaBatch{SessionID: r.sessionID(), Deltas: []model.AiDeltaEvent{ev}})
		},
		func(events []model.AiDeltaEvent) {
			r.publish("ai:deltas", model.AiDeltaBatch{SessionID: r.sessionID(), Deltas: events})
		})
	emit := func(delta model.AiDeltaEvent) {
		firstMu.Lock()
		if firstToken.IsZero() && (delta.Text != "" || delta.Input != "" || delta.Name != "") {
			firstToken = r.now()
		}
		firstMu.Unlock()
		delta.SessionID = r.sessionID()
		delta.Step = index
		batcher.add(delta)
	}

	var sink *aiStreamSink
	streamed := false
	sinkFactory := func(headers []model.KeyValue) *responseBodySink {
		touch()
		if !headerContainsEventStream(headers) {
			return nil
		}
		streamed = true
		reader, writer := io.Pipe()
		sink = &aiStreamSink{pipeWriter: writer, done: make(chan struct{}), touch: touch}
		go func() {
			defer close(sink.done)
			parseSSEStream(stepCtx, reader, "", func(ev model.SSEEvent) {
				decoder.event(ev, emit)
			})
			_, _ = io.Copy(io.Discard, reader)
		}()
		return &responseBodySink{
			writer: sink,
			commit: func() error {
				_ = writer.Close()
				<-sink.done
				return nil
			},
			abort: func() {
				_ = writer.CloseWithError(errors.New("aborted"))
				<-sink.done
			},
		}
	}

	resp := r.send(stepCtx, prepared, sinkFactory)
	batcher.flush()
	finished := r.now()

	idleMu.Lock()
	timedOut := idleExpired
	idleMu.Unlock()

	if !streamed && resp.Error == "" && resp.Body != "" && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		decoder.body([]byte(resp.Body))
	}
	result := decoder.result()
	step.Blocks = result.blocks
	step.StopReason = result.stop
	step.RawStopReason = result.rawStop
	step.Model = result.model
	step.Usage = result.usage
	step.HasUsage = result.hasUsage
	step.DurationMs = finished.Sub(started).Milliseconds()
	if !firstToken.IsZero() {
		step.FirstTokenMs = firstToken.Sub(started).Milliseconds()
	} else if !streamed && len(step.Blocks) > 0 {
		step.FirstTokenMs = step.DurationMs
	}
	step.HTTP = resp

	switch {
	case timedOut:
		step.Error = fmt.Sprintf("No data from the model for %s. The stream was stopped; raise the silence limit in Settings if the model needs longer.", idle)
	case r.ctx.Err() != nil:
		step.Error = "Cancelled"
	case resp.Error != "":
		step.Error = resp.Error
	case resp.StatusCode != 0 && (resp.StatusCode < 200 || resp.StatusCode >= 300):
		if message := aiErrorMessage([]byte(resp.Body)); message != "" {
			step.Error = fmt.Sprintf("%s: %s", resp.Status, message)
		} else {
			step.Error = resp.Status
		}
	case result.err != "":
		step.Error = result.err
	}
	step.HTTP.Error = ""
	step = model.NormalizeAiStep(step)
	r.publish("ai:step", model.AiStepEvent{SessionID: r.sessionID(), Step: aiStepEventCopy(step)})
	return step
}

func aiStepEventCopy(step model.AiStep) model.AiStep {
	step.HTTP = model.HttpResponse{StatusCode: step.HTTP.StatusCode, Status: step.HTTP.Status, Headers: []model.KeyValue{}}
	return step
}

func headerContainsEventStream(headers []model.KeyValue) bool {
	for _, h := range headers {
		if strings.EqualFold(h.Key, "Content-Type") && strings.Contains(strings.ToLower(h.Value), "text/event-stream") {
			return true
		}
	}
	return false
}

func (r *aiRunner) discoverTools() ([]aiTool, []string) {
	var tools []aiTool
	var warnings []string
	for serverIndex, server := range r.req.ToolServers {
		name := strings.TrimSpace(server.Name)
		if name == "" {
			name = server.Request.URL
		}
		cursor := ""
		for page := 0; page < 20; page++ {
			if r.ctx.Err() != nil {
				return tools, warnings
			}
			listReq := server.Request
			listReq.McpMethod = "tools/list"
			listReq.McpName = ""
			listReq.McpArguments = ""
			listReq.McpCursor = cursor
			listReq.PreRequestScript = ""
			listReq.TestScript = ""
			resp := r.mcp(listReq)
			if resp.Error != "" || resp.RPCErrorMessage != "" {
				message := resp.Error
				if message == "" {
					message = resp.RPCErrorMessage
				}
				warnings = append(warnings, fmt.Sprintf("Could not list the tools of %s: %s", name, message))
				break
			}
			for _, tool := range resp.Tools {
				if tool.Rejected != "" {
					warnings = append(warnings, fmt.Sprintf("Skipped %s from %s: %s", tool.Name, name, tool.Rejected))
					continue
				}
				tools = append(tools, aiTool{
					Original:    tool.Name,
					Server:      name,
					ServerIndex: serverIndex,
					Description: tool.Description,
					Schema:      json.RawMessage(tool.InputSchema),
				})
			}
			if resp.NextCursor == "" || resp.NextCursor == cursor {
				break
			}
			cursor = resp.NextCursor
		}
	}
	return aiAssignToolNames(tools), warnings
}

func (r *aiRunner) callTools(stepIndex int, blocks []model.AiBlock, tools []aiTool) []model.AiBlock {
	byName := map[string]aiTool{}
	for _, tool := range tools {
		byName[tool.Name] = tool
	}
	var results []model.AiBlock
	for _, block := range blocks {
		if block.Type != model.AiBlockToolUse {
			continue
		}
		result := model.AiBlock{Type: model.AiBlockToolResult, ID: block.ID, Name: block.Name}
		tool, ok := byName[block.Name]
		switch {
		case r.ctx.Err() != nil:
			result.Text = "Cancelled before the tool ran."
			result.IsError = true
		case !ok:
			result.Text = fmt.Sprintf("No tool named %s is available.", block.Name)
			result.IsError = true
		default:
			result.Server = tool.Server
			result.Text, result.IsError = r.callTool(tool, block.Input)
		}
		results = append(results, result)
		r.publish("ai:tool", model.AiToolResultEvent{SessionID: r.sessionID(), Step: stepIndex, Block: result})
	}
	return results
}

func (r *aiRunner) callTool(tool aiTool, input string) (string, bool) {
	arguments := string(aiInputObject(input))
	if strings.TrimSpace(input) != "" && !json.Valid([]byte(strings.TrimSpace(input))) {
		return "The tool arguments are not valid JSON: " + input, true
	}
	server := r.req.ToolServers[tool.ServerIndex]
	callReq := server.Request
	callReq.McpMethod = "tools/call"
	callReq.McpName = tool.Original
	callReq.McpArguments = arguments
	callReq.McpInputSchema = string(tool.Schema)
	callReq.McpCursor = ""
	callReq.PreRequestScript = ""
	callReq.TestScript = ""
	resp := r.mcp(callReq)
	if resp.Error != "" {
		return resp.Error, true
	}
	if resp.RPCErrorMessage != "" {
		return resp.RPCErrorMessage, true
	}
	return mcpResultText(resp), resp.IsError
}

func mcpResultText(resp model.McpResponse) string {
	var parts []string
	for _, content := range resp.Content {
		switch content.Type {
		case "text":
			parts = append(parts, content.Text)
		case "image", "audio":
			parts = append(parts, fmt.Sprintf("[%s %s]", content.Type, content.MimeType))
		case "resource_link", "resource":
			label := content.Name
			if label == "" {
				label = content.URI
			}
			if content.Text != "" {
				parts = append(parts, content.Text)
			} else {
				parts = append(parts, fmt.Sprintf("[resource %s]", label))
			}
		default:
			if content.Text != "" {
				parts = append(parts, content.Text)
			}
		}
	}
	if len(parts) == 0 && resp.StructuredContent != "" {
		return resp.StructuredContent
	}
	return strings.Join(parts, "\n")
}

func finishAiTests(ctx context.Context, req model.AiRequest, out model.AiResponse, sm *state.Manager, jars *cookieJarRegistry) model.AiResponse {
	if len(out.Steps) > 0 {
		first := out.Steps[0].HTTP
		out.HTTP.PreRequestResult = first.PreRequestResult
		out.HTTP.EnvironmentUpdates = first.EnvironmentUpdates
		out.HTTP.EnvironmentRemoved = first.EnvironmentRemoved
		out.HTTP.CollectionVariableUpdates = first.CollectionVariableUpdates
		out.HTTP.CollectionVariablesRemoved = first.CollectionVariablesRemoved
	}
	if strings.TrimSpace(req.HTTP.TestScript) == "" || len(out.Steps) == 0 || sm == nil {
		return out
	}
	resp := out.HTTP
	resp.Llm = aiScriptView(out)
	testReq := req.HTTP
	scope := beginScriptScope(sm, req.HTTP.CollectionVariables)
	testCtx := scope.ctx
	testCtx.Response = &resp
	populateScriptRequestContext(testCtx, testReq)
	populateScriptCookies(testCtx, testReq, jars)
	testCtx.Send = newScriptSender(ctx, testReq.AllowSendRequest, testReq)
	result := script.RunTests(testReq.ScriptEngine, testReq.TestScript, testCtx)
	result = redactScriptResult(result, testReq.SecretEnvironmentValues)
	var delta environmentDelta
	delta.add(map[string]string{}, out.HTTP.EnvironmentUpdates)
	for _, key := range out.HTTP.EnvironmentRemoved {
		delta.add(map[string]string{key: ""}, map[string]string{})
	}
	delta.merge(scope.commit(sm))
	out.HTTP.TestResult = result
	out.HTTP.CollectionVariableUpdates, out.HTTP.CollectionVariablesRemoved = mergeCollectionVariableResults(out.HTTP.PreRequestResult, result)
	delta.apply(&out.HTTP)
	return out
}

func aiScriptView(out model.AiResponse) string {
	type toolCall struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Input  any    `json:"input"`
		Server string `json:"server,omitempty"`
	}
	type toolResult struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Text    string `json:"text"`
		IsError bool   `json:"isError"`
	}
	type stepView struct {
		Text        string        `json:"text"`
		ToolCalls   []toolCall    `json:"toolCalls"`
		ToolResults []toolResult  `json:"toolResults"`
		StopReason  string        `json:"stopReason"`
		Usage       model.AiUsage `json:"usage"`
	}
	view := struct {
		Text       string        `json:"text"`
		Thinking   string        `json:"thinking"`
		ToolCalls  []toolCall    `json:"toolCalls"`
		StopReason string        `json:"stopReason"`
		Model      string        `json:"model"`
		Usage      model.AiUsage `json:"usage"`
		Timing     struct {
			FirstToken int64 `json:"firstToken"`
			Total      int64 `json:"total"`
		} `json:"timing"`
		Steps []stepView `json:"steps"`
		Error string     `json:"error"`
	}{Text: out.Text, StopReason: out.StopReason, Usage: out.Usage, ToolCalls: []toolCall{}, Steps: []stepView{}, Error: out.Error}
	view.Timing.FirstToken = out.FirstTokenMs
	view.Timing.Total = out.DurationMs
	servers := map[string]string{}
	for _, tool := range out.Tools {
		servers[tool.Name] = tool.Server
	}
	var thinking []string
	for _, step := range out.Steps {
		if step.Model != "" {
			view.Model = step.Model
		}
		sv := stepView{Text: aiTextOf(step.Blocks), StopReason: step.StopReason, Usage: step.Usage, ToolCalls: []toolCall{}, ToolResults: []toolResult{}}
		for _, block := range step.Blocks {
			switch block.Type {
			case model.AiBlockThinking:
				if block.Text != "" {
					thinking = append(thinking, block.Text)
				}
			case model.AiBlockToolUse:
				var input any
				if err := json.Unmarshal(aiInputObject(block.Input), &input); err != nil {
					input = map[string]any{}
				}
				call := toolCall{ID: block.ID, Name: block.Name, Input: input, Server: servers[block.Name]}
				sv.ToolCalls = append(sv.ToolCalls, call)
				view.ToolCalls = append(view.ToolCalls, call)
			}
		}
		for _, block := range step.ToolResults {
			sv.ToolResults = append(sv.ToolResults, toolResult{ID: block.ID, Name: block.Name, Text: block.Text, IsError: block.IsError})
		}
		view.Steps = append(view.Steps, sv)
	}
	view.Thinking = strings.Join(thinking, "\n")
	encoded, err := json.Marshal(view)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

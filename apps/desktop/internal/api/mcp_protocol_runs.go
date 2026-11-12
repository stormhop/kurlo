package api

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type mcpProtocolArgs struct {
	McpMethod    string         `json:"mcpMethod"`
	McpName      string         `json:"mcpName"`
	McpArguments map[string]any `json:"mcpArguments"`
	McpCursor    string         `json:"mcpCursor"`
}

func (s *mcpServer) protocolHTTP(run *mcpRunContext, req cliSavedRequest, values map[string]string) (model.HttpRequest, error) {
	req = cliRequestCollectionScope(req, run.sm)
	prepared := buildHTTPRequest(req, values, run.secrets, s.opts.timeoutMs)
	prepared.Name = req.Name
	prepared.ScriptTimeoutMs = req.Settings.ScriptTimeoutMs
	prepared.AllowSendRequest = s.opts.allowSendRequest || req.Settings.AllowSendRequest
	if s.opts.insecure {
		prepared.EnableSSLVerification = false
	}
	prepared, err := resolveHTTPRequestTemplates(prepared, prepared.TemplateValues)
	if err != nil {
		return prepared, err
	}
	cfg := &prepared.Auth
	if err := s.tokens.resolveOAuth2Token(cfg); err != nil {
		return prepared, fmt.Errorf("%s", redactSecrets(err.Error(), run.secrets))
	}
	if err := auth.PrepareJWTBearer(cfg); err != nil {
		return prepared, fmt.Errorf("%s", redactSecrets(err.Error(), run.secrets))
	}
	run.secrets = append(run.secrets, cfg.JWTSecret, cfg.JWTPrivateKey, cfg.Token, cfg.Password, cfg.KeyValue, cfg.OAuth2Secret, cfg.OAuth2Password, cfg.OAuth2RefreshToken, cfg.OAuth2AssertionPrivateKey, cfg.OAuth1ConsumerSecret, cfg.OAuth1Token, cfg.OAuth1TokenSecret, cfg.OAuth1PrivateKey, cfg.AWSSecretKey, cfg.AWSSessionToken)
	for _, header := range prepared.Headers {
		if mcpSensitiveRequestHeaders[strings.ToLower(header.Key)] {
			run.secrets = append(run.secrets, header.Value)
		}
	}
	prepared.SecretEnvironmentValues = run.secrets
	return prepared, nil
}

func (s *mcpServer) protocolGRPC(run *mcpRunContext, req cliSavedRequest, values map[string]string) (model.GrpcRequest, error) {
	httpReq, err := s.protocolHTTP(run, req, values)
	if err != nil {
		return model.GrpcRequest{}, err
	}
	path := func(text string) string {
		text = resolveTemplateValue(text, values)
		if text != "" && !filepath.IsAbs(text) {
			return filepath.Join(s.opts.workspace, text)
		}
		return text
	}
	var imports []string
	for _, raw := range req.GrpcProtoImportPaths {
		if resolved := path(raw); resolved != "" {
			imports = append(imports, resolved)
		}
	}
	var metadata []model.KeyValue
	for _, row := range req.GrpcMetadata {
		if row.Enabled {
			key := resolveTemplateValue(row.Key, values)
			value := resolveTemplateValue(row.Value, values)
			metadata = append(metadata, model.KeyValue{Key: key, Value: value, Enabled: true})
			if mcpSensitiveRequestHeaders[strings.ToLower(key)] {
				run.secrets = append(run.secrets, value)
			}
		}
	}
	httpReq.Auth.KeyIn = "header"
	settings := req.Settings
	return model.GrpcRequest{
		RequestID: req.ID, Target: httpReq.URL, FullMethod: resolveTemplateValue(req.GrpcMethod, values),
		Message: httpReq.Body, Metadata: metadata, Auth: httpReq.Auth,
		UseReflection: boolOr(settings.GrpcUseReflection, boolOr(req.GrpcUseReflection, true)),
		ProtoFilePath: path(req.GrpcProtoFilePath), ProtoImportPaths: imports,
		UseTLS: boolOr(settings.GrpcUseTLS, false), EnableSSLVerification: httpReq.EnableSSLVerification,
		ServerName: resolveTemplateValue(settings.GrpcServerName, values), IncludeDefaultValues: boolOr(settings.GrpcIncludeDefaultValues, true),
		MaxResponseMessageSizeMb: settings.GrpcMaxResponseMessageSizeMb, TimeoutMs: httpReq.TimeoutMs, Name: req.Name,
		PreRequestScript: httpReq.PreRequestScript, TestScript: httpReq.TestScript, ScriptEngine: httpReq.ScriptEngine,
		ScriptTimeoutMs: httpReq.ScriptTimeoutMs, AllowSendRequest: httpReq.AllowSendRequest, SecretEnvironmentValues: run.secrets,
		CollectionVariables: httpReq.CollectionVariables,
	}, nil
}

func (s *mcpServer) protocolMCP(run *mcpRunContext, req cliSavedRequest, args mcpProtocolArgs) (model.HttpRequest, error) {
	httpReq, err := s.protocolHTTP(run, req, cliRequestValues(req, run.sm))
	if err != nil {
		return httpReq, err
	}
	values := cliRequestValues(req, run.sm)
	httpReq.McpProtocolVersion = req.McpProtocolVersion
	httpReq.McpMethod = defaultString(args.McpMethod, defaultString(req.McpMethod, "tools/list"))
	httpReq.McpName = resolveTemplateValue(defaultString(args.McpName, req.McpName), values)
	httpReq.McpArguments = resolveTemplateValue(req.McpArguments, values)
	if args.McpArguments != nil {
		encoded, err := json.Marshal(resolveMCPArgument(args.McpArguments, values))
		if err != nil {
			return httpReq, err
		}
		httpReq.McpArguments = string(encoded)
	}
	httpReq.McpCursor = args.McpCursor
	return httpReq, nil
}

func resolveMCPArgument(value any, values map[string]string) any {
	switch item := value.(type) {
	case string:
		return resolveTemplateValue(item, values)
	case []any:
		for i := range item {
			item[i] = resolveMCPArgument(item[i], values)
		}
	case map[string]any:
		for key, child := range item {
			item[key] = resolveMCPArgument(child, values)
		}
	}
	return value
}

func (s *mcpServer) sendProtocolMCP(ctx context.Context, run *mcpRunContext, req model.HttpRequest) model.McpResponse {
	return s.protocolSessions.send(req, func(prepared model.HttpRequest) model.HttpResponse {
		return sendRequest(ctx, prepared, run.sm, s.jars, s.cache)
	})
}

type mcpProtocolOutcome struct {
	Protocol         string         `json:"protocol"`
	Request          string         `json:"request"`
	VariablesChanged []string       `json:"variablesChanged,omitempty"`
	Response         map[string]any `json:"response"`
	Error            string         `json:"error,omitempty"`
}

func (o mcpProtocolOutcome) toolFailed() bool { return o.Error != "" }

func (s *mcpServer) runSavedProtocol(ctx context.Context, ws mcpWorkspace, run *mcpRunContext, req cliSavedRequest, args mcpProtocolArgs, limit int) (any, error) {
	kind := mcpRequestType(req)
	out := mcpProtocolOutcome{Protocol: kind, Request: mcpRequestPath(req)}
	var httpResp model.HttpResponse
	switch kind {
	case "grpc":
		prepared, err := s.protocolGRPC(run, req, cliRequestValues(req, run.sm))
		if err != nil {
			return nil, err
		}
		resp := sendGrpcRequestWith(ctx, prepared, run.sm, nil, doUnaryGrpcRequest, grpcRunIteration{})
		httpResp = mcpGrpcHTTPResponse(resp)
		out.Error = grpcRunError(resp)
		out.Response = map[string]any{
			"grpcCode": resp.GrpcCode, "grpcMessage": resp.GrpcMessage, "method": resp.Method,
			"skipped": resp.Skipped, "skipReason": resp.SkipReason,
			"trailers": mcpSafeHeaders(resp.Trailers, run.secrets),
		}
		s.applyCollectionUpdates(run, req, resp.CollectionVariableUpdates, resp.CollectionVariablesRemoved)
	case "mcp":
		if args.McpMethod != "" && args.McpMethod != "tools/list" && args.McpMethod != "tools/call" {
			return nil, fmt.Errorf("mcpMethod must be tools/list or tools/call")
		}
		prepared, err := s.protocolMCP(run, req, args)
		if err != nil {
			return nil, err
		}
		resp := s.sendProtocolMCP(ctx, run, prepared)
		httpResp = resp.HTTP
		out.Error = defaultString(resp.Error, resp.RPCErrorMessage)
		if resp.IsError && out.Error == "" {
			out.Error = "The MCP server returned a tool error."
		}
		body, truncated := mcpTruncate(redactSecrets(defaultString(resp.StructuredContent, resp.Result), run.secrets), limit)
		out.Response = map[string]any{"server": resp.ServerName, "tools": resp.Tools, "nextCursor": resp.NextCursor, "result": body, "resultTruncated": truncated, "rpcErrorCode": resp.RPCErrorCode, "warnings": resp.Warnings}
		s.applyCollectionUpdates(run, req, httpResp.CollectionVariableUpdates, httpResp.CollectionVariablesRemoved)
	case "ai":
		resp, err := s.runSavedAI(ctx, ws, run, req)
		if err != nil {
			return nil, err
		}
		httpResp = resp.HTTP
		out.Error = defaultString(resp.Error, defaultString(httpResp.Error, httpResp.TestResult.Error))
		text, truncated := mcpTruncate(redactSecrets(resp.Text, run.secrets), limit)
		out.Response = map[string]any{"text": text, "textTruncated": truncated, "stopReason": resp.StopReason, "usage": resp.Usage, "firstTokenMs": resp.FirstTokenMs, "durationMs": resp.DurationMs, "steps": len(resp.Steps), "warnings": resp.Warnings}
		s.applyCollectionUpdates(run, req, httpResp.CollectionVariableUpdates, httpResp.CollectionVariablesRemoved)
	default:
		return nil, fmt.Errorf("%s is a %s request; use open_session in Agent Mode for live connections", mcpRequestPath(req), kind)
	}
	out.Error = redactSecrets(out.Error, run.secrets)
	if kind != "grpc" {
		httpResp.Body = ""
	}
	httpResp.Headers = mcpSafeHeaders(httpResp.Headers, run.secrets)
	out.Response["http"] = mcpHistoryResponse(httpResp, mcpStoredHistoryEntry{}, run.secrets, limit)
	if err := mcpRedactObject(out.Response, run.secrets); err != nil {
		return nil, err
	}
	out.VariablesChanged = s.remember(run)
	return out, nil
}

func mcpSafeHeaders(rows []model.KeyValue, secrets []string) []model.KeyValue {
	out := make([]model.KeyValue, 0, len(rows))
	for _, row := range rows {
		if strings.EqualFold(row.Key, "set-cookie") || mcpSensitiveRequestHeaders[strings.ToLower(row.Key)] {
			row.Value = "[secret]"
		} else {
			row.Value = redactSecrets(row.Value, secrets)
		}
		out = append(out, row)
	}
	return out
}

func mcpRedactObject(out map[string]any, secrets []string) error {
	encoded, err := json.Marshal(out)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(encoded, &out); err != nil {
		return err
	}
	redactMCPValue(out, secrets)
	return nil
}

func redactMCPValue(value any, secrets []string) any {
	switch item := value.(type) {
	case string:
		return redactSecrets(item, secrets)
	case []any:
		for i := range item {
			item[i] = redactMCPValue(item[i], secrets)
		}
	case map[string]any:
		for key, child := range item {
			item[key] = redactMCPValue(child, secrets)
		}
	}
	return value
}

func optionalAISetting(text string) *float64 {
	n, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return nil
	}
	return &n
}

func (s *mcpServer) runSavedAI(ctx context.Context, ws mcpWorkspace, run *mcpRunContext, req cliSavedRequest) (model.AiResponse, error) {
	provider := defaultString(req.AiProvider, model.AiProviderOpenAI)
	if provider == model.AiProviderKurlo {
		req.URL = ""
		req.Auth = cliAuth{Type: "none"}
	}
	httpReq, err := s.protocolHTTP(run, req, cliRequestValues(req, run.sm))
	if err != nil {
		return model.AiResponse{}, err
	}
	httpReq.Method, httpReq.BodyType, httpReq.Body, httpReq.BodyFilePath, httpReq.FormData = "POST", "none", "", "", nil
	resolve := func(v string) string { return resolveTemplateValue(v, cliRequestValues(req, run.sm)) }
	maxTokens, _ := strconv.Atoi(strings.TrimSpace(req.AiMaxTokens))
	maxSteps, _ := strconv.Atoi(strings.TrimSpace(req.AiMaxSteps))
	idleTimeout, _ := strconv.Atoi(strings.TrimSpace(req.AiIdleTimeoutSec))
	input := model.AiRequest{
		HTTP: httpReq, Provider: provider, Model: resolve(req.AiModel), System: resolve(req.AiSystem), MaxSteps: maxSteps,
		Messages: []model.AiMessage{{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: resolve(req.AiPrompt)}}}},
		Settings: model.AiSettings{Temperature: optionalAISetting(req.AiTemperature), TopP: optionalAISetting(req.AiTopP), MaxTokens: maxTokens, Stream: boolOr(req.AiStream, true), Thinking: req.AiThinking, IdleTimeoutSec: idleTimeout},
	}
	if provider == model.AiProviderKurlo {
		var key string
		input.ConnectionID = strings.TrimSpace(req.AiConnectionID)
		input, key, err = resolveKurloAiRequest(input)
		if err != nil {
			return model.AiResponse{}, err
		}
		run.secrets = append(run.secrets, key)
	}
	for _, id := range req.AiToolRequestIds {
		server, err := mcpFindRequest(ws.requests, id)
		if err != nil || mcpRequestType(server) != "mcp" {
			continue
		}
		prepared, err := s.protocolMCP(run, ws.withDefaults(server), mcpProtocolArgs{})
		if err != nil {
			return model.AiResponse{}, err
		}
		input.ToolServers = append(input.ToolServers, model.AiToolServer{Name: server.Name, Request: prepared})
	}
	input.HTTP.SecretEnvironmentValues = run.secrets
	runner := aiRunner{
		ctx: ctx, req: input, provider: aiProviderFor(input.Provider), now: time.Now,
		send: func(ctx context.Context, prepared model.HttpRequest, sink responseBodySinkFactory) model.HttpResponse {
			return sendRequestWithBodySink(ctx, prepared, run.sm, s.jars, s.cache, sink)
		},
		mcp: func(prepared model.HttpRequest) model.McpResponse { return s.sendProtocolMCP(ctx, run, prepared) },
	}
	if req.AiKurloTools {
		opts := s.opts
		tools := newAiRequestKurloTools(opts, defaultString(req.ID, "ai-request"))
		tools.server.executionApp = s.executionApp
		tools.server.jars = s.jars
		runner.local = tools
	}
	return finishAiTests(ctx, input, runner.run(), run.sm, s.jars), nil
}

func mcpRunnerRunnable(req cliSavedRequest) bool {
	return cliRunnable(req) || (!req.IsDraft && mcpRequestType(req) == "grpc")
}

func mcpGrpcHTTPResponse(resp model.GrpcResponse) model.HttpResponse {
	out := *grpcResponseAsHTTP(resp)
	out.PreRequestResult = resp.PreRequestResult
	out.TestResult = resp.TestResult
	out.Skipped, out.SkipReason = resp.Skipped, resp.SkipReason
	out.CollectionVariableUpdates, out.CollectionVariablesRemoved = resp.CollectionVariableUpdates, resp.CollectionVariablesRemoved
	out.GlobalVariableUpdates, out.GlobalVariablesRemoved = resp.GlobalVariableUpdates, resp.GlobalVariablesRemoved
	return out
}

func grpcRunError(resp model.GrpcResponse) string {
	message := defaultString(resp.Error, defaultString(resp.PreRequestResult.Error, resp.TestResult.Error))
	if message == "" && resp.GrpcCode != "OK" {
		return defaultString(resp.GrpcMessage, resp.GrpcCode)
	}
	return message
}

func (s *mcpServer) executeGrpcIteration(ctx context.Context, run *mcpRunContext, req cliSavedRequest, iteration grpcRunIteration) cliRunResult {
	result := cliRunResult{Name: mcpRequestLabel(req), Method: "GRPC", URL: req.URL, Iteration: iteration.index}
	values := cliRequestValues(req, run.sm)
	if len(iteration.data) > 0 {
		values = maps.Clone(values)
		maps.Copy(values, iteration.data)
	}
	prepared, err := s.protocolGRPC(run, req, values)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.URL = prepared.Target
	resp := sendGrpcRequestWith(ctx, prepared, run.sm, nil, doUnaryGrpcRequest, iteration)
	if resp.Skipped {
		result.Skipped, result.SkipReason = true, resp.SkipReason
		s.applyCollectionUpdates(run, req, resp.CollectionVariableUpdates, resp.CollectionVariablesRemoved)
		return result
	}
	if resp.Error == grpcStreamingRequired {
		result.Skipped, result.SkipReason = true, resp.Error
		return result
	}
	s.applyCollectionUpdates(run, req, resp.CollectionVariableUpdates, resp.CollectionVariablesRemoved)
	if resp.GrpcCode == "OK" {
		result.StatusCode = 200
	}
	result.DurationMs, result.Size = resp.Duration, resp.Size
	result.Error = grpcRunError(resp)
	for _, test := range resp.TestResult.Tests {
		result.Tests = append(result.Tests, cliTestResult{Name: test.Name, Passed: test.Passed, Error: test.Error})
		result.TestsTotal++
		if test.Passed {
			result.TestsPassed++
		}
	}
	for _, logs := range [][]string{resp.PreRequestResult.Logs, resp.TestResult.Logs} {
		for _, line := range logs {
			result.Logs = append(result.Logs, redactSecrets(line, run.secrets))
		}
	}
	return result
}

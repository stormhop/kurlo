package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type mcpTransport func(model.HttpRequest) model.HttpResponse

var mcpSessionProtocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26"}

const mcpSessionHeader = "Mcp-Session-Id"

type mcpSession struct {
	id      string
	version string
}

type mcpEndpoint struct {
	stateless bool
	session   *mcpSession
}

type mcpSessionRegistry struct {
	mu        sync.Mutex
	endpoints map[string]mcpEndpoint
}

func newMCPSessionRegistry() *mcpSessionRegistry {
	return &mcpSessionRegistry{endpoints: map[string]mcpEndpoint{}}
}

func mcpIsSessionVersion(version string) bool {
	for _, known := range mcpSessionProtocolVersions {
		if known == version {
			return true
		}
	}
	return false
}

func mcpSpokenVersions() string {
	return strings.Join(append([]string{model.McpDefaultProtocolVersion}, mcpSessionProtocolVersions...), ", ")
}

func mcpEndpointKey(req model.HttpRequest) string {
	resolved := req
	if req.ResolveTemplates {
		if templated, err := resolveHTTPRequestTemplates(req, req.TemplateValues); err == nil {
			resolved = templated
		}
	}
	headers := make([]string, 0, len(resolved.Headers))
	for _, row := range resolved.Headers {
		key := strings.ToLower(strings.TrimSpace(row.Key))
		if !row.Enabled || key == "" || strings.HasPrefix(key, "mcp-") {
			continue
		}
		headers = append(headers, key+": "+row.Value)
	}
	sum := sha256.New()
	_ = json.NewEncoder(sum).Encode([]any{resolved.WorkspaceID, strings.TrimSpace(resolved.URL), resolved.Auth, headers})
	return hex.EncodeToString(sum.Sum(nil))
}

func (r *mcpSessionRegistry) endpoint(key string) mcpEndpoint {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.endpoints[key]
}

func (r *mcpSessionRegistry) remember(key string, endpoint mcpEndpoint) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.endpoints[key] = endpoint
}

func (r *mcpSessionRegistry) send(req model.HttpRequest, transport mcpTransport) model.McpResponse {
	if r == nil {
		r = newMCPSessionRegistry()
	}
	requested := strings.TrimSpace(req.McpProtocolVersion)
	if requested != "" && requested != model.McpDefaultProtocolVersion {
		if !mcpIsSessionVersion(requested) {
			return model.McpResponse{Error: fmt.Sprintf("Kurlo does not speak MCP %s; it speaks %s", requested, mcpSpokenVersions())}
		}
		out, _ := r.sendInSession(req, transport, requested)
		return out
	}

	key := mcpEndpointKey(req)
	known := r.endpoint(key)
	if requested == "" && known.session != nil {
		out, _ := r.sendInSession(req, transport, "")
		return out
	}

	out := mcpSendStateless(req, transport)
	if requested != "" || known.stateless || !mcpMaySpeakSessions(out) {
		if out.Error == "" && out.RPCErrorCode == 0 && out.HTTP.StatusCode < 400 {
			r.remember(key, mcpEndpoint{stateless: true})
		}
		return out
	}

	fallback, handshakeErr := r.sendInSession(req, transport, "")
	if handshakeErr != nil {
		return out
	}
	return fallback
}

func mcpMaySpeakSessions(out model.McpResponse) bool {
	if out.HTTP.Error != "" || out.HTTP.StatusCode == 0 {
		return false
	}
	return out.HTTP.StatusCode >= 400 || out.RPCErrorCode != 0 || out.Error != ""
}

func (r *mcpSessionRegistry) sendInSession(req model.HttpRequest, transport mcpTransport, version string) (model.McpResponse, error) {
	req, err := mcpValidateCall(req)
	if err != nil {
		return model.McpResponse{Error: err.Error()}, err
	}
	key := mcpEndpointKey(req)
	if req.McpMethod == mcpMethodDiscover {
		out, _, err := r.openSession(key, req, transport, version)
		return out, err
	}

	session := r.endpoint(key).session
	if session == nil || (version != "" && session.version != version) {
		opened, fresh, err := r.openSession(key, req, transport, version)
		if err != nil {
			return opened, err
		}
		session = fresh
	}
	out := mcpSessionCall(req, transport, session)
	if out.HTTP.StatusCode == http.StatusNotFound && session.id != "" {
		opened, fresh, err := r.openSession(key, req, transport, version)
		if err != nil {
			return opened, nil
		}
		out = mcpSessionCall(req, transport, fresh)
	}
	return out, nil
}

func mcpHandshakeRequest(req model.HttpRequest, body map[string]any, session *mcpSession) model.HttpRequest {
	data, _ := json.MarshalIndent(body, "", "  ")
	protocol := []model.KeyValue{{Key: "Accept", Value: "application/json, text/event-stream", Enabled: true}}
	if session != nil {
		protocol = append(protocol, mcpSessionHeaders(session)...)
	}
	req.Headers, _ = mcpApplyHeaders(req.Headers, protocol)
	req.Method = "POST"
	req.BodyType = "json"
	req.Body = string(data)
	req.BodyFilePath = ""
	req.FormData = nil
	req.PreRequestScript = ""
	req.TestScript = ""
	return req
}

func mcpSessionHeaders(session *mcpSession) []model.KeyValue {
	var rows []model.KeyValue
	if session.id != "" {
		rows = append(rows, model.KeyValue{Key: mcpSessionHeader, Value: session.id, Enabled: true})
	}
	if session.version != "2025-03-26" {
		rows = append(rows, model.KeyValue{Key: "MCP-Protocol-Version", Value: session.version, Enabled: true})
	}
	return rows
}

func (r *mcpSessionRegistry) openSession(key string, req model.HttpRequest, transport mcpTransport, version string) (model.McpResponse, *mcpSession, error) {
	offered := version
	if offered == "" {
		offered = mcpSessionProtocolVersions[0]
	}
	initialize := mcpHandshakeRequest(req, map[string]any{
		"jsonrpc": "2.0",
		"id":      0,
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion": offered,
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "Kurlo", "version": appVersion},
		},
	}, nil)
	httpResponse := transport(initialize)
	out := mcpResponseFrom(initialize, httpResponse, nil)
	if failure := mcpHandshakeFailure(out); failure != "" {
		if out.Error == "" {
			out.Error = "the server did not accept MCP's initialize: " + failure
		}
		return out, nil, fmt.Errorf("%s", failure)
	}

	var result struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal([]byte(out.Result), &result)
	if !mcpIsSessionVersion(result.ProtocolVersion) {
		out.Error = fmt.Sprintf("the server answered initialize with MCP %q, which Kurlo does not speak; it speaks %s", result.ProtocolVersion, mcpSpokenVersions())
		return out, nil, fmt.Errorf("%s", out.Error)
	}
	session := &mcpSession{id: mcpHeaderValue(httpResponse.Headers, mcpSessionHeader), version: result.ProtocolVersion}

	initialized := mcpHandshakeRequest(req, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, session)
	acknowledged := transport(initialized)
	if acknowledged.Error != "" || acknowledged.StatusCode >= 400 {
		reason := acknowledged.Error
		if reason == "" {
			reason = acknowledged.Status
		}
		out.Error = "the server did not accept notifications/initialized: " + reason
		return out, nil, fmt.Errorf("%s", out.Error)
	}

	r.remember(key, mcpEndpoint{session: session})
	out.ProtocolVersion = session.version
	out.SupportedVersions = []string{session.version}
	out.Warnings = append(out.Warnings, fmt.Sprintf("This server speaks MCP %s, so Kurlo opened a session with initialize and sends later calls in it.", session.version))
	return out, session, nil
}

func mcpHandshakeFailure(out model.McpResponse) string {
	switch {
	case out.Error != "":
		return out.Error
	case out.RPCErrorMessage != "":
		return out.RPCErrorMessage
	case out.HTTP.StatusCode >= 400:
		return out.HTTP.Status
	}
	return ""
}

func mcpHeaderValue(headers []model.KeyValue, name string) string {
	for _, header := range headers {
		if strings.EqualFold(header.Key, name) {
			return strings.TrimSpace(header.Value)
		}
	}
	return ""
}

func mcpSessionCall(req model.HttpRequest, transport mcpTransport, session *mcpSession) model.McpResponse {
	params, err := mcpBuildParams(req)
	if err != nil {
		return model.McpResponse{Error: err.Error(), ProtocolVersion: session.version}
	}
	delete(params, "_meta")
	delete(params, "inputResponses")
	delete(params, "requestState")
	prepared := mcpHandshakeRequest(req, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  req.McpMethod,
		"params":  params,
	}, session)
	prepared.PreRequestScript = req.PreRequestScript
	prepared.TestScript = req.TestScript
	out := mcpResponseFrom(prepared, transport(prepared), nil)
	out.ProtocolVersion = session.version
	return out
}

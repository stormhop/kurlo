package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type agentLiveSessions struct {
	ctx      context.Context
	sessions map[string]*agentLiveSession
	ws       *websocketManager
	sio      *socketIOManager
	sse      *sseManager
}

func newAgentLiveSessions(ctx context.Context, jars *cookieJarRegistry) *agentLiveSessions {
	return &agentLiveSessions{
		ctx: ctx, sessions: map[string]*agentLiveSession{},
		ws: newWebSocketManager(jars), sio: newSocketIOManager(jars), sse: newSSEManager(jars),
	}
}

func (l *agentLiveSessions) close() {
	for _, session := range l.sessions {
		session.cancel()
	}
	l.ws.disconnectAll()
	l.sio.disconnectAll()
}

type agentSessionEvent struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type agentLiveSession struct {
	id        string
	kind      string
	ctx       context.Context
	cancel    context.CancelFunc
	secrets   []string
	ready     chan error
	readyOnce sync.Once
	done      chan struct{}
	dropped   atomic.Int64
	messages  chan agentSessionEvent
	grpcSend  func(string, bool) error
	namespace string
}

func (s *agentLiveSession) opened(err error) {
	s.readyOnce.Do(func() { s.ready <- err })
}

func (s *agentLiveSession) finish() {
	s.opened(fmt.Errorf("connection ended before it was ready"))
	s.cancel()
	close(s.done)
}

func (s *agentLiveSession) push(kind string, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	var value any
	if json.Unmarshal(encoded, &value) != nil {
		return
	}
	value = redactMCPValue(value, s.secrets)
	encoded, err = json.Marshal(value)
	if err != nil {
		return
	}
	if len(encoded) > 16384 {
		preview, _ := mcpTruncate(string(encoded), 16384)
		value = map[string]any{"preview": preview, "truncated": true}
	}
	select {
	case s.messages <- agentSessionEvent{Type: kind, Data: value}:
	default:
		s.dropped.Add(1)
	}
}

func (s *mcpServer) toolOpenSession(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		Request     string         `json:"request"`
		Environment string         `json:"environment"`
		Variables   map[string]any `json:"variables"`
		TimeoutMs   int            `json:"timeoutMs"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	live := s.live
	if err := live.ctx.Err(); err != nil {
		return nil, err
	}
	if len(live.sessions) >= 8 {
		return nil, fmt.Errorf("close a session before opening another; this turn can hold up to eight sessions")
	}
	if args.TimeoutMs < 0 || args.TimeoutMs > 120000 {
		return nil, fmt.Errorf("timeoutMs must be between 0 and 120000")
	}
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil, err
	}
	req, err := mcpFindRequest(ws.requests, args.Request)
	if err != nil {
		return nil, err
	}
	kind := mcpRequestType(req)
	if strings.EqualFold(req.Method, "SSE") {
		kind = "sse"
	}
	switch kind {
	case "ws", "socketio", "sse", "grpc":
	default:
		return nil, fmt.Errorf("%s is a %s request; use run_request", mcpRequestPath(req), kind)
	}
	req = ws.withDefaults(req)
	run, err := s.prepareRun(ws.forRequest(req), args.Environment, args.Variables)
	if err != nil {
		return nil, err
	}

	id := uuid.NewString()
	sessionCtx, cancel := context.WithCancel(live.ctx)
	session := &agentLiveSession{
		id: id, kind: kind, ctx: sessionCtx, cancel: cancel, ready: make(chan error, 1), done: make(chan struct{}),
		messages: make(chan agentSessionEvent, 128),
	}
	kept := false
	defer func() {
		if !kept {
			cancel()
		}
	}()
	if kind == "grpc" {
		prepared, err := s.protocolGRPC(run, req, run.sm.GetEnvironment())
		if err != nil {
			return nil, err
		}
		session.secrets = run.secrets
		go session.runGRPC(prepared, run.sm)
	} else {
		prepared, err := s.protocolHTTP(run, req, run.sm.GetEnvironment())
		if err != nil {
			return nil, err
		}
		session.secrets = run.secrets
		settings := req.Settings
		prepared.WebSocketHandshakeTimeoutMs = settings.WSHandshakeTimeoutMs
		prepared.WebSocketReconnectAttempts = settings.WSReconnectAttempts
		prepared.WebSocketReconnectIntervalMs = settings.WSReconnectIntervalMs
		prepared.WebSocketMaxMessageSizeMb = settings.WSMaxMessageSizeMb
		prepared.WebSocketKeepAliveIntervalMs = settings.WSKeepAliveIntervalMs
		prepared.SSEDisableReconnect = settings.SSEDisableReconnect
		prepared.SSEReconnectIntervalMs = settings.SSEReconnectIntervalMs
		prepared.SocketIOClientVersion = settings.SIOClientVersion
		prepared.SocketIOPath = settings.SIOPath
		prepared.SocketIONamespace = settings.SIONamespace
		for _, event := range req.SIOEvents {
			if event.Enabled && strings.TrimSpace(event.Key) != "" {
				prepared.SocketIOListenEvents = append(prepared.SocketIOListenEvents, strings.TrimSpace(event.Key))
			}
		}
		live.connect(session, prepared)
	}
	timeout := args.TimeoutMs
	if timeout == 0 {
		timeout = defaultCLIRequestTimeoutMs
	}
	timer := time.NewTimer(time.Duration(timeout) * time.Millisecond)
	defer timer.Stop()
	select {
	case err := <-session.ready:
		if err != nil {
			return nil, fmt.Errorf("%s", redactSecrets(err.Error(), session.secrets))
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, fmt.Errorf("timed out opening the %s connection", kind)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	kept = true
	live.sessions[id] = session
	return map[string]any{"sessionId": id, "protocol": kind}, nil
}

func (l *agentLiveSessions) connect(session *agentLiveSession, req model.HttpRequest) {
	open := func(data any) {
		session.push("open", data)
		session.opened(nil)
	}
	var lastError string
	fail := func(message string) {
		lastError = message
		session.push("error", message)
	}
	done := func() {
		if lastError != "" {
			session.opened(fmt.Errorf("%s", lastError))
		}
		session.finish()
	}
	switch session.kind {
	case "ws":
		l.ws.connectWithCallbacks(session.ctx, session.id, req, websocketCallbacks{
			onOpen: func(ev model.WebSocketOpenEvent) {
				open(map[string]any{"status": ev.Status, "subprotocol": ev.Protocol})
			},
			onEvent:     func(ev model.WebSocketMessage) { session.push("message", ev) },
			onClose:     func(ev model.WebSocketCloseEvent) { session.push("close", ev) },
			onError:     func(ev model.WebSocketErrorEvent) { fail(ev.Message) },
			onReconnect: func(ev model.WebSocketReconnectEvent) { session.push("reconnecting", ev) },
			onDone:      done,
		})
		context.AfterFunc(session.ctx, func() { l.ws.disconnect(session.id) })
	case "socketio":
		session.namespace = req.SocketIONamespace
		l.sio.connectWithCallbacks(session.ctx, session.id, req, socketIOCallbacks{
			onOpen: func(ev model.SocketIOOpenEvent) {
				open(map[string]any{"status": ev.StatusCode, "namespace": ev.Namespace})
			},
			onEvent:     func(ev model.SocketIOMessage) { session.push("message", ev) },
			onClose:     func(ev model.SocketIOCloseEvent) { session.push("close", ev) },
			onError:     func(ev model.SocketIOErrorEvent) { fail(ev.Message) },
			onReconnect: func(ev model.SocketIOReconnectEvent) { session.push("reconnecting", ev) },
			onAck:       func(ev model.SocketIOAckEvent) { session.push("ack", ev) },
			onDone:      done,
		})
		context.AfterFunc(session.ctx, func() { l.sio.disconnect(session.id) })
	case "sse":
		go func() {
			defer done()
			l.sse.runStreamEvents(session.ctx, session.id, req, func(kind string, data any) {
				switch ev := data.(type) {
				case model.SSEOpenEvent:
					open(map[string]any{"status": ev.StatusCode, "timings": ev.Timings})
				case model.SSEErrorEvent:
					fail(ev.Message)
				default:
					session.push(strings.TrimPrefix(kind, "sse:"), data)
				}
			}, func(ev model.SSEEvent) { session.push("message", ev) })
		}()
	}
}

func (l *agentLiveSessions) session(id string) (*agentLiveSession, error) {
	session := l.sessions[id]
	if session == nil {
		return nil, fmt.Errorf("session does not belong to this turn or has been closed")
	}
	return session, nil
}

func (s *mcpServer) toolSendMessage(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		SessionID string            `json:"sessionId"`
		Data      string            `json:"data"`
		Type      string            `json:"type"`
		Encoding  string            `json:"encoding"`
		EventName string            `json:"eventName"`
		Args      []json.RawMessage `json:"args"`
		Ack       bool              `json:"ack"`
		EndStream bool              `json:"endStream"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	session, err := s.live.session(args.SessionID)
	if err != nil {
		return nil, err
	}
	if session.ctx.Err() != nil {
		return nil, fmt.Errorf("session is closed; read any remaining messages or open a new session")
	}
	sendError := func(message string) (any, error) {
		return nil, fmt.Errorf("%s", redactSecrets(message, session.secrets))
	}
	switch session.kind {
	case "ws":
		out := s.live.ws.send(session.id, model.WebSocketSendMessage{Type: defaultString(args.Type, "text"), Data: args.Data, Encoding: args.Encoding})
		if !out.OK {
			return sendError(out.Error)
		}
		return out, nil
	case "socketio":
		values := make([]string, len(args.Args))
		for i, arg := range args.Args {
			values[i] = string(arg)
		}
		out := s.live.sio.emit(session.id, model.SocketIOEmitMessage{EventName: args.EventName, Args: values, Namespace: session.namespace, Ack: args.Ack})
		if !out.OK {
			return sendError(out.Error)
		}
		return out, nil
	case "grpc":
		if err := session.grpcSend(args.Data, args.EndStream); err != nil {
			return sendError(err.Error())
		}
		return map[string]any{"ok": true}, nil
	default:
		return nil, fmt.Errorf("SSE is receive-only")
	}
}

func (s *mcpServer) toolReadMessages(ctx context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		SessionID string `json:"sessionId"`
		TimeoutMs *int   `json:"timeoutMs"`
		Limit     int    `json:"limit"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	session, err := s.live.session(args.SessionID)
	if err != nil {
		return nil, err
	}
	timeout := 1000
	if args.TimeoutMs != nil {
		timeout = *args.TimeoutMs
	}
	if timeout < 0 || timeout > 120000 || args.Limit < 0 || args.Limit > 32 {
		return nil, fmt.Errorf("timeoutMs must be between 0 and 120000 and limit must be at most 32")
	}
	limit := args.Limit
	if limit == 0 {
		limit = 10
	}
	events := []agentSessionEvent{}
	timer := time.NewTimer(time.Duration(timeout) * time.Millisecond)
	defer timer.Stop()
	timedOut := false
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case ev := <-session.messages:
		events = append(events, ev)
	case <-session.done:
	case <-timer.C:
		timedOut = true
	}
drain:
	for len(events) < limit {
		select {
		case ev := <-session.messages:
			events = append(events, ev)
		default:
			break drain
		}
	}
	closed := session.ctx.Err() != nil
	return map[string]any{
		"sessionId": session.id, "messages": events, "dropped": session.dropped.Swap(0),
		"closed": closed, "timedOut": timedOut && !closed && len(events) == 0, "remaining": len(session.messages),
	}, nil
}

func (s *mcpServer) toolCloseSession(_ context.Context, arguments json.RawMessage) (any, error) {
	var args struct {
		SessionID string `json:"sessionId"`
	}
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	session, err := s.live.session(args.SessionID)
	if err != nil {
		return nil, err
	}
	session.cancel()
	s.live.ws.disconnect(session.id)
	s.live.sio.disconnect(session.id)
	delete(s.live.sessions, session.id)
	return map[string]any{"sessionId": session.id, "closed": true}, nil
}

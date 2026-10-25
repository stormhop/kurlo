package api

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const websocketWriteTimeout = 10 * time.Second

func websocketWriteDeadline(size int) time.Time {
	return time.Now().Add(websocketWriteTimeout + time.Duration(size/(64<<10))*time.Second)
}

const defaultWebSocketKeepAliveInterval = 30 * time.Second

type websocketSession struct {
	cancel  context.CancelFunc
	conn    *websocket.Conn
	id      uint64
	writeMu sync.Mutex
}

type websocketCallbacks struct {
	onOpen      func(model.WebSocketOpenEvent)
	onEvent     func(model.WebSocketMessage)
	onClose     func(model.WebSocketCloseEvent)
	onError     func(model.WebSocketErrorEvent)
	onReconnect func(model.WebSocketReconnectEvent)
}

type websocketManager struct {
	mu       sync.Mutex
	sessions map[string]*websocketSession
	seq      uint64
	jars     *cookieJarRegistry
}

func newWebSocketManager(jars *cookieJarRegistry) *websocketManager {
	if jars == nil {
		jars = newCookieJarRegistry()
	}
	return &websocketManager{sessions: make(map[string]*websocketSession), jars: jars}
}

func (m *websocketManager) connect(appCtx context.Context, sessionID string, req model.HttpRequest) {
	m.connectWithCallbacks(appCtx, sessionID, req, m.runtimeCallbacks(appCtx, sessionID))
}

func (m *websocketManager) connectWithCallbacks(appCtx context.Context, sessionID string, req model.HttpRequest, callbacks websocketCallbacks) {
	wsCtx, cancel := context.WithCancel(appCtx)

	m.mu.Lock()
	if existing, ok := m.sessions[sessionID]; ok {
		existing.cancel()
		if existing.conn != nil {
			_ = existing.conn.Close()
		}
	}
	m.seq++
	seq := m.seq
	m.sessions[sessionID] = &websocketSession{cancel: cancel, id: seq}
	m.mu.Unlock()

	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("kurlo: websocket session %s panicked: %v", sessionID, r)
			}
			m.mu.Lock()
			if sess, ok := m.sessions[sessionID]; ok && sess.id == seq {
				delete(m.sessions, sessionID)
			}
			m.mu.Unlock()
		}()
		m.runConnectionWithCallbacks(wsCtx, sessionID, seq, req, m.currentSessionCallbacks(sessionID, seq, callbacks))
	}()
}

func (m *websocketManager) replaced(sessionID string, seq uint64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	sess, ok := m.sessions[sessionID]
	return ok && sess.id != seq
}

func (m *websocketManager) currentSessionCallbacks(sessionID string, seq uint64, callbacks websocketCallbacks) websocketCallbacks {
	guarded := callbacks
	if callbacks.onOpen != nil {
		guarded.onOpen = func(ev model.WebSocketOpenEvent) {
			if !m.replaced(sessionID, seq) {
				callbacks.onOpen(ev)
			}
		}
	}
	if callbacks.onEvent != nil {
		guarded.onEvent = func(ev model.WebSocketMessage) {
			if !m.replaced(sessionID, seq) {
				callbacks.onEvent(ev)
			}
		}
	}
	if callbacks.onClose != nil {
		guarded.onClose = func(ev model.WebSocketCloseEvent) {
			if !m.replaced(sessionID, seq) {
				callbacks.onClose(ev)
			}
		}
	}
	if callbacks.onError != nil {
		guarded.onError = func(ev model.WebSocketErrorEvent) {
			if !m.replaced(sessionID, seq) {
				callbacks.onError(ev)
			}
		}
	}
	if callbacks.onReconnect != nil {
		guarded.onReconnect = func(ev model.WebSocketReconnectEvent) {
			if !m.replaced(sessionID, seq) {
				callbacks.onReconnect(ev)
			}
		}
	}
	return guarded
}

func (m *websocketManager) runtimeCallbacks(appCtx context.Context, sessionID string) websocketCallbacks {
	const batchWindow = 50 * time.Millisecond
	const maxBatchSize = 100

	batch := newEventBatcher[model.WebSocketMessage](maxBatchSize, batchWindow,
		func(ev model.WebSocketMessage) {
			runtime.EventsEmit(appCtx, "ws:event", model.WebSocketPayload{SessionID: sessionID, Event: ev})
		},
		func(events []model.WebSocketMessage) {
			runtime.EventsEmit(appCtx, "ws:events", model.WebSocketBatchPayload{SessionID: sessionID, Events: events})
		},
	)

	return websocketCallbacks{
		onOpen: func(ev model.WebSocketOpenEvent) {
			runtime.EventsEmit(appCtx, "ws:open", ev)
		},
		onEvent: func(ev model.WebSocketMessage) {
			batch.add(ev)
		},
		onClose: func(ev model.WebSocketCloseEvent) {
			batch.flush()
			runtime.EventsEmit(appCtx, "ws:close", ev)
		},
		onError: func(ev model.WebSocketErrorEvent) {
			batch.flush()
			runtime.EventsEmit(appCtx, "ws:error", ev)
		},
		onReconnect: func(ev model.WebSocketReconnectEvent) {
			batch.flush()
			runtime.EventsEmit(appCtx, "ws:reconnecting", ev)
		},
	}
}

func (m *websocketManager) disconnect(sessionID string) {
	m.mu.Lock()
	if sess, ok := m.sessions[sessionID]; ok {
		sess.cancel()
		if sess.conn != nil {
			_ = sess.conn.Close()
		}
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()
}

func (m *websocketManager) disconnectAll() {
	m.mu.Lock()
	sessions := m.sessions
	m.sessions = make(map[string]*websocketSession)
	m.mu.Unlock()
	for _, sess := range sessions {
		sess.cancel()
		if sess.conn != nil {
			_ = sess.conn.Close()
		}
	}
}

func (m *websocketManager) send(sessionID string, msg model.WebSocketSendMessage) model.WebSocketSendResult {
	m.mu.Lock()
	sess, ok := m.sessions[sessionID]
	var conn *websocket.Conn
	if ok {
		conn = sess.conn
	}
	m.mu.Unlock()
	if !ok || conn == nil {
		return model.WebSocketSendResult{Error: "WebSocket is not connected"}
	}

	payload, err := websocketPayloadBytes(msg)
	if err != nil {
		return model.WebSocketSendResult{Error: err.Error()}
	}

	sess.writeMu.Lock()
	defer sess.writeMu.Unlock()

	deadline := time.Now().Add(websocketWriteTimeout)
	switch strings.ToLower(msg.Type) {
	case "", "text":
		if err = conn.SetWriteDeadline(websocketWriteDeadline(len(payload))); err == nil {
			err = conn.WriteMessage(websocket.TextMessage, payload)
		}
	case "binary":
		if err = conn.SetWriteDeadline(websocketWriteDeadline(len(payload))); err == nil {
			err = conn.WriteMessage(websocket.BinaryMessage, payload)
		}
	case "ping":
		err = conn.WriteControl(websocket.PingMessage, payload, deadline)
	case "pong":
		err = conn.WriteControl(websocket.PongMessage, payload, deadline)
	case "close":
		code := msg.Code
		if code == 0 {
			code = websocket.CloseNormalClosure
		}
		err = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, msg.Data), deadline)
		sess.cancel()
	default:
		return model.WebSocketSendResult{Error: fmt.Sprintf("unsupported WebSocket message type %q", msg.Type)}
	}
	if err != nil {
		return model.WebSocketSendResult{Error: err.Error()}
	}
	return model.WebSocketSendResult{OK: true}
}

func websocketPayloadBytes(msg model.WebSocketSendMessage) ([]byte, error) {
	if strings.EqualFold(msg.Encoding, "base64") {
		payload, err := base64.StdEncoding.DecodeString(msg.Data)
		if err != nil {
			return nil, fmt.Errorf("invalid base64 payload: %w", err)
		}
		return payload, nil
	}
	return []byte(msg.Data), nil
}

func (m *websocketManager) runConnectionWithCallbacks(ctx context.Context, sessionID string, seq uint64, req model.HttpRequest, callbacks websocketCallbacks) {
	attempts := websocketReconnectAttempts(req)
	for attempt := 0; ; attempt++ {
		shouldRetry := m.runConnectionOnceWithCallbacks(ctx, sessionID, seq, req, callbacks)
		if !shouldRetry || ctx.Err() != nil || attempt >= attempts {
			return
		}
		interval := websocketReconnectInterval(req)
		if callbacks.onReconnect != nil {
			callbacks.onReconnect(model.WebSocketReconnectEvent{
				SessionID:   sessionID,
				Attempt:     attempt + 1,
				MaxAttempts: attempts,
				IntervalMs:  int(interval / time.Millisecond),
				Timestamp:   time.Now().UnixMilli(),
			})
		}
		if interval > 0 {
			select {
			case <-time.After(interval):
			case <-ctx.Done():
				return
			}
		}
	}
}

func (m *websocketManager) runConnectionOnceWithCallbacks(ctx context.Context, sessionID string, seq uint64, req model.HttpRequest, callbacks websocketCallbacks) bool {
	emitError := func(msg string) {
		callbacks.onError(model.WebSocketErrorEvent{SessionID: sessionID, Message: msg, Timestamp: time.Now().UnixMilli()})
	}
	emitClose := func(message string, code int) {
		callbacks.onClose(model.WebSocketCloseEvent{SessionID: sessionID, Message: message, Code: code, Timestamp: time.Now().UnixMilli()})
	}

	if strings.Contains(req.URL, "{{") {
		emitError("URL contains an unresolved variable — make sure all {{variables}} are defined in the active environment")
		return false
	}
	u, err := buildWebSocketURL(req)
	if err != nil {
		emitError(err.Error())
		return false
	}

	headers := make(http.Header)
	if browserSecurityActive(req) {
		headers.Set("User-Agent", browserLikeUserAgent)
	} else {
		headers.Set("User-Agent", "Kurlo/"+appVersion)
	}
	_, _ = applyUserHeaders(headers, req.Headers)
	if notice := websocketHandshakeHeaderNotice(dropWebSocketHandshakeHeaders(headers)); notice != "" {
		callbacks.onEvent(newWebSocketMessage("system", "notice", nil, "", 0, true, false, notice))
	}
	httpReq := &http.Request{Method: http.MethodGet, URL: cloneURL(u), Header: headers}
	if err := auth.Apply(httpReq, req.Auth); err != nil {
		emitError("auth error: " + err.Error())
		return false
	}
	browserCtx, err := prepareBrowserSecurity(req, headers, u, browserKindHandshake)
	if err != nil {
		emitError(err.Error())
		return false
	}
	if msg := validateBrowserCSP(req, u, browserCtx); msg != "" {
		emitError("CSP error: " + msg)
		return false
	}
	if msg := blockedBrowserNetworkAccess(u, browserCtx); msg != "" {
		emitError("Browser error: " + msg)
		return false
	}
	for _, warning := range browserNetworkAccessWarnings(u, "", false, browserCtx) {
		callbacks.onEvent(newWebSocketMessage("system", "notice", nil, "", 0, true, false, warning))
	}
	skipCookieJar := req.DisableCookieJar
	if browserCtx.active && browserCtx.crossOrigin && !browserCtx.withCredentials {
		skipCookieJar = true
		headers.Del("Cookie")
	}

	dialer := websocket.Dialer{
		Proxy:            proxyForRequest(req),
		HandshakeTimeout: websocketHandshakeTimeout(req),
	}
	var wsJar *trackedCookieJar
	if !skipCookieJar {
		wsJar = m.jars.jar(req.WorkspaceID)
	}
	if wsJar != nil {
		if cookieURL := websocketCookieURL(httpReq.URL); cookieURL != nil {
			for _, cookie := range wsJar.Cookies(cookieURL) {
				httpReq.AddCookie(cookie)
			}
		}
	}
	if !req.EnableSSLVerification {
		dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}
	} else {
		dialer.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	conn, resp, err := dialer.DialContext(ctx, httpReq.URL.String(), httpReq.Header)
	if err != nil {
		if ctx.Err() != nil {
			emitClose("Disconnected", websocket.CloseNormalClosure)
			return false
		}
		if resp != nil {
			emitError(fmt.Sprintf("WebSocket handshake failed: %s", resp.Status))
			return websocketHandshakeRetriable(resp.StatusCode)
		}
		emitError(websocketConnectionError(err, u, websocketHandshakeTimeout(req)))
		return true
	}
	if wsJar != nil && resp != nil {
		if cookieURL := websocketCookieURL(httpReq.URL); cookieURL != nil {
			wsJar.SetCookies(cookieURL, resp.Cookies())
		}
	}
	defer func() {
		_ = conn.Close()
		m.mu.Lock()
		if sess, ok := m.sessions[sessionID]; ok && sess.id == seq && sess.conn == conn {
			sess.conn = nil
		}
		m.mu.Unlock()
	}()
	if limit := websocketReadLimit(req); limit > 0 {
		conn.SetReadLimit(limit)
	}

	m.mu.Lock()
	sess, ok := m.sessions[sessionID]
	if !ok || sess.id != seq {
		m.mu.Unlock()
		return false
	}
	sess.conn = conn
	m.mu.Unlock()

	readIdleTimeout := websocketReadIdleTimeout(req)
	resetReadDeadline := func() {
		if readIdleTimeout > 0 {
			_ = conn.SetReadDeadline(time.Now().Add(readIdleTimeout))
		}
	}
	resetReadDeadline()

	conn.SetPingHandler(func(appData string) error {
		resetReadDeadline()
		callbacks.onEvent(newWebSocketMessage("incoming", "ping", []byte(appData), "", 0, true, false, ""))
		sess.writeMu.Lock()
		defer sess.writeMu.Unlock()
		return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(websocketWriteTimeout))
	})
	conn.SetPongHandler(func(appData string) error {
		resetReadDeadline()
		callbacks.onEvent(newWebSocketMessage("incoming", "pong", []byte(appData), "", 0, true, false, ""))
		return nil
	})

	callbacks.onOpen(model.WebSocketOpenEvent{
		SessionID:       sessionID,
		URL:             httpReq.URL.String(),
		Status:          responseStatus(resp),
		RequestHeaders:  headerValues(httpReq.Header),
		ResponseHeaders: headerKeyValues(resp),
		Headers:         headerKeyValues(resp),
		Protocol:        conn.Subprotocol(),
		Timestamp:       time.Now().UnixMilli(),
	})

	if interval := websocketKeepAliveInterval(req); interval > 0 {
		stopKeepAlive := make(chan struct{})
		defer close(stopKeepAlive)
		go m.keepAlive(ctx, sess, conn, interval, stopKeepAlive)
	}

	for {
		resetReadDeadline()
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				emitClose("Disconnected", websocket.CloseNormalClosure)
				return false
			}
			if closeErr, ok := err.(*websocket.CloseError); ok {
				emitClose(websocketCloseMessage(closeErr), closeErr.Code)
				return websocketShouldReconnect(req, closeErr.Code)
			}
			emitError("WebSocket read error: " + err.Error())
			return websocketReadErrorShouldReconnect(req, err)
		}
		switch messageType {
		case websocket.TextMessage:
			callbacks.onEvent(newWebSocketMessage("incoming", "text", data, "plain", 0, false, false, ""))
		case websocket.BinaryMessage:
			callbacks.onEvent(newWebSocketMessage("incoming", "binary", data, "base64", 0, false, false, ""))
		case websocket.CloseMessage:
			emitClose("Connection closed by server", websocket.CloseNormalClosure)
			return false
		}
	}
}

func websocketHandshakeRetriable(statusCode int) bool {
	return statusCode == http.StatusTooManyRequests || statusCode >= http.StatusInternalServerError
}

func websocketHandshakeTimeout(req model.HttpRequest) time.Duration {
	if req.WebSocketHandshakeTimeoutMs > 0 {
		return time.Duration(req.WebSocketHandshakeTimeoutMs) * time.Millisecond
	}
	return 0
}

func (m *websocketManager) keepAlive(ctx context.Context, sess *websocketSession, conn *websocket.Conn, interval time.Duration, stop <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			sess.writeMu.Lock()
			err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(websocketWriteTimeout))
			sess.writeMu.Unlock()
			if err != nil {
				return
			}
		case <-ctx.Done():
			return
		case <-stop:
			return
		}
	}
}

func websocketKeepAliveInterval(req model.HttpRequest) time.Duration {
	if req.WebSocketKeepAliveIntervalMs < 0 {
		return 0
	}
	if req.WebSocketKeepAliveIntervalMs == 0 {
		return defaultWebSocketKeepAliveInterval
	}
	return time.Duration(req.WebSocketKeepAliveIntervalMs) * time.Millisecond
}

var websocketHandshakeHeaders = []string{"Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Extensions", "Sec-WebSocket-Accept"}

func dropWebSocketHandshakeHeaders(headers http.Header) []string {
	var dropped []string
	for _, name := range websocketHandshakeHeaders {
		key := http.CanonicalHeaderKey(name)
		if _, ok := headers[key]; ok {
			delete(headers, key)
			dropped = append(dropped, name)
		}
	}
	return dropped
}

func websocketHandshakeHeaderNotice(names []string) string {
	if len(names) == 0 {
		return ""
	}
	return "Not sent: " + strings.Join(names, ", ") + ". Kurlo negotiates these itself during the WebSocket handshake."
}

func websocketReadIdleTimeout(req model.HttpRequest) time.Duration {
	interval := websocketKeepAliveInterval(req)
	if interval <= 0 {
		return 0
	}
	return max(90*time.Second, 2*interval+10*time.Second)
}

func websocketReadLimit(req model.HttpRequest) int64 {
	const defaultReadLimit = 64 * 1024 * 1024
	if req.WebSocketMaxMessageSizeMb <= 0 {
		return defaultReadLimit
	}
	return int64(req.WebSocketMaxMessageSizeMb) * 1024 * 1024
}

func websocketReconnectAttempts(req model.HttpRequest) int {
	if req.WebSocketReconnectAttempts < 0 {
		return 0
	}
	return req.WebSocketReconnectAttempts
}

func websocketReconnectInterval(req model.HttpRequest) time.Duration {
	if req.WebSocketReconnectIntervalMs <= 0 {
		return 0
	}
	return time.Duration(req.WebSocketReconnectIntervalMs) * time.Millisecond
}

func websocketShouldReconnect(req model.HttpRequest, code int) bool {
	if websocketReconnectAttempts(req) <= 0 {
		return false
	}
	switch code {
	case websocket.CloseNormalClosure, websocket.CloseGoingAway:
		return false
	default:
		return true
	}
}

func websocketReadErrorShouldReconnect(req model.HttpRequest, err error) bool {
	if err == nil {
		return false
	}
	if strings.Contains(strings.ToLower(err.Error()), "read limit") {
		return false
	}
	return websocketShouldReconnect(req, websocket.CloseAbnormalClosure)
}

func websocketCookieURL(u *url.URL) *url.URL {
	if u == nil {
		return nil
	}
	cookieURL := cloneURL(u)
	switch cookieURL.Scheme {
	case "ws":
		cookieURL.Scheme = "http"
	case "wss":
		cookieURL.Scheme = "https"
	case "http", "https":
	default:
		return nil
	}
	return cookieURL
}

func buildWebSocketURL(req model.HttpRequest) (*url.URL, error) {
	if isBarePortLikeURL(req.URL) {
		return nil, fmt.Errorf("%s", invalidBarePortURLMessage("ws"))
	}
	raw := normalizeWebSocketURL(req.URL)
	if raw == "" {
		return nil, fmt.Errorf("Empty URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("Invalid URL: %s", err)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return nil, fmt.Errorf("unsupported WebSocket URL scheme %q. Use ws:// or wss://.", u.Scheme)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("invalid URL: missing host. Try ws://localhost:8080/ws")
	}
	if isNumericHostname(u.Hostname()) {
		return nil, fmt.Errorf("%s", invalidBarePortURLMessage("ws"))
	}
	applyQueryParams(u, req)
	return u, nil
}

func normalizeWebSocketURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.HasPrefix(trimmed, "{{") {
		return trimmed
	}
	if strings.HasPrefix(trimmed, "//") {
		return "ws:" + trimmed
	}
	if !strings.Contains(trimmed, "://") {
		return "ws://" + trimmed
	}
	return trimmed
}

func websocketConnectionError(err error, target *url.URL, timeout time.Duration) string {
	if err == nil {
		return ""
	}
	if target == nil {
		return strings.TrimPrefix(strings.TrimSpace(err.Error()), "Error: ")
	}
	requestTarget := cloneURL(target)
	switch requestTarget.Scheme {
	case "ws":
		requestTarget.Scheme = "http"
	case "wss":
		requestTarget.Scheme = "https"
	}
	return strings.TrimPrefix(formatRequestError(err, requestTarget, timeout), "Error: ")
}

func cloneURL(u *url.URL) *url.URL {
	copy := *u
	return &copy
}

func responseStatus(resp *http.Response) string {
	if resp == nil {
		return "101 Switching Protocols"
	}
	return resp.Status
}

func headerKeyValues(resp *http.Response) []model.KeyValue {
	if resp == nil {
		return nil
	}
	return headerValues(resp.Header)
}

func headerValues(headers http.Header) []model.KeyValue {
	keys := make([]string, 0, len(headers))
	for k := range headers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]model.KeyValue, 0, len(keys))
	for _, k := range keys {
		for _, v := range headers[k] {
			out = append(out, model.KeyValue{Key: k, Value: v, Enabled: true})
		}
	}
	return out
}

func newWebSocketMessage(direction string, typ string, payload []byte, encoding string, code int, system bool, isError bool, message string) model.WebSocketMessage {
	data := string(payload)
	if encoding == "base64" {
		data = base64.StdEncoding.EncodeToString(payload)
	}
	return model.WebSocketMessage{
		ID:        newEventID(),
		Direction: direction,
		Type:      typ,
		Data:      data,
		Encoding:  encoding,
		Size:      len(payload),
		Code:      code,
		Timestamp: time.Now().UnixMilli(),
		IsSystem:  system,
		IsError:   isError,
		Message:   message,
	}
}

var eventIDCounter atomic.Uint64

func newEventID() string {
	return fmt.Sprintf("evt-%d", eventIDCounter.Add(1))
}

func websocketCloseMessage(err *websocket.CloseError) string {
	reason := strings.TrimSpace(err.Text)
	lowerReason := strings.ToLower(reason)
	switch err.Code {
	case websocket.CloseNormalClosure:
		if reason != "" {
			return "Connection closed normally: " + reason
		}
		return "Connection closed normally."
	case websocket.CloseGoingAway:
		if reason != "" {
			return "Server closed the connection: " + reason
		}
		return "Server closed the connection."
	case websocket.CloseAbnormalClosure:
		if strings.Contains(lowerReason, "unexpected eof") {
			return "Connection closed unexpectedly. The server ended the connection without a close frame."
		}
		if reason != "" {
			return "Connection closed unexpectedly: " + reason
		}
		return "Connection closed unexpectedly."
	case websocket.CloseNoStatusReceived:
		return "Connection closed without a status code."
	case websocket.CloseMessageTooBig:
		return "Message is too large for this WebSocket connection."
	case websocket.ClosePolicyViolation:
		if reason != "" {
			return "Server closed the connection because of a policy violation: " + reason
		}
		return "Server closed the connection because of a policy violation."
	case websocket.CloseProtocolError:
		if reason != "" {
			return "WebSocket protocol error: " + reason
		}
		return "WebSocket protocol error."
	case websocket.CloseUnsupportedData:
		return "Server closed the connection because the message type is not supported."
	}
	if reason != "" {
		return "Connection closed: " + reason
	}
	return "Connection closed."
}

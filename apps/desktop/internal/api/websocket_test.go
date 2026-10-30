package api

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type wsTestEmitter struct {
	opens      chan model.WebSocketOpenEvent
	events     chan model.WebSocketMessage
	closes     chan model.WebSocketCloseEvent
	errors     chan model.WebSocketErrorEvent
	reconnects chan model.WebSocketReconnectEvent
}

func newWSTestEmitter() *wsTestEmitter {
	return &wsTestEmitter{
		opens:      make(chan model.WebSocketOpenEvent, 8),
		events:     make(chan model.WebSocketMessage, 32),
		closes:     make(chan model.WebSocketCloseEvent, 8),
		errors:     make(chan model.WebSocketErrorEvent, 8),
		reconnects: make(chan model.WebSocketReconnectEvent, 8),
	}
}

func (e *wsTestEmitter) callbacks() websocketCallbacks {
	return websocketCallbacks{
		onOpen:      func(ev model.WebSocketOpenEvent) { e.opens <- ev },
		onEvent:     func(ev model.WebSocketMessage) { e.events <- ev },
		onClose:     func(ev model.WebSocketCloseEvent) { e.closes <- ev },
		onError:     func(ev model.WebSocketErrorEvent) { e.errors <- ev },
		onReconnect: func(ev model.WebSocketReconnectEvent) { e.reconnects <- ev },
	}
}

func waitWSOpen(t *testing.T, ch <-chan model.WebSocketOpenEvent) model.WebSocketOpenEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for websocket open")
		return model.WebSocketOpenEvent{}
	}
}

func waitWSEvent(t *testing.T, ch <-chan model.WebSocketMessage, typ string) model.WebSocketMessage {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case ev := <-ch:
			if ev.Type == typ {
				return ev
			}
		case <-deadline:
			t.Fatalf("timed out waiting for websocket event %q", typ)
			return model.WebSocketMessage{}
		}
	}
}

func waitWSClose(t *testing.T, ch <-chan model.WebSocketCloseEvent) model.WebSocketCloseEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for websocket close")
		return model.WebSocketCloseEvent{}
	}
}

func waitWSError(t *testing.T, ch <-chan model.WebSocketErrorEvent) model.WebSocketErrorEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for websocket error")
		return model.WebSocketErrorEvent{}
	}
}

func waitWSReconnect(t *testing.T, ch <-chan model.WebSocketReconnectEvent) model.WebSocketReconnectEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for websocket reconnect event")
		return model.WebSocketReconnectEvent{}
	}
}

func wsURLFromHTTP(serverURL string) string {
	return "ws" + strings.TrimPrefix(serverURL, "http")
}

func TestWebSocketConnectReceivesTextAndSendsText(t *testing.T) {
	upgrader := websocket.Upgrader{}
	handshakeSeen := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != "abc" {
			t.Errorf("expected token query param, got %q", r.URL.RawQuery)
		}
		if got := r.Header.Get("X-Trace"); got != "trace-1" {
			t.Errorf("expected custom header, got %q", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret-token" {
			t.Errorf("expected bearer auth, got %q", got)
		}
		header := http.Header{}
		header.Set("X-Handshake", "ok")
		conn, err := upgrader.Upgrade(w, r, header)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		handshakeSeen <- struct{}{}
		_ = conn.WriteMessage(websocket.TextMessage, []byte("welcome"))
		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			_ = conn.WriteMessage(mt, append([]byte("echo:"), msg...))
		}
	}))
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "session-1", model.HttpRequest{
		URL: wsURLFromHTTP(server.URL) + "/socket",
		Params: []model.KeyValue{
			{Key: "token", Value: "abc", Enabled: true},
		},
		Headers: []model.KeyValue{
			{Key: "X-Trace", Value: "trace-1", Enabled: true},
		},
		Auth:                  model.AuthConfig{Type: "bearer", Token: "secret-token"},
		EnableSSLVerification: true,
		TimeoutMs:             2000,
	}, em.callbacks())
	defer manager.disconnect("session-1")

	open := waitWSOpen(t, em.opens)
	if !strings.Contains(open.URL, "token=abc") {
		t.Fatalf("expected open URL to include query param, got %q", open.URL)
	}
	if open.Status != "101 Switching Protocols" {
		t.Fatalf("expected switching protocols status, got %q", open.Status)
	}
	if len(open.Headers) == 0 {
		t.Fatalf("expected handshake response headers")
	}
	<-handshakeSeen

	welcome := waitWSEvent(t, em.events, "text")
	if welcome.Direction != "incoming" || welcome.Data != "welcome" {
		t.Fatalf("unexpected welcome event: %+v", welcome)
	}

	result := manager.send("session-1", model.WebSocketSendMessage{Type: "text", Data: "hello"})
	if !result.OK || result.Error != "" {
		t.Fatalf("send text failed: %+v", result)
	}
	echo := waitWSEvent(t, em.events, "text")
	if echo.Data != "echo:hello" {
		t.Fatalf("expected echo text, got %+v", echo)
	}
}

func TestWebSocketSendsAndStoresCookies(t *testing.T) {
	upgrader := websocket.Upgrader{}
	cookieHeaderSeen := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookieHeaderSeen <- r.Header.Get("Cookie")
		header := http.Header{}
		header.Add("Set-Cookie", "wsSeen=1; Path=/")
		conn, err := upgrader.Upgrade(w, r, header)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		_, _, _ = conn.ReadMessage()
	}))
	defer server.Close()

	jar := newTrackedCookieJar()
	cookieURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse cookie url: %v", err)
	}
	jar.SetCookies(cookieURL, []*http.Cookie{{Name: "session", Value: "abc", Path: "/"}})

	manager := newWebSocketManager(singleJarRegistry(jar))
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "session-cookie", model.HttpRequest{
		URL:                   wsURLFromHTTP(server.URL),
		EnableSSLVerification: true,
	}, em.callbacks())
	defer manager.disconnect("session-cookie")

	waitWSOpen(t, em.opens)
	select {
	case got := <-cookieHeaderSeen:
		if !strings.Contains(got, "session=abc") {
			t.Fatalf("expected websocket handshake cookie, got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not see websocket handshake")
	}

	cookies := jar.ListCookies()
	found := false
	for _, cookie := range cookies {
		if cookie.Name == "wsSeen" && cookie.Value == "1" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected Set-Cookie from websocket handshake to be stored, got %+v", cookies)
	}
}

func TestWebSocketBinaryPingPongAndClose(t *testing.T) {
	upgrader := websocket.Upgrader{}
	pingSeen := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		conn.SetPingHandler(func(appData string) error {
			pingSeen <- appData
			return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(time.Second))
		})
		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if mt == websocket.BinaryMessage {
				_ = conn.WriteMessage(websocket.BinaryMessage, msg)
			}
		}
	}))
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "session-2", model.HttpRequest{
		URL:                   wsURLFromHTTP(server.URL),
		EnableSSLVerification: true,
		TimeoutMs:             2000,
	}, em.callbacks())
	waitWSOpen(t, em.opens)

	result := manager.send("session-2", model.WebSocketSendMessage{Type: "ping", Data: "are-you-there"})
	if !result.OK {
		t.Fatalf("send ping failed: %+v", result)
	}
	select {
	case got := <-pingSeen:
		if got != "are-you-there" {
			t.Fatalf("unexpected ping payload %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not receive ping")
	}
	pong := waitWSEvent(t, em.events, "pong")
	if pong.Data != "are-you-there" {
		t.Fatalf("unexpected pong event: %+v", pong)
	}

	payload := []byte{1, 2, 3, 4}
	result = manager.send("session-2", model.WebSocketSendMessage{Type: "binary", Data: base64.StdEncoding.EncodeToString(payload), Encoding: "base64"})
	if !result.OK {
		t.Fatalf("send binary failed: %+v", result)
	}
	binary := waitWSEvent(t, em.events, "binary")
	if binary.Encoding != "base64" || binary.Data != base64.StdEncoding.EncodeToString(payload) || binary.Size != len(payload) {
		t.Fatalf("unexpected binary event: %+v", binary)
	}

	result = manager.send("session-2", model.WebSocketSendMessage{Type: "close", Data: "bye", Code: websocket.CloseNormalClosure})
	if !result.OK {
		t.Fatalf("send close failed: %+v", result)
	}
	closeEvent := waitWSClose(t, em.closes)
	if closeEvent.Code != websocket.CloseNormalClosure {
		t.Fatalf("expected normal close code, got %+v", closeEvent)
	}
}

func TestWebSocketDisconnectCancelsSession(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		_, _, _ = conn.ReadMessage()
	}))
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "session-3", model.HttpRequest{
		URL:                   wsURLFromHTTP(server.URL),
		EnableSSLVerification: true,
		TimeoutMs:             2000,
	}, em.callbacks())
	waitWSOpen(t, em.opens)
	manager.disconnect("session-3")
	closeEvent := waitWSClose(t, em.closes)
	if closeEvent.Message != "Disconnected" {
		t.Fatalf("expected manual disconnect close, got %+v", closeEvent)
	}
	result := manager.send("session-3", model.WebSocketSendMessage{Type: "text", Data: "late"})
	if result.OK || result.Error == "" {
		t.Fatalf("expected send after disconnect to fail, got %+v", result)
	}
}

func TestWebSocketReconnectsAfterAbnormalClose(t *testing.T) {
	upgrader := websocket.Upgrader{}
	var connections atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		if connections.Add(1) == 1 {
			_ = conn.UnderlyingConn().Close()
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.TextMessage, []byte("reconnected"))
		_, _, _ = conn.ReadMessage()
	}))
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "session-reconnect", model.HttpRequest{
		URL:                          wsURLFromHTTP(server.URL),
		EnableSSLVerification:        true,
		WebSocketReconnectAttempts:   1,
		WebSocketReconnectIntervalMs: 10,
	}, em.callbacks())
	defer manager.disconnect("session-reconnect")

	waitWSOpen(t, em.opens)
	closeEvent := waitWSClose(t, em.closes)
	if closeEvent.Code != websocket.CloseAbnormalClosure {
		t.Fatalf("expected abnormal close before reconnect, got %+v", closeEvent)
	}
	reconnectEvent := waitWSReconnect(t, em.reconnects)
	if reconnectEvent.Attempt != 1 || reconnectEvent.MaxAttempts != 1 || reconnectEvent.IntervalMs != 10 {
		t.Fatalf("unexpected reconnect event: %+v", reconnectEvent)
	}
	waitWSOpen(t, em.opens)
	event := waitWSEvent(t, em.events, "text")
	if event.Data != "reconnected" {
		t.Fatalf("expected reconnected message, got %+v", event)
	}
	if got := connections.Load(); got != 2 {
		t.Fatalf("expected two websocket connections, got %d", got)
	}
}

func TestWebSocketReconnectsAfterInitialHandshakeFailure(t *testing.T) {
	upgrader := websocket.Upgrader{}
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if attempts.Add(1) == 1 {
			http.Error(w, "try again", http.StatusServiceUnavailable)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.TextMessage, []byte("connected"))
		_, _, _ = conn.ReadMessage()
	}))
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "session-initial-retry", model.HttpRequest{
		URL:                          wsURLFromHTTP(server.URL),
		EnableSSLVerification:        true,
		WebSocketReconnectAttempts:   1,
		WebSocketReconnectIntervalMs: 10,
	}, em.callbacks())
	defer manager.disconnect("session-initial-retry")

	errEvent := waitWSError(t, em.errors)
	if !strings.Contains(errEvent.Message, "503") {
		t.Fatalf("expected handshake status error, got %+v", errEvent)
	}
	reconnectEvent := waitWSReconnect(t, em.reconnects)
	if reconnectEvent.Attempt != 1 || reconnectEvent.MaxAttempts != 1 {
		t.Fatalf("unexpected reconnect event: %+v", reconnectEvent)
	}
	waitWSOpen(t, em.opens)
	event := waitWSEvent(t, em.events, "text")
	if event.Data != "connected" {
		t.Fatalf("expected connected message, got %+v", event)
	}
	if got := attempts.Load(); got != 2 {
		t.Fatalf("expected two websocket attempts, got %d", got)
	}
}

func TestWebSocketConnectionErrors(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want string
	}{
		{name: "empty", url: "", want: "Empty URL"},
		{name: "unresolved", url: "{{socketUrl}}", want: "unresolved variable"},
		{name: "unsupported scheme", url: "ftp://example.test/socket", want: "unsupported WebSocket URL scheme"},
		{name: "missing host", url: "ws:///socket", want: "missing host"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manager := newWebSocketManager(nil)
			em := newWSTestEmitter()
			manager.connectWithCallbacks(context.Background(), "bad-"+tt.name, model.HttpRequest{URL: tt.url, EnableSSLVerification: true}, em.callbacks())
			errEvent := waitWSError(t, em.errors)
			if !strings.Contains(errEvent.Message, tt.want) {
				t.Fatalf("expected error containing %q, got %+v", tt.want, errEvent)
			}
		})
	}
}

func TestWebSocketCloseMessageIsFriendly(t *testing.T) {
	tests := []struct {
		name string
		err  *websocket.CloseError
		want string
	}{
		{
			name: "abnormal unexpected eof",
			err:  &websocket.CloseError{Code: websocket.CloseAbnormalClosure, Text: "unexpected EOF"},
			want: "Connection closed unexpectedly. The server ended the connection without a close frame.",
		},
		{
			name: "normal close",
			err:  &websocket.CloseError{Code: websocket.CloseNormalClosure},
			want: "Connection closed normally.",
		},
		{
			name: "going away reason",
			err:  &websocket.CloseError{Code: websocket.CloseGoingAway, Text: "deploying"},
			want: "Server closed the connection: deploying",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := websocketCloseMessage(tt.err); got != tt.want {
				t.Fatalf("expected %q, got %q", tt.want, got)
			}
		})
	}
}

func TestWebSocketInvalidSendPayload(t *testing.T) {
	manager := newWebSocketManager(nil)
	result := manager.send("missing", model.WebSocketSendMessage{Type: "text", Data: "hello"})
	if result.OK || !strings.Contains(result.Error, "not connected") {
		t.Fatalf("expected not connected error, got %+v", result)
	}

	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		_, _, _ = conn.ReadMessage()
	}))
	defer server.Close()

	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "session-4", model.HttpRequest{
		URL:                   wsURLFromHTTP(server.URL),
		EnableSSLVerification: true,
		TimeoutMs:             2000,
	}, em.callbacks())
	waitWSOpen(t, em.opens)
	defer manager.disconnect("session-4")

	result = manager.send("session-4", model.WebSocketSendMessage{Type: "binary", Data: "not-base64", Encoding: "base64"})
	if result.OK || !strings.Contains(result.Error, "invalid base64") {
		t.Fatalf("expected invalid base64 error, got %+v", result)
	}
}

func TestWebSocketMaxMessageSizeLimit(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(strings.Repeat("x", 1024*1024+1)))
	}))
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "session-limit", model.HttpRequest{
		URL:                       wsURLFromHTTP(server.URL),
		EnableSSLVerification:     true,
		WebSocketMaxMessageSizeMb: 1,
	}, em.callbacks())
	waitWSOpen(t, em.opens)
	errEvent := waitWSError(t, em.errors)
	if !strings.Contains(strings.ToLower(errEvent.Message), "read limit") {
		t.Fatalf("expected read limit error, got %+v", errEvent)
	}
}

func idleWSServer(t *testing.T, pingReceived chan<- struct{}) *httptest.Server {
	t.Helper()
	upgrader := websocket.Upgrader{}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		conn.SetPingHandler(func(appData string) error {
			select {
			case pingReceived <- struct{}{}:
			default:
			}
			return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(time.Second))
		})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
}

func TestWebSocketKeepAlivePingsIdleConnection(t *testing.T) {
	pingReceived := make(chan struct{}, 4)
	server := idleWSServer(t, pingReceived)
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "keepalive", model.HttpRequest{
		URL:                          wsURLFromHTTP(server.URL),
		EnableSSLVerification:        true,
		WebSocketKeepAliveIntervalMs: 100,
	}, em.callbacks())
	defer manager.disconnect("keepalive")

	waitWSOpen(t, em.opens)

	select {
	case <-pingReceived:
	case <-time.After(2 * time.Second):
		t.Fatal("expected a keep-alive ping within 2s on an idle connection, got none")
	}
}

func TestWebSocketKeepAliveDisabledByNegativeInterval(t *testing.T) {
	pingReceived := make(chan struct{}, 4)
	server := idleWSServer(t, pingReceived)
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "no-keepalive", model.HttpRequest{
		URL:                          wsURLFromHTTP(server.URL),
		EnableSSLVerification:        true,
		WebSocketKeepAliveIntervalMs: -1,
	}, em.callbacks())
	defer manager.disconnect("no-keepalive")

	waitWSOpen(t, em.opens)

	select {
	case <-pingReceived:
		t.Fatal("expected no keep-alive ping when interval is negative")
	case <-time.After(600 * time.Millisecond):
	}
}

func TestWebSocketIdleDeadlineFollowsKeepAlive(t *testing.T) {
	cases := map[int]time.Duration{
		-1:     0,
		0:      90 * time.Second,
		100:    90 * time.Second,
		120000: 250 * time.Second,
	}
	for intervalMs, want := range cases {
		got := websocketReadIdleTimeout(model.HttpRequest{WebSocketKeepAliveIntervalMs: intervalMs})
		if got != want {
			t.Errorf("keep-alive %d ms: idle deadline = %s, want %s", intervalMs, got, want)
		}
	}
}

func TestWebSocketIgnoresHandshakeHeadersCopiedFromABrowser(t *testing.T) {
	server := idleWSServer(t, make(chan struct{}, 1))
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "copied", model.HttpRequest{
		URL:                   wsURLFromHTTP(server.URL),
		EnableSSLVerification: true,
		Headers: []model.KeyValue{
			{Key: "Sec-WebSocket-Key", Value: "dGhlIHNhbXBsZSBub25jZQ==", Enabled: true},
			{Key: "sec-websocket-version", Value: "13", Enabled: true},
			{Key: "Sec-WebSocket-Extensions", Value: "permessage-deflate", Enabled: true},
			{Key: "X-Kept", Value: "1", Enabled: true},
		},
	}, em.callbacks())
	defer manager.disconnect("copied")

	notice := waitWSEvent(t, em.events, "notice")
	if !strings.Contains(notice.Message, "Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Extensions") {
		t.Fatalf("unexpected notice %q", notice.Message)
	}
	open := waitWSOpen(t, em.opens)
	if headerValue(open.RequestHeaders, "X-Kept") != "1" {
		t.Fatalf("expected other headers to be sent, got %v", open.RequestHeaders)
	}
	select {
	case ev := <-em.errors:
		t.Fatalf("unexpected error %q", ev.Message)
	default:
	}
}

func TestWebSocketHandshakeHasADefaultTimeout(t *testing.T) {
	if got := websocketHandshakeTimeout(model.HttpRequest{}); got != defaultWebSocketHandshakeTimeout || got <= 0 {
		t.Fatalf("a request without its own handshake timeout must still time out, got %s", got)
	}
	if got := websocketHandshakeTimeout(model.HttpRequest{WebSocketHandshakeTimeoutMs: 1500}); got != 1500*time.Millisecond {
		t.Fatalf("the request's own timeout should win, got %s", got)
	}
}

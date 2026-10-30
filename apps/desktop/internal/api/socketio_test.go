package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const sioTestBinaryFrame = "\x00binary-frame:"

type sioServer struct {
	t        *testing.T
	upgrader websocket.Upgrader
	recv     chan [2]string
	push     chan string
}

func newSIOServer(t *testing.T) *sioServer {
	t.Helper()
	return &sioServer{
		t:        t,
		upgrader: websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }},
		recv:     make(chan [2]string, 32),
		push:     make(chan string, 32),
	}
}

func (s *sioServer) handler(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, "/socket.io") {
		http.NotFound(w, r)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.t.Logf("sioServer upgrade: %v", err)
		return
	}
	defer conn.Close()

	open := fmt.Sprintf(`0{"sid":"test-sid","pingInterval":25000,"pingTimeout":5000,"upgrades":[]}`)
	if err := conn.WriteMessage(websocket.TextMessage, []byte(open)); err != nil {
		return
	}

	_, data, err := conn.ReadMessage()
	if err != nil || len(data) < 2 || data[0] != eioMessage || data[1] != sioConnect {
		s.t.Logf("sioServer: expected CONNECT packet, got %q err=%v", data, err)
		return
	}

	if err := conn.WriteMessage(websocket.TextMessage, []byte("40")); err != nil {
		return
	}

	done := make(chan struct{})

	go func() {
		defer close(done)
		for {
			select {
			case pkt, ok := <-s.push:
				if !ok {
					return
				}
				frameType := websocket.TextMessage
				if binary, ok := strings.CutPrefix(pkt, sioTestBinaryFrame); ok {
					frameType, pkt = websocket.BinaryMessage, binary
				}
				if err := conn.WriteMessage(frameType, []byte(pkt)); err != nil {
					return
				}
			}
		}
	}()

	for {
		conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		_ = conn.SetReadDeadline(time.Time{})
		if len(data) == 0 {
			continue
		}
		switch data[0] {
		case eioPing:
			_ = conn.WriteMessage(websocket.TextMessage, []byte{eioPong})
		case eioMessage:
			if len(data) < 2 {
				continue
			}
			switch data[1] {
			case sioEvent:
				name, args := parseSIOEvent(data[2:])
				argsStr := ""
				if len(args) > 0 {
					argsStr = args[0]
				}
				s.recv <- [2]string{name, argsStr}
			case sioDisconnect:
				return
			}
		}
	}
}

func waitSIOOpen(t *testing.T, ch <-chan model.SocketIOOpenEvent) model.SocketIOOpenEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for sio:open")
		return model.SocketIOOpenEvent{}
	}
}

func waitSIOEvent(t *testing.T, ch <-chan model.SocketIOMessage) model.SocketIOMessage {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for sio:event")
		return model.SocketIOMessage{}
	}
}

func waitSIOClose(t *testing.T, ch <-chan model.SocketIOCloseEvent) model.SocketIOCloseEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for sio:close")
		return model.SocketIOCloseEvent{}
	}
}

func waitSIOError(t *testing.T, ch <-chan model.SocketIOErrorEvent) model.SocketIOErrorEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for sio:error")
		return model.SocketIOErrorEvent{}
	}
}

func waitSIOAck(t *testing.T, ch <-chan model.SocketIOAckEvent) model.SocketIOAckEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for sio:ack")
		return model.SocketIOAckEvent{}
	}
}

func waitSIORecv(t *testing.T, ch <-chan [2]string) [2]string {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for server to receive client event")
		return [2]string{}
	}
}

type sioTestEmitter struct {
	opens  chan model.SocketIOOpenEvent
	events chan model.SocketIOMessage
	closes chan model.SocketIOCloseEvent
	errors chan model.SocketIOErrorEvent
	acks   chan model.SocketIOAckEvent
}

func newSIOTestEmitter() *sioTestEmitter {
	return &sioTestEmitter{
		opens:  make(chan model.SocketIOOpenEvent, 4),
		events: make(chan model.SocketIOMessage, 32),
		closes: make(chan model.SocketIOCloseEvent, 4),
		errors: make(chan model.SocketIOErrorEvent, 4),
		acks:   make(chan model.SocketIOAckEvent, 4),
	}
}

func (e *sioTestEmitter) callbacks() socketIOCallbacks {
	return socketIOCallbacks{
		onOpen:  func(ev model.SocketIOOpenEvent) { e.opens <- ev },
		onEvent: func(ev model.SocketIOMessage) { e.events <- ev },
		onClose: func(ev model.SocketIOCloseEvent) { e.closes <- ev },
		onError: func(ev model.SocketIOErrorEvent) { e.errors <- ev },
		onAck:   func(ev model.SocketIOAckEvent) { e.acks <- ev },
	}
}

func sioHTTPToWS(serverURL string) string {
	return "ws" + strings.TrimPrefix(serverURL, "http")
}

func TestSocketIOConnectAndReceiveEvent(t *testing.T) {
	srv := newSIOServer(t)
	server := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer server.Close()

	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-1", model.HttpRequest{
		URL:                   sioHTTPToWS(server.URL),
		EnableSSLVerification: true,
	}, em.callbacks())
	defer manager.disconnect("sio-1")

	open := waitSIOOpen(t, em.opens)
	if open.SessionID != "sio-1" {
		t.Fatalf("unexpected sessionId: %q", open.SessionID)
	}
	if open.StatusCode != 101 {
		t.Fatalf("expected 101, got %d", open.StatusCode)
	}
	if open.Namespace != "/" {
		t.Fatalf("expected namespace /, got %q", open.Namespace)
	}

	srv.push <- `42["message","hello from server"]`

	ev := waitSIOEvent(t, em.events)
	if ev.Direction != "incoming" {
		t.Fatalf("expected incoming direction, got %q", ev.Direction)
	}
	if ev.EventName != "message" {
		t.Fatalf("expected event name 'message', got %q", ev.EventName)
	}
	if len(ev.Args) == 0 || ev.Args[0] != `"hello from server"` {
		t.Fatalf("unexpected args: %v", ev.Args)
	}
}

func TestSocketIOEmitFromClient(t *testing.T) {
	srv := newSIOServer(t)
	server := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer server.Close()

	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-emit", model.HttpRequest{
		URL:                   sioHTTPToWS(server.URL),
		EnableSSLVerification: true,
	}, em.callbacks())
	defer manager.disconnect("sio-emit")

	waitSIOOpen(t, em.opens)

	result := manager.emit("sio-emit", model.SocketIOEmitMessage{
		EventName: "chat",
		Args:      []string{`"hello"`},
	})
	if !result.OK || result.Error != "" {
		t.Fatalf("emit failed: %+v", result)
	}

	got := waitSIORecv(t, srv.recv)
	if got[0] != "chat" {
		t.Fatalf("expected event name 'chat', got %q", got[0])
	}
	if got[1] != `"hello"` {
		t.Fatalf("expected arg 'hello', got %q", got[1])
	}
}

func TestSocketIOEventFiltering(t *testing.T) {
	srv := newSIOServer(t)
	server := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer server.Close()

	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-filter", model.HttpRequest{
		URL:                   sioHTTPToWS(server.URL),
		EnableSSLVerification: true,
		SocketIOListenEvents:  []string{"allowed"},
	}, em.callbacks())
	defer manager.disconnect("sio-filter")

	waitSIOOpen(t, em.opens)

	srv.push <- `42["ignored","should not arrive"]`
	srv.push <- `42["allowed","should arrive"]`

	ev := waitSIOEvent(t, em.events)
	if ev.EventName != "allowed" {
		t.Fatalf("expected 'allowed' event, got %q", ev.EventName)
	}

	select {
	case extra := <-em.events:
		t.Fatalf("unexpected extra event: %+v", extra)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestSocketIONoEventsListened(t *testing.T) {
	srv := newSIOServer(t)
	server := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer server.Close()

	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-none", model.HttpRequest{
		URL:                   sioHTTPToWS(server.URL),
		EnableSSLVerification: true,
		SocketIOListenEvents:  []string{},
	}, em.callbacks())
	defer manager.disconnect("sio-none")

	waitSIOOpen(t, em.opens)

	srv.push <- `42["message","blocked"]`
	srv.push <- `42["update","also blocked"]`

	select {
	case ev := <-em.events:
		t.Fatalf("expected no events but got: %+v", ev)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestSocketIOV2PollingHandshakeAppliesParamsAuthAndCookies(t *testing.T) {
	var gotQuery url.Values
	var gotCookie string
	var gotHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/socket.io") {
			http.NotFound(w, r)
			return
		}
		gotQuery = r.URL.Query()
		gotCookie = r.Header.Get("Cookie")
		gotHeader = r.Header.Get("X-Kurlo-Test")
		http.SetCookie(w, &http.Cookie{Name: "server", Value: "stored", Path: "/"})
		open := `0{"sid":"poll-sid","pingInterval":25000,"pingTimeout":5000}`
		fmt.Fprintf(w, "%d:%s", len(open), open)
	}))
	defer server.Close()

	baseURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	jar := newTrackedCookieJar()
	jar.SetCookies(baseURL, []*http.Cookie{{Name: "client", Value: "abc", Path: "/"}})

	manager := newSocketIOManager(singleJarRegistry(jar))
	headers := make(http.Header)
	headers.Set("X-Kurlo-Test", "yes")

	sid, _, _, hs, err := manager.pollingHandshake(context.Background(), model.HttpRequest{
		URL:                    sioHTTPToWS(server.URL),
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		Params:                 []model.KeyValue{{Key: "room", Value: "chat", Enabled: true}},
		Auth:                   model.AuthConfig{Type: "apikey", KeyName: "api_key", KeyValue: "secret", KeyIn: "query"},
	}, baseURL, "/socket.io", headers)
	if err != nil {
		t.Fatalf("polling handshake failed: %v hs=%+v", err, hs)
	}
	if sid != "poll-sid" {
		t.Fatalf("expected sid poll-sid, got %q", sid)
	}
	if gotQuery.Get("EIO") != "3" || gotQuery.Get("transport") != "polling" {
		t.Fatalf("expected EIO=3 polling query, got %q", gotQuery.Encode())
	}
	if gotQuery.Get("room") != "chat" || gotQuery.Get("api_key") != "secret" {
		t.Fatalf("expected request params and API key auth, got %q", gotQuery.Encode())
	}
	if gotHeader != "yes" {
		t.Fatalf("expected custom header to survive handshake, got %q", gotHeader)
	}
	if !strings.Contains(gotCookie, "client=abc") {
		t.Fatalf("expected polling handshake to send cookie jar cookies, got %q", gotCookie)
	}
	cookies := jar.Cookies(baseURL)
	storedServerCookie := false
	for _, cookie := range cookies {
		if cookie.Name == "server" && cookie.Value == "stored" {
			storedServerCookie = true
		}
	}
	if !storedServerCookie {
		t.Fatalf("expected polling handshake response cookie to be stored, got %#v", cookies)
	}
}

func TestSocketIOEmitWithAck(t *testing.T) {
	srv := newSIOServer(t)
	ackSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/socket.io") {
			http.NotFound(w, r)
			return
		}
		conn, err := srv.upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"ack-sid","pingInterval":25000,"pingTimeout":5000,"upgrades":[]}`))
		_, _, _ = conn.ReadMessage()
		_ = conn.WriteMessage(websocket.TextMessage, []byte("40"))

		conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil || len(data) < 3 {
			return
		}
		payload := data[2:]
		i := 0
		for i < len(payload) && payload[i] >= '0' && payload[i] <= '9' {
			i++
		}
		ackIDStr := string(payload[:i])
		ackPkt := fmt.Sprintf(`43%s["ack-response"]`, ackIDStr)
		_ = conn.WriteMessage(websocket.TextMessage, []byte(ackPkt))
		_, _, _ = conn.ReadMessage()
	}))
	defer ackSrv.Close()

	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-ack", model.HttpRequest{
		URL:                   sioHTTPToWS(ackSrv.URL),
		EnableSSLVerification: true,
	}, em.callbacks())
	defer manager.disconnect("sio-ack")

	waitSIOOpen(t, em.opens)

	result := manager.emit("sio-ack", model.SocketIOEmitMessage{
		EventName: "greet",
		Args:      []string{`"world"`},
		Ack:       true,
	})
	if !result.OK {
		t.Fatalf("emit with ack failed: %+v", result)
	}
	ackID := result.AckID

	ack := waitSIOAck(t, em.acks)
	if ack.AckID != ackID {
		t.Fatalf("expected ackId %d, got %d", ackID, ack.AckID)
	}
	if ack.EventName != "greet" {
		t.Fatalf("unexpected ack event name: %q", ack.EventName)
	}
	if len(ack.Args) != 1 || ack.Args[0] != `"ack-response"` {
		t.Fatalf("unexpected ack args: %#v", ack.Args)
	}
}

func TestSocketIODisconnect(t *testing.T) {
	srv := newSIOServer(t)
	server := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer server.Close()

	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-disc", model.HttpRequest{
		URL:                   sioHTTPToWS(server.URL),
		EnableSSLVerification: true,
	}, em.callbacks())

	waitSIOOpen(t, em.opens)
	manager.disconnect("sio-disc")

	closeEv := waitSIOClose(t, em.closes)
	if closeEv.Message != "Disconnected" {
		t.Fatalf("expected 'Disconnected', got %q", closeEv.Message)
	}
}

func TestSocketIOConnectionError(t *testing.T) {
	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-err", model.HttpRequest{
		URL:                   "ws://{{host}}/socket.io",
		EnableSSLVerification: true,
	}, em.callbacks())

	errEv := waitSIOError(t, em.errors)
	if !strings.Contains(errEv.Message, "unresolved variable") {
		t.Fatalf("expected unresolved variable error, got %q", errEv.Message)
	}
}

func TestSocketIOConnectionErrorIsFriendly(t *testing.T) {
	target, err := url.Parse("ws://localhost:3001/socket.io/?EIO=4&transport=websocket")
	if err != nil {
		t.Fatalf("parse URL: %v", err)
	}

	got := socketIOConnectionError(errors.New(`dial tcp [::1]:3001: connect: connection refused`), target, 30*time.Second)
	want := "connect ECONNREFUSED 127.0.0.1:3001"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
	if strings.Contains(got, "dial tcp") || strings.Contains(got, "[::1]") {
		t.Fatalf("expected non-Go network error, got %q", got)
	}
}

func TestSocketIOMultipleEvents(t *testing.T) {
	srv := newSIOServer(t)
	server := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer server.Close()

	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-multi", model.HttpRequest{
		URL:                   sioHTTPToWS(server.URL),
		EnableSSLVerification: true,
	}, em.callbacks())
	defer manager.disconnect("sio-multi")

	waitSIOOpen(t, em.opens)

	names := []string{"first", "second", "third"}
	for i, name := range names {
		payload, _ := json.Marshal([]interface{}{name, fmt.Sprintf("arg%d", i)})
		srv.push <- string(eioMessage) + string(sioEvent) + string(payload)
	}

	for _, expected := range names {
		ev := waitSIOEvent(t, em.events)
		if ev.EventName != expected {
			t.Fatalf("expected event %q, got %q", expected, ev.EventName)
		}
	}
}

func TestSocketIOAllEventsWhenNilListenEvents(t *testing.T) {
	srv := newSIOServer(t)
	server := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer server.Close()

	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-nil-filter", model.HttpRequest{
		URL:                   sioHTTPToWS(server.URL),
		EnableSSLVerification: true,
		SocketIOListenEvents:  nil,
	}, em.callbacks())
	defer manager.disconnect("sio-nil-filter")

	waitSIOOpen(t, em.opens)

	srv.push <- `42["alpha","1"]`
	srv.push <- `42["beta","2"]`

	ev1 := waitSIOEvent(t, em.events)
	ev2 := waitSIOEvent(t, em.events)
	if ev1.EventName != "alpha" || ev2.EventName != "beta" {
		t.Fatalf("expected alpha+beta, got %q %q", ev1.EventName, ev2.EventName)
	}
}

func TestSocketIODisplayURLHumanizesSchemeAndQuery(t *testing.T) {
	u, err := url.Parse("ws://localhost:3001/socket.io/?EIO=4&transport=websocket&%D0%B0=")
	if err != nil {
		t.Fatal(err)
	}

	got := socketIODisplayURL(u)
	want := "http://localhost:3001/socket.io/?EIO=4&transport=websocket&а="
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestSocketIOReceivesBinaryEvents(t *testing.T) {
	srv := newSIOServer(t)
	server := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer server.Close()

	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-bin", model.HttpRequest{
		URL:                   sioHTTPToWS(server.URL),
		EnableSSLVerification: true,
	}, em.callbacks())
	defer manager.disconnect("sio-bin")
	waitSIOOpen(t, em.opens)

	srv.push <- `452-["file",{"name":"a.bin","data":{"_placeholder":true,"num":0}},{"_placeholder":true,"num":1}]`
	srv.push <- sioTestBinaryFrame + "\x01\x02\x03"
	srv.push <- sioTestBinaryFrame + "hi"

	ev := waitSIOEvent(t, em.events)
	if ev.EventName != "file" || len(ev.Args) != 2 {
		t.Fatalf("expected the binary event with two args, got %+v", ev)
	}
	if ev.Args[0] != `{"data":{"_binary":"AQID","size":3},"name":"a.bin"}` || ev.Args[1] != `{"_binary":"aGk=","size":2}` {
		t.Fatalf("unexpected args %v", ev.Args)
	}

	srv.push <- `450-["empty"]`
	if ev := waitSIOEvent(t, em.events); ev.EventName != "empty" {
		t.Fatalf("expected a binary event without attachments to arrive at once, got %+v", ev)
	}
}

func TestSocketIOReceivesABinaryAck(t *testing.T) {
	srv := newSIOServer(t)
	server := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer server.Close()

	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-bin-ack", model.HttpRequest{
		URL:                   sioHTTPToWS(server.URL),
		EnableSSLVerification: true,
	}, em.callbacks())
	defer manager.disconnect("sio-bin-ack")
	waitSIOOpen(t, em.opens)

	result := manager.emit("sio-bin-ack", model.SocketIOEmitMessage{EventName: "download", Ack: true})
	if !result.OK {
		t.Fatalf("emit failed: %s", result.Error)
	}
	srv.push <- fmt.Sprintf(`461-%d[{"_placeholder":true,"num":0}]`, result.AckID)
	srv.push <- sioTestBinaryFrame + "ok"

	select {
	case ack := <-em.acks:
		if ack.EventName != "download" || len(ack.Args) != 1 || ack.Args[0] != `{"_binary":"b2s=","size":2}` {
			t.Fatalf("unexpected ack %+v", ack)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for the binary ack")
	}
}

func TestSocketIOCallbacksFromAReplacedConnectionAreDropped(t *testing.T) {
	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	stale := manager.currentSessionCallbacks("sio-gen", 1, em.callbacks())
	current := manager.currentSessionCallbacks("sio-gen", 2, em.callbacks())
	manager.mu.Lock()
	manager.sessions["sio-gen"] = &socketIOSession{cancel: func() {}, id: 2}
	manager.mu.Unlock()

	stale.onClose(model.SocketIOCloseEvent{SessionID: "sio-gen", Message: "old"})
	stale.onEvent(model.SocketIOMessage{EventName: "old"})
	current.onOpen(model.SocketIOOpenEvent{SessionID: "sio-gen"})

	if len(em.closes) != 0 || len(em.events) != 0 {
		t.Fatalf("a replaced connection must stay silent, got %d closes and %d events", len(em.closes), len(em.events))
	}
	if len(em.opens) != 1 {
		t.Fatalf("the current connection should still report, got %d opens", len(em.opens))
	}
}

func TestSocketIOV2NoticesAServerThatStopsAnsweringPings(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("transport") == "polling" {
			open := `0{"sid":"v2-sid","pingInterval":100,"pingTimeout":100}`
			fmt.Fprintf(w, "%d:%s", len(open), open)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		if _, data, err := conn.ReadMessage(); err != nil || string(data) != "2probe" {
			return
		}
		_ = conn.WriteMessage(websocket.TextMessage, []byte("3probe"))
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if len(data) >= 2 && data[0] == eioMessage && data[1] == sioConnect {
				_ = conn.WriteMessage(websocket.TextMessage, []byte("40"))
			}
		}
	}))
	defer server.Close()

	manager := newSocketIOManager(nil)
	em := newSIOTestEmitter()
	manager.connectWithCallbacks(context.Background(), "sio-v2-dead", model.HttpRequest{
		URL:                   sioHTTPToWS(server.URL),
		EnableSSLVerification: true,
		SocketIOClientVersion: "v2",
	}, em.callbacks())
	defer manager.disconnect("sio-v2-dead")

	waitSIOOpen(t, em.opens)
	select {
	case ev := <-em.errors:
		if !strings.Contains(ev.Message, "timeout") {
			t.Fatalf("expected a read timeout, got %q", ev.Message)
		}
	case <-em.closes:
	case <-time.After(3 * time.Second):
		t.Fatal("a v2 connection whose server went silent must not stay connected")
	}
}

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type graphqlTestFrame struct {
	ID      string          `json:"id,omitempty"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

func readGraphQLTestFrame(t *testing.T, conn *websocket.Conn) graphqlTestFrame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var frame graphqlTestFrame
	if err := conn.ReadJSON(&frame); err != nil {
		t.Errorf("read frame: %v", err)
	}
	return frame
}

func graphqlSubscriptionRequest(url string) model.HttpRequest {
	return model.HttpRequest{
		URL:                   url,
		Body:                  `{"query":"subscription OnTick($n: Int) { tick(n: $n) }","variables":{"n":2},"operationName":"OnTick"}`,
		BodyType:              "graphql",
		EnableSSLVerification: true,
		GraphQLSubscription:   true,
	}
}

func collectWSEvents(ch <-chan model.WebSocketMessage, until func(model.WebSocketMessage) bool) []model.WebSocketMessage {
	var out []model.WebSocketMessage
	deadline := time.After(2 * time.Second)
	for {
		select {
		case ev := <-ch:
			out = append(out, ev)
			if until(ev) {
				return out
			}
		case <-deadline:
			return out
		}
	}
}

func TestGraphQLSubscriptionOverGraphQLTransportWS(t *testing.T) {
	t.Parallel()
	upgrader := websocket.Upgrader{Subprotocols: []string{graphqlTransportWSProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Errorf("expected bearer auth on the handshake, got %q", got)
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		init := readGraphQLTestFrame(t, conn)
		if init.Type != "connection_init" || string(init.Payload) != `{"authToken":"abc"}` {
			t.Errorf("unexpected connection_init: %+v %s", init, init.Payload)
		}
		_ = conn.WriteJSON(graphqlTestFrame{Type: "connection_ack"})
		sub := readGraphQLTestFrame(t, conn)
		if sub.Type != "subscribe" || sub.ID != "1" {
			t.Errorf("unexpected subscribe frame: %+v", sub)
		}
		var payload struct {
			Query         string         `json:"query"`
			Variables     map[string]int `json:"variables"`
			OperationName string         `json:"operationName"`
		}
		_ = json.Unmarshal(sub.Payload, &payload)
		if !strings.HasPrefix(payload.Query, "subscription OnTick") || payload.Variables["n"] != 2 || payload.OperationName != "OnTick" {
			t.Errorf("unexpected subscribe payload: %s", sub.Payload)
		}
		_ = conn.WriteJSON(graphqlTestFrame{Type: "ping"})
		if pong := readGraphQLTestFrame(t, conn); pong.Type != "pong" {
			t.Errorf("expected pong, got %+v", pong)
		}
		_ = conn.WriteJSON(graphqlTestFrame{ID: "1", Type: "next", Payload: json.RawMessage(`{"data":{"tick":1}}`)})
		_ = conn.WriteJSON(graphqlTestFrame{ID: "1", Type: "next", Payload: json.RawMessage(`{"data":{"tick":2}}`)})
		_ = conn.WriteJSON(graphqlTestFrame{ID: "1", Type: "complete"})
		_, _, _ = conn.ReadMessage()
	}))
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	req := graphqlSubscriptionRequest(server.URL + "/graphql")
	req.Auth = model.AuthConfig{Type: "bearer", Token: "secret"}
	req.GraphQLConnectionPayload = "{\n  \"authToken\": \"abc\"\n}"
	manager.connectWithCallbacks(context.Background(), "gql-1", req, em.callbacks())
	defer manager.disconnect("gql-1")

	open := waitWSOpen(t, em.opens)
	if open.Protocol != graphqlTransportWSProtocol {
		t.Fatalf("expected negotiated protocol %q, got %q", graphqlTransportWSProtocol, open.Protocol)
	}
	if !strings.HasPrefix(open.URL, "ws://") {
		t.Fatalf("expected the http URL to become ws, got %q", open.URL)
	}
	closeEvent := waitWSClose(t, em.closes)
	if closeEvent.Message != "Subscription completed by the server." {
		t.Fatalf("unexpected close: %+v", closeEvent)
	}
	events := collectWSEvents(em.events, func(model.WebSocketMessage) bool { return len(em.events) == 0 })
	var nexts, outgoing []string
	for _, ev := range events {
		if ev.Direction == "incoming" && strings.Contains(ev.Data, `"next"`) {
			nexts = append(nexts, ev.Data)
		}
		if ev.Direction == "outgoing" {
			outgoing = append(outgoing, ev.Data)
		}
		if strings.Contains(ev.Data, `"ping"`) || strings.Contains(ev.Data, `"pong"`) {
			if !ev.IsSystem {
				t.Fatalf("expected ping/pong to be system messages, got %+v", ev)
			}
		}
	}
	if len(nexts) != 2 || !strings.Contains(nexts[1], `"tick":2`) {
		t.Fatalf("expected two next events, got %v", nexts)
	}
	if len(outgoing) != 3 || !strings.Contains(outgoing[0], "connection_init") || !strings.Contains(outgoing[1], "subscribe") {
		t.Fatalf("expected init, subscribe and pong to be logged, got %v", outgoing)
	}
}

func TestGraphQLSubscriptionDisconnectSendsComplete(t *testing.T) {
	t.Parallel()
	upgrader := websocket.Upgrader{Subprotocols: []string{graphqlTransportWSProtocol}}
	completed := make(chan graphqlTestFrame, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		readGraphQLTestFrame(t, conn)
		_ = conn.WriteJSON(graphqlTestFrame{Type: "connection_ack"})
		readGraphQLTestFrame(t, conn)
		_ = conn.WriteJSON(graphqlTestFrame{ID: "1", Type: "next", Payload: json.RawMessage(`{"data":{"tick":1}}`)})
		completed <- readGraphQLTestFrame(t, conn)
	}))
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "gql-2", graphqlSubscriptionRequest(wsURLFromHTTP(server.URL)), em.callbacks())
	waitWSOpen(t, em.opens)
	collectWSEvents(em.events, func(ev model.WebSocketMessage) bool { return strings.Contains(ev.Data, `"next"`) })
	manager.disconnect("gql-2")

	select {
	case frame := <-completed:
		if frame.Type != "complete" || frame.ID != "1" {
			t.Fatalf("expected complete for the subscription, got %+v", frame)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server never received complete")
	}
	if closeEvent := waitWSClose(t, em.closes); closeEvent.Message != "Disconnected" {
		t.Fatalf("unexpected close: %+v", closeEvent)
	}
}

func TestGraphQLSubscriptionOverLegacyGraphQLWS(t *testing.T) {
	t.Parallel()
	upgrader := websocket.Upgrader{Subprotocols: []string{graphqlLegacyWSProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		init := readGraphQLTestFrame(t, conn)
		if init.Type != "connection_init" || string(init.Payload) != `{}` {
			t.Errorf("unexpected legacy connection_init: %+v %s", init, init.Payload)
		}
		_ = conn.WriteJSON(graphqlTestFrame{Type: "connection_ack"})
		_ = conn.WriteJSON(graphqlTestFrame{Type: "ka"})
		start := readGraphQLTestFrame(t, conn)
		if start.Type != "start" || start.ID != "1" || !strings.Contains(string(start.Payload), "OnTick") {
			t.Errorf("unexpected start frame: %+v", start)
		}
		_ = conn.WriteJSON(graphqlTestFrame{ID: "1", Type: "data", Payload: json.RawMessage(`{"data":{"tick":1}}`)})
		_ = conn.WriteJSON(graphqlTestFrame{ID: "1", Type: "error", Payload: json.RawMessage(`[{"message":"boom"}]`)})
		if terminate := readGraphQLTestFrame(t, conn); terminate.Type != "connection_terminate" {
			t.Errorf("expected connection_terminate, got %+v", terminate)
		}
	}))
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	manager.connectWithCallbacks(context.Background(), "gql-3", graphqlSubscriptionRequest(wsURLFromHTTP(server.URL)), em.callbacks())
	defer manager.disconnect("gql-3")

	if open := waitWSOpen(t, em.opens); open.Protocol != graphqlLegacyWSProtocol {
		t.Fatalf("expected legacy protocol, got %q", open.Protocol)
	}
	if failure := waitWSError(t, em.errors); failure.Message != "Subscription failed: boom" {
		t.Fatalf("unexpected error: %+v", failure)
	}
	events := collectWSEvents(em.events, func(model.WebSocketMessage) bool { return len(em.events) == 0 })
	var sawData, sawKA bool
	for _, ev := range events {
		if strings.Contains(ev.Data, `"data"`) && strings.Contains(ev.Data, `"tick":1`) {
			sawData = true
		}
		if strings.Contains(ev.Data, `"ka"`) {
			sawKA = ev.IsSystem
		}
		if strings.Contains(ev.Data, `"error"`) && ev.Direction == "incoming" && !ev.IsError {
			t.Fatalf("expected the error frame to be marked as an error: %+v", ev)
		}
	}
	if !sawData || !sawKA {
		t.Fatalf("expected data and a system keep-alive frame, got %+v", events)
	}
}

func TestGraphQLSubscriptionFailsWithoutConnectionAck(t *testing.T) {
	t.Parallel()
	upgrader := websocket.Upgrader{Subprotocols: []string{graphqlTransportWSProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	manager := newWebSocketManager(nil)
	em := newWSTestEmitter()
	req := graphqlSubscriptionRequest(wsURLFromHTTP(server.URL))
	req.WebSocketHandshakeTimeoutMs = 200
	manager.connectWithCallbacks(context.Background(), "gql-4", req, em.callbacks())
	defer manager.disconnect("gql-4")

	waitWSOpen(t, em.opens)
	failure := waitWSError(t, em.errors)
	if !strings.Contains(failure.Message, "did not acknowledge the GraphQL connection within 200ms") {
		t.Fatalf("unexpected error: %+v", failure)
	}
}

func TestGraphQLSubscriptionRejectsBadPayloads(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		edit func(*model.HttpRequest)
		want string
	}{
		{"connection payload not an object", func(r *model.HttpRequest) { r.GraphQLConnectionPayload = `["token"]` }, "GraphQL connection payload must be a JSON object"},
		{"connection payload not JSON", func(r *model.HttpRequest) { r.GraphQLConnectionPayload = `{token}` }, "GraphQL connection payload must be a JSON object"},
		{"empty query", func(r *model.HttpRequest) { r.Body = `{"query":"  "}` }, "GraphQL query is empty"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			manager := newWebSocketManager(nil)
			em := newWSTestEmitter()
			req := graphqlSubscriptionRequest("ws://127.0.0.1:1/graphql")
			tc.edit(&req)
			manager.connectWithCallbacks(context.Background(), "gql-bad", req, em.callbacks())
			if failure := waitWSError(t, em.errors); failure.Message != tc.want {
				t.Fatalf("got %q, want %q", failure.Message, tc.want)
			}
		})
	}
}

func TestGraphQLSubprotocolsRespectAnExplicitHeader(t *testing.T) {
	t.Parallel()
	headers := http.Header{}
	if got := graphqlSubprotocols(headers); len(got) != 2 || got[0] != graphqlTransportWSProtocol {
		t.Fatalf("unexpected default subprotocols: %v", got)
	}
	headers.Set("Sec-WebSocket-Protocol", graphqlLegacyWSProtocol)
	if got := graphqlSubprotocols(headers); got != nil {
		t.Fatalf("expected the user's header to win, got %v", got)
	}
}

func TestGraphQLErrorText(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		`[{"message":"a"},{"message":"b"}]`: "a; b",
		`{"message":"denied"}`:              "denied",
		`"plain"`:                           "plain",
		``:                                  "no details",
		`{"code":4}`:                        `{"code":4}`,
	}
	for raw, want := range cases {
		if got := graphqlErrorText(json.RawMessage(raw)); got != want {
			t.Fatalf("graphqlErrorText(%s) = %q, want %q", raw, got, want)
		}
	}
}

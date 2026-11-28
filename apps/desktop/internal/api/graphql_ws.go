package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	graphqlTransportWSProtocol = "graphql-transport-ws"
	graphqlLegacyWSProtocol    = "graphql-ws"
	graphqlSubscriptionID      = "1"
	graphqlStopWriteTimeout    = time.Second
)

type graphqlWSFrame struct {
	ID      string          `json:"id,omitempty"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type graphqlWSClient struct {
	conn      *websocket.Conn
	writeMu   *sync.Mutex
	legacy    bool
	subscribe json.RawMessage
	init      json.RawMessage
	emit      func(model.WebSocketMessage)

	mu       sync.Mutex
	acked    bool
	finished bool
	timedOut bool
	ackTimer *time.Timer
}

type graphqlWSResult struct {
	done    bool
	failed  bool
	message string
	code    int
}

func graphqlSubscriptionPayloads(req model.HttpRequest) (json.RawMessage, json.RawMessage, error) {
	body := strings.TrimSpace(req.Body)
	if body == "" {
		return nil, nil, fmt.Errorf("GraphQL query is empty")
	}
	var operation map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &operation); err != nil {
		return nil, nil, fmt.Errorf("GraphQL subscription payload is not valid JSON: %v", err)
	}
	var query string
	if raw, ok := operation["query"]; !ok || json.Unmarshal(raw, &query) != nil || strings.TrimSpace(query) == "" {
		return nil, nil, fmt.Errorf("GraphQL query is empty")
	}
	var init json.RawMessage
	if raw := strings.TrimSpace(req.GraphQLConnectionPayload); raw != "" {
		var params map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &params); err != nil || params == nil {
			return nil, nil, fmt.Errorf("GraphQL connection payload must be a JSON object")
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, []byte(raw)); err != nil {
			return nil, nil, fmt.Errorf("GraphQL connection payload must be a JSON object")
		}
		init = compact.Bytes()
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, []byte(body)); err != nil {
		return nil, nil, fmt.Errorf("GraphQL subscription payload is not valid JSON: %v", err)
	}
	return compact.Bytes(), init, nil
}

func graphqlSubprotocols(headers http.Header) []string {
	if strings.TrimSpace(headers.Get("Sec-WebSocket-Protocol")) != "" {
		return nil
	}
	return []string{graphqlTransportWSProtocol, graphqlLegacyWSProtocol}
}

func newGraphQLWSClient(conn *websocket.Conn, writeMu *sync.Mutex, protocol string, subscribe, init json.RawMessage, emit func(model.WebSocketMessage)) *graphqlWSClient {
	return &graphqlWSClient{
		conn:      conn,
		writeMu:   writeMu,
		legacy:    strings.EqualFold(strings.TrimSpace(protocol), graphqlLegacyWSProtocol),
		subscribe: subscribe,
		init:      init,
		emit:      emit,
	}
}

func (c *graphqlWSClient) protocolName() string {
	if c.legacy {
		return graphqlLegacyWSProtocol
	}
	return graphqlTransportWSProtocol
}

func (c *graphqlWSClient) start(ackTimeout time.Duration) error {
	payload := c.init
	if payload == nil && c.legacy {
		payload = json.RawMessage(`{}`)
	}
	if err := c.write(graphqlWSFrame{Type: "connection_init", Payload: payload}, false, websocketWriteTimeout); err != nil {
		return err
	}
	if ackTimeout > 0 {
		c.mu.Lock()
		c.ackTimer = time.AfterFunc(ackTimeout, func() {
			c.mu.Lock()
			if c.acked || c.finished {
				c.mu.Unlock()
				return
			}
			c.timedOut = true
			c.mu.Unlock()
			_ = c.conn.Close()
		})
		c.mu.Unlock()
	}
	return nil
}

func (c *graphqlWSClient) ackTimedOut() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.timedOut
}

func (c *graphqlWSClient) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.finished = true
	if c.ackTimer != nil {
		c.ackTimer.Stop()
	}
}

func (c *graphqlWSClient) write(frame graphqlWSFrame, system bool, timeout time.Duration) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	err = c.conn.SetWriteDeadline(time.Now().Add(timeout))
	if err == nil {
		err = c.conn.WriteMessage(websocket.TextMessage, data)
	}
	c.writeMu.Unlock()
	if err != nil {
		return err
	}
	c.emit(newWebSocketMessage("outgoing", "text", data, "plain", 0, system, false, ""))
	return nil
}

func (c *graphqlWSClient) receive(data []byte) graphqlWSResult {
	var frame graphqlWSFrame
	if err := json.Unmarshal(data, &frame); err != nil || frame.Type == "" {
		c.emit(newWebSocketMessage("incoming", "text", data, "plain", 0, false, false, ""))
		c.emit(newWebSocketMessage("system", "notice", nil, "", 0, true, false, "Ignored a message that is not a "+c.protocolName()+" frame."))
		return graphqlWSResult{}
	}
	system := frame.Type == "ping" || frame.Type == "pong" || frame.Type == "ka"
	isError := frame.Type == "error" || frame.Type == "connection_error"
	c.emit(newWebSocketMessage("incoming", "text", data, "plain", 0, system, isError, ""))

	switch frame.Type {
	case "connection_ack":
		c.mu.Lock()
		already := c.acked
		c.acked = true
		if c.ackTimer != nil {
			c.ackTimer.Stop()
		}
		c.mu.Unlock()
		if already {
			return graphqlWSResult{}
		}
		start := "subscribe"
		if c.legacy {
			start = "start"
		}
		if err := c.write(graphqlWSFrame{ID: graphqlSubscriptionID, Type: start, Payload: c.subscribe}, false, websocketWriteTimeout); err != nil {
			return graphqlWSResult{done: true, failed: true, code: websocket.CloseAbnormalClosure, message: "Could not start the subscription: " + err.Error()}
		}
	case "ping":
		if !c.legacy {
			_ = c.write(graphqlWSFrame{Type: "pong"}, true, websocketWriteTimeout)
		}
	case "connection_error":
		return graphqlWSResult{done: true, failed: true, code: websocket.CloseNormalClosure, message: "Server rejected the connection: " + graphqlErrorText(frame.Payload)}
	case "error":
		if frame.ID == "" || frame.ID == graphqlSubscriptionID {
			return c.finish("Subscription failed: "+graphqlErrorText(frame.Payload), true)
		}
	case "complete":
		if frame.ID == "" || frame.ID == graphqlSubscriptionID {
			return c.finish("Subscription completed by the server.", false)
		}
	}
	return graphqlWSResult{}
}

func (c *graphqlWSClient) finish(message string, failed bool) graphqlWSResult {
	c.mu.Lock()
	c.finished = true
	c.mu.Unlock()
	if c.legacy {
		_ = c.write(graphqlWSFrame{Type: "connection_terminate"}, true, graphqlStopWriteTimeout)
	}
	return graphqlWSResult{done: true, failed: failed, code: websocket.CloseNormalClosure, message: message}
}

func (c *graphqlWSClient) stop() {
	c.mu.Lock()
	active := c.acked && !c.finished
	c.finished = true
	if c.ackTimer != nil {
		c.ackTimer.Stop()
	}
	c.mu.Unlock()
	if active {
		if c.legacy {
			_ = c.write(graphqlWSFrame{ID: graphqlSubscriptionID, Type: "stop"}, false, graphqlStopWriteTimeout)
			_ = c.write(graphqlWSFrame{Type: "connection_terminate"}, true, graphqlStopWriteTimeout)
		} else {
			_ = c.write(graphqlWSFrame{ID: graphqlSubscriptionID, Type: "complete"}, false, graphqlStopWriteTimeout)
		}
	}
	c.writeMu.Lock()
	_ = c.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(graphqlStopWriteTimeout))
	c.writeMu.Unlock()
}

func graphqlErrorText(payload json.RawMessage) string {
	raw := strings.TrimSpace(string(payload))
	if raw == "" || raw == "null" {
		return "no details"
	}
	var list []struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(payload, &list) == nil && len(list) > 0 {
		messages := make([]string, 0, len(list))
		for _, item := range list {
			if strings.TrimSpace(item.Message) != "" {
				messages = append(messages, strings.TrimSpace(item.Message))
			}
		}
		if len(messages) > 0 {
			return strings.Join(messages, "; ")
		}
	}
	var single struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(payload, &single) == nil && strings.TrimSpace(single.Message) != "" {
		return strings.TrimSpace(single.Message)
	}
	var text string
	if json.Unmarshal(payload, &text) == nil && strings.TrimSpace(text) != "" {
		return strings.TrimSpace(text)
	}
	return raw
}

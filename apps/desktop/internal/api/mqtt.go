package api

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	defaultMqttConnectTimeout = 30 * time.Second
	defaultMqttKeepAlive      = 60
	mqttAckTimeout            = 15 * time.Second
	mqttMaxReconnectAttempts  = 10
)

type mqttCallbacks struct {
	onOpen      func(model.MqttOpenEvent)
	onMessage   func(model.MqttMessage)
	onClose     func(model.MqttCloseEvent)
	onError     func(model.MqttErrorEvent)
	onReconnect func(model.MqttReconnectEvent)
	onDone      func()
}

type mqttConn struct {
	conn      net.Conn
	reader    *bufio.Reader
	version   byte
	keepAlive int
	writeMu   sync.Mutex

	mu         sync.Mutex
	nextID     uint16
	pending    map[uint16]chan mqttAck
	aliases    map[uint16]string
	inboundQoS map[uint16]bool
	closed     chan struct{}
	closeOnce  sync.Once
}

func (c *mqttConn) markClosed() {
	c.closeOnce.Do(func() { close(c.closed) })
}

func (c *mqttConn) write(packet []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(mqttAckTimeout))
	_, err := c.conn.Write(packet)
	return err
}

func (c *mqttConn) reserve() (uint16, chan mqttAck) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for {
		c.nextID++
		if c.nextID == 0 {
			c.nextID = 1
		}
		if _, used := c.pending[c.nextID]; !used {
			ch := make(chan mqttAck, 1)
			c.pending[c.nextID] = ch
			return c.nextID, ch
		}
	}
}

func (c *mqttConn) release(id uint16) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *mqttConn) resolve(ack mqttAck) {
	c.mu.Lock()
	ch := c.pending[ack.ID]
	delete(c.pending, ack.ID)
	c.mu.Unlock()
	if ch != nil {
		ch <- ack
	}
}

func (c *mqttConn) await(ctx context.Context, id uint16, ch chan mqttAck) (mqttAck, error) {
	timer := time.NewTimer(mqttAckTimeout)
	defer timer.Stop()
	select {
	case ack := <-ch:
		return ack, nil
	case <-timer.C:
		c.release(id)
		return mqttAck{}, errors.New("the broker did not acknowledge in time")
	case <-c.closed:
		c.release(id)
		return mqttAck{}, errors.New("the connection to the broker dropped before it acknowledged")
	case <-ctx.Done():
		c.release(id)
		return mqttAck{}, errors.New("MQTT is not connected")
	}
}

type mqttSession struct {
	cancel context.CancelFunc
	id     uint64
	cb     mqttCallbacks

	mu            sync.Mutex
	conn          *mqttConn
	ctx           context.Context
	subscriptions map[string]model.MqttTopic
	order         []string
}

func (s *mqttSession) current() *mqttConn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn
}

type mqttManager struct {
	mu       sync.Mutex
	sessions map[string]*mqttSession
	seq      uint64
}

func newMqttManager() *mqttManager {
	return &mqttManager{sessions: map[string]*mqttSession{}}
}

const (
	mqttFeedInterval   = 100 * time.Millisecond
	mqttFeedMaxPending = 5000
	mqttMaxShownBytes  = 256 << 10
)

type mqttFeed struct {
	mu      sync.Mutex
	pending []model.MqttMessage
	dropped int
	emit    func([]model.MqttMessage)
	stop    chan struct{}
	once    sync.Once
}

func newMqttFeed(emit func([]model.MqttMessage)) *mqttFeed {
	f := &mqttFeed{emit: emit, stop: make(chan struct{})}
	go func() {
		ticker := time.NewTicker(mqttFeedInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				f.flush()
			case <-f.stop:
				f.flush()
				return
			}
		}
	}()
	return f
}

func (f *mqttFeed) add(msg model.MqttMessage) {
	f.mu.Lock()
	f.pending = append(f.pending, msg)
	if extra := len(f.pending) - mqttFeedMaxPending; extra > 0 {
		f.pending = append(f.pending[:0:0], f.pending[extra:]...)
		f.dropped += extra
	}
	f.mu.Unlock()
}

func (f *mqttFeed) flush() {
	f.mu.Lock()
	batch, dropped := f.pending, f.dropped
	f.pending, f.dropped = nil, 0
	f.mu.Unlock()
	if dropped > 0 {
		batch = append([]model.MqttMessage{mqttSystemMessage(fmt.Sprintf("%d messages arrived faster than the log can show them and were left out", dropped), false)}, batch...)
	}
	if len(batch) > 0 {
		f.emit(batch)
	}
}

func (f *mqttFeed) close() {
	f.once.Do(func() { close(f.stop) })
}

func (m *mqttManager) runtimeCallbacks(appCtx context.Context, sessionID string) mqttCallbacks {
	feed := newMqttFeed(func(msgs []model.MqttMessage) {
		emitRealtime(appCtx, sessionID, "mqtt:messages", model.MqttBatchPayload{SessionID: sessionID, Messages: msgs})
	})
	return mqttCallbacks{
		onOpen:    func(ev model.MqttOpenEvent) { feed.flush(); emitRealtime(appCtx, sessionID, "mqtt:open", ev) },
		onMessage: feed.add,
		onClose:   func(ev model.MqttCloseEvent) { feed.flush(); emitRealtime(appCtx, sessionID, "mqtt:close", ev) },
		onError:   func(ev model.MqttErrorEvent) { feed.flush(); emitRealtime(appCtx, sessionID, "mqtt:error", ev) },
		onReconnect: func(ev model.MqttReconnectEvent) {
			feed.flush()
			emitRealtime(appCtx, sessionID, "mqtt:reconnecting", ev)
		},
		onDone: feed.close,
	}
}

func (m *mqttManager) connect(appCtx context.Context, sessionID string, req model.HttpRequest, callbacks mqttCallbacks) {
	ctx, cancel := context.WithCancel(appCtx)
	sess := &mqttSession{cancel: cancel, ctx: ctx, subscriptions: map[string]model.MqttTopic{}}
	m.mu.Lock()
	if existing := m.sessions[sessionID]; existing != nil {
		existing.cancel()
	}
	m.seq++
	sess.id = m.seq
	m.sessions[sessionID] = sess
	m.mu.Unlock()
	guard := func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.sessions[sessionID] == sess
	}
	guarded := mqttCallbacks{
		onOpen: func(ev model.MqttOpenEvent) {
			if guard() {
				callbacks.onOpen(ev)
			}
		},
		onMessage: func(msg model.MqttMessage) {
			if guard() {
				callbacks.onMessage(msg)
			}
		},
		onClose: func(ev model.MqttCloseEvent) {
			if guard() {
				callbacks.onClose(ev)
			}
		},
		onError: func(ev model.MqttErrorEvent) {
			if guard() {
				callbacks.onError(ev)
			}
		},
		onReconnect: func(ev model.MqttReconnectEvent) {
			if guard() && callbacks.onReconnect != nil {
				callbacks.onReconnect(ev)
			}
		},
	}
	sess.cb = guarded
	go func() {
		if callbacks.onDone != nil {
			defer callbacks.onDone()
		}
		defer func() {
			if r := recover(); r != nil {
				log.Printf("kurlo: mqtt session %s panicked: %v", sessionID, r)
			}
			m.mu.Lock()
			if m.sessions[sessionID] == sess {
				delete(m.sessions, sessionID)
			}
			m.mu.Unlock()
		}()
		runMqttSession(ctx, sessionID, sess, req, guarded)
	}()
}

func (m *mqttManager) session(sessionID string) *mqttSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[sessionID]
}

func (m *mqttManager) disconnect(sessionID string) {
	m.mu.Lock()
	sess := m.sessions[sessionID]
	m.mu.Unlock()
	if sess != nil {
		sess.cancel()
	}
}

func (m *mqttManager) disconnectAll() {
	m.mu.Lock()
	sessions := m.sessions
	m.sessions = map[string]*mqttSession{}
	m.mu.Unlock()
	for _, sess := range sessions {
		sess.cancel()
		if conn := sess.current(); conn != nil {
			_ = conn.write(mqttDisconnectPacket(conn.version))
			_ = conn.conn.Close()
		}
	}
}

func runMqttSession(ctx context.Context, sessionID string, sess *mqttSession, req model.HttpRequest, cb mqttCallbacks) {
	cfg := mqttConfig(req)
	now := func() int64 { return time.Now().UnixMilli() }
	failures := 0
	for {
		conn, open, err := dialMqtt(ctx, req, cfg)
		if err != nil {
			if ctx.Err() != nil {
				cb.onClose(model.MqttCloseEvent{SessionID: sessionID, Message: "Disconnected", Timestamp: now()})
				return
			}
			cb.onError(model.MqttErrorEvent{SessionID: sessionID, Message: err.Error(), Timestamp: now()})
			var refused mqttRefusedError
			if !cfg.AutoReconnect || errors.As(err, &refused) || failures >= mqttMaxReconnectAttempts {
				return
			}
		} else {
			failures = 0
			open.SessionID = sessionID
			sess.mu.Lock()
			sess.conn = conn
			sess.mu.Unlock()
			cb.onOpen(open)
			reason, clean := serveMqtt(ctx, sess, conn, cfg, cb)
			sess.mu.Lock()
			sess.conn = nil
			sess.mu.Unlock()
			if clean || ctx.Err() != nil {
				cb.onClose(model.MqttCloseEvent{SessionID: sessionID, Message: reason, Timestamp: now()})
				return
			}
			if !cfg.AutoReconnect {
				cb.onError(model.MqttErrorEvent{SessionID: sessionID, Message: reason, Timestamp: now()})
				return
			}
			cb.onMessage(mqttSystemMessage(reason, true))
		}
		failures++
		cb.onReconnect(model.MqttReconnectEvent{SessionID: sessionID, Attempt: failures, Timestamp: now()})
		delay := time.Duration(min(failures, 5)) * time.Second
		select {
		case <-ctx.Done():
			cb.onClose(model.MqttCloseEvent{SessionID: sessionID, Message: "Disconnected", Timestamp: now()})
			return
		case <-time.After(delay):
		}
	}
}

func serveMqtt(ctx context.Context, sess *mqttSession, conn *mqttConn, cfg model.MqttRequest, cb mqttCallbacks) (string, bool) {
	connCtx, stop := context.WithCancel(ctx)
	defer stop()
	defer conn.markClosed()
	go func() {
		<-connCtx.Done()
		if ctx.Err() != nil {
			_ = conn.write(mqttDisconnectPacket(conn.version))
		}
		_ = conn.conn.Close()
	}()
	if conn.keepAlive > 0 {
		go func() {
			ticker := time.NewTicker(time.Duration(conn.keepAlive) * time.Second * 3 / 4)
			defer ticker.Stop()
			for {
				select {
				case <-connCtx.Done():
					return
				case <-ticker.C:
					if conn.write(mqttFrame(mqttPingreq, 0, nil)) != nil {
						return
					}
				}
			}
		}()
	}
	go func() {
		sess.mu.Lock()
		topics := make([]model.MqttTopic, 0, len(sess.order))
		for _, name := range sess.order {
			topics = append(topics, sess.subscriptions[name])
		}
		sess.mu.Unlock()
		if len(topics) == 0 {
			for _, topic := range cfg.Topics {
				if topic.Enabled && strings.TrimSpace(topic.Name) != "" {
					topics = append(topics, topic)
				}
			}
		}
		for _, topic := range topics {
			if connCtx.Err() != nil {
				return
			}
			_ = mqttSubscribeTopic(connCtx, sess, conn, topic, cb)
		}
	}()

	reader := conn.reader
	idle := time.Duration(0)
	if conn.keepAlive > 0 {
		idle = time.Duration(conn.keepAlive)*time.Second*3/2 + 5*time.Second
	}
	for {
		if idle > 0 {
			_ = conn.conn.SetReadDeadline(time.Now().Add(idle))
		}
		pkt, err := readMqttPacket(reader)
		if err != nil {
			if ctx.Err() != nil {
				return "Disconnected", true
			}
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				return "The broker stopped answering keep-alive pings", false
			}
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				return "The broker closed the connection", false
			}
			return "MQTT read error: " + err.Error(), false
		}
		switch pkt.Kind {
		case mqttPublish:
			pub, err := decodeMqttPublish(pkt, conn.version)
			if err != nil {
				return "Malformed PUBLISH from the broker: " + err.Error(), false
			}
			if alias, ok := pub.Props.num(mqttPropTopicAlias); ok && alias > 0 {
				conn.mu.Lock()
				if pub.Topic != "" {
					conn.aliases[uint16(alias)] = pub.Topic
				} else {
					pub.Topic = conn.aliases[uint16(alias)]
				}
				conn.mu.Unlock()
			}
			switch pub.QoS {
			case 1:
				_ = conn.write(mqttAckPacket(mqttPuback, pub.PacketID, conn.version, 0))
			case 2:
				conn.mu.Lock()
				seen := conn.inboundQoS[pub.PacketID]
				conn.inboundQoS[pub.PacketID] = true
				conn.mu.Unlock()
				_ = conn.write(mqttAckPacket(mqttPubrec, pub.PacketID, conn.version, 0))
				if seen {
					continue
				}
			}
			cb.onMessage(mqttMessageFrom("incoming", pub))
		case mqttPubrel:
			ack, _ := decodeMqttAck(pkt, conn.version)
			conn.mu.Lock()
			delete(conn.inboundQoS, ack.ID)
			conn.mu.Unlock()
			_ = conn.write(mqttAckPacket(mqttPubcomp, ack.ID, conn.version, 0))
		case mqttPubrec:
			ack, _ := decodeMqttAck(pkt, conn.version)
			if len(ack.Codes) > 0 && ack.Codes[0] >= 0x80 {
				conn.resolve(ack)
				continue
			}
			_ = conn.write(mqttAckPacket(mqttPubrel, ack.ID, conn.version, 0))
		case mqttPuback, mqttPubcomp, mqttSuback, mqttUnsuback:
			ack, err := decodeMqttAck(pkt, conn.version)
			if err == nil {
				conn.resolve(ack)
			}
		case mqttPingresp:
		case mqttDisconnect:
			code, reason := decodeMqttDisconnect(pkt.Body)
			return "The broker closed the connection: " + mqttReasonText(code, reason), code == 0
		case mqttAuth:
			return "The broker asked for enhanced authentication, which Kurlo does not support", false
		}
	}
}

func mqttSubscribeTopic(ctx context.Context, sess *mqttSession, conn *mqttConn, topic model.MqttTopic, cb mqttCallbacks) error {
	name := strings.TrimSpace(topic.Name)
	id, ch := conn.reserve()
	qos := byte(min(max(topic.QoS, 0), 2))
	if err := conn.write(mqttSubscribePacket(id, conn.version, []mqttSubscription{{Topic: name, QoS: qos, NoLocal: topic.NoLocal, RetainAsPub: topic.RetainAsPub}})); err != nil {
		conn.release(id)
		return err
	}
	ack, err := conn.await(ctx, id, ch)
	if err != nil {
		cb.onMessage(mqttSystemMessage(fmt.Sprintf("Could not subscribe to %s: %s", name, err), true))
		return err
	}
	if len(ack.Codes) == 0 || ack.Codes[0] >= 0x80 {
		code := byte(0x80)
		if len(ack.Codes) > 0 {
			code = ack.Codes[0]
		}
		message := fmt.Sprintf("The broker refused the subscription to %s: %s", name, mqttReasonText(code, ack.Reason))
		cb.onMessage(mqttSystemMessage(message, true))
		return errors.New(message)
	}
	sess.mu.Lock()
	if _, ok := sess.subscriptions[name]; !ok {
		sess.order = append(sess.order, name)
	}
	topic.Name = name
	sess.subscriptions[name] = topic
	sess.mu.Unlock()
	msg := mqttSystemMessage(fmt.Sprintf("Subscribed to %s (QoS %d)", name, ack.Codes[0]), false)
	msg.Topic = name
	msg.QoS = int(ack.Codes[0])
	cb.onMessage(msg)
	return nil
}

func (m *mqttManager) subscribe(sessionID string, topic model.MqttTopic) model.MqttResult {
	sess := m.session(sessionID)
	if sess == nil || sess.current() == nil {
		return model.MqttResult{Error: "MQTT is not connected"}
	}
	if err := validateMqttTopicFilter(topic.Name); err != nil {
		return model.MqttResult{Error: err.Error()}
	}
	if err := mqttSubscribeTopic(sess.ctx, sess, sess.current(), topic, sess.cb); err != nil {
		return model.MqttResult{Error: err.Error()}
	}
	return model.MqttResult{OK: true}
}

func (m *mqttManager) unsubscribe(sessionID, topic string) model.MqttResult {
	sess := m.session(sessionID)
	conn := (*mqttConn)(nil)
	if sess != nil {
		conn = sess.current()
	}
	if conn == nil {
		return model.MqttResult{Error: "MQTT is not connected"}
	}
	name := strings.TrimSpace(topic)
	id, ch := conn.reserve()
	if err := conn.write(mqttUnsubscribePacket(id, conn.version, []string{name})); err != nil {
		conn.release(id)
		return model.MqttResult{Error: err.Error()}
	}
	ack, err := conn.await(sess.ctx, id, ch)
	if err != nil {
		return model.MqttResult{Error: err.Error()}
	}
	if len(ack.Codes) > 0 && ack.Codes[0] >= 0x80 {
		return model.MqttResult{Error: "The broker refused to unsubscribe: " + mqttReasonText(ack.Codes[0], ack.Reason)}
	}
	sess.mu.Lock()
	delete(sess.subscriptions, name)
	for i, existing := range sess.order {
		if existing == name {
			sess.order = append(sess.order[:i], sess.order[i+1:]...)
			break
		}
	}
	sess.mu.Unlock()
	msg := mqttSystemMessage("Unsubscribed from "+name, false)
	msg.Topic = name
	sess.cb.onMessage(msg)
	return model.MqttResult{OK: true}
}

func (m *mqttManager) publish(sessionID string, msg model.MqttPublishMessage) model.MqttResult {
	sess := m.session(sessionID)
	conn := (*mqttConn)(nil)
	if sess != nil {
		conn = sess.current()
	}
	if conn == nil {
		return model.MqttResult{Error: "MQTT is not connected"}
	}
	pub, err := mqttPublishFrom(msg, conn.version)
	if err != nil {
		return model.MqttResult{Error: err.Error()}
	}
	var ch chan mqttAck
	if pub.QoS > 0 {
		pub.PacketID, ch = conn.reserve()
	}
	if err := conn.write(pub.encode(conn.version)); err != nil {
		if ch != nil {
			conn.release(pub.PacketID)
		}
		return model.MqttResult{Error: err.Error()}
	}
	if ch != nil {
		ack, err := conn.await(sess.ctx, pub.PacketID, ch)
		if err != nil {
			return model.MqttResult{Error: err.Error()}
		}
		if len(ack.Codes) > 0 && ack.Codes[0] >= 0x80 {
			return model.MqttResult{Error: "The broker rejected the message: " + mqttReasonText(ack.Codes[0], ack.Reason)}
		}
	}
	sess.cb.onMessage(mqttMessageFrom("outgoing", pub))
	return model.MqttResult{OK: true}
}

func validateMqttTopicName(topic string) error {
	if topic == "" {
		return errors.New("enter a topic to publish to")
	}
	if strings.ContainsAny(topic, "+#") {
		return fmt.Errorf("topic %q contains a wildcard; wildcards work only in subscriptions", topic)
	}
	return nil
}

func validateMqttTopicFilter(filter string) error {
	filter = strings.TrimSpace(filter)
	if filter == "" {
		return errors.New("enter a topic to subscribe to")
	}
	levels := strings.Split(filter, "/")
	for i, level := range levels {
		if strings.Contains(level, "#") && (level != "#" || i != len(levels)-1) {
			return fmt.Errorf("topic filter %q: # must be the last level on its own", filter)
		}
		if strings.Contains(level, "+") && level != "+" {
			return fmt.Errorf("topic filter %q: + must fill a whole level", filter)
		}
	}
	return nil
}

func mqttPayloadBytes(payload, format string) ([]byte, error) {
	switch strings.ToLower(format) {
	case "base64":
		out, err := base64.StdEncoding.DecodeString(strings.TrimSpace(payload))
		if err != nil {
			return nil, fmt.Errorf("the message is not valid Base64: %w", err)
		}
		return out, nil
	case "hex":
		clean := strings.NewReplacer(" ", "", "\n", "", "\t", "", "\r", "").Replace(payload)
		clean = strings.TrimPrefix(strings.TrimPrefix(clean, "0x"), "0X")
		out, err := hex.DecodeString(clean)
		if err != nil {
			return nil, fmt.Errorf("the message is not valid hexadecimal: %w", err)
		}
		return out, nil
	}
	return []byte(payload), nil
}

func mqttUint(value, field string, limit uint64) (uint32, bool, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false, nil
	}
	n, err := strconv.ParseUint(value, 10, 32)
	if err != nil || n > limit {
		return 0, false, fmt.Errorf("%s must be a whole number from 0 to %d", field, limit)
	}
	return uint32(n), true, nil
}

func mqttPublishProps(p model.MqttPublishProperties) (mqttProps, error) {
	var props mqttProps
	if p.PayloadFormatIndicator {
		props = append(props, mqttProp{ID: mqttPropPayloadFormat, Num: 1})
	}
	if n, ok, err := mqttUint(p.MessageExpiryInterval, "Message expiry interval", 1<<32-1); err != nil {
		return nil, err
	} else if ok {
		props = append(props, mqttProp{ID: mqttPropMessageExpiry, Num: n})
	}
	if n, ok, err := mqttUint(p.TopicAlias, "Topic alias", 65535); err != nil {
		return nil, err
	} else if ok && n > 0 {
		props = append(props, mqttProp{ID: mqttPropTopicAlias, Num: n})
	}
	if p.ContentType != "" {
		props = append(props, mqttProp{ID: mqttPropContentType, Str: p.ContentType})
	}
	if p.ResponseTopic != "" {
		props = append(props, mqttProp{ID: mqttPropResponseTopic, Str: p.ResponseTopic})
	}
	if p.CorrelationData != "" {
		props = append(props, mqttProp{ID: mqttPropCorrelationData, Bin: []byte(p.CorrelationData)})
	}
	return append(props, mqttUserProps(p.UserProperties)...), nil
}

func mqttUserProps(rows []model.KeyValue) mqttProps {
	var props mqttProps
	for _, row := range rows {
		if row.Enabled && row.Key != "" {
			props = append(props, mqttProp{ID: mqttPropUserProperty, Str: row.Key, Value: row.Value})
		}
	}
	return props
}

func mqttPublishFrom(msg model.MqttPublishMessage, version byte) (mqttPublishPacket, error) {
	topic := strings.TrimSpace(msg.Topic)
	alias := strings.TrimSpace(msg.Properties.TopicAlias)
	aliasOnly := topic == "" && version == 5 && alias != "" && alias != "0"
	if !aliasOnly {
		if err := validateMqttTopicName(topic); err != nil {
			return mqttPublishPacket{}, err
		}
	}
	payload, err := mqttPayloadBytes(msg.Payload, msg.Format)
	if err != nil {
		return mqttPublishPacket{}, err
	}
	pub := mqttPublishPacket{Topic: topic, Payload: payload, QoS: byte(min(max(msg.QoS, 0), 2)), Retain: msg.Retain}
	if version == 5 {
		if pub.Props, err = mqttPublishProps(msg.Properties); err != nil {
			return mqttPublishPacket{}, err
		}
	}
	return pub, nil
}

func mqttMessageFrom(direction string, pub mqttPublishPacket) model.MqttMessage {
	msg := model.MqttMessage{
		ID: newEventID(), Direction: direction, Topic: pub.Topic, Size: len(pub.Payload), QoS: int(pub.QoS),
		Retain: pub.Retain, Duplicate: pub.Dup, Timestamp: time.Now().UnixMilli(),
		ContentType: pub.Props.str(mqttPropContentType), ResponseTopic: pub.Props.str(mqttPropResponseTopic),
	}
	shown := pub.Payload
	if len(shown) > mqttMaxShownBytes {
		shown, msg.Truncated = shown[:mqttMaxShownBytes], true
	}
	if text, ok := mqttUTF8Prefix(shown, msg.Truncated); ok {
		msg.Payload = text
	} else {
		msg.Payload, msg.Encoding = base64.StdEncoding.EncodeToString(shown), "base64"
	}
	if data := pub.Props.bin(mqttPropCorrelationData); data != nil {
		if utf8.Valid(data) {
			msg.CorrelationData = string(data)
		} else {
			msg.CorrelationData = base64.StdEncoding.EncodeToString(data)
		}
	}
	for _, pair := range pub.Props.pairs() {
		msg.UserProperties = append(msg.UserProperties, model.KeyValue{Key: pair[0], Value: pair[1], Enabled: true})
	}
	return msg
}

func mqttUTF8Prefix(data []byte, cut bool) (string, bool) {
	if utf8.Valid(data) {
		return string(data), true
	}
	if !cut {
		return "", false
	}
	for trim := 1; trim < utf8.UTFMax && trim < len(data); trim++ {
		if utf8.Valid(data[:len(data)-trim]) {
			return string(data[:len(data)-trim]), true
		}
	}
	return "", false
}

func mqttSystemMessage(text string, isError bool) model.MqttMessage {
	return model.MqttMessage{ID: newEventID(), Direction: "system", Timestamp: time.Now().UnixMilli(), IsSystem: true, IsError: isError, Message: text}
}

func mqttConfig(req model.HttpRequest) model.MqttRequest {
	cfg := model.MqttRequest{CleanSession: true}
	if req.Mqtt != nil {
		cfg = *req.Mqtt
	}
	if cfg.Version == "" {
		cfg.Version = "5"
	}
	if cfg.KeepAliveSec < 0 {
		cfg.KeepAliveSec = 0
	} else if cfg.KeepAliveSec == 0 && req.Mqtt == nil {
		cfg.KeepAliveSec = defaultMqttKeepAlive
	}
	cfg.KeepAliveSec = min(cfg.KeepAliveSec, 65535)
	return cfg
}

func mqttVersionByte(version string) (byte, string, error) {
	switch strings.TrimSpace(version) {
	case "", "5", "5.0":
		return 5, "MQTT", nil
	case "3.1.1", "4":
		return 4, "MQTT", nil
	case "3.1", "3":
		return 3, "MQIsdp", nil
	}
	return 0, "", fmt.Errorf("unsupported MQTT version %q", version)
}

func mqttRandomClientID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "kurlo-" + hex.EncodeToString(b)
}

type mqttTarget struct {
	scheme string
	url    *url.URL
	addr   string
}

func parseMqttURL(raw string) (mqttTarget, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return mqttTarget{}, errors.New("enter a broker URL, for example mqtt://localhost:1883")
	}
	if strings.Contains(raw, "{{") {
		return mqttTarget{}, errors.New("the broker URL contains an unresolved variable — make sure all {{variables}} are defined in the active environment")
	}
	if !strings.Contains(raw, "://") {
		raw = "mqtt://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return mqttTarget{}, fmt.Errorf("invalid broker URL: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	ports := map[string]string{"mqtt": "1883", "tcp": "1883", "mqtts": "8883", "ssl": "8883", "tls": "8883", "ws": "80", "wss": "443"}
	port, ok := ports[scheme]
	if !ok {
		return mqttTarget{}, fmt.Errorf("unsupported broker URL scheme %q. Use mqtt://, mqtts://, ws:// or wss://", u.Scheme)
	}
	if u.Hostname() == "" {
		return mqttTarget{}, errors.New("the broker URL has no host. Try mqtt://localhost:1883")
	}
	if u.Port() != "" {
		port = u.Port()
	}
	switch scheme {
	case "tcp":
		scheme = "mqtt"
	case "ssl", "tls":
		scheme = "mqtts"
	}
	if (scheme == "ws" || scheme == "wss") && (u.Path == "" || u.Path == "/") {
		u.Path = "/mqtt"
	}
	return mqttTarget{scheme: scheme, url: u, addr: net.JoinHostPort(u.Hostname(), port)}, nil
}

func mqttTLSConfig(req model.HttpRequest, host string) (*tls.Config, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: !req.EnableSSLVerification, ServerName: host}
	if cert := clientCertConfigFor(req); cert.enabled() {
		cert.certPath = resolveRequestFilePath(req.FileRoot, cert.certPath)
		if cert.keyPath != "" {
			cert.keyPath = resolveRequestFilePath(req.FileRoot, cert.keyPath)
		}
		pair, err := clientCerts.load(cert)
		if err != nil {
			return nil, err
		}
		cfg.Certificates = []tls.Certificate{pair}
	}
	return cfg, nil
}

type mqttRefusedError struct{ message string }

func (e mqttRefusedError) Error() string { return e.message }

func dialMqtt(ctx context.Context, req model.HttpRequest, cfg model.MqttRequest) (*mqttConn, model.MqttOpenEvent, error) {
	target, err := parseMqttURL(req.URL)
	if err != nil {
		return nil, model.MqttOpenEvent{}, mqttRefusedError{err.Error()}
	}
	version, protocolName, err := mqttVersionByte(cfg.Version)
	if err != nil {
		return nil, model.MqttOpenEvent{}, mqttRefusedError{err.Error()}
	}
	connect, err := mqttConnectFrom(req, cfg, version, protocolName)
	if err != nil {
		return nil, model.MqttOpenEvent{}, mqttRefusedError{err.Error()}
	}
	timeout := defaultMqttConnectTimeout
	if cfg.ConnectTimeoutMs > 0 {
		timeout = time.Duration(cfg.ConnectTimeoutMs) * time.Millisecond
	}
	dialCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	raw, err := dialMqttTransport(dialCtx, req, target, version)
	if err != nil {
		if dialCtx.Err() == context.DeadlineExceeded {
			return nil, model.MqttOpenEvent{}, fmt.Errorf("could not reach %s within %s", target.addr, timeout)
		}
		return nil, model.MqttOpenEvent{}, fmt.Errorf("could not connect to %s: %w", target.addr, err)
	}
	stopWatch := context.AfterFunc(dialCtx, func() { _ = raw.SetDeadline(time.Now()) })
	defer stopWatch()
	conn := &mqttConn{conn: raw, reader: bufio.NewReaderSize(raw, 64<<10), version: version, keepAlive: cfg.KeepAliveSec, pending: map[uint16]chan mqttAck{}, aliases: map[uint16]string{}, inboundQoS: map[uint16]bool{}, closed: make(chan struct{})}
	if err := conn.write(connect.encode()); err != nil {
		_ = raw.Close()
		return nil, model.MqttOpenEvent{}, fmt.Errorf("could not send CONNECT: %w", err)
	}
	pkt, err := readMqttPacket(conn.reader)
	if err != nil {
		_ = raw.Close()
		if dialCtx.Err() == context.DeadlineExceeded {
			return nil, model.MqttOpenEvent{}, fmt.Errorf("the broker did not answer CONNECT within %s", timeout)
		}
		if ctx.Err() != nil {
			return nil, model.MqttOpenEvent{}, ctx.Err()
		}
		return nil, model.MqttOpenEvent{}, fmt.Errorf("the broker closed the connection during CONNECT. Check the MQTT version and the URL: %w", err)
	}
	if pkt.Kind != mqttConnack {
		_ = raw.Close()
		return nil, model.MqttOpenEvent{}, fmt.Errorf("the broker answered CONNECT with packet type %d", pkt.Kind)
	}
	ack, err := decodeMqttConnack(pkt.Body, version)
	if err != nil {
		_ = raw.Close()
		return nil, model.MqttOpenEvent{}, err
	}
	if ack.Code != 0 {
		_ = raw.Close()
		text := mqttConnackV3Codes[ack.Code]
		if version == 5 {
			text = mqttReasonText(ack.Code, ack.Props.str(mqttPropReasonString))
		}
		if text == "" {
			text = fmt.Sprintf("return code %d", ack.Code)
		}
		return nil, model.MqttOpenEvent{}, mqttRefusedError{"The broker refused the connection: " + text}
	}
	_ = raw.SetDeadline(time.Time{})
	clientID := connect.ClientID
	if assigned := ack.Props.str(mqttPropAssignedClientID); assigned != "" {
		clientID = assigned
	}
	if keep, ok := ack.Props.num(mqttPropServerKeepAlive); ok {
		conn.keepAlive = int(keep)
	}
	versionLabel := map[byte]string{3: "3.1", 4: "3.1.1", 5: "5"}[version]
	return conn, model.MqttOpenEvent{URL: target.url.String(), ClientID: clientID, Version: versionLabel, SessionPresent: ack.SessionPresent, Timestamp: time.Now().UnixMilli()}, nil
}

func mqttConnectFrom(req model.HttpRequest, cfg model.MqttRequest, version byte, protocolName string) (mqttConnectPacket, error) {
	clientID := strings.TrimSpace(cfg.ClientID)
	if clientID == "" {
		clientID = mqttRandomClientID()
	}
	connect := mqttConnectPacket{Version: version, ProtocolName: protocolName, ClientID: clientID, CleanStart: cfg.CleanSession, KeepAlive: uint16(cfg.KeepAliveSec)}
	if strings.EqualFold(req.Auth.Type, "basic") {
		connect.Username, connect.HasUsername = req.Auth.Username, req.Auth.Username != ""
		connect.Password, connect.HasPassword = req.Auth.Password, req.Auth.Password != ""
		if connect.HasPassword && !connect.HasUsername && version != 5 {
			connect.HasUsername = true
		}
	}
	if version == 5 {
		cp := cfg.ConnectProperties
		for _, field := range []struct {
			id    byte
			value string
			name  string
			limit uint64
		}{
			{mqttPropSessionExpiry, cp.SessionExpiryInterval, "Session expiry interval", 1<<32 - 1},
			{mqttPropReceiveMaximum, cp.ReceiveMaximum, "Receive maximum", 65535},
			{mqttPropMaximumPacketSize, cp.MaximumPacketSize, "Maximum packet size", 1<<32 - 1},
			{mqttPropTopicAliasMaximum, cp.TopicAliasMaximum, "Topic alias maximum", 65535},
		} {
			n, ok, err := mqttUint(field.value, field.name, field.limit)
			if err != nil {
				return connect, err
			}
			if ok {
				if (field.id == mqttPropReceiveMaximum || field.id == mqttPropMaximumPacketSize) && n == 0 {
					return connect, fmt.Errorf("%s must be greater than 0", field.name)
				}
				connect.Props = append(connect.Props, mqttProp{ID: field.id, Num: n})
			}
		}
		if cp.RequestResponseInformation {
			connect.Props = append(connect.Props, mqttProp{ID: mqttPropRequestResponse, Num: 1})
		}
		if cp.RequestProblemInformation {
			connect.Props = append(connect.Props, mqttProp{ID: mqttPropRequestProblem, Num: 1})
		}
		connect.Props = append(connect.Props, mqttUserProps(cp.UserProperties)...)
	}
	if will := cfg.Will; will.Enabled {
		if err := validateMqttTopicName(strings.TrimSpace(will.Topic)); err != nil {
			return connect, fmt.Errorf("last will: %w", err)
		}
		payload, err := mqttPayloadBytes(will.Payload, will.Format)
		if err != nil {
			return connect, fmt.Errorf("last will: %w", err)
		}
		connect.Will = &mqttPublishPacket{Topic: strings.TrimSpace(will.Topic), Payload: payload, QoS: byte(min(max(will.QoS, 0), 2)), Retain: will.Retain}
		if version == 5 {
			props, err := mqttPublishProps(will.Properties)
			if err != nil {
				return connect, fmt.Errorf("last will: %w", err)
			}
			if n, ok, err := mqttUint(will.DelayInterval, "Will delay interval", 1<<32-1); err != nil {
				return connect, fmt.Errorf("last will: %w", err)
			} else if ok {
				props = append(props, mqttProp{ID: mqttPropWillDelay, Num: n})
			}
			kept := props[:0]
			for _, prop := range props {
				if prop.ID != mqttPropTopicAlias {
					kept = append(kept, prop)
				}
			}
			connect.WillProps = kept
		}
	}
	return connect, nil
}

func dialMqttTransport(ctx context.Context, req model.HttpRequest, target mqttTarget, version byte) (net.Conn, error) {
	switch target.scheme {
	case "mqtt", "mqtts":
		conn, err := dialMqttTCP(ctx, req, target)
		if err != nil || target.scheme == "mqtt" {
			return conn, err
		}
		cfg, err := mqttTLSConfig(req, target.url.Hostname())
		if err != nil {
			_ = conn.Close()
			return nil, err
		}
		tlsConn := tls.Client(conn, cfg)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}
	protocol := "mqtt"
	if version == 3 {
		protocol = "mqttv3.1"
	}
	dialer := websocket.Dialer{Subprotocols: []string{protocol}, Proxy: proxyForRequest(req)}
	if target.scheme == "wss" {
		cfg, err := mqttTLSConfig(req, target.url.Hostname())
		if err != nil {
			return nil, err
		}
		dialer.TLSClientConfig = cfg
	}
	headers := http.Header{"User-Agent": []string{"Kurlo/" + appVersion}}
	_, _ = applyUserHeaders(headers, req.Headers)
	wsURL := cloneURL(target.url)
	wsURL.Host = target.addr
	ws, resp, err := dialer.DialContext(ctx, wsURL.String(), headers)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("WebSocket handshake failed: %s", resp.Status)
		}
		return nil, err
	}
	return &mqttWebSocketConn{Conn: ws}, nil
}

type mqttWebSocketConn struct {
	*websocket.Conn
	reader io.Reader
}

func (c *mqttWebSocketConn) Read(p []byte) (int, error) {
	for {
		if c.reader == nil {
			kind, r, err := c.NextReader()
			if err != nil {
				return 0, err
			}
			if kind != websocket.BinaryMessage {
				continue
			}
			c.reader = r
		}
		n, err := c.reader.Read(p)
		if errors.Is(err, io.EOF) {
			c.reader = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (c *mqttWebSocketConn) Write(p []byte) (int, error) {
	if err := c.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *mqttWebSocketConn) SetDeadline(t time.Time) error {
	if err := c.SetReadDeadline(t); err != nil {
		return err
	}
	return c.SetWriteDeadline(t)
}

package api

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"io"
	"log/slog"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type mqttTestBroker struct {
	tcp string
	ws  string
}

func closeMqttBroker(server *mochi.Server) {
	done := make(chan struct{})
	go func() {
		_ = server.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
}

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	return addr
}

func startMqttBroker(t *testing.T, withAuth bool) mqttTestBroker {
	t.Helper()
	server := mochi.New(&mochi.Options{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if withAuth {
		ledger := &auth.Ledger{
			Auth: auth.AuthRules{{Username: "kurlo", Password: "secret", Allow: true}},
			ACL:  auth.ACLRules{{Filters: auth.Filters{"#": auth.ReadWrite}}},
		}
		if err := server.AddHook(new(auth.Hook), &auth.Options{Ledger: ledger}); err != nil {
			t.Fatal(err)
		}
	} else if err := server.AddHook(new(auth.AllowHook), nil); err != nil {
		t.Fatal(err)
	}
	tcp, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	broker := mqttTestBroker{tcp: tcp.Addr().String(), ws: freeAddr(t)}
	if err := server.AddListener(listeners.NewNet("tcp", tcp)); err != nil {
		t.Fatal(err)
	}
	if err := server.AddListener(listeners.NewWebsocket(listeners.Config{ID: "ws", Address: broker.ws})); err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve() }()
	t.Cleanup(func() { closeMqttBroker(server) })
	for _, addr := range []string{broker.tcp, broker.ws} {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if c, err := net.Dial("tcp", addr); err == nil {
				_ = c.Close()
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	return broker
}

type mqttRecorder struct {
	mu       sync.Mutex
	opens    []model.MqttOpenEvent
	messages []model.MqttMessage
	errors   []string
	closes   []string
	changed  chan struct{}
}

func newMqttRecorder() *mqttRecorder { return &mqttRecorder{changed: make(chan struct{}, 1000)} }

func (r *mqttRecorder) callbacks() mqttCallbacks {
	note := func() {
		select {
		case r.changed <- struct{}{}:
		default:
		}
	}
	return mqttCallbacks{
		onOpen: func(ev model.MqttOpenEvent) { r.mu.Lock(); r.opens = append(r.opens, ev); r.mu.Unlock(); note() },
		onMessage: func(msg model.MqttMessage) {
			r.mu.Lock()
			r.messages = append(r.messages, msg)
			r.mu.Unlock()
			note()
		},
		onClose: func(ev model.MqttCloseEvent) {
			r.mu.Lock()
			r.closes = append(r.closes, ev.Message)
			r.mu.Unlock()
			note()
		},
		onError: func(ev model.MqttErrorEvent) {
			r.mu.Lock()
			r.errors = append(r.errors, ev.Message)
			r.mu.Unlock()
			note()
		},
		onReconnect: func(model.MqttReconnectEvent) { note() },
	}
}

func (r *mqttRecorder) wait(t *testing.T, what string, ok func(*mqttRecorder) bool) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		r.mu.Lock()
		done := ok(r)
		r.mu.Unlock()
		if done {
			return
		}
		select {
		case <-r.changed:
		case <-deadline:
			r.mu.Lock()
			defer r.mu.Unlock()
			t.Fatalf("timed out waiting for %s; opens=%v errors=%v closes=%v messages=%+v", what, r.opens, r.errors, r.closes, r.messages)
		}
	}
}

func (r *mqttRecorder) received(direction, topic string) []model.MqttMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]model.MqttMessage(nil), r.find(direction, topic)...)
}

func (r *mqttRecorder) find(direction, topic string) []model.MqttMessage {
	var out []model.MqttMessage
	for _, msg := range r.messages {
		if msg.Direction == direction && msg.Topic == topic {
			out = append(out, msg)
		}
	}
	return out
}

func (r *mqttRecorder) hasSystem(text string) bool {
	for _, msg := range r.messages {
		if msg.IsSystem && strings.Contains(msg.Message, text) {
			return true
		}
	}
	return false
}

func mqttTestRequest(url, version string, topics ...model.MqttTopic) model.HttpRequest {
	return model.HttpRequest{URL: url, Mqtt: &model.MqttRequest{Version: version, CleanSession: true, KeepAliveSec: 30, Topics: topics}}
}

func connectMqttTest(t *testing.T, m *mqttManager, id string, req model.HttpRequest) *mqttRecorder {
	t.Helper()
	rec := newMqttRecorder()
	m.connect(context.Background(), id, req, rec.callbacks())
	t.Cleanup(func() { m.disconnect(id) })
	rec.wait(t, "connection", func(r *mqttRecorder) bool { return len(r.opens) > 0 || len(r.errors) > 0 })
	if len(rec.errors) > 0 {
		t.Fatalf("connect failed: %v", rec.errors)
	}
	return rec
}

func TestMqttPublishSubscribeAcrossVersionsAndQoS(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, false)
	for _, version := range []string{"3.1", "3.1.1", "5"} {
		t.Run(version, func(t *testing.T) {
			m := newMqttManager()
			topic := "kurlo/" + strings.ReplaceAll(version, ".", "")
			rec := connectMqttTest(t, m, "s-"+version, mqttTestRequest("mqtt://"+broker.tcp, version, model.MqttTopic{Name: topic + "/#", QoS: 2, Enabled: true}))
			if rec.opens[0].Version != version {
				t.Fatalf("version = %q", rec.opens[0].Version)
			}
			rec.wait(t, "subscription", func(r *mqttRecorder) bool { return r.hasSystem("Subscribed to " + topic + "/#") })
			for qos := 0; qos <= 2; qos++ {
				res := m.publish("s-"+version, model.MqttPublishMessage{Topic: topic + "/q", Payload: `{"qos":` + string(rune('0'+qos)) + `}`, Format: "json", QoS: qos})
				if !res.OK {
					t.Fatalf("publish qos %d: %s", qos, res.Error)
				}
			}
			rec.wait(t, "three incoming messages", func(r *mqttRecorder) bool { return len(r.find("incoming", topic+"/q")) == 3 })
			if got := len(rec.received("outgoing", topic+"/q")); got != 3 {
				t.Fatalf("outgoing = %d", got)
			}
			for i, msg := range rec.received("incoming", topic+"/q") {
				if msg.QoS != i || msg.Payload != `{"qos":`+string(rune('0'+i))+`}` {
					t.Fatalf("message %d = %+v", i, msg)
				}
			}
			if res := m.unsubscribe("s-"+version, topic+"/#"); !res.OK {
				t.Fatalf("unsubscribe: %s", res.Error)
			}
			m.publish("s-"+version, model.MqttPublishMessage{Topic: topic + "/q", Payload: "late"})
			time.Sleep(150 * time.Millisecond)
			if got := len(rec.received("incoming", topic+"/q")); got != 3 {
				t.Fatalf("received %d messages after unsubscribe", got)
			}
		})
	}
}

func TestMqttV5PropertiesAndBinaryPayloads(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, false)
	m := newMqttManager()
	rec := connectMqttTest(t, m, "props", mqttTestRequest(broker.tcp, "5", model.MqttTopic{Name: "props/+", Enabled: true}))
	rec.wait(t, "subscription", func(r *mqttRecorder) bool { return r.hasSystem("Subscribed to props/+") })
	res := m.publish("props", model.MqttPublishMessage{Topic: "props/a", Payload: "de ad be ef", Format: "hex", QoS: 1, Properties: model.MqttPublishProperties{
		ContentType: "application/octet-stream", ResponseTopic: "props/reply", CorrelationData: "req-1",
		UserProperties: []model.KeyValue{{Key: "trace", Value: "abc", Enabled: true}, {Key: "off", Value: "x"}},
	}})
	if !res.OK {
		t.Fatal(res.Error)
	}
	rec.wait(t, "incoming", func(r *mqttRecorder) bool { return len(r.find("incoming", "props/a")) == 1 })
	msg := rec.received("incoming", "props/a")[0]
	if msg.Encoding != "base64" || msg.Payload != "3q2+7w==" || msg.Size != 4 {
		t.Fatalf("payload = %+v", msg)
	}
	if msg.ContentType != "application/octet-stream" || msg.ResponseTopic != "props/reply" || msg.CorrelationData != "req-1" {
		t.Fatalf("properties = %+v", msg)
	}
	if len(msg.UserProperties) != 1 || msg.UserProperties[0].Key != "trace" || msg.UserProperties[0].Value != "abc" {
		t.Fatalf("user properties = %+v", msg.UserProperties)
	}
	if res := m.publish("props", model.MqttPublishMessage{Topic: "props/#", Payload: "x"}); res.OK || !strings.Contains(res.Error, "wildcard") {
		t.Fatalf("wildcard publish = %+v", res)
	}
	if res := m.publish("props", model.MqttPublishMessage{Topic: "props/a", Payload: "zz", Format: "base64"}); res.OK {
		t.Fatal("invalid base64 was published")
	}
}

func TestMqttRetainedMessageReachesNewSubscriber(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, false)
	m := newMqttManager()
	connectMqttTest(t, m, "pub", mqttTestRequest(broker.tcp, "3.1.1"))
	if res := m.publish("pub", model.MqttPublishMessage{Topic: "state/door", Payload: "open", QoS: 1, Retain: true}); !res.OK {
		t.Fatal(res.Error)
	}
	rec := connectMqttTest(t, m, "sub", mqttTestRequest(broker.tcp, "5", model.MqttTopic{Name: "state/door", Enabled: true, QoS: 1}))
	rec.wait(t, "retained", func(r *mqttRecorder) bool { return len(r.find("incoming", "state/door")) == 1 })
	if got := rec.received("incoming", "state/door")[0]; !got.Retain || got.Payload != "open" {
		t.Fatalf("retained = %+v", got)
	}
}

func TestMqttLastWillIsDeliveredWhenTheClientDrops(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, false)
	m := newMqttManager()
	watcher := connectMqttTest(t, m, "watch", mqttTestRequest(broker.tcp, "5", model.MqttTopic{Name: "will/#", Enabled: true}))
	watcher.wait(t, "subscription", func(r *mqttRecorder) bool { return r.hasSystem("Subscribed to will/#") })
	req := mqttTestRequest(broker.tcp, "3.1.1")
	req.Mqtt.Will = model.MqttWill{Enabled: true, Topic: "will/device", Payload: "gone", QoS: 1}
	connectMqttTest(t, m, "dying", req)
	conn := m.session("dying").current()
	_ = conn.conn.Close()
	watcher.wait(t, "will", func(r *mqttRecorder) bool { return len(r.find("incoming", "will/device")) == 1 })
}

func TestMqttCredentialsAreChecked(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, true)
	for _, version := range []string{"3.1.1", "5"} {
		m := newMqttManager()
		bad := mqttTestRequest(broker.tcp, version)
		bad.Auth = model.AuthConfig{Type: "basic", Username: "kurlo", Password: "wrong"}
		rec := newMqttRecorder()
		m.connect(context.Background(), "bad", bad, rec.callbacks())
		rec.wait(t, "refusal", func(r *mqttRecorder) bool { return len(r.errors) > 0 })
		if !strings.Contains(strings.ToLower(rec.errors[0]), "refused") {
			t.Fatalf("%s: error = %q", version, rec.errors[0])
		}
		good := mqttTestRequest(broker.tcp, version)
		good.Auth = model.AuthConfig{Type: "basic", Username: "kurlo", Password: "secret"}
		connectMqttTest(t, m, "good", good)
	}
}

func TestMqttOverWebSocket(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, false)
	m := newMqttManager()
	rec := connectMqttTest(t, m, "ws", mqttTestRequest("ws://"+broker.ws, "5", model.MqttTopic{Name: "ws/t", Enabled: true}))
	rec.wait(t, "subscription", func(r *mqttRecorder) bool { return r.hasSystem("Subscribed to ws/t") })
	big := strings.Repeat("x", 200<<10)
	if res := m.publish("ws", model.MqttPublishMessage{Topic: "ws/t", Payload: big, QoS: 1}); !res.OK {
		t.Fatal(res.Error)
	}
	rec.wait(t, "echo", func(r *mqttRecorder) bool { return len(r.find("incoming", "ws/t")) == 1 })
	if rec.received("incoming", "ws/t")[0].Size != len(big) {
		t.Fatal("payload was truncated")
	}
}

func TestMqttDisconnectClosesTheSession(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, false)
	m := newMqttManager()
	rec := connectMqttTest(t, m, "bye", mqttTestRequest(broker.tcp, "5"))
	m.disconnect("bye")
	rec.wait(t, "close", func(r *mqttRecorder) bool { return len(r.closes) > 0 })
	if res := m.publish("bye", model.MqttPublishMessage{Topic: "a", Payload: "b"}); res.OK {
		t.Fatal("published after disconnect")
	}
}

func TestMqttAutoReconnectResubscribes(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, false)
	m := newMqttManager()
	req := mqttTestRequest(broker.tcp, "5", model.MqttTopic{Name: "re/t", Enabled: true})
	req.Mqtt.AutoReconnect = true
	rec := connectMqttTest(t, m, "re", req)
	rec.wait(t, "subscription", func(r *mqttRecorder) bool { return r.hasSystem("Subscribed to re/t") })
	_ = m.session("re").current().conn.Close()
	rec.wait(t, "second open", func(r *mqttRecorder) bool { return len(r.opens) == 2 })
	rec.wait(t, "resubscribe", func(r *mqttRecorder) bool {
		n := 0
		for _, msg := range r.messages {
			if msg.IsSystem && msg.Message == "Subscribed to re/t (QoS 0)" {
				n++
			}
		}
		return n == 2
	})
	if res := m.publish("re", model.MqttPublishMessage{Topic: "re/t", Payload: "back"}); !res.OK {
		t.Fatal(res.Error)
	}
	rec.wait(t, "message after reconnect", func(r *mqttRecorder) bool { return len(r.find("incoming", "re/t")) == 1 })
}

func TestMqttConnectionErrors(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"http://broker":      "unsupported broker URL scheme",
		"mqtt://":            "no host",
		"mqtt://{{host}}":    "unresolved variable",
		"mqtt://127.0.0.1:1": "could not connect",
	}
	for url, want := range cases {
		m := newMqttManager()
		rec := newMqttRecorder()
		m.connect(context.Background(), "e", mqttTestRequest(url, "5"), rec.callbacks())
		rec.wait(t, url, func(r *mqttRecorder) bool { return len(r.errors) > 0 })
		if !strings.Contains(rec.errors[0], want) {
			t.Fatalf("%s: %q does not mention %q", url, rec.errors[0], want)
		}
	}
	bad := mqttTestRequest("mqtt://127.0.0.1:1", "5")
	bad.Mqtt.Will = model.MqttWill{Enabled: true, Topic: "a/#"}
	if _, _, err := dialMqtt(context.Background(), bad, *bad.Mqtt); err == nil || !strings.Contains(err.Error(), "last will") {
		t.Fatalf("will error = %v", err)
	}
}

func TestMqttTopicFilterValidation(t *testing.T) {
	t.Parallel()
	for _, ok := range []string{"a", "a/+/b", "#", "a/#", "+"} {
		if err := validateMqttTopicFilter(ok); err != nil {
			t.Fatalf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "a/#/b", "a+", "a/b#"} {
		if validateMqttTopicFilter(bad) == nil {
			t.Fatalf("%q was accepted", bad)
		}
	}
}

func TestMqttURLDefaults(t *testing.T) {
	t.Parallel()
	cases := map[string][2]string{
		"broker.local":           {"mqtt", "broker.local:1883"},
		"mqtts://broker.local":   {"mqtts", "broker.local:8883"},
		"wss://broker.local":     {"wss", "broker.local:443"},
		"ws://broker.local:9001": {"ws", "broker.local:9001"},
		"tcp://broker.local:11":  {"mqtt", "broker.local:11"},
	}
	for raw, want := range cases {
		target, err := parseMqttURL(raw)
		if err != nil || target.scheme != want[0] || target.addr != want[1] {
			t.Fatalf("%s = %+v, %v", raw, target, err)
		}
	}
	if target, _ := parseMqttURL("ws://b"); target.url.Path != "/mqtt" {
		t.Fatalf("ws path = %q", target.url.Path)
	}
}

func TestMqttUnderLoad(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, false)
	m := newMqttManager()
	rec := connectMqttTest(t, m, "sink", mqttTestRequest(broker.tcp, "5", model.MqttTopic{Name: "load/#", QoS: 2, Enabled: true}))
	rec.wait(t, "subscription", func(r *mqttRecorder) bool { return r.hasSystem("Subscribed to load/#") })
	connectMqttTest(t, m, "source", mqttTestRequest(broker.tcp, "3.1.1"))

	const workers, perWorker = 20, 1000
	started := time.Now()
	var wg sync.WaitGroup
	errs := make(chan string, workers*perWorker)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				qos := 0
				if i%10 == 0 {
					qos = 1
				} else if i%25 == 1 {
					qos = 2
				}
				res := m.publish("source", model.MqttPublishMessage{Topic: "load/t" + strconv.Itoa((w*perWorker+i)%1000), Payload: `{"w":` + strconv.Itoa(w) + `,"i":` + strconv.Itoa(i) + `}`, QoS: qos})
				if !res.OK {
					errs <- res.Error
				}
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("publish failed: %s", err)
	}
	published := time.Since(started)
	deadline := time.Now().Add(30 * time.Second)
	for {
		rec.mu.Lock()
		got := 0
		topics := map[string]bool{}
		for _, msg := range rec.messages {
			if msg.Direction == "incoming" {
				got++
				topics[msg.Topic] = true
			}
		}
		rec.mu.Unlock()
		if got == workers*perWorker {
			if len(topics) != 1000 {
				t.Fatalf("messages reached %d topics, want 1000", len(topics))
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("received %d of %d messages", got, workers*perWorker)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Logf("%d messages from %d publishers: published in %s, all received in %s", workers*perWorker, workers, published, time.Since(started))
}

func TestMqttManySubscriptionsAndLargeMessages(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, false)
	m := newMqttManager()
	rec := connectMqttTest(t, m, "many", mqttTestRequest(broker.tcp, "5"))
	started := time.Now()
	for i := 0; i < 500; i++ {
		if res := m.subscribe("many", model.MqttTopic{Name: "big/" + strconv.Itoa(i), QoS: 1, Enabled: true}); !res.OK {
			t.Fatalf("subscribe %d: %s", i, res.Error)
		}
	}
	t.Logf("500 subscriptions in %s", time.Since(started))
	if got := len(m.session("many").order); got != 500 {
		t.Fatalf("session tracks %d subscriptions", got)
	}
	payload := strings.Repeat("é", 2<<20)
	if res := m.publish("many", model.MqttPublishMessage{Topic: "big/7", Payload: payload, QoS: 1}); !res.OK {
		t.Fatal(res.Error)
	}
	binary := strings.Repeat("ff", 1<<20)
	if res := m.publish("many", model.MqttPublishMessage{Topic: "big/8", Payload: binary, Format: "hex", QoS: 2}); !res.OK {
		t.Fatal(res.Error)
	}
	rec.wait(t, "large messages", func(r *mqttRecorder) bool {
		return len(r.find("incoming", "big/7")) == 1 && len(r.find("incoming", "big/8")) == 1
	})
	text := rec.received("incoming", "big/7")[0]
	if text.Size != len(payload) || !text.Truncated || len(text.Payload) > mqttMaxShownBytes || !utf8.ValidString(text.Payload) || text.Encoding != "" {
		t.Fatalf("text message: size %d, shown %d, truncated %v, encoding %q", text.Size, len(text.Payload), text.Truncated, text.Encoding)
	}
	bin := rec.received("incoming", "big/8")[0]
	if bin.Size != 1<<20 || !bin.Truncated || bin.Encoding != "base64" || len(bin.Payload) != base64.StdEncoding.EncodedLen(mqttMaxShownBytes) {
		t.Fatalf("binary message: size %d, shown %d, truncated %v, encoding %q", bin.Size, len(bin.Payload), bin.Truncated, bin.Encoding)
	}
}

func TestMqttFeedKeepsTheNewestMessagesWhenTheWindowFallsBehind(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var batches [][]model.MqttMessage
	feed := &mqttFeed{emit: func(msgs []model.MqttMessage) {
		mu.Lock()
		batches = append(batches, msgs)
		mu.Unlock()
	}}
	for i := 0; i < mqttFeedMaxPending+1500; i++ {
		feed.add(model.MqttMessage{Payload: strconv.Itoa(i)})
	}
	feed.flush()
	mu.Lock()
	defer mu.Unlock()
	var all []model.MqttMessage
	for _, batch := range batches {
		all = append(all, batch...)
	}
	if len(all) != mqttFeedMaxPending+1 || !strings.Contains(all[0].Message, "1500 messages") {
		t.Fatalf("emitted %d messages, first %+v", len(all), all[0])
	}
	if all[1].Payload != "1500" || all[len(all)-1].Payload != strconv.Itoa(mqttFeedMaxPending+1499) {
		t.Fatalf("kept %s..%s", all[1].Payload, all[len(all)-1].Payload)
	}
}

func startMqttTLSBroker(t *testing.T, clientCAs *x509.CertPool) mqttTestBroker {
	t.Helper()
	_, _, serverCert := issueCert(t, "broker")
	cfg := &tls.Config{Certificates: []tls.Certificate{serverCert}, MinVersion: tls.VersionTLS12}
	if clientCAs != nil {
		cfg.ClientAuth, cfg.ClientCAs = tls.RequireAndVerifyClientCert, clientCAs
	}
	server := mochi.New(&mochi.Options{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err := server.AddHook(new(auth.AllowHook), nil); err != nil {
		t.Fatal(err)
	}
	tcp, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	broker := mqttTestBroker{tcp: tcp.Addr().String(), ws: freeAddr(t)}
	if err := server.AddListener(listeners.NewNet("tls", tls.NewListener(tcp, cfg))); err != nil {
		t.Fatal(err)
	}
	if err := server.AddListener(listeners.NewWebsocket(listeners.Config{ID: "wss", Address: broker.ws, TLSConfig: cfg})); err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve() }()
	t.Cleanup(func() { closeMqttBroker(server) })
	for _, addr := range []string{broker.tcp, broker.ws} {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if c, err := net.Dial("tcp", addr); err == nil {
				_ = c.Close()
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	return broker
}

func mqttConnectResult(t *testing.T, req model.HttpRequest) *mqttRecorder {
	t.Helper()
	m := newMqttManager()
	rec := newMqttRecorder()
	m.connect(context.Background(), "probe", req, rec.callbacks())
	t.Cleanup(func() { m.disconnect("probe") })
	rec.wait(t, "connection result", func(r *mqttRecorder) bool { return len(r.opens) > 0 || len(r.errors) > 0 })
	return rec
}

func TestMqttServerCertificateVerification(t *testing.T) {
	t.Parallel()
	broker := startMqttTLSBroker(t, nil)
	for _, url := range []string{"mqtts://" + broker.tcp, "wss://" + broker.ws} {
		verify := mqttTestRequest(url, "5")
		verify.EnableSSLVerification = true
		rec := mqttConnectResult(t, verify)
		if len(rec.errors) == 0 || !strings.Contains(rec.errors[0], "certificate") {
			t.Fatalf("%s with verification: opens=%v errors=%v", url, rec.opens, rec.errors)
		}
		skip := mqttTestRequest(url, "3.1.1", model.MqttTopic{Name: "secure/t", Enabled: true})
		skip.EnableSSLVerification = false
		rec = mqttConnectResult(t, skip)
		if len(rec.opens) == 0 {
			t.Fatalf("%s without verification: %v", url, rec.errors)
		}
		rec.wait(t, "subscription over TLS", func(r *mqttRecorder) bool { return r.hasSystem("Subscribed to secure/t") })
	}
}

func TestMqttPresentsClientCertificateForMutualTLS(t *testing.T) {
	t.Parallel()
	certPEM, keyPEM, clientCert := issueCert(t, "device-7")
	pool := x509.NewCertPool()
	pool.AddCert(clientCert.Leaf)
	broker := startMqttTLSBroker(t, pool)
	dir := t.TempDir()
	certPath := writeTemp(t, dir, "client.crt", certPEM)
	keyPath := writeTemp(t, dir, "client.key", keyPEM)

	without := mqttTestRequest("mqtts://"+broker.tcp, "5")
	rec := mqttConnectResult(t, without)
	if len(rec.opens) != 0 {
		t.Fatal("the broker accepted a client without a certificate")
	}
	for _, url := range []string{"mqtts://" + broker.tcp, "wss://" + broker.ws} {
		with := mqttTestRequest(url, "5")
		with.ClientCertPath, with.ClientKeyPath = certPath, keyPath
		rec = mqttConnectResult(t, with)
		if len(rec.opens) == 0 {
			t.Fatalf("%s with a client certificate: %v", url, rec.errors)
		}
	}
	missing := mqttTestRequest("mqtts://"+broker.tcp, "5")
	missing.ClientCertPath = filepath.Join(dir, "absent.crt")
	rec = mqttConnectResult(t, missing)
	if len(rec.errors) == 0 || !strings.Contains(rec.errors[0], "absent.crt") {
		t.Fatalf("missing certificate error = %v", rec.errors)
	}
}

func TestMqttClientIDAndPersistentSession(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, false)
	for _, version := range []string{"3.1.1", "5"} {
		t.Run(version, func(t *testing.T) {
			m := newMqttManager()
			topic := "resume/" + strings.ReplaceAll(version, ".", "")
			req := mqttTestRequest(broker.tcp, version, model.MqttTopic{Name: topic, QoS: 1, Enabled: true})
			req.Mqtt.ClientID = "kurlo-resume-" + version
			req.Mqtt.CleanSession = false
			if version == "5" {
				req.Mqtt.ConnectProperties.SessionExpiryInterval = "60"
			}
			first := connectMqttTest(t, m, "device", req)
			if first.opens[0].ClientID != req.Mqtt.ClientID || first.opens[0].SessionPresent {
				t.Fatalf("first open = %+v", first.opens[0])
			}
			first.wait(t, "subscription", func(r *mqttRecorder) bool { return r.hasSystem("Subscribed to " + topic) })
			m.disconnect("device")
			first.wait(t, "close", func(r *mqttRecorder) bool { return len(r.closes) > 0 })

			connectMqttTest(t, m, "publisher", mqttTestRequest(broker.tcp, "5"))
			if res := m.publish("publisher", model.MqttPublishMessage{Topic: topic, Payload: "queued while offline", QoS: 1}); !res.OK {
				t.Fatal(res.Error)
			}
			req.Mqtt.Topics = nil
			second := connectMqttTest(t, m, "device-again", req)
			if !second.opens[0].SessionPresent {
				t.Fatalf("the broker did not resume the session: %+v", second.opens[0])
			}
			second.wait(t, "queued message", func(r *mqttRecorder) bool { return len(r.find("incoming", topic)) == 1 })
		})
	}
}

func TestMqttKeepAliveHoldsAnIdleConnection(t *testing.T) {
	t.Parallel()
	if testing.Short() {
		t.Skip("waits through keep-alive pings")
	}
	broker := startMqttBroker(t, false)
	m := newMqttManager()
	req := mqttTestRequest(broker.tcp, "3.1.1", model.MqttTopic{Name: "idle/t", Enabled: true})
	req.Mqtt.KeepAliveSec = 1
	rec := connectMqttTest(t, m, "idle", req)
	time.Sleep(3500 * time.Millisecond)
	rec.mu.Lock()
	closed, failed := len(rec.closes), len(rec.errors)
	rec.mu.Unlock()
	if closed > 0 || failed > 0 {
		t.Fatalf("idle connection dropped: closes=%v errors=%v", rec.closes, rec.errors)
	}
	if res := m.publish("idle", model.MqttPublishMessage{Topic: "idle/t", Payload: "still here", QoS: 1}); !res.OK {
		t.Fatal(res.Error)
	}
	rec.wait(t, "echo", func(r *mqttRecorder) bool { return len(r.find("incoming", "idle/t")) == 1 })
}

func TestMqttConnectTimeout(t *testing.T) {
	t.Parallel()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { _ = c.Close() })
		}
	}()
	req := mqttTestRequest(l.Addr().String(), "5")
	req.Mqtt.ConnectTimeoutMs = 300
	started := time.Now()
	rec := mqttConnectResult(t, req)
	if len(rec.errors) == 0 || !strings.Contains(rec.errors[0], "did not answer CONNECT within 300ms") {
		t.Fatalf("errors = %v", rec.errors)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("timeout took %s", elapsed)
	}
}

func TestMqttPublishFailsAtOnceWhenTheConnectionDrops(t *testing.T) {
	t.Parallel()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		r := bufio.NewReader(c)
		if _, err := readMqttPacket(r); err != nil {
			return
		}
		_, _ = c.Write([]byte{0x20, 0x03, 0, 0, 0})
		for {
			pkt, err := readMqttPacket(r)
			if err != nil || pkt.Kind == mqttPublish {
				return
			}
		}
	}()
	m := newMqttManager()
	connectMqttTest(t, m, "drop", mqttTestRequest(l.Addr().String(), "5"))
	for _, qos := range []int{1, 2} {
		started := time.Now()
		res := m.publish("drop", model.MqttPublishMessage{Topic: "a/b", Payload: "x", QoS: qos})
		if res.OK || time.Since(started) > 2*time.Second {
			t.Fatalf("QoS %d publish after a dropped connection: %+v in %s", qos, res, time.Since(started))
		}
	}
}

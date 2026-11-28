package api

import (
	"bufio"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func pipeMqttProxy(client, upstream net.Conn) {
	go func() { _, _ = io.Copy(upstream, client); _ = upstream.Close() }()
	_, _ = io.Copy(client, upstream)
	_ = client.Close()
}

func startMqttConnectProxy(t *testing.T, wantAuth string) (string, *atomic.Int32) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	var tunnels atomic.Int32
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				r := bufio.NewReader(c)
				req, err := http.ReadRequest(r)
				if err != nil || req.Method != http.MethodConnect {
					_ = c.Close()
					return
				}
				if req.Header.Get("Proxy-Authorization") != wantAuth {
					_, _ = io.WriteString(c, "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
					_ = c.Close()
					return
				}
				upstream, err := net.Dial("tcp", req.Host)
				if err != nil {
					_, _ = io.WriteString(c, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
					_ = c.Close()
					return
				}
				tunnels.Add(1)
				_, _ = io.WriteString(c, "HTTP/1.1 200 Connection established\r\n\r\n")
				pipeMqttProxy(c, upstream)
			}()
		}
	}()
	return l.Addr().String(), &tunnels
}

func startMqttSocksProxy(t *testing.T) (string, *atomic.Int32) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	var tunnels atomic.Int32
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				head := make([]byte, 2)
				if _, err := io.ReadFull(c, head); err != nil || head[0] != 5 {
					_ = c.Close()
					return
				}
				_, _ = io.ReadFull(c, make([]byte, head[1]))
				_, _ = c.Write([]byte{5, 0})
				req := make([]byte, 4)
				if _, err := io.ReadFull(c, req); err != nil || req[1] != 1 {
					_ = c.Close()
					return
				}
				var host string
				switch req[3] {
				case 1:
					ip := make([]byte, 4)
					_, _ = io.ReadFull(c, ip)
					host = net.IP(ip).String()
				case 3:
					n := make([]byte, 1)
					_, _ = io.ReadFull(c, n)
					name := make([]byte, n[0])
					_, _ = io.ReadFull(c, name)
					host = string(name)
				default:
					_ = c.Close()
					return
				}
				port := make([]byte, 2)
				_, _ = io.ReadFull(c, port)
				upstream, err := net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(port)))))
				if err != nil {
					_, _ = c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
					_ = c.Close()
					return
				}
				tunnels.Add(1)
				_, _ = c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
				pipeMqttProxy(c, upstream)
			}()
		}
	}()
	return l.Addr().String(), &tunnels
}

func TestMqttTCPConnectsThroughAProxy(t *testing.T) {
	t.Parallel()
	broker := startMqttBroker(t, false)
	httpProxy, httpTunnels := startMqttConnectProxy(t, "Basic a3VybG86cHJveHk=")
	socksProxy, socksTunnels := startMqttSocksProxy(t)
	for name, tc := range map[string]struct {
		proxyURL string
		tunnels  *atomic.Int32
	}{
		"http":   {"http://kurlo:proxy@" + httpProxy, httpTunnels},
		"socks5": {"socks5://" + socksProxy, socksTunnels},
	} {
		m := newMqttManager()
		req := mqttTestRequest("mqtt://"+broker.tcp, "5", model.MqttTopic{Name: "proxy/t", Enabled: true})
		req.ProxyMode, req.ProxyURL = "on", tc.proxyURL
		rec := connectMqttTest(t, m, name, req)
		rec.wait(t, name+" subscription", func(r *mqttRecorder) bool { return r.hasSystem("Subscribed to proxy/t") })
		if res := m.publish(name, model.MqttPublishMessage{Topic: "proxy/t", Payload: name, QoS: 1}); !res.OK {
			t.Fatalf("%s: %s", name, res.Error)
		}
		rec.wait(t, name+" echo", func(r *mqttRecorder) bool { return len(r.find("incoming", "proxy/t")) == 1 })
		if tc.tunnels.Load() != 1 {
			t.Fatalf("%s: the connection did not go through the proxy", name)
		}
		m.disconnect(name)
	}

	req := mqttTestRequest("mqtt://"+broker.tcp, "5")
	req.ProxyMode, req.ProxyURL, req.ProxyBypass = "on", "http://kurlo:proxy@"+httpProxy, "127.0.0.1"
	connectMqttTest(t, newMqttManager(), "bypass", req)
	if httpTunnels.Load() != 1 {
		t.Fatal("a bypassed broker went through the proxy")
	}

	req = mqttTestRequest("mqtt://"+broker.tcp, "5")
	req.ProxyMode, req.ProxyURL = "on", "http://kurlo:wrong@"+httpProxy
	rec := newMqttRecorder()
	m := newMqttManager()
	m.connect(t.Context(), "refused", req, rec.callbacks())
	t.Cleanup(func() { m.disconnect("refused") })
	rec.wait(t, "proxy refusal", func(r *mqttRecorder) bool { return len(r.errors) > 0 })
	if got := rec.errors[0]; !strings.Contains(got, "407") || strings.Contains(got, "wrong") {
		t.Fatalf("proxy refusal: %q", got)
	}
}

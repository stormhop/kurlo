package proxycapture

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/gorilla/websocket"
	"github.com/klauspost/compress/zstd"
)

func startRecorder(t *testing.T, c Config) (*Recorder, *http.Client) {
	t.Helper()
	r := new(Recorder)
	status, err := r.Start(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse("http://" + status.Address)
	transport := &http.Transport{Proxy: http.ProxyURL(u)}
	t.Cleanup(func() { transport.CloseIdleConnections(); r.Close() })
	return r, &http.Client{Transport: transport, Timeout: 3 * time.Second}
}
func localRule(id, method, pattern string, answer LocalAnswer) Rule {
	return Rule{ID: id, Name: id, Enabled: true, Kind: RuleLocal, Method: method, URL: pattern, Local: answer}
}
func responseText(t *testing.T, resp *http.Response, err error) string {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
func TestCaptureHTTPMappingAndHAR(t *testing.T) {
	const payload = "hello proxy"
	var upstreamCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Set-Cookie", "sid=never-save")
		if r.Header.Get("Authorization") != "Bearer private" || r.URL.Query().Get("token") != "sensitive" {
			http.Error(w, "missing credentials", 400)
			return
		}
		io.Copy(w, r.Body)
	}))
	defer target.Close()
	r, client := startRecorder(t, Config{})
	req, _ := http.NewRequest("POST", target.URL+"/echo?token=sensitive&sort=id", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer private")
	resp, err := client.Do(req)
	if got := responseText(t, resp, err); got != payload {
		t.Fatal(got)
	}
	rows := r.Entries()
	if len(rows) != 1 {
		t.Fatal(rows)
	}
	x, err := r.Get(rows[0].ID)
	if err != nil || x.Request.Body != payload || x.Response.Body != payload {
		t.Fatal(x, err)
	}
	har, err := r.HAR([]int64{x.Entry.ID})
	if err != nil || !json.Valid([]byte(har)) || strings.Contains(har, "sensitive") || strings.Contains(har, "never-save") || strings.Contains(har, "Bearer private") {
		t.Fatal(har, err)
	}
	if err := r.SetRules([]Rule{localRule("fixture", "POST", target.URL+"/echo?token=sensitive&sort=id", LocalAnswer{Status: 202, Body: "fixture", ContentType: "text/plain"})}); err != nil {
		t.Fatal(err)
	}
	resp, err = client.Post(target.URL+"/echo?token=sensitive&sort=id", "text/plain", strings.NewReader(payload))
	if got := responseText(t, resp, err); got != "fixture" || resp.StatusCode != 202 || upstreamCalls.Load() != 1 {
		t.Fatal(got, resp.StatusCode)
	}
	resp, err = client.Post(target.URL+"/echo?sort=id", "text/plain", nil)
	responseText(t, resp, err)
	if resp.StatusCode == 202 {
		t.Fatal("rule matched a different URL")
	}
	if err := r.SetRules(nil); err != nil {
		t.Fatal(err)
	}
	resp, err = client.Post(target.URL+"/echo?sort=id", "text/plain", nil)
	responseText(t, resp, err)
	if resp.StatusCode != 400 || upstreamCalls.Load() != 3 {
		t.Fatal(resp.StatusCode)
	}
}
func TestProxyBoundedPreviewPACAndLoop(t *testing.T) {
	body := strings.Repeat("π", previewLimit)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
	defer target.Close()
	r, client := startRecorder(t, Config{})
	resp, err := client.Get(target.URL)
	if got := responseText(t, resp, err); got != body {
		t.Fatal("forwarded body was truncated")
	}
	row := r.Entries()[0]
	x, _ := r.Get(row.ID)
	if !x.Response.Truncated || len(x.Response.Body) != previewLimit || row.Received != int64(len(body)) {
		t.Fatal(x.Entry)
	}
	resp, err = http.Get("http://" + r.Status().Address + "/proxy.pac")
	if text := responseText(t, resp, err); !strings.Contains(text, "PROXY "+r.Status().Address+"; DIRECT") {
		t.Fatal(text)
	}
	resp, err = client.Get("http://" + r.Status().Address + "/")
	responseText(t, resp, err)
	if resp.StatusCode != 502 {
		t.Fatal("self-forwarding", resp.StatusCode)
	}
	r.Stop()
	_, err = r.Start(Config{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Get(row.ID); err == nil {
		t.Fatal("old id survived restart")
	}
}
func devCertificate(t *testing.T) (tls.Certificate, string, string, *x509.CertPool) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	priv, _ := x509.MarshalECPrivateKey(key)
	dir := t.TempDir()
	cf, kf := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := os.WriteFile(cf, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(kf, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: priv}), 0600); err != nil {
		t.Fatal(err)
	}
	pair, err := tls.LoadX509KeyPair(cf, kf)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	roots := x509.NewCertPool()
	roots.AddCert(leaf)
	return pair, cf, kf, roots
}
func TestDevelopmentTLSAndTunnel(t *testing.T) {
	pair, cert, key, roots := devCertificate(t)
	target := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "service") }))
	target.TLS = &tls.Config{Certificates: []tls.Certificate{pair}}
	target.StartTLS()
	defer target.Close()
	for _, inspect := range []bool{false, true} {
		config := Config{}
		if inspect {
			config.Service = target.Listener.Addr().String()
			config.Certificate = cert
			config.Key = key
		}
		r, client := startRecorder(t, config)
		client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: roots}
		resp, err := client.Get(target.URL + "/orders")
		if responseText(t, resp, err) != "service" {
			t.Fatal("unexpected content")
		}
		client.CloseIdleConnections()
		r.Stop()
		rows := r.Entries()
		if len(rows) != 1 {
			t.Fatal(rows)
		}
		x, _ := r.Get(rows[0].ID)
		if inspect && (x.Response.Body != "service" || x.Entry.Method != "GET" || x.Entry.URL != target.URL+"/orders") {
			t.Fatal(x)
		}
		if !inspect && (x.Entry.Method != "CONNECT" || x.Response.Body != "" || x.Entry.Received == 0) {
			t.Fatal(x)
		}
	}
}
func TestRejectDifferentUpstreamCertificate(t *testing.T) {
	_, cf, kf, roots := devCertificate(t)
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("reached unexpected origin") }))
	defer target.Close()
	_, client := startRecorder(t, Config{Service: target.Listener.Addr().String(), Certificate: cf, Key: kf})
	client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: roots}
	resp, err := client.Get(target.URL)
	responseText(t, resp, err)
	if resp.StatusCode != 502 {
		t.Fatal(resp.Status)
	}
}
func TestStopReleasesHangingTunnel(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer target.Close()
	r, _ := startRecorder(t, Config{})
	conn, err := net.Dial("tcp", r.Status().Address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	dest := target.Listener.Addr().String()
	io.WriteString(conn, "CONNECT "+dest+" HTTP/1.1\r\nHost: "+dest+"\r\n\r\n")
	buf := make([]byte, 80)
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := conn.Read(buf); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for len(r.Entries()) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if rows := r.Entries(); len(rows) != 1 || !rows[0].InProgress || rows[0].Host != dest {
		t.Fatal("missing active tunnel", rows)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { r.Stop(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("stop hung")
	}
}

func TestLocalBreakpointHooksAndResume(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "original") }))
	defer target.Close()
	r, client := startRecorder(t, Config{})
	resp, err := client.Get(target.URL)
	responseText(t, resp, err)
	config := localRule("pause", "GET", target.URL+"/", LocalAnswer{Status: 200, Body: "test", Pause: true, Script: "function onResponse(req, res) { res.status = 203; res.body += ' edited'; }"})
	if err = r.SetRules([]Rule{config}); err != nil {
		t.Fatal(err)
	}
	type result struct {
		status int
		body   string
		err    error
	}
	done := make(chan result, 1)
	go func() {
		resp, err := client.Get(target.URL)
		if err != nil {
			done <- result{err: err}
			return
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		done <- result{resp.StatusCode, string(b), err}
	}()
	deadline := time.Now().Add(time.Second)
	for len(r.Paused()) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	paused := r.Paused()
	if len(paused) != 1 || paused[0].Body != "test edited" || paused[0].Status != 203 {
		t.Fatal(paused)
	}
	if err = r.Continue(paused[0].ID, 202, "released"); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil || got.status != 202 || got.body != "released" {
		t.Fatal(got)
	}
	config.Local.Pause = false
	config.Local.Script = ""
	config.Local.ErrorPercent = 100
	if err = r.SetRules([]Rule{config}); err != nil {
		t.Fatal(err)
	}
	resp, err = client.Get(target.URL)
	responseText(t, resp, err)
	if resp.StatusCode != 503 {
		t.Fatal(resp.Status)
	}
}
func TestLiveSSECapture(t *testing.T) {
	release := make(chan struct{})
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "event: price\ndata: 42\n\n")
		w.(http.Flusher).Flush()
		<-release
	}))
	defer target.Close()
	defer close(release)
	r, client := startRecorder(t, Config{})
	resp, err := client.Get(target.URL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		rows := r.Entries()
		if len(rows) == 1 {
			x, _ := r.Get(rows[0].ID)
			if len(x.Frames) > 0 {
				if !x.Entry.InProgress || x.Frames[0].Text != "42" {
					t.Fatal(x)
				}
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("live event was not visible")
}

func TestLiveSSECaptureDecodesSupportedContentEncodings(t *testing.T) {
	body := "event: first\ndata: one\ndata: two\n\nevent: old\nevent:\ndata: fallback\n\n"
	for _, coding := range []string{"identity", "gzip", "br", "zstd"} {
		t.Run(coding, func(t *testing.T) {
			var packed bytes.Buffer
			wire := []byte(body)
			switch coding {
			case "gzip":
				writer := gzip.NewWriter(&packed)
				if _, err := writer.Write(wire); err != nil {
					t.Fatal(err)
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
				wire = packed.Bytes()
			case "br":
				writer := brotli.NewWriter(&packed)
				if _, err := writer.Write(wire); err != nil {
					t.Fatal(err)
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
				wire = packed.Bytes()
			case "zstd":
				writer, err := zstd.NewWriter(&packed)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := writer.Write(wire); err != nil {
					t.Fatal(err)
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
				wire = packed.Bytes()
			}
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				if coding != "identity" {
					w.Header().Set("Content-Encoding", coding)
				}
				_, _ = w.Write(wire)
			}))
			defer target.Close()
			r, client := startRecorder(t, Config{})
			req, err := http.NewRequest(http.MethodGet, target.URL+"/events", nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Accept-Encoding", coding)
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			received, err := io.ReadAll(resp.Body)
			if closeErr := resp.Body.Close(); err == nil {
				err = closeErr
			}
			if err != nil || !bytes.Equal(received, wire) {
				t.Fatalf("client received %d bytes matching wire=%t, error %v", len(received), bytes.Equal(received, wire), err)
			}
			rows := r.Entries()
			if len(rows) != 1 {
				t.Fatalf("entries = %d", len(rows))
			}
			exchange, err := r.Get(rows[0].ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(exchange.Frames) != 2 || exchange.Frames[0].Text != "one\ntwo" || exchange.Frames[1].Kind != "message" || exchange.Frames[1].Text != "fallback" {
				t.Fatalf("events = %+v", exchange.Frames)
			}
			if coding == "identity" {
				if exchange.Response.Binary || exchange.Response.Body != body {
					t.Fatalf("identity response = %+v", exchange.Response)
				}
			} else {
				raw, err := io.ReadAll(exchange.Response.EncodedPreview())
				if err != nil || !exchange.Response.Binary || !bytes.Equal(raw, wire) {
					t.Fatalf("captured %s wire differs: binary=%v bytes=%d err=%v", coding, exchange.Response.Binary, len(raw), err)
				}
			}
		})
	}
}

func TestZstdSSEDecoderStopsWhenClientCloses(t *testing.T) {
	started := make(chan struct{})
	closed := make(chan struct{})
	release := make(chan struct{})
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		defer close(closed)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Encoding", "zstd")
		encoder, err := zstd.NewWriter(w, zstd.WithEncoderConcurrency(1))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer encoder.Close()
		if _, err := encoder.Write([]byte("data: partial\n\n")); err != nil {
			return
		}
		if err := encoder.Flush(); err != nil {
			return
		}
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-req.Context().Done():
		case <-release:
		}
	}))
	defer target.Close()
	defer close(release)
	r, client := startRecorder(t, Config{})
	req, err := http.NewRequest(http.MethodGet, target.URL+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Accept-Encoding", "zstd")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 64)
	if _, err := resp.Body.Read(buffer); err != nil {
		t.Fatalf("read initial zstd bytes: %v", err)
	}
	startedAt := time.Now()
	if err := resp.Body.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("origin did not start the stream")
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("origin stream did not close after the client closed")
	}
	if elapsed := time.Since(startedAt); elapsed > 2*time.Second {
		t.Fatalf("closing the zstd stream took %s", elapsed)
	}
	rows := r.Entries()
	if len(rows) != 1 {
		t.Fatalf("entries = %d", len(rows))
	}
	exchange, err := r.Get(rows[0].ID)
	if err != nil || exchange.Entry.InProgress || len(exchange.Frames) != 1 || exchange.Frames[0].Text != "partial" {
		t.Fatalf("closed stream = %+v, error %v", exchange, err)
	}
}
func TestLargeBodyHARAndEviction(t *testing.T) {
	body := strings.Repeat("a", previewLimit*3)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
	defer target.Close()
	r, client := startRecorder(t, Config{})
	resp, err := client.Get(target.URL)
	responseText(t, resp, err)
	x, _ := r.Get(r.Entries()[0].ID)
	if !x.Response.Archived {
		t.Fatal("missing archive")
	}
	har, err := r.HAR(nil)
	if err != nil || !strings.Contains(har, body) {
		t.Fatal("missing full HAR text", err)
	}
	file := x.Response.file
	r.Close()
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("body file retained", err)
	}
}

func TestDevelopmentWebSocketFramesWhileConnected(t *testing.T) {
	pair, cert, key, roots := devCertificate(t)
	upgrader := websocket.Upgrader{}
	target := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		conn, err := upgrader.Upgrade(w, req, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if conn.WriteMessage(kind, data) != nil {
				return
			}
		}
	}))
	target.TLS = &tls.Config{Certificates: []tls.Certificate{pair}}
	target.StartTLS()
	defer target.Close()
	rec, _ := startRecorder(t, Config{Service: target.Listener.Addr().String(), Certificate: cert, Key: key})
	proxy, _ := url.Parse("http://" + rec.Status().Address)
	dialer := websocket.Dialer{Proxy: http.ProxyURL(proxy), TLSClientConfig: &tls.Config{RootCAs: roots}, HandshakeTimeout: 3 * time.Second}
	client, _, err := dialer.Dial("wss"+strings.TrimPrefix(target.URL, "https")+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err = client.WriteMessage(websocket.TextMessage, []byte("echo")); err != nil {
		t.Fatal(err)
	}
	client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, b, err := client.ReadMessage(); err != nil || string(b) != "echo" {
		t.Fatal(string(b), err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rows := rec.Entries(); len(rows) == 1 {
			x, _ := rec.Get(rows[0].ID)
			if len(x.Frames) == 2 && x.Frames[0].Text == "echo" && x.Frames[1].Text == "echo" && x.Entry.InProgress {
				rec.Stop()
				x, _ = rec.Get(rows[0].ID)
				if x.Entry.InProgress {
					t.Fatal("stream still marked active")
				}
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("missing live WebSocket messages")
}

func TestMultipartFieldsAndBinaryHAR(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	writer.WriteField("order", "42")
	writer.Close()
	post := harPost(Message{Headers: http.Header{"Content-Type": []string{writer.FormDataContentType()}}}, body.String())
	params, ok := post["params"].([]pair)
	if !ok || len(params) != 1 || params[0] != (pair{"order", "42"}) || post["_incomplete"] != false {
		t.Fatal(post)
	}
	var p preview
	p.Write([]byte{0, 1, 2})
	msg, _ := p.message(nil)
	raw, err := msg.archived()
	if err != nil || raw != "\x00\x01\x02" || !msg.Binary {
		t.Fatal("binary body lost", err)
	}
}

func TestMappedPostBodyAndRateLimit(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "original") }))
	defer target.Close()
	rec, client := startRecorder(t, Config{})
	resp, err := client.Post(target.URL, "text/plain", strings.NewReader("sample"))
	responseText(t, resp, err)
	content := strings.Repeat("k", 2048)
	if err := rec.SetRules([]Rule{localRule("rate", "POST", target.URL, LocalAnswer{Status: 200, Body: content, RateKiB: 16})}); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	resp, err = client.Post(target.URL, "text/plain", strings.NewReader("another sample"))
	if got := responseText(t, resp, err); got != content || time.Since(start) < 110*time.Millisecond {
		t.Fatal("incorrect throttled response")
	}
	rec.Stop()
	rows := rec.Entries()
	x, _ := rec.Get(rows[len(rows)-1].ID)
	if x.Request.Body != "another sample" || !x.Entry.Local {
		t.Fatal(x)
	}
}

func TestRewritePreservesEscapedPathSuffix(t *testing.T) {
	pathReceived := make(chan string, 2)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		pathReceived <- req.URL.EscapedPath()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	r, client := startRecorder(t, Config{})
	if err := r.SetRules([]Rule{{ID: "rewrite", Name: "rewrite", Enabled: true, Kind: RuleRewrite, URL: target.URL + "/v1/*", Rewrite: RewriteAction{PathFrom: "/v1", PathTo: "/v2"}}}); err != nil {
		t.Fatal(err)
	}
	resp, err := client.Get(target.URL + "/v1/a%2Fb")
	responseText(t, resp, err)
	if got := <-pathReceived; got != "/v2/a%2Fb" {
		t.Fatalf("rewritten path %q", got)
	}
	if err := r.SetRules([]Rule{{ID: "escaped-rewrite", Name: "escaped-rewrite", Enabled: true, Kind: RuleRewrite, URL: target.URL + "/*", Rewrite: RewriteAction{PathFrom: "/old/", PathTo: "/new/"}}}); err != nil {
		t.Fatal(err)
	}
	resp, err = client.Get(target.URL + "/%6Fld/a%2Fb")
	responseText(t, resp, err)
	if got := <-pathReceived; got != "/new/a%2Fb" {
		t.Fatalf("rewritten path with escaped prefix %q", got)
	}
}

func TestChunkedRequestPreservesTrailers(t *testing.T) {
	const payload = "body π across chunks"
	type receivedRequest struct {
		body    string
		trailer string
	}
	received := make(chan receivedRequest, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			t.Error(err)
		}
		received <- receivedRequest{body: string(body), trailer: req.Trailer.Get("X-End")}
	}))
	defer target.Close()
	r, client := startRecorder(t, Config{})
	req, err := http.NewRequest(http.MethodPost, target.URL, strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.ContentLength = -1
	req.Trailer = http.Header{"X-End": []string{"done"}}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	responseText(t, resp, nil)
	if got := <-received; got.body != payload || got.trailer != "done" {
		t.Fatalf("origin received body %q and trailer %q", got.body, got.trailer)
	}
	entries := r.Entries()
	if len(entries) != 1 {
		t.Fatalf("got %d entries", len(entries))
	}
	exchange, err := r.Get(entries[0].ID)
	if err != nil || exchange.Request.Body != payload {
		t.Fatalf("captured request body %q, error %v", exchange.Request.Body, err)
	}
}

func TestPOSTSSECaptureKeepsRequestBodyAndHAR(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	bodyReceived := make(chan string, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		bodyReceived <- string(body)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: accepted\n\n")
		w.(http.Flusher).Flush()
		<-release
	}))
	defer target.Close()
	defer releaseOnce.Do(func() { close(release) })
	r, client := startRecorder(t, Config{})
	const payload = "subscription: 42"
	resp, err := client.Post(target.URL+"/events", "text/plain", strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := <-bodyReceived; got != payload {
		t.Fatalf("origin received %q", got)
	}
	if _, err := io.ReadFull(resp.Body, make([]byte, len("data: accepted\n\n"))); err != nil {
		t.Fatal(err)
	}
	entries := r.Entries()
	if len(entries) != 1 {
		t.Fatalf("got %d entries", len(entries))
	}
	exchange, err := r.Get(entries[0].ID)
	if err != nil || exchange.Request.Body != payload || exchange.Entry.Sent != int64(len(payload)) {
		t.Fatalf("live request body %q, sent %d, error %v", exchange.Request.Body, exchange.Entry.Sent, err)
	}
	har, err := r.HAR(nil)
	if err != nil || !strings.Contains(har, payload) || strings.Contains(har, `"_incomplete":true`) {
		t.Fatalf("HAR omitted SSE request body: %v", err)
	}
	releaseOnce.Do(func() { close(release) })
	r.Stop()
	exchange, err = r.Get(entries[0].ID)
	if err != nil || exchange.Request.Body != payload {
		t.Fatalf("final request body %q, error %v", exchange.Request.Body, err)
	}
}

func TestGzipSSECaptureDecodesEvents(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Content-Encoding", "gzip")
		writer := gzip.NewWriter(w)
		io.WriteString(writer, "data: compressed-event\n\n")
		writer.Flush()
		w.(http.Flusher).Flush()
		<-release
		writer.Close()
	}))
	defer target.Close()
	defer releaseOnce.Do(func() { close(release) })
	r, client := startRecorder(t, Config{})
	resp, err := client.Get(target.URL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !resp.Uncompressed {
		t.Fatal("client did not receive a transparently decompressed stream")
	}
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil || line != "data: compressed-event\n" {
		t.Fatalf("client received %q, error %v", line, err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		entries := r.Entries()
		if len(entries) > 0 {
			exchange, err := r.Get(entries[0].ID)
			if err == nil && len(exchange.Frames) > 0 {
				if exchange.Frames[0].Text != "compressed-event" {
					t.Fatalf("captured event %q", exchange.Frames[0].Text)
				}
				releaseOnce.Do(func() { close(release) })
				if _, err := io.Copy(io.Discard, resp.Body); err != nil {
					t.Fatal(err)
				}
				resp.Body.Close()
				r.Stop()
				exchange, err = r.Get(entries[0].ID)
				if err != nil {
					t.Fatal(err)
				}
				raw, err := exchange.Response.archived()
				if err != nil {
					t.Fatal(err)
				}
				compressed, err := gzip.NewReader(strings.NewReader(raw))
				if err != nil {
					t.Fatal(err)
				}
				decoded, err := io.ReadAll(compressed)
				compressed.Close()
				if err != nil || string(decoded) != "data: compressed-event\n\n" {
					t.Fatalf("captured gzip body %q, error %v", decoded, err)
				}
				har, err := r.HAR(nil)
				if err != nil {
					t.Fatal(err)
				}
				var archive struct {
					Log struct {
						Entries []struct {
							Response struct {
								Content struct {
									Encoding string `json:"encoding"`
									Text     string `json:"text"`
								} `json:"content"`
							} `json:"response"`
						} `json:"entries"`
					} `json:"log"`
				}
				if err := json.Unmarshal([]byte(har), &archive); err != nil {
					t.Fatal(err)
				}
				if len(archive.Log.Entries) != 1 || archive.Log.Entries[0].Response.Content.Encoding != "base64" {
					t.Fatalf("HAR did not preserve gzip encoding: %s", har)
				}
				archived, err := base64.StdEncoding.DecodeString(archive.Log.Entries[0].Response.Content.Text)
				if err != nil || string(archived) != raw {
					t.Fatalf("HAR gzip bytes differ from captured bytes: %v", err)
				}
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("compressed SSE event was not captured")
}

func TestWebSocketFramesPreserveConversationOrder(t *testing.T) {
	pair, cert, key, roots := devCertificate(t)
	upgrader := websocket.Upgrader{}
	target := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		conn, err := upgrader.Upgrade(w, req, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if conn.WriteMessage(kind, data) != nil {
				return
			}
		}
	}))
	target.TLS = &tls.Config{Certificates: []tls.Certificate{pair}}
	target.StartTLS()
	defer target.Close()
	r, _ := startRecorder(t, Config{Service: target.Listener.Addr().String(), Certificate: cert, Key: key})
	proxyURL, _ := url.Parse("http://" + r.Status().Address)
	dialer := websocket.Dialer{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: roots}, HandshakeTimeout: 3 * time.Second}
	client, _, err := dialer.Dial("wss"+strings.TrimPrefix(target.URL, "https")+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range []string{"one", "two"} {
		if err := client.WriteMessage(websocket.TextMessage, []byte(message)); err != nil {
			t.Fatal(err)
		}
		client.SetReadDeadline(time.Now().Add(time.Second))
		_, body, err := client.ReadMessage()
		if err != nil || string(body) != message {
			t.Fatalf("echo %q, error %v", body, err)
		}
	}
	client.Close()
	r.Stop()
	entries := r.Entries()
	if len(entries) != 1 {
		t.Fatalf("got %d entries", len(entries))
	}
	exchange, err := r.Get(entries[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	var textFrames []string
	for _, frame := range exchange.Frames {
		if frame.Kind == "Text" {
			textFrames = append(textFrames, frame.Direction+":"+frame.Text)
		}
	}
	want := []string{"Sent:one", "Received:one", "Sent:two", "Received:two"}
	if strings.Join(textFrames, ",") != strings.Join(want, ",") {
		t.Fatalf("frame order %v", textFrames)
	}
}

func TestMapLocalRespectsIncludeFilter(t *testing.T) {
	body := strings.Repeat("mapped", 4<<10)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { io.WriteString(w, "origin") }))
	defer target.Close()
	r, client := startRecorder(t, Config{Include: "excluded.test"})
	if err := r.SetRules([]Rule{localRule("local", "GET", target.URL+"/orders", LocalAnswer{Status: 200, Body: body})}); err != nil {
		t.Fatal(err)
	}
	resp, err := client.Get(target.URL + "/orders")
	if got := responseText(t, resp, err); got != body {
		t.Fatalf("local response length %d", len(got))
	}
	if got := r.Entries(); len(got) != 0 {
		t.Fatalf("excluded local response was captured: %+v", got)
	}
	if r.files.bytes != 0 {
		t.Fatalf("excluded local response consumed %d archive bytes", r.files.bytes)
	}
}

func TestMapLocalIncludesProcessSource(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip()
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { io.WriteString(w, "origin") }))
	defer target.Close()
	r, client := startRecorder(t, Config{IdentifyProcess: true})
	transport := client.Transport.(*http.Transport)
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		processes := &r.run.processes
		processes.mu.Lock()
		processes.last = time.Now()
		processes.processes = map[string]string{conn.LocalAddr().String(): "audit-client (123)"}
		processes.mu.Unlock()
		return conn, nil
	}
	if err := r.SetRules([]Rule{localRule("local", "GET", target.URL+"/orders", LocalAnswer{Status: 200, Body: "mapped"})}); err != nil {
		t.Fatal(err)
	}
	resp, err := client.Get(target.URL + "/orders")
	responseText(t, resp, err)
	entries := r.Entries()
	if len(entries) != 1 || entries[0].Process != "audit-client (123)" {
		t.Fatalf("local process source missing: %+v", entries)
	}
}

func TestSystemProxyAllowsItsOwnLANConnection(t *testing.T) {
	ip := ""
	interfaces, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	for _, iface := range interfaces {
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			ipnet, ok := address.(*net.IPNet)
			if ok && ipnet.IP.To4() != nil && ipnet.IP.IsPrivate() && !ipnet.IP.IsLoopback() {
				ip = ipnet.IP.String()
				break
			}
		}
		if ip != "" {
			break
		}
	}
	if ip == "" {
		t.Skip()
	}
	for _, enabled := range []bool{false, true} {
		r := new(Recorder)
		status, err := r.Start(Config{ListenIP: ip, ClientIP: "10.254.254.254", SystemProxy: enabled}, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.Get("http://" + status.Address + "/proxy.pac")
		if err != nil {
			r.Close()
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		want := http.StatusForbidden
		if enabled {
			want = http.StatusOK
		}
		if resp.StatusCode != want {
			r.Close()
			t.Fatalf("system proxy enabled=%t got %d, want %d", enabled, resp.StatusCode, want)
		}
		r.Close()
	}
}

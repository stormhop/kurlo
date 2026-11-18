package proxycapture

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
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
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
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
	if err := r.SetLocalResponse(LocalResponse{EntryID: x.Entry.ID, Status: 202, Body: "fixture", ContentType: "text/plain"}); err != nil {
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
	r.ClearLocalResponses()
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
	config := LocalResponse{EntryID: r.Entries()[0].ID, Status: 200, Body: "test", Pause: true, Script: "function onResponse(req, res) { res.status = 203; res.body += ' edited'; }"}
	if err = r.SetLocalResponse(config); err != nil {
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
	config.Pause = false
	config.Script = ""
	config.ErrorPercent = 100
	if err = r.SetLocalResponse(config); err != nil {
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
	if err := rec.SetLocalResponse(LocalResponse{EntryID: rec.Entries()[0].ID, Status: 200, Body: content, RateKiB: 16}); err != nil {
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

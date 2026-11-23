package proxycapture

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

var activeAddresses sync.Map

func IsActiveAddress(u *url.URL) bool {
	if u == nil {
		return false
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		host = "127.0.0.1"
	}
	_, ok := activeAddresses.Load(net.JoinHostPort(host, u.Port()))
	return ok
}

const capacity = 1000
const previewLimit = 16 * 1024

type Entry struct {
	Stream     string `json:"stream,omitempty"`
	InProgress bool   `json:"inProgress,omitempty"`
	Process    string `json:"process,omitempty"`
	Local      bool   `json:"local,omitempty"`
	Rule       string `json:"rule,omitempty"`
	Rewritten  string `json:"rewritten,omitempty"`
	Protocol   string `json:"protocol,omitempty"`
	ID         int64  `json:"id"`
	Started    string `json:"started"`
	Method     string `json:"method"`
	Host       string `json:"host"`
	URL        string `json:"url"`
	Path       string `json:"path"`
	Status     int    `json:"status"`
	Duration   int64  `json:"duration"`
	Received   int64  `json:"received"`
	Sent       int64  `json:"sent"`
	Error      string `json:"error,omitempty"`
}

type Message struct {
	decoded   bool
	raw       []byte
	file      string
	Archived  bool                `json:"archived,omitempty"`
	Headers   map[string][]string `json:"headers"`
	Body      string              `json:"body"`
	Truncated bool                `json:"truncated"`
	Binary    bool                `json:"binary"`
}

func (m Message) HasContentEncoding() bool {
	if m.decoded {
		return false
	}
	for coding := range strings.SplitSeq(http.Header(m.Headers).Get("Content-Encoding"), ",") {
		if name := strings.TrimSpace(coding); name != "" && !strings.EqualFold(name, "identity") {
			return true
		}
	}
	return false
}

func (m Message) EncodedPreview() io.Reader {
	if m.Binary {
		return bytes.NewReader(m.raw)
	}
	return strings.NewReader(m.Body)
}

type Exchange struct {
	harTimings     map[string]float64
	harStatusText  *string
	harBodySize    *int64
	harContentSize *int64
	Timings        *model.ResponseTime `json:"timings,omitempty"`
	Frames         []Frame             `json:"frames,omitempty"`
	Entry          Entry               `json:"entry"`
	Request        Message             `json:"request"`
	Response       Message             `json:"response"`
}

type Status struct {
	Config      Config `json:"config"`
	Rules       int    `json:"rules"`
	Address     string `json:"address"`
	Running     bool   `json:"running"`
	Count       int    `json:"count"`
	SystemProxy bool   `json:"systemProxy"`
	Source      string `json:"source,omitempty"`
}

type Recorder struct {
	files   *bodyFiles
	rules   ruleSet
	config  Config
	mu      sync.Mutex
	run     *session
	address string
	source  string
	next    int64
	ring    [capacity]*Exchange
	count   int
	cursor  int
}

type session struct {
	stopped         chan struct{}
	files           *bodyFiles
	pauses          map[int64]pauseSlot
	changed         func()
	processes       processLookup
	service         *serviceTLS
	clientIP        net.IP
	identifyProcess bool
	rules           *ruleSet
	server          *http.Server
	transport       *http.Transport
	serviceHTTP     *http.Transport
	authority       *Authority
	authorityDir    string
	sslHosts        []string
	proxy           *httputil.ReverseProxy
	addr            *net.TCPAddr
	include         string
	systemProxy     bool
	ctx             context.Context
	cancel          context.CancelFunc
	mu              sync.Mutex
	closing         bool
	wg              sync.WaitGroup
	record          func(Exchange) int64
}

func (r *Recorder) Start(config Config, notify func()) (Status, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.run != nil {
		return r.status(), errors.New("capture proxy is already running")
	}
	if config.Port < 0 || config.Port > 65535 {
		return r.status(), errors.New("invalid proxy port")
	}
	service, err := loadService(config)
	if err != nil {
		return r.status(), err
	}
	sslHosts, err := NormalizeSSLHosts(config.SSLHosts)
	if err != nil {
		return r.status(), err
	}
	config.SSLHosts = sslHosts
	var authority *Authority
	if len(sslHosts) > 0 {
		if authority, err = LoadAuthority(config.AuthorityDir, true); err != nil {
			return r.status(), err
		}
	}
	listen := config.ListenIP
	if listen == "" {
		listen = "127.0.0.1"
	}
	ip, peer := net.ParseIP(listen), net.ParseIP(config.ClientIP)
	if ip == nil || ip.To4() == nil || (!ip.IsLoopback() && (!ip.IsPrivate() || peer == nil || peer.To4() == nil || !peer.IsPrivate())) {
		return r.status(), errors.New("use a loopback address or specify both the private LAN interface and client IPv4 addresses")
	}
	ln, err := net.Listen("tcp4", net.JoinHostPort(listen, strconv.Itoa(config.Port)))
	if err != nil {
		return r.status(), err
	}
	ctx, cancel := context.WithCancel(context.Background())
	if notify == nil {
		notify = func() {}
	}
	s := &session{files: &bodyFiles{}, changed: notify, pauses: make(map[int64]pauseSlot), service: service, clientIP: peer, identifyProcess: config.IdentifyProcess, rules: &r.rules, authority: authority, authorityDir: config.AuthorityDir, sslHosts: sslHosts, addr: ln.Addr().(*net.TCPAddr), ctx: ctx, cancel: cancel, include: strings.ToLower(strings.TrimSpace(config.Include)), systemProxy: config.SystemProxy}
	s.transport = s.newTransport(nil)
	if service != nil {
		s.serviceHTTP = s.newTransport(service.upstream)
	}
	s.proxy = &httputil.ReverseProxy{Transport: roundTripFunc(s.roundTrip), Rewrite: func(p *httputil.ProxyRequest) {
		p.Out.Host = p.Out.URL.Host
		if p.Out.Body != nil && len(p.Out.Trailer) > 0 {
			p.Out.Body = &requestTrailerReader{ReadCloser: p.Out.Body, source: p.In.Trailer, target: p.Out.Trailer}
		}
	}, ModifyResponse: func(resp *http.Response) error {
		tr := resp.Request.Context().Value(traceKey{}).(*trace)
		return tr.responseBody(resp)
	}, ErrorHandler: func(w http.ResponseWriter, req *http.Request, err error) {
		req.Context().Value(traceKey{}).(*trace).failed = true
		http.Error(w, "Upstream connection failed", http.StatusBadGateway)
	}}
	s.server = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	r.beginSession(s, config, ln.Addr().String())
	activeAddresses.Store(r.address, s)
	go s.server.Serve(ln)
	return r.status(), nil
}

func (r *Recorder) beginSession(s *session, config Config, address string) {
	s.stopped = make(chan struct{})
	s.record = func(x Exchange) int64 {
		r.mu.Lock()
		if r.run != s {
			r.mu.Unlock()
			return 0
		}
		if x.Entry.ID != 0 {
			if x.Entry.ID > r.next-int64(r.count) && x.Entry.ID <= r.next {
				idx := (r.cursor - 1 - int(r.next-x.Entry.ID) + capacity) % capacity
				if r.ring[idx] != nil {
					r.ring[idx] = &x
				} else {
					s.files.remove(x.Request.file)
					s.files.remove(x.Response.file)
				}
			} else {
				s.files.remove(x.Request.file)
				s.files.remove(x.Response.file)
			}
			r.mu.Unlock()
			s.changed()
			return x.Entry.ID
		}
		r.next++
		x.Entry.ID = r.next
		if old := r.ring[r.cursor]; old != nil {
			s.files.remove(old.Request.file)
			s.files.remove(old.Response.file)
		}
		r.ring[r.cursor] = &x
		r.cursor = (r.cursor + 1) % capacity
		if r.count < capacity {
			r.count++
		}
		r.mu.Unlock()
		s.changed()
		return x.Entry.ID
	}
	if r.files != nil {
		r.files.close()
	}
	r.files = s.files
	r.config = config
	r.address = address
	r.run = s
	r.source = ""
	r.ring = [capacity]*Exchange{}
	r.count = 0
	r.cursor = 0
}

func (r *Recorder) Stop() Status {
	r.mu.Lock()
	s := r.run
	r.mu.Unlock()
	if s != nil {
		r.stopSession(s)
	}
	return r.Status()
}

func (r *Recorder) stopSession(s *session) {
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		<-s.stopped
		return
	}

	s.closing = true
	s.mu.Unlock()
	s.cancel()
	s.server.Close()
	s.transport.CloseIdleConnections()
	if s.serviceHTTP != nil {
		s.serviceHTTP.CloseIdleConnections()
	}
	s.wg.Wait()
	r.mu.Lock()
	if r.run == s {
		activeAddresses.CompareAndDelete(r.address, s)
		r.run = nil
	}
	close(s.stopped)
	r.mu.Unlock()
	s.changed()
}

func (r *Recorder) Close() {
	r.Stop()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.run == nil && r.files != nil {
		r.files.close()
		r.files = nil
		r.count = 0
		r.cursor = 0
		r.ring = [capacity]*Exchange{}
	}
}
func (r *Recorder) status() Status {
	return Status{Config: r.config, Rules: r.rules.enabled(), Running: r.run != nil, Address: r.address, Count: r.liveCount(), Source: r.source}
}
func (r *Recorder) liveCount() int {
	count := 0
	for _, x := range r.ring {
		if x != nil {
			count++
		}
	}
	return count
}
func (r *Recorder) Status() Status { r.mu.Lock(); defer r.mu.Unlock(); return r.status() }
func (r *Recorder) snapshotLocked() []*Exchange {
	items := make([]*Exchange, 0, r.count)
	for i := 0; i < r.count; i++ {
		if x := r.ring[(r.cursor-r.count+i+capacity)%capacity]; x != nil {
			items = append(items, x)
		}
	}
	return items
}
func (r *Recorder) Entries() []Entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	items := r.snapshotLocked()
	result := make([]Entry, len(items))
	for i, x := range items {
		result[i] = x.Entry
	}
	return result
}
func (r *Recorder) Get(id int64) (Exchange, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if id <= r.next-int64(r.count) || id > r.next {
		return Exchange{}, errors.New("capture entry is no longer available")
	}
	idx := (r.cursor - 1 - int(r.next-id) + capacity) % capacity
	if r.ring[idx] == nil {
		return Exchange{}, errors.New("capture entry is no longer available")
	}
	return *r.ring[idx], nil
}

func (s *session) dial(ctx context.Context, network, address string) (net.Conn, error) {
	d := net.Dialer{Timeout: 15 * time.Second}
	conn, err := d.DialContext(ctx, network, address)
	if err == nil && conn.RemoteAddr().String() == s.addr.String() {
		conn.Close()
		return nil, errors.New("proxy forwarding loop")
	}
	return conn, err
}

type preview struct {
	files  *bodyFiles
	file   *os.File
	done   bool
	failed bool
	data   bytes.Buffer
	total  int64
	mu     sync.Mutex
}

func (p *preview) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.done {
		return len(b), nil
	}
	p.total += int64(len(b))
	if p.files != nil && !p.failed && p.total > previewLimit {
		var prior []byte
		if p.file == nil {
			prior = p.data.Bytes()
		}
		if p.total > maxBodyFile || !p.files.append(&p.file, prior, b) {
			p.failed = true
			if p.file != nil {
				p.file.Close()
				p.files.remove(p.file.Name())
				p.file = nil
			}
		}
	}
	if room := previewLimit - p.data.Len(); room > 0 {
		p.data.Write(b[:min(len(b), room)])
	}
	return len(b), nil
}
func TextPreview(b []byte, truncated bool) ([]byte, bool) {
	visible := b
	if truncated {
		for i := len(b) - 1; i >= max(0, len(b)-utf8.UTFMax); i-- {
			if utf8.RuneStart(b[i]) {
				if !utf8.FullRune(b[i:]) {
					visible = b[:i]
				}
				break
			}
		}
	}
	return visible, utf8.Valid(visible) && bytes.IndexByte(visible, 0) < 0
}

func (p *preview) message(h http.Header) (Message, int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.done = true
	b := p.data.Bytes()
	truncated := p.total > int64(len(b))
	visible, text := TextPreview(b, truncated)
	m := Message{Headers: h, Truncated: truncated, Binary: !text}
	if p.file != nil {
		if err := p.file.Close(); err == nil {
			m.file = p.file.Name()
			m.Archived = true
		} else {
			p.files.remove(p.file.Name())
		}
		p.file = nil
	}
	if !m.Binary {
		m.Body = string(visible)
	} else {
		m.raw = bytes.Clone(b)
	}
	return m, p.total
}

type traceKey struct{}
type trace struct {
	stream         *streamTap
	newStream      func(string, int, http.Header) *streamTap
	sent, received preview
	response       http.Header
	rewrites       []*compiledRule
	failed         bool
}

func (t *trace) discardUnfinished() {
	for _, p := range []*preview{&t.sent, &t.received} {
		p.mu.Lock()
		p.done = true
		if p.file != nil {
			p.file.Close()
			p.files.remove(p.file.Name())
			p.file = nil
		}
		p.mu.Unlock()
	}
}

type readerWithClose struct {
	io.Reader
	io.Closer
}

type requestTrailerReader struct {
	io.ReadCloser
	source http.Header
	target http.Header
}

func (r *requestTrailerReader) Read(b []byte) (int, error) {
	n, err := r.ReadCloser.Read(b)
	if err == io.EOF {
		for key, values := range r.source {
			r.target[key] = append([]string(nil), values...)
		}
	}
	return n, err
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *statusWriter) WriteHeader(status int) {
	if status >= 200 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func copyHeaders(h http.Header) http.Header {
	out := http.Header{}
	for key, values := range h {
		if sensitive(key) || strings.EqualFold(key, "Set-Cookie") {
			continue
		}
		out[key] = append([]string(nil), values...)
	}
	return out
}

func sensitive(key string) bool {
	key = strings.ToLower(key)
	return strings.Contains(key, "authorization") || strings.Contains(key, "cookie") || strings.Contains(key, "token") || strings.Contains(key, "password") || strings.Contains(key, "secret") || strings.Contains(key, "api-key") || strings.Contains(key, "api_key")
}

func displayURL(u *url.URL) string {
	clean := *u
	clean.User = nil
	q := clean.Query()
	changed := false
	for k := range q {
		if sensitive(k) {
			q.Del(k)
			changed = true
		}
	}
	if changed {
		clean.RawQuery = q.Encode()
	}
	return clean.String()
}

func (s *session) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		http.Error(w, "Proxy stopped", 503)
		return
	}
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()
	if !s.addr.IP.IsLoopback() {
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		remote := net.ParseIP(ip)
		if !remote.Equal(s.clientIP) && !(s.systemProxy && remote.Equal(s.addr.IP)) {
			http.Error(w, "Client is not enabled for this session", 403)
			return
		}
	}
	if !r.URL.IsAbs() && r.Method != http.MethodConnect {
		if r.Method == http.MethodGet && r.URL.Path == "/proxy.pac" && r.Host == s.addr.String() {
			w.Header().Set("Content-Type", "application/x-ns-proxy-autoconfig")
			fmt.Fprintf(w, "function FindProxyForURL(url, host) { return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ? 'DIRECT' : 'PROXY %s; DIRECT'; }", s.addr)
			return
		}
		http.Error(w, "Expected an explicit proxy request", 400)
		return
	}
	start := time.Now()
	if s.identifyProcess {
		s.processes.source(s.ctx, s.addr, r.RemoteAddr)
	}
	x := Exchange{Entry: Entry{Method: r.Method, Host: r.URL.Host, Started: start.UTC().Format(time.RFC3339Nano)}}
	if r.Method == http.MethodConnect {
		if s.service != nil && strings.EqualFold(r.Host, s.service.authority) {
			s.serveService(w, r)
			return
		}
		if authority := s.decryptingAuthority(r.Host); authority != nil {
			x.Entry.Host = r.Host
			s.serveDecrypted(w, r, authority, x)
			return
		}
		x.Entry.Host = r.Host
		s.tunnel(w, r, &x.Entry)
	} else {
		if (r.URL.Scheme != "http" && !(r.TLS != nil && r.URL.Scheme == "https")) || r.URL.Host == "" {
			http.Error(w, "Expected an HTTP destination", 400)
			return
		}

		x.Entry.URL = displayURL(r.URL)
		x.Entry.Protocol = r.Proto
		x.Entry.Path = r.URL.EscapedPath()
		if x.Entry.Path == "" {
			x.Entry.Path = "/"
		}
		if s.serveLocal(w, r, &x) {
			x.Entry.Duration = time.Since(start).Milliseconds()
			if s.identifyProcess {
				x.Entry.Process = s.processes.source(s.ctx, s.addr, r.RemoteAddr)
			}
			if s.includes(r.URL.Hostname()) {
				s.record(x)
			}
			return
		}
		tr := &trace{}
		if s.includes(r.URL.Hostname()) {
			tr.newStream = func(kind string, code int, headers http.Header) *streamTap {
				live := x
				live.Entry.Stream = kind
				live.Entry.Status = code
				live.Entry.InProgress = true
				live.Request, live.Entry.Sent = tr.sent.message(copyHeaders(r.Header))
				live.Entry.Rule = x.Entry.Rule
				live.Entry.Rewritten = x.Entry.Rewritten
				live.Response.Headers = headers
				live.Entry.ID = s.record(live)
				return &streamTap{base: live, start: start, publish: s.record}
			}
			tr.sent.files = s.files
			tr.received.files = s.files
		}
		defer tr.discardUnfinished()
		ctx, timing := withTiming(context.WithValue(r.Context(), traceKey{}, tr), start)
		req := r.WithContext(ctx)
		if rewrites := s.rules.matching(RuleRewrite, r); len(rewrites) > 0 {
			applyRequestRewrites(req, rewrites)
			tr.rewrites = rewrites
			x.Entry.Rule = ruleNames(rewrites)
			x.Entry.Rewritten = displayURL(req.URL)
		}
		if r.Body != nil {
			req.Body = readerWithClose{Reader: io.TeeReader(r.Body, &tr.sent), Closer: r.Body}
		}
		writer := &statusWriter{ResponseWriter: w, status: 200}
		func() {
			defer func() {
				if tr.stream != nil {
					done := tr.stream.finish()
					done.Timings = timing.result(time.Now())
					s.record(done)
				}
			}()
			s.proxy.ServeHTTP(writer, req)
		}()
		if tr.stream != nil {
			return
		}
		x.Entry.Status = writer.status
		if tr.failed {
			x.Entry.Error = "Upstream connection failed"
		}
		x.Request, x.Entry.Sent = tr.sent.message(copyHeaders(r.Header))
		x.Response, x.Entry.Received = tr.received.message(tr.response)
		x.Timings = timing.result(time.Now())
	}
	x.Entry.Duration = time.Since(start).Milliseconds()
	if s.identifyProcess {
		x.Entry.Process = s.processes.source(s.ctx, s.addr, r.RemoteAddr)
	}
	if s.includes(r.URL.Hostname()) {
		s.record(x)
	}
}

func (s *session) includes(host string) bool {
	return s.include == "" || strings.EqualFold(host, s.include)
}

func (s *session) tunnel(w http.ResponseWriter, r *http.Request, e *Entry) {
	if _, _, err := net.SplitHostPort(r.Host); err != nil {
		http.Error(w, "Expected host:port", 400)
		e.Status = 400
		return
	}
	up, err := s.dial(r.Context(), "tcp", r.Host)
	if err != nil {
		http.Error(w, "Tunnel unavailable", 502)
		e.Error = "Tunnel unavailable"
		e.Status = 502
		return
	}
	defer up.Close()
	client, buffer, err := http.NewResponseController(w).Hijack()
	if err != nil {
		e.Error = "Tunnel unavailable"
		return
	}
	defer client.Close()
	stop := context.AfterFunc(s.ctx, func() { client.Close(); up.Close() })
	defer stop()
	if _, err = buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if err = buffer.Flush(); err != nil {
		return
	}
	e.Status = 200
	if s.includes(r.URL.Hostname()) {
		e.InProgress = true
		e.ID = s.record(Exchange{Entry: *e})
		defer func() { e.InProgress = false }()
	}
	sent := make(chan int64, 1)
	go func() {
		n, _ := io.Copy(up, buffer.Reader)
		if tcp, ok := up.(*net.TCPConn); ok {
			tcp.CloseWrite()
		}
		sent <- n
	}()
	e.Received, _ = io.Copy(client, up)
	if tcp, ok := client.(*net.TCPConn); ok {
		tcp.CloseWrite()
	}
	e.Sent = <-sent
}

func SensitiveName(key string) bool { return sensitive(key) }

package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	mockShutdownTimeout = 3 * time.Second
	mockMaxDelay        = 30 * time.Second
	mockDefaultPort     = 3100
	mockReadTimeout     = time.Minute
	mockIdleTimeout     = 2 * time.Minute
)

const mockClientClosedStatus = 499

type mockCompiledRoute struct {
	route       model.MockRoute
	method      string
	segments    []string
	specificity int
	order       int
}

type mockServer struct {
	startMu  sync.Mutex
	mu       sync.RWMutex
	server   *http.Server
	listener net.Listener
	routes   []mockCompiledRoute
	config   model.MockServerConfig
	port     int
	running  bool
	seq      atomic.Uint64
	emit     func(model.MockRequestLog)
	log      []model.MockRequestLog
}

const mockLogLimit = 200

func newMockServer() *mockServer {
	return &mockServer{}
}

func normalizeMockPath(path string) []string {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func isMockParamSegment(segment string) bool {
	return strings.HasPrefix(segment, ":") || (strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}"))
}

func compileMockRoutes(routes []model.MockRoute) []mockCompiledRoute {
	compiled := make([]mockCompiledRoute, 0, len(routes))
	for index, route := range routes {
		segments := normalizeMockPath(route.PathTemplate)
		literals := 0
		for _, segment := range segments {
			if !isMockParamSegment(segment) {
				literals++
			}
		}
		compiled = append(compiled, mockCompiledRoute{
			route:       route,
			method:      strings.ToUpper(strings.TrimSpace(route.Method)),
			segments:    segments,
			specificity: literals*100 + len(route.Query)*10,
			order:       index,
		})
	}
	sort.SliceStable(compiled, func(i, j int) bool {
		if compiled[i].specificity != compiled[j].specificity {
			return compiled[i].specificity > compiled[j].specificity
		}
		return compiled[i].order < compiled[j].order
	})
	return compiled
}

func mockPathMatches(template []string, actual []string) bool {
	if len(template) != len(actual) {
		return false
	}
	for i, segment := range template {
		if isMockParamSegment(segment) {
			if actual[i] == "" {
				return false
			}
			continue
		}
		if segment != actual[i] {
			return false
		}
	}
	return true
}

func mockQueryMatches(required []model.KeyValue, actual url.Values) bool {
	for _, pair := range required {
		if pair.Key == "" {
			continue
		}
		values, ok := actual[pair.Key]
		if !ok {
			return false
		}
		if pair.Value == "" {
			continue
		}
		found := false
		for _, value := range values {
			if value == pair.Value {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func selectMockRoute(routes []mockCompiledRoute, method, path string, query url.Values) (mockCompiledRoute, bool) {
	wanted := strings.ToUpper(strings.TrimSpace(method))
	actual := normalizeMockPath(path)
	for _, candidate := range routes {
		if candidate.method != "" && candidate.method != wanted {
			continue
		}
		if !mockPathMatches(candidate.segments, actual) {
			continue
		}
		if !mockQueryMatches(candidate.route.Query, query) {
			continue
		}
		return candidate, true
	}
	return mockCompiledRoute{}, false
}

func (m *mockServer) statusLocked() model.MockServerStatus {
	if !m.running {
		return model.MockServerStatus{}
	}
	return model.MockServerStatus{
		Running:        true,
		Port:           m.port,
		URL:            fmt.Sprintf("http://127.0.0.1:%d", m.port),
		CollectionID:   m.config.CollectionID,
		CollectionName: m.config.CollectionName,
		RouteCount:     len(m.routes),
	}
}

func (m *mockServer) status() model.MockServerStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.statusLocked()
}

func (m *mockServer) swapRoutes(config model.MockServerConfig, emit func(model.MockRequestLog), port int) (model.MockServerStatus, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.running || m.port != port {
		return model.MockServerStatus{}, false
	}
	if m.config.CollectionID != config.CollectionID {
		m.log = nil
	}
	m.config = config
	m.routes = compileMockRoutes(config.Routes)
	m.emit = emit
	return m.statusLocked(), true
}

func (m *mockServer) start(config model.MockServerConfig, emit func(model.MockRequestLog)) model.MockServerStatus {
	port := config.Port
	if port <= 0 {
		port = mockDefaultPort
	}
	if port < 1 || port > 65535 {
		return model.MockServerStatus{Error: fmt.Sprintf("port %d is out of range — use 1–65535", port)}
	}
	if len(config.Routes) == 0 {
		return model.MockServerStatus{Error: "this collection has no saved examples yet — capture one from a response first"}
	}

	m.startMu.Lock()
	defer m.startMu.Unlock()

	if status, swapped := m.swapRoutes(config, emit, port); swapped {
		return status
	}

	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return model.MockServerStatus{Error: mockListenError(err, port)}
	}
	m.teardown()

	m.mu.Lock()
	m.config = config
	m.routes = compileMockRoutes(config.Routes)
	m.listener = listener
	m.port = listener.Addr().(*net.TCPAddr).Port
	m.running = true
	m.emit = emit
	m.server = &http.Server{
		Handler:           http.HandlerFunc(m.handle),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       mockReadTimeout,
		IdleTimeout:       mockIdleTimeout,
	}
	server := m.server
	status := m.statusLocked()
	m.mu.Unlock()

	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			m.mu.Lock()
			if m.server == server {
				m.running = false
			}
			m.mu.Unlock()
		}
	}()

	return status
}

func mockListenError(err error, port int) string {
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "address already in use"),
		strings.Contains(message, "only one usage of each socket address"):
		return fmt.Sprintf("port %d is already in use — pick another one", port)
	case strings.Contains(message, "permission denied"),
		strings.Contains(message, "access permissions"):
		return fmt.Sprintf("port %d needs elevated permissions — pick one above 1024", port)
	}
	return err.Error()
}

func (m *mockServer) stop() model.MockServerStatus {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	m.teardown()
	return model.MockServerStatus{}
}

func (m *mockServer) teardown() {
	m.mu.Lock()
	server := m.server
	listener := m.listener
	m.log = nil
	m.server = nil
	m.listener = nil
	m.routes = nil
	m.running = false
	m.emit = nil
	m.config = model.MockServerConfig{}
	m.port = 0
	m.mu.Unlock()

	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), mockShutdownTimeout)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			_ = server.Close()
		}
	}
	if listener != nil {
		_ = listener.Close()
	}
}

func mockLoopbackHostname(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

func mockOriginAllowed(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
	default:
		return false
	}
	return mockLoopbackHostname(parsed.Hostname())
}

func mockApplyCORS(header http.Header, r *http.Request, origin string) {
	header.Set("Access-Control-Allow-Origin", origin)
	header.Set("Access-Control-Allow-Credentials", "true")
	header.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS")
	if requested := r.Header.Get("Access-Control-Request-Headers"); requested != "" {
		header.Set("Access-Control-Allow-Headers", requested)
		header.Add("Vary", "Access-Control-Request-Headers")
	} else {
		header.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	}
}

func mockExposeHeaders(header http.Header) {
	names := make([]string, 0, len(header))
	for name := range header {
		if strings.HasPrefix(strings.ToLower(name), "access-control-") || strings.EqualFold(name, "Vary") {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) > 0 {
		header.Set("Access-Control-Expose-Headers", strings.Join(names, ", "))
	}
}

func writeMockForbiddenOrigin(w http.ResponseWriter, origin string) {
	payload := map[string]any{
		"error":  "This mock server only answers pages served from this machine.",
		"origin": origin,
		"detail": "It replays responses recorded from real APIs, so it does not hand them to a site on another host.",
	}
	body, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		body = []byte(`{"error":"This mock server only answers pages served from this machine."}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write(body)
}

func (m *mockServer) snapshot() ([]mockCompiledRoute, model.MockServerConfig, func(model.MockRequestLog)) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.routes, m.config, m.emit
}

func (m *mockServer) record(entry model.MockRequestLog) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.running {
		return false
	}
	m.log = append(m.log, entry)
	if len(m.log) > mockLogLimit {
		m.log = m.log[len(m.log)-mockLogLimit:]
	}
	return true
}

func (m *mockServer) recentLog() []model.MockRequestLog {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.MockRequestLog, len(m.log))
	copy(out, m.log)
	return out
}

func (m *mockServer) handle(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	routes, config, emit := m.snapshot()

	entry := model.MockRequestLog{
		ID:        fmt.Sprintf("mock-%d", m.seq.Add(1)),
		Method:    r.Method,
		Path:      r.URL.Path,
		Query:     r.URL.RawQuery,
		Timestamp: start.UnixMilli(),
	}
	finish := func() {
		entry.DurationMs = time.Since(start).Milliseconds()
		if m.record(entry) && emit != nil {
			emit(entry)
		}
	}

	w.Header().Add("Vary", "Origin")
	if origin := r.Header.Get("Origin"); origin != "" {
		if !mockOriginAllowed(origin) {
			entry.StatusCode = http.StatusForbidden
			entry.Note = "refused — served from " + origin
			writeMockForbiddenOrigin(w, origin)
			finish()
			return
		}
		mockApplyCORS(w.Header(), r, origin)
	}

	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
		entry.StatusCode = http.StatusNoContent
		entry.Note = "CORS preflight"
		finish()
		return
	}

	matched, ok := selectMockRoute(routes, r.Method, r.URL.Path, r.URL.Query())
	if !ok {
		entry.StatusCode = http.StatusNotFound
		writeMockNotFound(w, r, routes)
		finish()
		return
	}

	entry.Matched = true
	entry.ExampleID = matched.route.ExampleID
	entry.ExampleName = matched.route.ExampleName
	entry.RequestName = matched.route.RequestName

	if config.SimulateLatency && matched.route.DelayMs > 0 {
		delay := time.Duration(matched.route.DelayMs) * time.Millisecond
		if delay > mockMaxDelay {
			delay = mockMaxDelay
		}
		select {
		case <-time.After(delay):
		case <-r.Context().Done():
			entry.StatusCode = mockClientClosedStatus
			entry.Note = "the client gave up before the recorded delay was over"
			finish()
			return
		}
	}

	status := matched.route.StatusCode
	if status < 100 || status > 599 {
		status = http.StatusOK
	}

	for _, header := range matched.route.Headers {
		if header.Key == "" || !mockHeaderIsForwardable(header.Key) {
			continue
		}
		w.Header().Set(header.Key, header.Value)
	}
	if w.Header().Get("Content-Type") == "" && matched.route.BodyMediaType != "" {
		w.Header().Set("Content-Type", matched.route.BodyMediaType)
	}
	w.Header().Set("X-Kurlo-Mock-Example", matched.route.ExampleName)
	mockExposeHeaders(w.Header())

	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(matched.route.Body))
	}

	entry.StatusCode = status
	finish()
}

func mockHeaderIsForwardable(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive", "upgrade", "trailer", "te":
		return false
	case "access-control-allow-origin", "access-control-allow-credentials",
		"access-control-allow-methods", "access-control-allow-headers":
		return false
	}
	return true
}

func writeMockNotFound(w http.ResponseWriter, r *http.Request, routes []mockCompiledRoute) {
	available := make([]string, 0, len(routes))
	for _, route := range routes {
		method := route.method
		if method == "" {
			method = "ANY"
		}
		path := route.route.PathTemplate
		if path == "" {
			path = "/"
		}
		available = append(available, method+" "+path)
	}
	payload := map[string]any{
		"error":     "No saved example matches this request.",
		"method":    r.Method,
		"path":      r.URL.Path,
		"available": available,
	}
	body, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		body = []byte(`{"error":"No saved example matches this request."}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write(body)
}

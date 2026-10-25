package api

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"golang.org/x/net/publicsuffix"
)

const (
	cookieSyncDefaultPort     = 3199
	cookieSyncShutdownTimeout = 3 * time.Second
	cookieSyncMaxMessageBytes = 4 << 20
	cookieSyncMaxCookies      = 5000
	cookieSyncMaxDomains      = 100
	cookieSyncLogLimit        = 50
	cookieSyncTokenBytes      = 24
	cookieSyncPairTTL         = 2 * time.Minute
	cookieSyncPairCooldown    = 20 * time.Second
	cookieSyncWriteTimeout    = 10 * time.Second
	cookieSyncReadTimeout     = 70 * time.Second
	cookieSyncPingInterval    = 25 * time.Second
)

type cookieSyncPairing struct {
	id          string
	browser     string
	extensionID string
	code        string
	requestedAt time.Time
	expiresAt   time.Time
	approved    bool
	denied      bool
}

type cookieSyncSession struct {
	id      string
	browser string
	conn    *websocket.Conn
	writeMu sync.Mutex
}

func (s *cookieSyncSession) send(message any) error {
	payload, err := json.Marshal(message)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.conn.SetWriteDeadline(time.Now().Add(cookieSyncWriteTimeout)); err != nil {
		return err
	}
	return s.conn.WriteMessage(websocket.TextMessage, payload)
}

func (s *cookieSyncSession) ping() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(cookieSyncWriteTimeout))
}

func (s *cookieSyncSession) closeWith(code int, reason string) {
	s.writeMu.Lock()
	_ = s.conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason),
		time.Now().Add(cookieSyncWriteTimeout),
	)
	s.writeMu.Unlock()
	_ = s.conn.Close()
}

type cookieSyncServer struct {
	mu               sync.RWMutex
	server           *http.Server
	listener         net.Listener
	jars             *cookieJarRegistry
	emit             func(model.CookieSyncStatus)
	upgrader         websocket.Upgrader
	running          bool
	enabled          bool
	port             int
	token            string
	domains          []string
	workspaceID      string
	sessions         map[string]*cookieSyncSession
	pending          *cookieSyncPairing
	cooldownUntil    time.Time
	paired           bool
	browser          string
	extensionVersion string
	lastContactAt    time.Time
	lastSyncAt       time.Time
	lastSyncCount    int
	syncedTotal      int
	unreadable       []string
	log              []model.CookieSyncLog
	seq              atomic.Uint64
	startErr         string
	hydrated         bool
}

func newCookieSyncServer(jars *cookieJarRegistry) *cookieSyncServer {
	return &cookieSyncServer{
		jars:     jars,
		port:     cookieSyncDefaultPort,
		sessions: make(map[string]*cookieSyncSession),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin:     func(r *http.Request) bool { return cookieSyncExtensionOrigin(r.Header.Get("Origin")) },
		},
	}
}

func cookieSyncExtensionOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	lowered := strings.ToLower(origin)
	return strings.HasPrefix(lowered, "chrome-extension://") ||
		strings.HasPrefix(lowered, "moz-extension://") ||
		strings.HasPrefix(lowered, "safari-web-extension://")
}

func newCookieSyncToken() string {
	buf := make([]byte, cookieSyncTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func newCookieSyncRequestID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	return "pair-" + base64.RawURLEncoding.EncodeToString(buf)
}

func newCookieSyncApprovalCode() string {
	value, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%06d", value.Int64())
}

func cookieSyncPairingCode(port int, token string) string {
	if token == "" || port <= 0 {
		return ""
	}
	return fmt.Sprintf("kurlo-%d-%s", port, token)
}

func normalizeCookieSyncDomain(input string) string {
	value := strings.ToLower(strings.TrimSpace(input))
	if value == "" {
		return ""
	}
	if strings.Contains(value, "://") {
		if parsed, err := url.Parse(value); err == nil && parsed.Hostname() != "" {
			value = parsed.Hostname()
		}
	}
	value = strings.Trim(value, ".")
	value = strings.TrimPrefix(value, "*.")
	if host, _, err := net.SplitHostPort(value); err == nil && host != "" {
		value = host
	}
	if idx := strings.IndexAny(value, "/?#"); idx >= 0 {
		value = value[:idx]
	}
	value = strings.Trim(value, ".")
	if value == "" || strings.ContainsAny(value, " \t\"'\\") {
		return ""
	}
	if value != "localhost" && !strings.Contains(value, ".") && net.ParseIP(value) == nil {
		return ""
	}
	return value
}

func syncableCookieSyncDomains(input []string) []string {
	normalized := normalizeCookieSyncDomains(input)
	out := make([]string, 0, len(normalized))
	for _, domain := range normalized {
		if cookieSyncDomainIsSyncable(domain) {
			out = append(out, domain)
		}
	}
	return out
}

func normalizeCookieSyncDomains(input []string) []string {
	seen := make(map[string]bool, len(input))
	out := make([]string, 0, len(input))
	for _, candidate := range input {
		domain := normalizeCookieSyncDomain(candidate)
		if domain == "" || seen[domain] {
			continue
		}
		seen[domain] = true
		out = append(out, domain)
		if len(out) >= cookieSyncMaxDomains {
			break
		}
	}
	sort.Strings(out)
	return out
}

func cookieSyncDomainIsSyncable(domain string) bool {
	if domain == "localhost" || net.ParseIP(domain) != nil {
		return true
	}
	if suffix, _ := publicsuffix.PublicSuffix(domain); suffix == domain {
		return false
	}
	return strings.Contains(domain, ".")
}

func (s *cookieSyncServer) status() model.CookieSyncStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.statusLocked()
}

func (s *cookieSyncServer) statusLocked() model.CookieSyncStatus {
	status := model.CookieSyncStatus{
		Enabled:          s.enabled,
		Running:          s.running,
		Port:             s.port,
		Domains:          append([]string{}, s.domains...),
		Paired:           s.paired,
		Connected:        len(s.sessions) > 0,
		Browser:          s.browser,
		ExtensionVersion: s.extensionVersion,
		Unreadable:       append([]string{}, s.unreadable...),
		LastSyncCount:    s.lastSyncCount,
		SyncedTotal:      s.syncedTotal,
		Log:              append([]model.CookieSyncLog{}, s.log...),
		Error:            s.startErr,
	}
	if s.running {
		status.URL = fmt.Sprintf("http://127.0.0.1:%d", s.port)
		status.PairingCode = cookieSyncPairingCode(s.port, s.token)
	}
	if !s.lastContactAt.IsZero() {
		status.LastContactAt = s.lastContactAt.UnixMilli()
	}
	if !s.lastSyncAt.IsZero() {
		status.LastSyncAt = s.lastSyncAt.UnixMilli()
	}
	if s.pending != nil && !s.pending.approved && !s.pending.denied && time.Now().Before(s.pending.expiresAt) {
		status.Pending = model.CookieSyncPairRequest{
			ID:          s.pending.id,
			Browser:     s.pending.browser,
			ExtensionID: s.pending.extensionID,
			Code:        s.pending.code,
			RequestedAt: s.pending.requestedAt.UnixMilli(),
			ExpiresAt:   s.pending.expiresAt.UnixMilli(),
		}
	}
	return status
}

func (s *cookieSyncServer) start(config model.CookieSyncConfig, workspaceID string, emit func(model.CookieSyncStatus)) model.CookieSyncStatus {
	s.stopServer()

	port := config.Port
	if port <= 0 {
		port = cookieSyncDefaultPort
	}
	if port < 1024 || port > 65535 {
		s.mu.Lock()
		s.enabled = false
		s.startErr = fmt.Sprintf("port %d is out of range — use 1024–65535", port)
		status := s.statusLocked()
		s.mu.Unlock()
		return status
	}

	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		s.mu.Lock()
		s.enabled = true
		s.port = port
		s.startErr = cookieSyncListenError(err, port)
		status := s.statusLocked()
		s.mu.Unlock()
		return status
	}

	s.mu.Lock()
	s.enabled = true
	s.startErr = ""
	s.listener = listener
	s.port = listener.Addr().(*net.TCPAddr).Port
	s.domains = syncableCookieSyncDomains(config.Domains)
	s.workspaceID = workspaceID
	s.emit = emit
	s.running = true
	if s.token == "" {
		s.token = newCookieSyncToken()
	}
	s.server = &http.Server{
		Handler:           http.HandlerFunc(s.handle),
		ReadHeaderTimeout: 10 * time.Second,
	}
	server := s.server
	status := s.statusLocked()
	s.mu.Unlock()

	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			s.mu.Lock()
			s.running = false
			s.startErr = serveErr.Error()
			s.mu.Unlock()
			s.publish()
		}
	}()

	return status
}

func cookieSyncListenError(err error, port int) string {
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

func (s *cookieSyncServer) stopServer() {
	s.mu.Lock()
	server := s.server
	listener := s.listener
	sessions := s.sessions
	s.server = nil
	s.listener = nil
	s.sessions = make(map[string]*cookieSyncSession)
	s.pending = nil
	s.running = false
	s.emit = nil
	s.browser = ""
	s.extensionVersion = ""
	s.lastContactAt = time.Time{}
	s.mu.Unlock()

	for _, session := range sessions {
		session.closeWith(websocket.CloseGoingAway, "kurlo is closing the bridge")
	}
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), cookieSyncShutdownTimeout)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			_ = server.Close()
		}
	}
	if listener != nil {
		_ = listener.Close()
	}
}

func (s *cookieSyncServer) stop() model.CookieSyncStatus {
	s.stopServer()
	s.mu.Lock()
	s.enabled = false
	s.startErr = ""
	s.lastSyncCount = 0
	s.log = nil
	status := s.statusLocked()
	s.mu.Unlock()
	return status
}

func (s *cookieSyncServer) setDomains(domains []string) model.CookieSyncStatus {
	accepted := syncableCookieSyncDomains(domains)
	rejected := make([]string, 0)
	for _, domain := range normalizeCookieSyncDomains(domains) {
		if !cookieSyncDomainIsSyncable(domain) {
			rejected = append(rejected, domain)
		}
	}

	s.mu.Lock()
	s.domains = accepted
	status := s.statusLocked()
	s.mu.Unlock()

	s.broadcastDomains()
	if len(rejected) > 0 && status.Error == "" {
		status.Error = fmt.Sprintf(
			"%s cannot hold cookies of its own — list a domain below it, like app.%s",
			strings.Join(rejected, ", "), rejected[0],
		)
	}
	return status
}

func (s *cookieSyncServer) setWorkspace(workspaceID string) {
	s.mu.Lock()
	s.workspaceID = workspaceID
	s.mu.Unlock()
}

func (s *cookieSyncServer) revokePairing() model.CookieSyncStatus {
	s.mu.Lock()
	s.token = newCookieSyncToken()
	s.paired = false
	s.browser = ""
	s.extensionVersion = ""
	s.pending = nil
	s.lastContactAt = time.Time{}
	s.unreadable = nil
	sessions := s.sessions
	s.sessions = make(map[string]*cookieSyncSession)
	status := s.statusLocked()
	s.mu.Unlock()

	for _, session := range sessions {
		session.closeWith(websocket.ClosePolicyViolation, "kurlo disconnected this browser")
	}
	return status
}

func (s *cookieSyncServer) publish() {
	s.mu.RLock()
	emit := s.emit
	status := s.statusLocked()
	s.mu.RUnlock()
	if emit != nil {
		emit(status)
	}
}

func (s *cookieSyncServer) record(entry model.CookieSyncLog) {
	entry.ID = fmt.Sprintf("cookie-sync-%d", s.seq.Add(1))
	s.mu.Lock()
	s.log = append(s.log, entry)
	if len(s.log) > cookieSyncLogLimit {
		s.log = s.log[len(s.log)-cookieSyncLogLimit:]
	}
	s.mu.Unlock()
}

func (s *cookieSyncServer) authorizedToken(provided string) bool {
	s.mu.RLock()
	token := s.token
	s.mu.RUnlock()
	if token == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(token)) == 1
}

func sanitizeCookieSyncLabel(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 64 {
		value = value[:64]
	}
	out := make([]rune, 0, len(value))
	for _, r := range value {
		if r < 32 || r == 127 {
			continue
		}
		out = append(out, r)
	}
	return strings.TrimSpace(string(out))
}

func (s *cookieSyncServer) handle(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if !cookieSyncExtensionOrigin(origin) {
		writeCookieSyncJSON(w, http.StatusForbidden, map[string]any{"error": "cookie sync only answers browser extensions"})
		return
	}
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "content-type, x-kurlo-cookie-sync")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	switch {
	case r.URL.Path == "/discover" && r.Method == http.MethodGet:
		s.handleDiscover(w, r)
	case r.URL.Path == "/pair" && r.Method == http.MethodPost:
		s.handlePairRequest(w, r)
	case r.URL.Path == "/pair" && r.Method == http.MethodGet:
		s.handlePairPoll(w, r)
	case r.URL.Path == "/ws" && r.Method == http.MethodGet:
		s.handleSocket(w, r)
	default:
		writeCookieSyncJSON(w, http.StatusNotFound, map[string]any{"error": "unknown endpoint"})
	}
}

func (s *cookieSyncServer) handleDiscover(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	port := s.port
	paired := s.paired
	s.mu.RUnlock()
	writeCookieSyncJSON(w, http.StatusOK, map[string]any{
		"app":     "kurlo",
		"version": appVersion,
		"port":    port,
		"paired":  paired,
	})
}

type cookieSyncPairPayload struct {
	Browser     string `json:"browser"`
	ExtensionID string `json:"extensionId"`
}

func (s *cookieSyncServer) handlePairRequest(w http.ResponseWriter, r *http.Request) {
	var payload cookieSyncPairPayload
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
	if err := decoder.Decode(&payload); err != nil {
		writeCookieSyncJSON(w, http.StatusBadRequest, map[string]any{"error": "could not read the pairing request"})
		return
	}
	browser := sanitizeCookieSyncLabel(payload.Browser)
	if browser == "" {
		browser = "A browser"
	}
	extensionID := sanitizeCookieSyncLabel(payload.ExtensionID)

	now := time.Now()
	s.mu.Lock()
	if now.Before(s.cooldownUntil) {
		wait := int(s.cooldownUntil.Sub(now).Seconds()) + 1
		s.mu.Unlock()
		writeCookieSyncJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":      "Kurlo turned down the last request — wait before asking again",
			"retryAfter": wait,
		})
		return
	}
	if existing := s.pending; existing != nil && !existing.approved && !existing.denied && now.Before(existing.expiresAt) {
		s.mu.Unlock()
		writeCookieSyncJSON(w, http.StatusConflict, map[string]any{"error": "a browser is already waiting to be approved — approve or deny it in Kurlo first"})
		return
	}

	requestID := newCookieSyncRequestID()
	if requestID == "" {
		s.mu.Unlock()
		writeCookieSyncJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not start pairing"})
		return
	}
	pairing := &cookieSyncPairing{
		id:          requestID,
		browser:     browser,
		extensionID: extensionID,
		code:        newCookieSyncApprovalCode(),
		requestedAt: now,
		expiresAt:   now.Add(cookieSyncPairTTL),
	}
	s.pending = pairing
	s.lastContactAt = now
	response := map[string]any{"requestId": pairing.id, "code": pairing.code, "status": "pending"}
	s.mu.Unlock()

	s.record(model.CookieSyncLog{
		Timestamp: now.UnixMilli(),
		Browser:   browser,
		Message:   "asked to connect",
	})
	s.publish()
	writeCookieSyncJSON(w, http.StatusOK, response)
}

func (s *cookieSyncServer) handlePairPoll(w http.ResponseWriter, r *http.Request) {
	requestID := strings.TrimSpace(r.URL.Query().Get("requestId"))
	s.mu.Lock()
	pairing := s.pending
	if pairing == nil || requestID == "" || subtle.ConstantTimeCompare([]byte(pairing.id), []byte(requestID)) != 1 {
		s.mu.Unlock()
		writeCookieSyncJSON(w, http.StatusOK, map[string]any{"status": "expired"})
		return
	}
	switch {
	case pairing.denied:
		s.pending = nil
		s.mu.Unlock()
		writeCookieSyncJSON(w, http.StatusOK, map[string]any{"status": "denied"})
		s.publish()
	case time.Now().After(pairing.expiresAt):
		s.pending = nil
		s.mu.Unlock()
		writeCookieSyncJSON(w, http.StatusOK, map[string]any{"status": "expired"})
		s.publish()
	case pairing.approved:
		if s.token == "" {
			s.token = newCookieSyncToken()
		}
		token := s.token
		s.pending = nil
		s.paired = true
		s.browser = pairing.browser
		s.mu.Unlock()
		writeCookieSyncJSON(w, http.StatusOK, map[string]any{"status": "approved", "token": token})
		s.publish()
	default:
		s.mu.Unlock()
		writeCookieSyncJSON(w, http.StatusOK, map[string]any{"status": "pending"})
	}
}

func (s *cookieSyncServer) approvePairing(id string) model.CookieSyncStatus {
	s.mu.Lock()
	if s.pending != nil && (id == "" || s.pending.id == id) {
		s.pending.approved = true
	}
	status := s.statusLocked()
	s.mu.Unlock()
	return status
}

func (s *cookieSyncServer) denyPairing(id string) model.CookieSyncStatus {
	s.mu.Lock()
	if s.pending != nil && (id == "" || s.pending.id == id) {
		s.pending.denied = true
		s.cooldownUntil = time.Now().Add(cookieSyncPairCooldown)
	}
	status := s.statusLocked()
	s.mu.Unlock()
	return status
}

func (s *cookieSyncServer) handleSocket(w http.ResponseWriter, r *http.Request) {
	if !s.authorizedToken(strings.TrimSpace(r.URL.Query().Get("token"))) {
		writeCookieSyncJSON(w, http.StatusUnauthorized, map[string]any{"error": "pairing token does not match"})
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	browser := sanitizeCookieSyncLabel(r.URL.Query().Get("browser"))
	if browser == "" {
		browser = "A browser"
	}
	extensionVersion := sanitizeCookieSyncLabel(r.URL.Query().Get("version"))
	session := &cookieSyncSession{
		id:      fmt.Sprintf("cookie-sync-session-%d", s.seq.Add(1)),
		browser: browser,
		conn:    conn,
	}

	s.mu.Lock()
	s.sessions[session.id] = session
	s.paired = true
	s.browser = browser
	s.extensionVersion = extensionVersion
	s.lastContactAt = time.Now()
	domains := append([]string{}, s.domains...)
	s.mu.Unlock()

	conn.SetReadLimit(cookieSyncMaxMessageBytes)
	_ = conn.SetReadDeadline(time.Now().Add(cookieSyncReadTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(cookieSyncReadTimeout))
	})

	_ = session.send(map[string]any{
		"type":    "hello",
		"app":     "kurlo",
		"version": appVersion,
		"domains": domains,
	})
	s.record(model.CookieSyncLog{
		Timestamp: time.Now().UnixMilli(),
		Browser:   browser,
		Message:   "connected",
	})
	s.publish()

	done := make(chan struct{})
	go s.pingSession(session, done)
	s.readSession(session)
	close(done)

	s.mu.Lock()
	delete(s.sessions, session.id)
	if len(s.sessions) == 0 {
		s.browser = ""
		s.extensionVersion = ""
		s.unreadable = nil
	}
	s.mu.Unlock()
	_ = conn.Close()
	s.record(model.CookieSyncLog{
		Timestamp: time.Now().UnixMilli(),
		Browser:   browser,
		Message:   "disconnected",
	})
	s.publish()
}

func (s *cookieSyncServer) pingSession(session *cookieSyncSession, done <-chan struct{}) {
	ticker := time.NewTicker(cookieSyncPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			if err := session.ping(); err != nil {
				return
			}
		}
	}
}

type cookieSyncMessage struct {
	Type    string             `json:"type"`
	Browser string             `json:"browser"`
	Domains []string           `json:"domains"`
	Cookies []cookieSyncCookie `json:"cookies"`
	Cookie  cookieSyncCookie   `json:"cookie"`
	Removed bool               `json:"removed"`
	Cause   string             `json:"cause"`
}

type cookieSyncCookie struct {
	Name           string  `json:"name"`
	Value          string  `json:"value"`
	Domain         string  `json:"domain"`
	Path           string  `json:"path"`
	Secure         bool    `json:"secure"`
	HTTPOnly       bool    `json:"httpOnly"`
	SameSite       string  `json:"sameSite"`
	HostOnly       bool    `json:"hostOnly"`
	Session        bool    `json:"session"`
	ExpiresAt      int64   `json:"expiresAt"`
	ExpirationDate float64 `json:"expirationDate"`
}

func (c cookieSyncCookie) toModel() model.Cookie {
	cookie := model.Cookie{
		Name:     c.Name,
		Value:    c.Value,
		Domain:   strings.Trim(strings.ToLower(strings.TrimSpace(c.Domain)), "."),
		Path:     c.Path,
		Secure:   c.Secure,
		HTTPOnly: c.HTTPOnly,
		SameSite: normalizeSyncedSameSite(c.SameSite),
		HostOnly: c.HostOnly,
		Session:  c.Session,
	}
	if cookie.Path == "" {
		cookie.Path = "/"
	}
	switch {
	case c.ExpiresAt > 0:
		cookie.ExpiresAt = c.ExpiresAt
	case c.ExpirationDate > 0 && c.ExpirationDate < math.MaxInt64/1000:
		cookie.ExpiresAt = int64(c.ExpirationDate * 1000)
	}
	if cookie.ExpiresAt <= 0 {
		cookie.Session = true
	}
	return cookie
}

func normalizeSyncedSameSite(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "no_restriction", "none":
		return "none"
	case "lax":
		return "lax"
	case "strict":
		return "strict"
	default:
		return ""
	}
}

func (s *cookieSyncServer) readSession(session *cookieSyncSession) {
	for {
		_, payload, err := session.conn.ReadMessage()
		if err != nil {
			return
		}
		_ = session.conn.SetReadDeadline(time.Now().Add(cookieSyncReadTimeout))

		var message cookieSyncMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			_ = session.send(map[string]any{"type": "error", "error": "could not read that message"})
			continue
		}
		switch message.Type {
		case "ping":
			_ = session.send(map[string]any{"type": "pong"})
		case "snapshot":
			s.applySnapshot(session, message)
		case "change":
			s.applyChange(session, message)
		default:
			_ = session.send(map[string]any{"type": "error", "error": "unknown message type"})
		}
	}
}

func (s *cookieSyncServer) syncTargets(claimed []string) ([]string, *trackedCookieJar) {
	s.mu.RLock()
	allowed := append([]string{}, s.domains...)
	workspaceID := s.workspaceID
	jars := s.jars
	s.mu.RUnlock()

	scope := make([]string, 0, len(allowed))
	narrowed := normalizeCookieSyncDomains(claimed)
	for _, domain := range allowed {
		if len(narrowed) > 0 && !cookieDomainAllowed(domain, narrowed) && !containsString(narrowed, domain) {
			continue
		}
		scope = append(scope, domain)
	}
	if jars == nil {
		return scope, nil
	}
	return scope, jars.jar(workspaceID)
}

func (s *cookieSyncServer) noteUnreadable(claimed []string) {
	readable := normalizeCookieSyncDomains(claimed)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(readable) == 0 {
		return
	}
	unreadable := make([]string, 0)
	for _, domain := range s.domains {
		if !containsString(readable, domain) {
			unreadable = append(unreadable, domain)
		}
	}
	s.unreadable = unreadable
}

func (s *cookieSyncServer) noteSync(session *cookieSyncSession, accepted int) {
	now := time.Now()
	s.mu.Lock()
	s.lastContactAt = now
	s.lastSyncAt = now
	s.lastSyncCount = accepted
	s.syncedTotal += accepted
	s.browser = session.browser
	s.mu.Unlock()
}

func (s *cookieSyncServer) applySnapshot(session *cookieSyncSession, message cookieSyncMessage) {
	if len(message.Cookies) > cookieSyncMaxCookies {
		_ = session.send(map[string]any{
			"type":  "error",
			"error": fmt.Sprintf("too many cookies in one snapshot — %d is the limit", cookieSyncMaxCookies),
		})
		return
	}

	scope, jar := s.syncTargets(message.Domains)
	if len(scope) == 0 || jar == nil {
		_ = session.send(map[string]any{"type": "synced", "accepted": 0, "removed": 0, "skipped": len(message.Cookies), "domains": []string{}})
		return
	}

	cookies := make([]model.Cookie, 0, len(message.Cookies))
	skipped := 0
	for _, raw := range message.Cookies {
		cookie := raw.toModel()
		if cookie.Name == "" || cookie.Domain == "" || !cookieDomainAllowed(cookie.Domain, scope) {
			skipped++
			continue
		}
		cookies = append(cookies, cookie)
	}

	accepted, removed := jar.SyncCookies(scope, cookies)
	s.noteSync(session, accepted)
	s.noteUnreadable(message.Domains)
	s.record(model.CookieSyncLog{
		Timestamp: time.Now().UnixMilli(),
		Browser:   session.browser,
		Domain:    strings.Join(scope, ", "),
		Accepted:  accepted,
		Skipped:   skipped,
		Removed:   removed,
		Message:   cookieSyncSummary(accepted, removed, skipped),
	})
	_ = session.send(map[string]any{
		"type":     "synced",
		"accepted": accepted,
		"removed":  removed,
		"skipped":  skipped,
		"domains":  scope,
	})
	s.publish()
}

func (s *cookieSyncServer) applyChange(session *cookieSyncSession, message cookieSyncMessage) {
	cookie := message.Cookie.toModel()
	if cookie.Name == "" || cookie.Domain == "" {
		_ = session.send(map[string]any{"type": "error", "error": "that change carries no cookie"})
		return
	}

	scope, jar := s.syncTargets(nil)
	if jar == nil || !jar.ApplySyncedCookie(scope, cookie, message.Removed) {
		_ = session.send(map[string]any{"type": "skipped", "name": cookie.Name, "domain": cookie.Domain})
		return
	}

	accepted, removed := 1, 0
	if message.Removed {
		accepted, removed = 0, 1
	}
	s.noteSync(session, accepted)
	s.record(model.CookieSyncLog{
		Timestamp: time.Now().UnixMilli(),
		Browser:   session.browser,
		Domain:    cookie.Domain,
		Accepted:  accepted,
		Removed:   removed,
		Message:   cookieSyncChangeSummary(cookie.Name, message.Removed, message.Cause),
	})
	_ = session.send(map[string]any{"type": "synced", "accepted": accepted, "removed": removed, "skipped": 0, "domains": []string{cookie.Domain}})
	s.publish()
}

func (s *cookieSyncServer) broadcastDomains() {
	s.mu.RLock()
	domains := append([]string{}, s.domains...)
	sessions := make([]*cookieSyncSession, 0, len(s.sessions))
	for _, session := range s.sessions {
		sessions = append(sessions, session)
	}
	s.mu.RUnlock()

	for _, session := range sessions {
		_ = session.send(map[string]any{"type": "domains", "domains": domains})
	}
}

func cookieSyncSummary(accepted int, removed int, skipped int) string {
	parts := []string{fmt.Sprintf("%s synced", pluralCookies(accepted))}
	if removed > 0 {
		parts = append(parts, fmt.Sprintf("%d gone from the browser", removed))
	}
	if skipped > 0 {
		parts = append(parts, fmt.Sprintf("%d outside the allowlist", skipped))
	}
	return strings.Join(parts, ", ")
}

func cookieSyncChangeSummary(name string, removed bool, cause string) string {
	action := "updated"
	if removed {
		action = "cleared"
	}
	cause = sanitizeCookieSyncLabel(cause)
	if cause == "" || cause == "explicit" {
		return fmt.Sprintf("%s %s in the browser", name, action)
	}
	return fmt.Sprintf("%s %s in the browser (%s)", name, action, cause)
}

func pluralCookies(count int) string {
	if count == 1 {
		return "1 cookie"
	}
	return fmt.Sprintf("%d cookies", count)
}

func writeCookieSyncJSON(w http.ResponseWriter, status int, payload map[string]any) {
	body, err := json.Marshal(payload)
	if err != nil {
		body = []byte(`{"error":"could not encode the response"}`)
		status = http.StatusInternalServerError
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

package api

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/auth"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type sseSession struct {
	cancel context.CancelFunc
	id     uint64
}

type sseManager struct {
	mu       sync.Mutex
	sessions map[string]*sseSession
	seq      uint64
	jars     *cookieJarRegistry
}

func newSSEManager(jars *cookieJarRegistry) *sseManager {
	if jars == nil {
		jars = newCookieJarRegistry()
	}
	return &sseManager{sessions: make(map[string]*sseSession), jars: jars}
}

func (m *sseManager) connect(appCtx context.Context, sessionID string, req model.HttpRequest) {
	sseCtx, cancel := context.WithCancel(appCtx)

	m.mu.Lock()
	if existing, ok := m.sessions[sessionID]; ok {
		existing.cancel()
	}
	m.seq++
	seq := m.seq
	m.sessions[sessionID] = &sseSession{cancel: cancel, id: seq}
	m.mu.Unlock()

	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("kurlo: SSE session %s panicked: %v", sessionID, r)
			}
			m.mu.Lock()
			if sess, ok := m.sessions[sessionID]; ok && sess.id == seq {
				delete(m.sessions, sessionID)
			}
			m.mu.Unlock()
		}()
		m.runStream(sseCtx, appCtx, sessionID, req)
	}()
}

func (m *sseManager) disconnect(sessionID string) {
	m.mu.Lock()
	if sess, ok := m.sessions[sessionID]; ok {
		sess.cancel()
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()
}

func (m *sseManager) disconnectAll() {
	m.mu.Lock()
	sessions := m.sessions
	m.sessions = make(map[string]*sseSession)
	m.mu.Unlock()
	for _, sess := range sessions {
		sess.cancel()
	}
}

func (m *sseManager) runStream(sseCtx, appCtx context.Context, sessionID string, req model.HttpRequest) {
	const batchWindow = 50 * time.Millisecond
	const maxBatchSize = 100

	batch := newEventBatcher[model.SSEEvent](maxBatchSize, batchWindow,
		func(ev model.SSEEvent) {
			runtime.EventsEmit(appCtx, "sse:event", model.SSEPayload{SessionID: sessionID, Event: ev})
		},
		func(events []model.SSEEvent) {
			runtime.EventsEmit(appCtx, "sse:events", model.SSEBatchPayload{SessionID: sessionID, Events: events})
		},
	)
	defer batch.flush()

	onOpen := func(ev model.SSEOpenEvent) {
		runtime.EventsEmit(appCtx, "sse:open", ev)
	}
	onEvent := func(ev model.SSEEvent) {
		batch.add(ev)
	}

	lastEventID := ""
	attempt := 0
	for {
		res := m.runStreamAttempt(sseCtx, sessionID, req, lastEventID, onOpen, onEvent)
		lastEventID = res.lastEventID

		if !res.reconnect || req.SSEDisableReconnect || sseCtx.Err() != nil {
			batch.flush()
			if res.errorEvent != nil {
				runtime.EventsEmit(appCtx, "sse:error", *res.errorEvent)
			} else if res.closeEvent != nil {
				runtime.EventsEmit(appCtx, "sse:close", *res.closeEvent)
			}
			return
		}

		delay := sseReconnectDelay(req, res.retry)
		attempt++
		batch.flush()
		runtime.EventsEmit(appCtx, "sse:reconnecting", model.SSEReconnectEvent{
			SessionID:   sessionID,
			Attempt:     attempt,
			DelayMs:     int(delay / time.Millisecond),
			LastEventID: lastEventID,
			Message:     sseReconnectMessage(res),
			Timestamp:   time.Now().UnixMilli(),
		})

		select {
		case <-time.After(delay):
		case <-sseCtx.Done():
			return
		}
	}
}

func sseReconnectDelay(req model.HttpRequest, serverRetry time.Duration) time.Duration {
	if req.SSEReconnectIntervalMs > 0 {
		return time.Duration(req.SSEReconnectIntervalMs) * time.Millisecond
	}
	if serverRetry > 0 {
		return serverRetry
	}
	return 3 * time.Second
}

func sseReconnectMessage(res sseAttempt) string {
	if res.errorEvent != nil {
		return res.errorEvent.Message
	}
	if res.closeEvent != nil {
		return res.closeEvent.Message
	}
	return "Reconnecting…"
}

type sseAttempt struct {
	reconnect   bool
	lastEventID string
	retry       time.Duration
	closeEvent  *model.SSECloseEvent
	errorEvent  *model.SSEErrorEvent
}

func (m *sseManager) runStreamWithCallbacks(
	sseCtx context.Context,
	sessionID string,
	req model.HttpRequest,
	onOpen func(model.SSEOpenEvent),
	onEvent func(model.SSEEvent),
	onClose func(model.SSECloseEvent),
	onError func(model.SSEErrorEvent),
) sseAttempt {
	res := m.runStreamAttempt(sseCtx, sessionID, req, "", onOpen, onEvent)
	if res.errorEvent != nil {
		onError(*res.errorEvent)
	} else if res.closeEvent != nil {
		onClose(*res.closeEvent)
	}
	return res
}

func (m *sseManager) runStreamAttempt(
	sseCtx context.Context,
	sessionID string,
	req model.HttpRequest,
	lastEventID string,
	onOpen func(model.SSEOpenEvent),
	onEvent func(model.SSEEvent),
) sseAttempt {
	start := time.Now()
	result := sseAttempt{lastEventID: lastEventID}
	fail := func(msg string, reconnect bool) sseAttempt {
		result.errorEvent = &model.SSEErrorEvent{SessionID: sessionID, Message: msg, Timestamp: time.Now().UnixMilli()}
		result.reconnect = reconnect
		return result
	}
	closed := func(msg string, reconnect bool) sseAttempt {
		result.closeEvent = &model.SSECloseEvent{SessionID: sessionID, Message: msg, Timestamp: time.Now().UnixMilli()}
		result.reconnect = reconnect
		return result
	}

	req.URL = applyPathParams(req.URL, req.PathParams)
	rawInput := strings.TrimSpace(req.URL)
	if isBarePortLikeURL(rawInput) {
		return fail(invalidBarePortURLMessage("http"), false)
	}
	rawURL := normalizeRequestURL(req.URL)
	if rawURL == "" {
		return fail("Empty URL", false)
	}
	if strings.Contains(rawURL, "{{") {
		return fail("URL contains an unresolved variable — make sure all {{variables}} are defined in the active environment", false)
	}

	u, err := url.Parse(rawURL)
	if err != nil {
		return fail(fmt.Sprintf("Invalid URL: %s", err), false)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fail(fmt.Sprintf("Unsupported URL scheme %q. Use http:// or https://.", u.Scheme), false)
	}
	if u.Host == "" {
		return fail("Invalid URL: missing host. Try http://localhost:3005/...", false)
	}
	if isNumericHostname(u.Hostname()) {
		return fail(invalidBarePortURLMessage("http"), false)
	}

	applyQueryParams(u, req)

	httpReq, err := http.NewRequestWithContext(sseCtx, "GET", u.String(), nil)
	if err != nil {
		return fail(fmt.Sprintf("Failed to build request: %s", err), false)
	}

	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("Cache-Control", "no-cache")
	httpReq.Header.Set("Connection", "keep-alive")
	if lastEventID != "" {
		httpReq.Header.Set("Last-Event-ID", lastEventID)
	}
	if browserSecurityActive(req) {
		httpReq.Header.Set("User-Agent", browserLikeUserAgent)
	} else {
		httpReq.Header.Set("User-Agent", "Kurlo/"+appVersion)
	}

	_, _ = applyUserHeaders(httpReq.Header, req.Headers)
	if err := auth.Apply(httpReq, req.Auth); err != nil {
		return fail("auth error: "+err.Error(), false)
	}
	browserCtx, err := prepareBrowserSecurity(req, httpReq.Header, u, browserKindFetch)
	if err != nil {
		return fail(err.Error(), false)
	}
	if msg := validateBrowserCSP(req, u, browserCtx); msg != "" {
		return fail("CSP error: "+msg, false)
	}
	if msg := blockedBrowserNetworkAccess(u, browserCtx); msg != "" {
		return fail("Browser error: "+msg, false)
	}

	sseReq := req
	sseReq.Method = http.MethodGet
	if browserCtx.active && browserCtx.crossOrigin && !browserCtx.withCredentials {
		sseReq.DisableCookieJar = true
		httpReq.Header.Del("Cookie")
	}
	transport := sharedHTTPTransport(sseReq)
	var jar http.CookieJar
	if !sseReq.DisableCookieJar {
		jar = m.jars.jar(sseReq.WorkspaceID)
		if browserCtx.active && !browserCtx.withCredentials {
			jar = browserCredentialsJar{jar: jar, state: &browserCtx}
		}
	}
	client := &http.Client{
		Transport: buildHTTPRoundTripper(sseReq, transport),
		Jar:       jar,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			return browserCtx.followRedirect(sseReq, next, via, nil)
		},
	}
	traceCtx, timings := withResponseTiming(httpReq.Context(), start)
	httpReq = httpReq.WithContext(traceCtx)
	timings.markPrepared()
	resp, err := client.Do(httpReq)
	if err != nil {
		if sseCtx.Err() != nil {
			return closed("Disconnected", false)
		}
		var blocked browserBlockedError
		if errors.As(err, &blocked) {
			return fail(blocked.Error(), false)
		}
		return fail(formatRequestError(err, u, effectiveRequestTimeout(req)), true)
	}
	if browserCtx.enforceCORS {
		if msg := validateCORSActualResponse(resp, browserCtx); msg != "" {
			_ = resp.Body.Close()
			return fail("CORS error: "+msg, false)
		}
	}
	openedAt := time.Now()
	defer resp.Body.Close()
	status2xx := resp.StatusCode >= 200 && resp.StatusCode < 300

	keys := make([]string, 0, len(resp.Header))
	for k := range resp.Header {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	respHeaders := make([]model.KeyValue, 0, len(keys))
	for _, k := range keys {
		for _, v := range resp.Header[k] {
			respHeaders = append(respHeaders, model.KeyValue{Key: k, Value: v, Enabled: true})
		}
	}

	onOpen(model.SSEOpenEvent{
		SessionID:  sessionID,
		URL:        u.String(),
		StatusCode: resp.StatusCode,
		Status:     resp.Status,
		Headers:    respHeaders,
		Duration:   openedAt.Sub(start).Milliseconds(),
		Timings:    timings.snapshot(openedAt),
		Timestamp:  openedAt.UnixMilli(),
	})

	parsed := parseSSEStream(sseCtx, resp.Body, result.lastEventID, onEvent)
	result.lastEventID = parsed.lastEventID
	if parsed.retry >= 0 {
		result.retry = parsed.retry
	}

	if sseCtx.Err() != nil {
		return closed("Disconnected", false)
	}

	if scanErr := parsed.err; scanErr != nil {
		if errors.Is(scanErr, bufio.ErrTooLong) {
			return fail(fmt.Sprintf("SSE line exceeds %d bytes — stream is malformed", sseMaxLineSize), false)
		}
		return fail(fmt.Sprintf("Stream error: %s", scanErr), status2xx)
	}
	return closed("Connection closed by server", status2xx)
}

type sseParseResult struct {
	lastEventID string
	retry       time.Duration
	err         error
}

const sseMaxLineSize = 1 * 1024 * 1024
const sseMaxEventDataSize = 16 * 1024 * 1024

func parseSSEStream(ctx context.Context, r io.Reader, lastEventID string, onEvent func(model.SSEEvent)) sseParseResult {
	out := sseParseResult{lastEventID: lastEventID, retry: -1}
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), sseMaxLineSize)
	scanner.Split(newSSELineSplitter())

	var currentEvent, dataLines string
	hasData := false
	dataTruncated := false
	firstLine := true

	for scanner.Scan() {
		if ctx.Err() != nil {
			break
		}

		line := scanner.Text()
		if firstLine {
			line = strings.TrimPrefix(line, "\uFEFF")
			firstLine = false
		}

		if line == "" {
			if hasData || currentEvent != "" {
				ev := model.SSEEvent{
					ID:        out.lastEventID,
					Event:     currentEvent,
					Data:      dataLines,
					Timestamp: time.Now().UnixMilli(),
				}
				if ev.Event == "" {
					ev.Event = "message"
				}
				onEvent(ev)
			}
			currentEvent = ""
			dataLines = ""
			hasData = false
			dataTruncated = false
			continue
		}

		if strings.HasPrefix(line, ":") {
			continue
		}

		field, value, found := strings.Cut(line, ":")
		if found {
			value = strings.TrimPrefix(value, " ")
		}

		switch field {
		case "id":
			if !strings.ContainsRune(value, '\x00') {
				out.lastEventID = value
			}
		case "retry":
			if ms, convErr := strconv.Atoi(strings.TrimSpace(value)); convErr == nil && ms >= 0 {
				out.retry = time.Duration(ms) * time.Millisecond
			}
		case "event":
			currentEvent = value
		case "data":
			if dataTruncated {
				continue
			}
			extra := len(value)
			if hasData {
				extra++
			}
			if len(dataLines)+extra > sseMaxEventDataSize {
				remaining := sseMaxEventDataSize - len(dataLines)
				if remaining > 0 {
					if hasData {
						dataLines += "\n"
						remaining--
					}
					if remaining > 0 && remaining < len(value) {
						dataLines += value[:remaining]
					} else if remaining >= len(value) {
						dataLines += value
					}
				}
				hasData = true
				dataTruncated = true
				continue
			}
			if hasData {
				dataLines += "\n"
			}
			dataLines += value
			hasData = true
		}
	}

	out.err = scanner.Err()
	return out
}

func newSSELineSplitter() bufio.SplitFunc {
	skipLF := false
	return func(data []byte, atEOF bool) (int, []byte, error) {
		start := 0
		if skipLF && len(data) > 0 {
			skipLF = false
			if data[0] == '\n' {
				start = 1
			}
		}
		if i := bytes.IndexAny(data[start:], "\r\n"); i >= 0 {
			end := start + i
			if data[end] == '\r' {
				skipLF = true
			}
			return end + 1, data[start:end], nil
		}
		if atEOF && len(data) > start {
			return len(data), data[start:], nil
		}
		return start, nil, nil
	}
}

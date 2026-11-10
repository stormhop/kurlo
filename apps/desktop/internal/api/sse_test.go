package api

import (
	"compress/gzip"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestSSEStreamDecodesExplicitContentEncoding(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Encoding", "gzip")
		z := gzip.NewWriter(w)
		_, _ = z.Write([]byte("data: hello\n\n"))
		_ = z.Close()
	}))
	defer server.Close()
	for _, explicit := range []bool{false, true} {
		req := model.HttpRequest{URL: server.URL, SSEDisableReconnect: true}
		if explicit {
			req.Headers = []model.KeyValue{{Key: "Accept-Encoding", Value: "gzip", Enabled: true}}
		}
		em := &testEmitter{}
		runStreamWithEmitter(t.Context(), req, em)
		if len(em.errors) != 0 || len(em.events) != 1 || em.events[0].Data != "hello" {
			t.Errorf("explicit Accept-Encoding=%v: events=%#v errors=%#v", explicit, em.events, em.errors)
		}
	}
}

func TestSSEStreamReportsInvalidCompressedBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write([]byte("invalid compressed body"))
	}))
	defer server.Close()
	em := &testEmitter{}
	runStreamWithEmitter(t.Context(), model.HttpRequest{
		URL: server.URL, Headers: []model.KeyValue{{Key: "Accept-Encoding", Value: "gzip", Enabled: true}},
	}, em)
	if len(em.errors) != 1 || !strings.Contains(em.errors[0].Message, "Stream error") || len(em.events) != 0 {
		t.Fatalf("invalid compression was not reported: events=%#v errors=%#v", em.events, em.errors)
	}
}

func TestSSECompressedStreamClosesOnCancel(t *testing.T) {
	closed := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(closed)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Encoding", "gzip")
		z := gzip.NewWriter(w)
		_, _ = z.Write([]byte("data: hello\n\n"))
		_ = z.Flush()
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	events := 0
	res := newSSEManager(nil).runStreamAttempt(ctx, "compressed", model.HttpRequest{
		URL: server.URL, Headers: []model.KeyValue{{Key: "Accept-Encoding", Value: "gzip", Enabled: true}},
	}, "", noopOpen, func(ev model.SSEEvent) {
		events++
		cancel()
	})
	if events != 1 || res.closeEvent == nil || res.closeEvent.Message != "Disconnected" || res.reconnect {
		t.Fatalf("cancelled compressed stream events=%d result=%#v", events, res)
	}
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled compressed stream kept its HTTP connection open")
	}
}

type testEmitter struct {
	mu     sync.Mutex
	opens  []model.SSEOpenEvent
	events []model.SSEEvent
	closes []model.SSECloseEvent
	errors []model.SSEErrorEvent
}

func (e *testEmitter) open(ev model.SSEOpenEvent) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.opens = append(e.opens, ev)
}
func (e *testEmitter) event(ev model.SSEEvent) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = append(e.events, ev)
}
func (e *testEmitter) close(ev model.SSECloseEvent) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closes = append(e.closes, ev)
}
func (e *testEmitter) error(ev model.SSEErrorEvent) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.errors = append(e.errors, ev)
}

func runStreamWithEmitter(sseCtx context.Context, req model.HttpRequest, em *testEmitter) {
	m := newSSEManager(nil)
	m.runStreamWithCallbacks(sseCtx, "test-session", req,
		func(ev model.SSEOpenEvent) { em.open(ev) },
		func(ev model.SSEEvent) { em.event(ev) },
		func(ev model.SSECloseEvent) { em.close(ev) },
		func(ev model.SSEErrorEvent) { em.error(ev) },
	)
}

func TestSSEStream_BasicEvents(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		f := w.(http.Flusher)

		events := []string{
			"id: 1\nevent: ping\ndata: Server time is 2024-01-01T00:00:00+00:00\n\n",
			"id: 2\nevent: message\ndata: {\"text\": \"hello world\"}\n\n",
			"id: 3\nevent: notification\ndata: Update request received\n\n",
			"id: 4\nevent: error\ndata: Error encountered while processing event\n\n",
			"id: 5\nevent: info\ndata: Keep listening to server updates\n\n",
		}

		for _, ev := range events {
			fmt.Fprint(w, ev)
			f.Flush()
			time.Sleep(5 * time.Millisecond)
		}
	}))
	defer srv.Close()

	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req := model.HttpRequest{
		URL:                   srv.URL,
		EnableSSLVerification: true,
	}
	runStreamWithEmitter(ctx, req, em)

	if len(em.opens) != 1 {
		t.Fatalf("expected 1 open event, got %d", len(em.opens))
	}
	if em.opens[0].StatusCode != 200 {
		t.Errorf("expected status 200, got %d", em.opens[0].StatusCode)
	}
	if em.opens[0].URL != srv.URL {
		t.Errorf("expected URL %q, got %q", srv.URL, em.opens[0].URL)
	}

	if len(em.events) != 5 {
		t.Fatalf("expected 5 events, got %d", len(em.events))
	}

	cases := []struct{ event, data string }{
		{"ping", "Server time is 2024-01-01T00:00:00+00:00"},
		{"message", `{"text": "hello world"}`},
		{"notification", "Update request received"},
		{"error", "Error encountered while processing event"},
		{"info", "Keep listening to server updates"},
	}
	for i, tc := range cases {
		ev := em.events[i]
		if ev.Event != tc.event {
			t.Errorf("event[%d]: expected type %q, got %q", i, tc.event, ev.Event)
		}
		if ev.Data != tc.data {
			t.Errorf("event[%d]: expected data %q, got %q", i, tc.data, ev.Data)
		}
		if ev.ID != fmt.Sprintf("%d", i+1) {
			t.Errorf("event[%d]: expected id %q, got %q", i, fmt.Sprintf("%d", i+1), ev.ID)
		}
		if ev.Timestamp == 0 {
			t.Errorf("event[%d]: timestamp should not be 0", i)
		}
	}

	if len(em.closes) != 1 {
		t.Fatalf("expected 1 close event, got %d", len(em.closes))
	}
	if em.closes[0].Message != "Connection closed by server" {
		t.Errorf("unexpected close message: %q", em.closes[0].Message)
	}
	if len(em.errors) != 0 {
		t.Errorf("expected no errors, got %d: %v", len(em.errors), em.errors)
	}
}

func TestSSEStream_OpenIncludesRequestDuration(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(20 * time.Millisecond)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: ok\n\n")
		w.(http.Flusher).Flush()
	}))
	defer srv.Close()

	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req := model.HttpRequest{
		URL:                   srv.URL,
		EnableSSLVerification: true,
	}
	runStreamWithEmitter(ctx, req, em)

	if len(em.opens) != 1 {
		t.Fatalf("expected 1 open event, got %d", len(em.opens))
	}
	if em.opens[0].Duration <= 0 {
		t.Fatalf("expected SSE open duration to be recorded, got %d", em.opens[0].Duration)
	}
	if em.opens[0].Timings.Total <= 0 {
		t.Fatalf("expected SSE open timings total to be recorded, got %.2f", em.opens[0].Timings.Total)
	}
}

func TestSSEStream_DefaultEventType(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		f := w.(http.Flusher)
		fmt.Fprint(w, "data: no event field here\n\n")
		f.Flush()
	}))
	defer srv.Close()

	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	runStreamWithEmitter(ctx, model.HttpRequest{URL: srv.URL, EnableSSLVerification: true}, em)

	if len(em.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(em.events))
	}
	if em.events[0].Event != "message" {
		t.Errorf("expected default event type %q, got %q", "message", em.events[0].Event)
	}
	if em.events[0].Data != "no event field here" {
		t.Errorf("unexpected data: %q", em.events[0].Data)
	}
}

func TestSSEStream_MultilineData(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		f := w.(http.Flusher)
		fmt.Fprint(w, "event: multi\ndata: line1\ndata: line2\ndata: line3\n\n")
		f.Flush()
	}))
	defer srv.Close()

	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	runStreamWithEmitter(ctx, model.HttpRequest{URL: srv.URL, EnableSSLVerification: true}, em)

	if len(em.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(em.events))
	}
	expected := "line1\nline2\nline3"
	if em.events[0].Data != expected {
		t.Errorf("expected multiline data %q, got %q", expected, em.events[0].Data)
	}
}

func TestSSEStream_LargeDataLine(t *testing.T) {
	large := strings.Repeat("x", 70*1024)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, "data: %s\n\n", large)
		w.(http.Flusher).Flush()
	}))
	defer srv.Close()

	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	runStreamWithEmitter(ctx, model.HttpRequest{URL: srv.URL, EnableSSLVerification: true}, em)

	if len(em.errors) != 0 {
		t.Fatalf("expected no scanner error for a large SSE line, got %v", em.errors)
	}
	if len(em.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(em.events))
	}
	if em.events[0].Data != large {
		t.Fatalf("expected %d bytes, got %d", len(large), len(em.events[0].Data))
	}
}

func TestSSEStream_QueryParams(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: ok\n\n")
		w.(http.Flusher).Flush()
	}))
	defer srv.Close()

	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req := model.HttpRequest{
		URL:                   srv.URL,
		EnableSSLVerification: true,
		Params: []model.KeyValue{
			{Key: "token", Value: "abc123", Enabled: true},
			{Key: "stream", Value: "true", Enabled: true},
		},
	}
	runStreamWithEmitter(ctx, req, em)

	if !strings.Contains(gotQuery, "token=abc123") {
		t.Errorf("expected query to contain token=abc123, got %q", gotQuery)
	}
	if !strings.Contains(gotQuery, "stream=true") {
		t.Errorf("expected query to contain stream=true, got %q", gotQuery)
	}
}

func TestSSEStream_CustomHeaders(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: ok\n\n")
		w.(http.Flusher).Flush()
	}))
	defer srv.Close()

	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req := model.HttpRequest{
		URL:                   srv.URL,
		EnableSSLVerification: true,
		Headers: []model.KeyValue{
			{Key: "Authorization", Value: "Bearer test-token", Enabled: true},
		},
	}
	runStreamWithEmitter(ctx, req, em)

	if gotAuth != "Bearer test-token" {
		t.Errorf("expected Authorization header %q, got %q", "Bearer test-token", gotAuth)
	}
}

func TestSSEStream_AppliesAuthConfigAndCookies(t *testing.T) {
	var gotAuth string
	var gotCookie string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		http.SetCookie(w, &http.Cookie{Name: "server", Value: "stored", Path: "/"})
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: ok\n\n")
		w.(http.Flusher).Flush()
	}))
	defer srv.Close()

	cookieURL, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	jar := newTrackedCookieJar()
	jar.SetCookies(cookieURL, []*http.Cookie{{Name: "session", Value: "abc", Path: "/"}})

	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req := model.HttpRequest{
		URL:                   srv.URL,
		EnableSSLVerification: true,
		Auth:                  model.AuthConfig{Type: "bearer", Token: "from-auth"},
	}
	m := newSSEManager(singleJarRegistry(jar))
	m.runStreamWithCallbacks(ctx, "test-session", req,
		func(ev model.SSEOpenEvent) { em.open(ev) },
		func(ev model.SSEEvent) { em.event(ev) },
		func(ev model.SSECloseEvent) { em.close(ev) },
		func(ev model.SSEErrorEvent) { em.error(ev) },
	)

	if gotAuth != "Bearer from-auth" {
		t.Fatalf("expected bearer auth from AuthConfig, got %q", gotAuth)
	}
	if !strings.Contains(gotCookie, "session=abc") {
		t.Fatalf("expected cookie jar cookie to be sent, got %q", gotCookie)
	}
	cookies := jar.Cookies(cookieURL)
	storedServerCookie := false
	for _, cookie := range cookies {
		if cookie.Name == "server" && cookie.Value == "stored" {
			storedServerCookie = true
		}
	}
	if !storedServerCookie {
		t.Fatalf("expected SSE response cookie to be stored, got %#v", cookies)
	}
}

func TestSSEStream_AppliesAPIKeyQueryAuth(t *testing.T) {
	var gotQuery url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: ok\n\n")
		w.(http.Flusher).Flush()
	}))
	defer srv.Close()

	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req := model.HttpRequest{
		URL:                    srv.URL,
		EnableSSLVerification:  true,
		EncodeURLAutomatically: true,
		Auth:                   model.AuthConfig{Type: "apikey", KeyName: "api_key", KeyValue: "secret", KeyIn: "query"},
	}
	runStreamWithEmitter(ctx, req, em)

	if gotQuery.Get("api_key") != "secret" {
		t.Fatalf("expected API key query auth, got %q", gotQuery.Encode())
	}
}

func TestSSEStream_Disconnect(t *testing.T) {
	connected := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(connected)
		<-r.Context().Done()
	}))
	defer srv.Close()

	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)

	go func() {
		<-connected
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	runStreamWithEmitter(ctx, model.HttpRequest{URL: srv.URL, EnableSSLVerification: true}, em)

	if len(em.closes) != 1 {
		t.Fatalf("expected 1 close event after disconnect, got %d", len(em.closes))
	}
	if em.closes[0].Message != "Disconnected" {
		t.Errorf("expected close message %q, got %q", "Disconnected", em.closes[0].Message)
	}
}

func TestSSEStream_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	runStreamWithEmitter(ctx, model.HttpRequest{URL: srv.URL, EnableSSLVerification: true}, em)

	if len(em.opens) != 1 {
		t.Fatalf("expected 1 open event, got %d", len(em.opens))
	}
	if em.opens[0].StatusCode != 500 {
		t.Errorf("expected status 500, got %d", em.opens[0].StatusCode)
	}
}

func TestSSEStream_InvalidURL(t *testing.T) {
	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	runStreamWithEmitter(ctx, model.HttpRequest{URL: "http://localhost:0/no-such-server", EnableSSLVerification: true}, em)

	if len(em.errors) == 0 {
		t.Error("expected at least 1 error event for unreachable server")
	}
}

func noopOpen(model.SSEOpenEvent) {}
func noopEvent(model.SSEEvent)    {}

func TestSSEReconnect_LastEventIDResent(t *testing.T) {
	var mu sync.Mutex
	requests := 0
	secondLastEventID := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		n := requests
		if n == 2 {
			secondLastEventID = r.Header.Get("Last-Event-ID")
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if n == 1 {
			fmt.Fprint(w, "id: 42\ndata: hello\n\n")
		} else {
			fmt.Fprint(w, "data: world\n\n")
		}
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}))
	defer srv.Close()

	m := newSSEManager(nil)
	req := model.HttpRequest{URL: srv.URL, EnableSSLVerification: true}

	res1 := m.runStreamAttempt(context.Background(), "s", req, "", noopOpen, noopEvent)
	if !res1.reconnect {
		t.Fatal("expected reconnect=true after a 200 stream closed by the server")
	}
	if res1.lastEventID != "42" {
		t.Fatalf("lastEventID = %q, want 42", res1.lastEventID)
	}

	m.runStreamAttempt(context.Background(), "s", req, res1.lastEventID, noopOpen, noopEvent)
	mu.Lock()
	got := secondLastEventID
	mu.Unlock()
	if got != "42" {
		t.Fatalf("second request Last-Event-ID = %q, want 42", got)
	}
}

func TestSSEReconnect_RespectsRetryField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "retry: 4500\ndata: x\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}))
	defer srv.Close()

	m := newSSEManager(nil)
	res := m.runStreamAttempt(context.Background(), "s", model.HttpRequest{URL: srv.URL, EnableSSLVerification: true}, "", noopOpen, noopEvent)
	if res.retry != 4500*time.Millisecond {
		t.Fatalf("retry = %v, want 4.5s", res.retry)
	}
}

func TestSSEReconnect_NoReconnectOnUserDisconnect(t *testing.T) {
	connected := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		close(connected)
		<-r.Context().Done()
	}))
	defer srv.Close()

	m := newSSEManager(nil)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-connected
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	res := m.runStreamAttempt(ctx, "s", model.HttpRequest{URL: srv.URL, EnableSSLVerification: true}, "", noopOpen, noopEvent)
	if res.reconnect {
		t.Error("must not reconnect after a user-initiated disconnect")
	}
	if res.closeEvent == nil || res.closeEvent.Message != "Disconnected" {
		t.Errorf("expected a Disconnected close event, got %+v", res.closeEvent)
	}
}

func TestSSEReconnectDelay(t *testing.T) {
	if d := sseReconnectDelay(model.HttpRequest{SSEReconnectIntervalMs: 1000}, 5*time.Second); d != time.Second {
		t.Errorf("override delay = %v, want 1s", d)
	}
	if d := sseReconnectDelay(model.HttpRequest{}, 5*time.Second); d != 5*time.Second {
		t.Errorf("server-retry delay = %v, want 5s", d)
	}
	if d := sseReconnectDelay(model.HttpRequest{}, 0); d != 3*time.Second {
		t.Errorf("default delay = %v, want 3s", d)
	}
}

func sseEventsFor(t *testing.T, payload string) []model.SSEEvent {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, payload)
	}))
	defer srv.Close()
	em := &testEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	runStreamWithEmitter(ctx, model.HttpRequest{URL: srv.URL, EnableSSLVerification: true}, em)
	return em.events
}

func TestSSEStream_FollowsTheEventStreamSpec(t *testing.T) {
	cases := map[string]struct {
		payload string
		want    []model.SSEEvent
	}{
		"empty data still dispatches":    {"data:\n\ndata\n\n", []model.SSEEvent{{Event: "message", Data: ""}, {Event: "message", Data: ""}}},
		"blank data line adds a newline": {"data: a\ndata:\ndata: b\n\n", []model.SSEEvent{{Event: "message", Data: "a\n\nb"}}},
		"id carries over":                {"id: 7\ndata: a\n\ndata: b\n\nid:\ndata: c\n\n", []model.SSEEvent{{ID: "7", Event: "message", Data: "a"}, {ID: "7", Event: "message", Data: "b"}, {ID: "", Event: "message", Data: "c"}}},
		"bare CR line endings":           {"event: x\rdata: a\r\rdata: b\r\n\r\n", []model.SSEEvent{{Event: "x", Data: "a"}, {Event: "message", Data: "b"}}},
		"leading BOM":                    {"\uFEFFdata: first\n\n", []model.SSEEvent{{Event: "message", Data: "first"}}},
		"value without space":            {"data:tight\n\n", []model.SSEEvent{{Event: "message", Data: "tight"}}},
	}
	for name, tc := range cases {
		got := sseEventsFor(t, tc.payload)
		if len(got) != len(tc.want) {
			t.Errorf("%s: got %d events %+v, want %d", name, len(got), got, len(tc.want))
			continue
		}
		for i := range got {
			if got[i].ID != tc.want[i].ID || got[i].Event != tc.want[i].Event || got[i].Data != tc.want[i].Data {
				t.Errorf("%s: event %d = %+v, want %+v", name, i, got[i], tc.want[i])
			}
		}
	}
}

func TestSSELineSplitterHandlesACarriageReturnAtTheChunkEdge(t *testing.T) {
	split := newSSELineSplitter()
	advance, token, _ := split([]byte("a\r"), false)
	if advance != 2 || string(token) != "a" {
		t.Fatalf("expected the line before a trailing CR at once, got advance=%d token=%q", advance, token)
	}
	advance, token, _ = split([]byte("\nb\n"), false)
	if advance != 3 || string(token) != "b" {
		t.Fatalf("expected the LF of a split CRLF to be skipped, got advance=%d token=%q", advance, token)
	}
	advance, token, _ = split([]byte("\n"), false)
	if advance != 1 || string(token) != "" || token == nil {
		t.Fatalf("expected a lone LF to be an empty line again, got advance=%d token=%q", advance, token)
	}
}

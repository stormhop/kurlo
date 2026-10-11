package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const hundredMB = 100 * 1024 * 1024

func bigTextBody(size int) string {
	line := `{"id":1234567,"name":"Заказ 🚀","note":"lorem ipsum dolor sit amet"}` + "\n"
	return strings.Repeat(line, size/len(line)+1)[:size]
}

func bigRequest(url string) model.HttpRequest {
	return model.HttpRequest{
		RequestID: "req-big", Method: http.MethodPost, URL: url,
		FollowRedirects: true, TimeoutMs: 120000, HTTPVersion: "auto",
		EnableSSLVerification: true, MaxRedirects: 10,
	}
}

type allocMeter struct {
	start runtime.MemStats
	began time.Time
}

func startAllocMeter() *allocMeter {
	runtime.GC()
	m := &allocMeter{began: time.Now()}
	runtime.ReadMemStats(&m.start)
	return m
}

func (m *allocMeter) report(t *testing.T, label string) uint64 {
	t.Helper()
	var end runtime.MemStats
	runtime.ReadMemStats(&end)
	allocated := end.TotalAlloc - m.start.TotalAlloc
	t.Logf("%-34s %8v  allocated %4d MB", label, time.Since(m.began).Round(time.Millisecond), allocated>>20)
	return allocated
}

func hashingServer(t *testing.T) (*httptest.Server, chan string) {
	t.Helper()
	sums := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hash := sha256.New()
		n, _ := io.Copy(hash, r.Body)
		sums <- fmt.Sprintf("%d:%x", n, hash.Sum(nil))
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	return server, sums
}

func sumOf(data []byte) string {
	return fmt.Sprintf("%d:%x", len(data), sha256.Sum256(data))
}

func TestHundredMegabyteTextRequestBodyArrivesIntact(t *testing.T) {
	if testing.Short() {
		t.Skip("sends 100 MB")
	}
	server, sums := hashingServer(t)
	body := bigTextBody(hundredMB)
	req := bigRequest(server.URL)
	req.BodyType = "json"
	req.Body = body

	meter := startAllocMeter()
	resp := NewApp().SendRequest(req)
	allocated := meter.report(t, "send 100 MB text body")
	if resp.Error != "" {
		t.Fatalf("send failed: %s", resp.Error)
	}
	if got, want := <-sums, sumOf([]byte(body)); got != want {
		t.Fatalf("server received %s, want %s", got, want)
	}
	if allocated > 6*hundredMB {
		t.Errorf("sending a 100 MB body allocated %d MB", allocated>>20)
	}
}

func TestHundredMegabyteFileRequestBodyStreams(t *testing.T) {
	if testing.Short() {
		t.Skip("sends 100 MB")
	}
	server, sums := hashingServer(t)
	path := filepath.Join(t.TempDir(), "upload.bin")
	data := bytes.Repeat([]byte{0, 1, 2, 250, 251, 252, 253, 254, 255}, hundredMB/9+1)[:hundredMB]
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	want := sumOf(data)
	data = nil
	req := bigRequest(server.URL)
	req.BodyType = "binary"
	req.BodyFilePath = path

	meter := startAllocMeter()
	resp := NewApp().SendRequest(req)
	allocated := meter.report(t, "send 100 MB file body")
	if resp.Error != "" {
		t.Fatalf("send failed: %s", resp.Error)
	}
	if got := <-sums; got != want {
		t.Fatalf("server received %s, want %s", got, want)
	}
	if allocated > 32<<20 {
		t.Errorf("file upload is buffered in memory: allocated %d MB", allocated>>20)
	}
}

func responseServer(t *testing.T, body []byte, contentType string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestHundredMegabyteResponseReachesTheWindow(t *testing.T) {
	if testing.Short() {
		t.Skip("receives 100 MB")
	}
	body := []byte(bigTextBody(hundredMB))
	server := responseServer(t, body, "application/json")
	req := bigRequest(server.URL)
	req.Method = http.MethodGet

	meter := startAllocMeter()
	resp := NewApp().SendRequest(req)
	meter.report(t, "receive 100 MB text response")
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if sumOf([]byte(resp.Body)) != sumOf(body) {
		t.Fatal("response body changed on the way")
	}

	meter = startAllocMeter()
	encoded, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	meter.report(t, "encode for the bridge")
	t.Logf("bridge payload %d MB for a %d MB body", len(encoded)>>20, len(body)>>20)
	var decoded model.HttpResponse
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Body != resp.Body {
		t.Fatal("text body changed across the bridge encoding")
	}
}

func TestResponseOverTheLimitIsTruncatedWithAClearMessage(t *testing.T) {
	if testing.Short() {
		t.Skip("receives 100 MB")
	}
	body := []byte(bigTextBody(hundredMB + 1024))
	server := responseServer(t, body, "text/plain")
	req := bigRequest(server.URL)
	req.Method = http.MethodGet

	resp := NewApp().SendRequest(req)
	if len(resp.Body) != hundredMB {
		t.Fatalf("got %d bytes, want the first %d", len(resp.Body), hundredMB)
	}
	if !strings.Contains(resp.Error, "truncated") {
		t.Fatalf("missing truncation message: %q", resp.Error)
	}
	if resp.Size != int64(len(body)) {
		t.Fatalf("size %d, want the full %d", resp.Size, len(body))
	}
}

func TestHundredMegabyteBinaryResponseBridgeCost(t *testing.T) {
	if testing.Short() {
		t.Skip("receives 100 MB")
	}
	body := bytes.Repeat([]byte{0, 1, 2, 0x80, 0xff, 0xfe, 'P', 'K'}, hundredMB/8)
	server := responseServer(t, body, "application/octet-stream")
	req := bigRequest(server.URL)
	req.Method = http.MethodGet

	app := NewApp()
	meter := startAllocMeter()
	resp := app.SendRequest(req)
	meter.report(t, "receive 100 MB binary response")
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if !resp.BodyIsBinary {
		t.Fatal("binary body was not flagged")
	}
	if resp.Body != "" || !resp.BodyOmitted {
		t.Fatalf("binary body still goes to the window: %d bytes, omitted=%v", len(resp.Body), resp.BodyOmitted)
	}
	encoded, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("bridge payload %d KB for a %d MB binary body", len(encoded)>>10, len(body)>>20)

	saved := filepath.Join(t.TempDir(), "saved.bin")
	cached, ok := app.binaryBodies.get(req.RequestID)
	if !ok {
		t.Fatal("binary body was not kept for saving")
	}
	if err := writeResponseBodyFile(saved, cached.data); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(saved)
	if err != nil {
		t.Fatal(err)
	}
	if sumOf(written) != sumOf(body) {
		t.Fatal("saved file differs from the bytes the server sent")
	}
}

func TestBinaryResponseCacheKeepsOnlyRecentBodies(t *testing.T) {
	cache := newBinaryResponseCache()
	for i := 0; i < binaryResponseCacheSize+3; i++ {
		cache.put(fmt.Sprintf("req-%d", i), binaryResponseBody{data: []byte{byte(i)}})
	}
	if _, ok := cache.get("req-0"); ok {
		t.Fatal("oldest body should be evicted")
	}
	if body, ok := cache.get(fmt.Sprintf("req-%d", binaryResponseCacheSize+2)); !ok || body.data[0] != byte(binaryResponseCacheSize+2) {
		t.Fatal("newest body missing")
	}
	app := &App{binaryBodies: cache}
	app.keepBinaryBodyOutOfTheWindow("req-6", model.HttpResponse{Body: "text"})
	if _, ok := cache.get("req-6"); ok {
		t.Fatal("a text response must drop the stale binary body for that request")
	}
}

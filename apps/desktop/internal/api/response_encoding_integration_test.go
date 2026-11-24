package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestSendRequestDecodesBrotli(t *testing.T) {
	const payload = `{"error":"unauthorized"}`
	var compressed bytes.Buffer
	bw := brotli.NewWriter(&compressed)
	if _, err := bw.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := bw.Close(); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "br")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write(compressed.Bytes())
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Headers = []model.KeyValue{{Enabled: true, Key: "Accept-Encoding", Value: "gzip, deflate, br, zstd"}}

	resp := NewApp().SendRequest(req)
	if resp.Body != payload {
		t.Fatalf("brotli body not decoded: got %q, want %q", resp.Body, payload)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}

func TestSendRequestDecodesZstd(t *testing.T) {
	const payload = `{"ok":true,"data":[1,2,3]}`
	var compressed bytes.Buffer
	zw, err := zstd.NewWriter(&compressed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := zw.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "zstd")
		_, _ = w.Write(compressed.Bytes())
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL)
	req.Headers = []model.KeyValue{{Enabled: true, Key: "Accept-Encoding", Value: "zstd"}}

	resp := NewApp().SendRequest(req)
	if resp.Body != payload {
		t.Fatalf("zstd body not decoded: got %q, want %q", resp.Body, payload)
	}
}

func TestSendRequestReportsHeaderAndEncodedBodySizes(t *testing.T) {
	payload := bytes.Repeat([]byte(`{"name":"kurlo","ok":true},`), 64)
	var compressed bytes.Buffer
	bw := brotli.NewWriter(&compressed)
	if _, err := bw.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := bw.Close(); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/plain" {
			_, _ = w.Write(payload)
			return
		}
		w.Header().Set("Content-Encoding", "br")
		_, _ = w.Write(compressed.Bytes())
	}))
	defer server.Close()

	req := defaultBrowserReq(server.URL + "/br")
	req.Headers = []model.KeyValue{{Enabled: true, Key: "Accept-Encoding", Value: "br"}}
	resp := NewApp().SendRequest(req)
	if resp.Size != int64(len(payload)) {
		t.Fatalf("size = %d, want decoded %d", resp.Size, len(payload))
	}
	if resp.EncodedBodySize != int64(compressed.Len()) {
		t.Fatalf("encoded size = %d, want %d", resp.EncodedBodySize, compressed.Len())
	}

	plain := NewApp().SendRequest(defaultBrowserReq(server.URL + "/plain"))
	if plain.EncodedBodySize != 0 {
		t.Fatalf("encoded size for an unencoded body = %d, want 0", plain.EncodedBodySize)
	}
	want := int64(len("HTTP/1.1 200 OK\r\n") + 2)
	for _, header := range plain.Headers {
		want += int64(len(header.Key) + 2 + len(header.Value) + 2)
	}
	if plain.HeadersSize != want {
		t.Fatalf("headers size = %d, want %d", plain.HeadersSize, want)
	}
}

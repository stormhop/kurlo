package api

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"net/http"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

const sampleBody = `{"error":"unauthorized","code":401,"message":"token expired"}`

func gzipBytes(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func brotliBytes(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := brotli.NewWriter(&buf)
	if _, err := w.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func zstdBytes(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := zstd.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func zlibBytes(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	if _, err := w.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func rawDeflateBytes(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := flate.NewWriter(&buf, flate.DefaultCompression)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func respWithEncoding(encoding string) *http.Response {
	h := http.Header{}
	if encoding != "" {
		h.Set("Content-Encoding", encoding)
	}
	return &http.Response{Header: h}
}

func TestDecodeResponseBody(t *testing.T) {
	tests := []struct {
		name     string
		encoding string
		body     []byte
	}{
		{"gzip", "gzip", gzipBytes(t, sampleBody)},
		{"gzip case-insensitive", "GZIP", gzipBytes(t, sampleBody)},
		{"brotli", "br", brotliBytes(t, sampleBody)},
		{"zstd", "zstd", zstdBytes(t, sampleBody)},
		{"deflate zlib", "deflate", zlibBytes(t, sampleBody)},
		{"deflate raw", "deflate", rawDeflateBytes(t, sampleBody)},
		{"chained gzip then br", "gzip, br", brotliBytes(t, string(gzipBytes(t, sampleBody)))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decoded, ok := decodeResponseBody(tt.body, respWithEncoding(tt.encoding))
			if !ok {
				t.Fatalf("expected decode to succeed for %s", tt.encoding)
			}
			if string(decoded) != sampleBody {
				t.Fatalf("got %q, want %q", decoded, sampleBody)
			}
		})
	}
}

func TestDecodeResponseBodyPassthrough(t *testing.T) {
	plain := []byte(sampleBody)
	if decoded, ok := decodeResponseBody(plain, respWithEncoding("")); ok || string(decoded) != sampleBody {
		t.Fatalf("plain body should pass through unchanged, ok=%v", ok)
	}

	if _, ok := decodeResponseBody(plain, respWithEncoding("identity")); ok {
		t.Fatal("identity should not report a decode")
	}

	if decoded, ok := decodeResponseBody(plain, respWithEncoding("magic-v9")); ok || string(decoded) != sampleBody {
		t.Fatalf("unknown encoding should pass through, ok=%v", ok)
	}
}

func TestDecodeResponseBodyAlreadyUncompressed(t *testing.T) {
	resp := respWithEncoding("gzip")
	resp.Uncompressed = true
	plain := []byte(sampleBody)
	if _, ok := decodeResponseBody(plain, resp); ok {
		t.Fatal("Uncompressed responses must not be decoded again")
	}
}

func TestDecodeResponseBodyGarbage(t *testing.T) {
	garbage := []byte("this is not gzip at all, just plain text")
	decoded, ok := decodeResponseBody(garbage, respWithEncoding("gzip"))
	if ok {
		t.Fatal("invalid stream must not report success")
	}
	if !bytes.Equal(decoded, garbage) {
		t.Fatal("invalid stream must return original bytes untouched")
	}
}

func TestReadAllCappedRejectsBomb(t *testing.T) {
	huge := strings.Repeat("A", maxDecodedResponseBodySize+1024)
	bomb := gzipBytes(t, huge)
	if _, ok := decodeResponseBody(bomb, respWithEncoding("gzip")); ok {
		t.Fatal("over-cap decompression must be rejected")
	}
}

func TestDeflateRejectsOversizedZlibStream(t *testing.T) {
	body := strings.Repeat("A", maxDecodedResponseBodySize+1)
	compressed := zlibBytes(t, body)
	if _, ok := decodeResponseBody(compressed, respWithEncoding("deflate")); ok {
		t.Fatal("oversized zlib stream must not fall back to raw deflate")
	}
}

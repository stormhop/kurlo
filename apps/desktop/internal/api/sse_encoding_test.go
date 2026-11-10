package api

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

func encodeSSEFixture(t *testing.T, data []byte, encodings ...string) []byte {
	t.Helper()
	for _, encoding := range encodings {
		var buffer bytes.Buffer
		var writer io.WriteCloser
		var err error
		switch encoding {
		case "gzip":
			writer = gzip.NewWriter(&buffer)
		case "br":
			writer = brotli.NewWriter(&buffer)
		case "zstd":
			writer, err = zstd.NewWriter(&buffer)
		case "zlib":
			writer = zlib.NewWriter(&buffer)
		case "raw-deflate":
			writer, err = flate.NewWriter(&buffer, flate.DefaultCompression)
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(data); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		data = buffer.Bytes()
	}
	return data
}

func TestSSEBodyDecodesSupportedEncodings(t *testing.T) {
	payload := []byte("id: 1\ndata: compressed event\n\n")
	for _, tc := range []struct {
		name      string
		header    string
		encodings []string
	}{
		{name: "identity", header: "identity"},
		{name: "gzip", header: "gzip", encodings: []string{"gzip"}},
		{name: "brotli", header: "br", encodings: []string{"br"}},
		{name: "zstd", header: "zstd", encodings: []string{"zstd"}},
		{name: "zlib deflate", header: "deflate", encodings: []string{"zlib"}},
		{name: "raw deflate", header: "deflate", encodings: []string{"raw-deflate"}},
		{name: "stacked", header: "gzip, br", encodings: []string{"gzip", "br"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := &http.Response{Header: http.Header{"Content-Encoding": []string{tc.header}}, Body: io.NopCloser(bytes.NewReader(encodeSSEFixture(t, payload, tc.encodings...)))}
			reader, closeDecoders, err := decodeSSEBody(resp)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDecoders()
			got, err := io.ReadAll(reader)
			if err != nil || !bytes.Equal(got, payload) {
				t.Fatalf("decoded=%q error=%v", got, err)
			}
		})
	}
}

func TestSSEBodyReportsUnsupportedAndCorruptEncodings(t *testing.T) {
	compressed := encodeSSEFixture(t, []byte("data: event\n\n"), "gzip")
	for _, tc := range []struct {
		name   string
		header string
		data   []byte
	}{
		{name: "unknown", header: "unknown", data: []byte("data: event\n\n")},
		{name: "invalid gzip header", header: "gzip", data: []byte("invalid gzip body")},
		{name: "truncated gzip", header: "gzip", data: compressed[:len(compressed)-4]},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := &http.Response{Header: http.Header{"Content-Encoding": []string{tc.header}}, Body: io.NopCloser(bytes.NewReader(tc.data))}
			reader, closeDecoders, err := decodeSSEBody(resp)
			defer closeDecoders()
			if err == nil {
				_, err = io.ReadAll(reader)
			}
			if err == nil {
				t.Fatal("invalid encoding was accepted")
			}
		})
	}
}

func TestSSEBodyKeepsAutomaticallyDecodedResponses(t *testing.T) {
	resp := &http.Response{Uncompressed: true, Header: http.Header{"Content-Encoding": []string{"gzip"}}, Body: io.NopCloser(strings.NewReader("data: decoded\n\n"))}
	reader, closeDecoders, err := decodeSSEBody(resp)
	defer closeDecoders()
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(reader)
	if err != nil || string(got) != "data: decoded\n\n" {
		t.Fatalf("body=%q error=%v", got, err)
	}
}

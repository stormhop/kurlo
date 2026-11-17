package api

import (
	"bytes"
	"io"
	"net/http"
	"runtime"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

func TestInterruptedZstdDownloadReleasesDecoderGoroutines(t *testing.T) {
	var compressed bytes.Buffer
	writer, err := zstd.NewWriter(&compressed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(bytes.Repeat([]byte("kurlo "), 1<<20)); err != nil {
		t.Fatal(err)
	}
	_ = writer.Close()
	resp := &http.Response{Header: http.Header{"Content-Encoding": []string{"zstd"}}}

	settle := func() int {
		runtime.GC()
		time.Sleep(50 * time.Millisecond)
		return runtime.NumGoroutine()
	}
	before := settle()
	for range 20 {
		reader, closeDecoders := newDecodingReader(bytes.NewReader(compressed.Bytes()), resp)
		if _, err := io.CopyN(io.Discard, reader, 4096); err != nil {
			t.Fatal(err)
		}
		closeDecoders()
	}
	deadline := time.Now().Add(2 * time.Second)
	for settle() > before+2 {
		if time.Now().After(deadline) {
			t.Fatalf("decoder goroutines kept running: %d before, %d after", before, runtime.NumGoroutine())
		}
	}
}

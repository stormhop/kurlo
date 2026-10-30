package api

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

const maxDecodedResponseBodySize = 64 * 1024 * 1024

func decodeResponseBody(body []byte, resp *http.Response) ([]byte, bool) {
	if resp.Uncompressed {
		return body, false
	}
	encoding := resp.Header.Get("Content-Encoding")
	if encoding == "" || len(body) == 0 {
		return body, false
	}

	encodings := strings.Split(encoding, ",")
	current := body
	decodedAny := false
	for i := len(encodings) - 1; i >= 0; i-- {
		name := strings.ToLower(strings.TrimSpace(encodings[i]))
		if name == "" || name == "identity" {
			continue
		}
		decoded, ok := decodeOne(name, current)
		if !ok {
			return body, false
		}
		current = decoded
		decodedAny = true
	}
	if !decodedAny {
		return body, false
	}
	return current, true
}

func decodeOne(name string, data []byte) ([]byte, bool) {
	switch name {
	case "gzip", "x-gzip":
		r, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, false
		}
		defer r.Close()
		return readAllCapped(r)
	case "br":
		return readAllCapped(brotli.NewReader(bytes.NewReader(data)))
	case "zstd":
		r, err := zstd.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, false
		}
		defer r.Close()
		return readAllCapped(r)
	case "deflate":
		if r, err := zlib.NewReader(bytes.NewReader(data)); err == nil {
			defer r.Close()
			return readAllCapped(r)
		}
		r := flate.NewReader(bytes.NewReader(data))
		defer r.Close()
		return readAllCapped(r)
	default:
		return nil, false
	}
}

func readAllCapped(r io.Reader) ([]byte, bool) {
	out, err := io.ReadAll(io.LimitReader(r, maxDecodedResponseBodySize+1))
	if err != nil {
		return nil, false
	}
	if int64(len(out)) > maxDecodedResponseBodySize {
		return nil, false
	}
	return out, true
}

const maxStreamedDecodedBodySize int64 = 1 << 30

var errDecodedBodyTooLarge = errors.New("decompressed response exceeds 1 GB")

func newDecodingReader(body io.Reader, resp *http.Response) io.Reader {
	if resp.Uncompressed {
		return body
	}
	encoding := resp.Header.Get("Content-Encoding")
	if encoding == "" {
		return body
	}
	encodings := strings.Split(encoding, ",")
	current := body
	for i := len(encodings) - 1; i >= 0; i-- {
		name := strings.ToLower(strings.TrimSpace(encodings[i]))
		if name == "" || name == "identity" {
			continue
		}
		next, ok := decodeStream(name, current)
		if !ok {
			return next
		}
		current = next
	}
	return current
}

type sniffReader struct {
	src      io.Reader
	buf      bytes.Buffer
	sniffing bool
}

func newSniffReader(src io.Reader) *sniffReader {
	return &sniffReader{src: src, sniffing: true}
}

func (s *sniffReader) Read(p []byte) (int, error) {
	n, err := s.src.Read(p)
	if s.sniffing && n > 0 {
		s.buf.Write(p[:n])
	}
	return n, err
}

func (s *sniffReader) stop() {
	s.sniffing = false
	s.buf.Reset()
}

func (s *sniffReader) rewind() io.Reader {
	return io.MultiReader(bytes.NewReader(s.buf.Bytes()), s.src)
}

func decodeStream(name string, r io.Reader) (io.Reader, bool) {
	sniff := newSniffReader(r)
	switch name {
	case "gzip", "x-gzip":
		zr, err := gzip.NewReader(sniff)
		if err != nil {
			return sniff.rewind(), false
		}
		sniff.stop()
		return cappedStream(zr), true
	case "br":
		sniff.stop()
		return cappedStream(brotli.NewReader(r)), true
	case "zstd":
		zr, err := zstd.NewReader(sniff)
		if err != nil {
			return sniff.rewind(), false
		}
		sniff.stop()
		return cappedStream(zr.IOReadCloser()), true
	case "deflate":
		if zr, err := zlib.NewReader(sniff); err == nil {
			sniff.stop()
			return cappedStream(zr), true
		}
		return cappedStream(flate.NewReader(sniff.rewind())), true
	default:
		return sniff.rewind(), false
	}
}

func cappedStream(r io.Reader) io.Reader {
	return &cappedReader{r: r, remaining: maxStreamedDecodedBodySize}
}

type cappedReader struct {
	r         io.Reader
	remaining int64
}

func (c *cappedReader) Read(p []byte) (int, error) {
	if c.remaining <= 0 {
		return 0, errDecodedBodyTooLarge
	}
	if int64(len(p)) > c.remaining {
		p = p[:c.remaining]
	}
	n, err := c.r.Read(p)
	c.remaining -= int64(n)
	return n, err
}

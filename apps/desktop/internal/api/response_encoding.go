package api

import (
	"bufio"
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

func newDecodingReader(body io.Reader, resp *http.Response) (io.Reader, func()) {
	reader, closeDecoders, _ := responseDecodingReader(body, resp)
	return reader, closeDecoders
}

func responseDecodingReader(body io.Reader, resp *http.Response) (io.Reader, func(), bool) {
	var closers []io.Closer
	closeDecoders := func() {
		for i := len(closers) - 1; i >= 0; i-- {
			_ = closers[i].Close()
		}
	}
	if resp.Uncompressed {
		return body, closeDecoders, false
	}
	encoding := resp.Header.Get("Content-Encoding")
	if encoding == "" {
		return body, closeDecoders, false
	}
	encodings := strings.Split(encoding, ",")
	decoded := false
	current := body
	for i := len(encodings) - 1; i >= 0; i-- {
		name := strings.ToLower(strings.TrimSpace(encodings[i]))
		if name == "" || name == "identity" {
			continue
		}
		next, closer, ok := decodeStream(name, current)
		if closer != nil {
			closers = append(closers, closer)
		}
		if !ok {
			return next, closeDecoders, false
		}
		decoded = true
		current = next
	}
	return current, closeDecoders, decoded
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

var zstdMagic = []byte{0x28, 0xb5, 0x2f, 0xfd}

func decodeStream(name string, r io.Reader) (io.Reader, io.Closer, bool) {
	sniff := newSniffReader(r)
	switch name {
	case "gzip", "x-gzip":
		zr, err := gzip.NewReader(sniff)
		if err != nil {
			return sniff.rewind(), nil, false
		}
		sniff.stop()
		return cappedStream(zr), zr, true
	case "br":
		sniff.stop()
		return cappedStream(brotli.NewReader(r)), nil, true
	case "zstd":
		buffered := bufio.NewReader(r)
		magic, _ := buffered.Peek(len(zstdMagic))
		if !bytes.Equal(magic, zstdMagic) {
			return buffered, nil, false
		}
		zr, err := zstd.NewReader(buffered)
		if err != nil {
			return buffered, nil, false
		}
		decoder := zr.IOReadCloser()
		return cappedStream(decoder), decoder, true
	case "deflate":
		if zr, err := zlib.NewReader(sniff); err == nil {
			sniff.stop()
			return cappedStream(zr), zr, true
		}
		fr := flate.NewReader(sniff.rewind())
		return cappedStream(fr), fr, true
	default:
		return sniff.rewind(), nil, false
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

func responseHeadersSize(resp *http.Response) int64 {
	size := int64(len(resp.Proto) + 1 + len(resp.Status) + 2)
	for key, values := range resp.Header {
		for _, value := range values {
			size += int64(len(key) + 2 + len(value) + 2)
		}
	}
	return size + 2
}

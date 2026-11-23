package proxycapture

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

type Frame struct {
	Direction string `json:"direction"`
	Kind      string `json:"kind"`
	Text      string `json:"text"`
	Size      int64  `json:"size"`
}

func websocketFrames(data []byte, dir string) []Frame {
	frames, _ := websocketFramesFrom(data, dir)
	return frames
}

func websocketFramesFrom(data []byte, dir string) ([]Frame, int) {
	frames := []Frame{}
	consumed := 0
	for len(data)-consumed >= 2 && len(frames) < 48 {
		wireFrame := data[consumed:]
		first, second := wireFrame[0], wireFrame[1]
		off := 2
		n := uint64(second & 127)
		switch n {
		case 126:
			if len(wireFrame) < 4 {
				return frames, consumed
			}
			n = uint64(binary.BigEndian.Uint16(wireFrame[2:4]))
			off = 4
		case 127:
			if len(wireFrame) < 10 {
				return frames, consumed
			}
			n = binary.BigEndian.Uint64(wireFrame[2:10])
			off = 10
		}
		var mask []byte
		if second&128 != 0 {
			if len(wireFrame) < off+4 {
				return frames, consumed
			}
			mask = wireFrame[off : off+4]
			off += 4
		}
		if n > uint64(len(wireFrame)-off) {
			return frames, consumed
		}
		kind := map[byte]string{0: "Continuation", 1: "Text", 2: "Binary", 8: "Close", 9: "Ping", 10: "Pong"}[first&15]
		if kind == "" {
			kind = "Reserved"
		}
		captured := Frame{Direction: dir, Kind: kind, Size: int64(n)}
		if first&64 != 0 {
			captured.Kind += " (compressed)"
		} else if kind == "Text" || kind == "Continuation" {
			b := bytes.Clone(data[consumed+off : consumed+off+min(int(n), 1024)])
			if mask != nil {
				for i := range b {
					b[i] ^= mask[i%4]
				}
			}
			captured.Text = strings.ToValidUTF8(string(b), "�")
		}
		frames = append(frames, captured)
		consumed += off + int(n)
	}
	return frames, consumed
}
func eventFrames(b []byte) []Frame {
	text := strings.ReplaceAll(strings.ReplaceAll(strings.TrimPrefix(string(b), "\uFEFF"), "\r\n", "\n"), "\r", "\n")
	items := strings.Split(text, "\n\n")
	out := []Frame{}
	for _, item := range items[:len(items)-1] {
		kind := "message"
		var data []string
		for _, line := range strings.Split(item, "\n") {
			key, value, _ := strings.Cut(line, ":")
			value = strings.TrimPrefix(value, " ")
			switch key {
			case "event":
				kind = value
				if kind == "" {
					kind = "message"
				}
			case "data":
				data = append(data, value)
			}
		}
		if len(data) == 0 {
			continue
		}
		value := strings.Join(data, "\n")
		out = append(out, Frame{Direction: "Received", Kind: kind, Text: strings.ToValidUTF8(value[:min(len(value), 1024)], "�"), Size: int64(len(value))})
		if len(out) == 48 {
			break
		}
	}
	return out
}

type streamTap struct {
	mu             sync.Mutex
	base           Exchange
	sent, received bytes.Buffer
	decoded        bytes.Buffer
	frames         []Frame
	sentParsed     int
	receivedParsed int
	encodedSSE     bool
	start          time.Time
	timer          *time.Timer
	finished       bool
	publish        func(Exchange) int64
}

func (t *streamTap) write(b []byte, sent bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.finished {
		return
	}
	buf := &t.received
	if sent {
		buf = &t.sent
		t.base.Entry.Sent += int64(len(b))
	} else {
		t.base.Entry.Received += int64(len(b))
	}
	if room := previewLimit - buf.Len(); room > 0 {
		buf.Write(b[:min(room, len(b))])
	}
	if t.base.Entry.Stream == "WebSocket" && len(t.frames) < 48 {
		parsed := &t.receivedParsed
		direction := "Received"
		if sent {
			parsed = &t.sentParsed
			direction = "Sent"
		}
		frames, consumed := websocketFramesFrom(buf.Bytes()[*parsed:], direction)
		*parsed += consumed
		room := 48 - len(t.frames)
		t.frames = append(t.frames, frames[:min(len(frames), room)]...)
	}
	t.schedulePublish()
}

func (t *streamTap) writeDecoded(b []byte) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.finished {
		return false
	}
	room := previewLimit - t.decoded.Len()
	if room <= 0 {
		return false
	}
	t.decoded.Write(b[:min(room, len(b))])
	t.schedulePublish()
	return len(b) < room
}

func (t *streamTap) schedulePublish() {
	if t.timer == nil {
		t.timer = time.AfterFunc(120*time.Millisecond, func() {
			t.mu.Lock()
			defer t.mu.Unlock()
			t.timer = nil
			if !t.finished {
				t.publish(t.snapshot())
			}
		})
	}
}
func (t *streamTap) snapshot() Exchange {
	x := t.base
	x.Entry.Duration = time.Since(t.start).Milliseconds()
	if x.Entry.Stream == "WebSocket" {
		x.Frames = append([]Frame(nil), t.frames...)
		x.Request.Truncated = t.base.Request.Truncated
	} else {
		events := t.received.Bytes()
		if t.encodedSSE {
			events = t.decoded.Bytes()
		}
		x.Frames = eventFrames(events)
		if t.encodedSSE {
			x.Response.Binary = true
			x.Response.raw = bytes.Clone(t.received.Bytes())
		} else {
			x.Response.Body = strings.ToValidUTF8(t.received.String(), "�")
		}
		x.Request.Truncated = t.base.Request.Truncated
	}
	x.Response.Truncated = x.Entry.Received > int64(t.received.Len())
	return x
}
func (t *streamTap) finish() Exchange {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.timer != nil {
		t.timer.Stop()
	}
	t.finished = true
	x := t.snapshot()
	x.Entry.InProgress = false
	return x
}

type streamReadCloser struct {
	io.ReadCloser
	tap *streamTap
}

func (r *streamReadCloser) Read(b []byte) (int, error) {
	n, err := r.ReadCloser.Read(b)
	if n > 0 {
		r.tap.write(b[:n], false)
	}
	return n, err
}

type streamDuplex struct {
	*streamReadCloser
	writer io.Writer
}

func (d *streamDuplex) Write(b []byte) (int, error) {
	n, err := d.writer.Write(b)
	if n > 0 {
		d.tap.write(b[:n], true)
	}
	return n, err
}

func (t *trace) responseBody(resp *http.Response) error {
	applyResponseRewrites(resp.Header, t.rewrites)
	t.response = copyHeaders(resp.Header)
	ws := resp.StatusCode == 101 && strings.EqualFold(resp.Header.Get("Upgrade"), "websocket")
	sse := strings.EqualFold(strings.TrimSpace(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0]), "text/event-stream")
	if !ws && !sse {
		resp.Body = readerWithClose{Reader: io.TeeReader(resp.Body, &t.received), Closer: resp.Body}
		return nil
	}
	if t.newStream == nil {
		return nil
	}
	kind := "SSE"
	if ws {
		kind = "WebSocket"
	}
	t.stream = t.newStream(kind, resp.StatusCode, t.response)
	reader := &streamReadCloser{ReadCloser: resp.Body, tap: t.stream}
	if ws {
		writer, ok := resp.Body.(io.Writer)
		if !ok {
			return fmt.Errorf("upstream WebSocket is not writable")
		}
		resp.Body = &streamDuplex{streamReadCloser: reader, writer: writer}
	} else {
		encoding := strings.TrimSpace(strings.ToLower(resp.Header.Get("Content-Encoding")))
		if encoding != "" && encoding != "identity" {
			t.stream.encodedSSE = true
			resp.Body = newEncodedSSEReadCloser(reader, t.stream, encoding)
		} else {
			resp.Body = reader
		}
	}
	return nil
}

type encodedSSEReadCloser struct {
	io.ReadCloser
	decoded *io.PipeWriter
	done    chan struct{}
	once    sync.Once
}

func newEncodedSSEReadCloser(source io.ReadCloser, tap *streamTap, encoding string) *encodedSSEReadCloser {
	reader, writer := io.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer reader.Close()
		decoded, closeDecoder, err := newSSEDecoder(reader, encoding)
		if err != nil {
			reader.CloseWithError(err)
			return
		}
		defer closeDecoder()
		buffer := make([]byte, 32*1024)
		for {
			n, readErr := decoded.Read(buffer)
			if n > 0 {
				if !tap.writeDecoded(buffer[:n]) {
					return
				}
			}
			if readErr != nil {
				return
			}
		}
	}()
	return &encodedSSEReadCloser{ReadCloser: source, decoded: writer, done: done}
}

func newSSEDecoder(source io.Reader, encoding string) (io.Reader, func(), error) {
	codings := strings.Split(encoding, ",")
	var closers []func()
	reader := source
	for i := len(codings) - 1; i >= 0; i-- {
		coding := strings.TrimSpace(codings[i])
		if coding == "" || coding == "identity" {
			continue
		}
		var closeDecoder func()
		switch coding {
		case "gzip", "x-gzip":
			decoded, err := gzip.NewReader(reader)
			if err != nil {
				closeSSEDecoders(closers)
				return nil, func() {}, err
			}
			reader = decoded
			closeDecoder = func() { _ = decoded.Close() }
		case "br":
			reader = brotli.NewReader(reader)
		case "zstd":
			decoded, err := zstd.NewReader(reader, zstd.WithDecoderConcurrency(1))
			if err != nil {
				closeSSEDecoders(closers)
				return nil, func() {}, err
			}
			reader = decoded
			closeDecoder = decoded.Close
		default:
			closeSSEDecoders(closers)
			return nil, func() {}, fmt.Errorf("unsupported content encoding %q", coding)
		}
		if closeDecoder != nil {
			closers = append(closers, closeDecoder)
		}
	}
	return reader, func() { closeSSEDecoders(closers) }, nil
}

func closeSSEDecoders(closers []func()) {
	for i := len(closers) - 1; i >= 0; i-- {
		closers[i]()
	}
}

func (r *encodedSSEReadCloser) Read(b []byte) (int, error) {
	n, err := r.ReadCloser.Read(b)
	if n > 0 {
		if _, writeErr := r.decoded.Write(b[:n]); writeErr != nil {
			r.decoded.CloseWithError(writeErr)
		}
	}
	if err != nil {
		r.stopDecoder(err)
	}
	return n, err
}

func (r *encodedSSEReadCloser) Close() error {
	r.stopDecoder(io.ErrClosedPipe)
	return r.ReadCloser.Close()
}

func (r *encodedSSEReadCloser) stopDecoder(err error) {
	r.once.Do(func() {
		if err == nil || err == io.EOF {
			r.decoded.Close()
		} else {
			r.decoded.CloseWithError(err)
		}
	})
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-r.done:
	case <-timer.C:
	}
}

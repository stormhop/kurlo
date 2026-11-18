package proxycapture

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Frame struct {
	Direction string `json:"direction"`
	Kind      string `json:"kind"`
	Text      string `json:"text"`
	Size      int64  `json:"size"`
}

func websocketFrames(data []byte, dir string) []Frame {
	frames := []Frame{}
	for len(data) >= 2 && len(frames) < 48 {
		first, second := data[0], data[1]
		off := 2
		n := uint64(second & 127)
		switch n {
		case 126:
			if len(data) < 4 {
				return frames
			}
			n = uint64(binary.BigEndian.Uint16(data[2:4]))
			off = 4
		case 127:
			if len(data) < 10 {
				return frames
			}
			n = binary.BigEndian.Uint64(data[2:10])
			off = 10
		}
		var mask []byte
		if second&128 != 0 {
			if len(data) < off+4 {
				return frames
			}
			mask = data[off : off+4]
			off += 4
		}
		if n > uint64(len(data)-off) {
			return frames
		}
		kind := map[byte]string{0: "Continuation", 1: "Text", 2: "Binary", 8: "Close", 9: "Ping", 10: "Pong"}[first&15]
		if kind == "" {
			kind = "Reserved"
		}
		frame := Frame{Direction: dir, Kind: kind, Size: int64(n)}
		if first&64 != 0 {
			frame.Kind += " (compressed)"
		} else if kind == "Text" || kind == "Continuation" {
			b := bytes.Clone(data[off : off+min(int(n), 1024)])
			if mask != nil {
				for i := range b {
					b[i] ^= mask[i%4]
				}
			}
			frame.Text = strings.ToValidUTF8(string(b), "�")
		}
		frames = append(frames, frame)
		data = data[off+int(n):]
	}
	return frames
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
				if value != "" {
					kind = value
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
		x.Frames = append(websocketFrames(t.sent.Bytes(), "Sent"), websocketFrames(t.received.Bytes(), "Received")...)
	} else {
		x.Frames = eventFrames(t.received.Bytes())
		x.Response.Body = strings.ToValidUTF8(t.received.String(), "�")
	}
	x.Response.Truncated = x.Entry.Received > int64(t.received.Len())
	x.Request.Truncated = x.Entry.Sent > int64(t.sent.Len())
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
		resp.Body = reader
	}
	return nil
}

package proxycapture

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const MaxSessionFile = 256 << 20

type harValue struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type harExtension struct {
	Stream    string              `json:"stream,omitempty"`
	Process   string              `json:"process,omitempty"`
	Error     string              `json:"error,omitempty"`
	Rule      string              `json:"rule,omitempty"`
	Rewritten string              `json:"rewritten,omitempty"`
	Local     bool                `json:"local,omitempty"`
	Frames    []Frame             `json:"frames,omitempty"`
	Timings   *model.ResponseTime `json:"timings,omitempty"`
}

type harSocketMessage struct {
	Type   string  `json:"type"`
	Opcode int     `json:"opcode"`
	Data   string  `json:"data"`
	Time   float64 `json:"time"`
}

type harEntry struct {
	Started  string             `json:"startedDateTime"`
	Time     float64            `json:"time"`
	Error    string             `json:"_error"`
	Kurlo    *harExtension      `json:"_kurlo"`
	Messages []harSocketMessage `json:"_webSocketMessages"`
	Timings  map[string]float64 `json:"timings"`
	Request  struct {
		Version  string     `json:"httpVersion"`
		Method   string     `json:"method"`
		URL      string     `json:"url"`
		Headers  []harValue `json:"headers"`
		BodySize int64      `json:"bodySize"`
		PostData *struct {
			MimeType string     `json:"mimeType"`
			Text     string     `json:"text"`
			Encoding string     `json:"_encoding"`
			Params   []harValue `json:"params"`
		} `json:"postData"`
	} `json:"request"`
	Response struct {
		Version  string     `json:"httpVersion"`
		Status   int        `json:"status"`
		Headers  []harValue `json:"headers"`
		BodySize int64      `json:"bodySize"`
		Content  struct {
			Size     int64  `json:"size"`
			Text     string `json:"text"`
			Encoding string `json:"encoding"`
		} `json:"content"`
	} `json:"response"`
}

var ErrRecording = errors.New("stop recording before opening a session")

func (r *Recorder) Load(data []byte, source string, decode func(http.Header, string, int) (string, bool)) (Status, error) {
	return r.load(data, source, decode, true)
}

func (r *Recorder) LoadPreviews(data []byte, source string, decode func(http.Header, string, int) (string, bool)) (Status, error) {
	return r.load(data, source, decode, false)
}

func (r *Recorder) load(data []byte, source string, decode func(http.Header, string, int) (string, bool), archive bool) (Status, error) {
	var file struct {
		Log *struct {
			Entries []harEntry `json:"entries"`
		} `json:"log"`
	}
	if err := json.Unmarshal(data, &file); err != nil || file.Log == nil {
		return r.Status(), errors.New("this file is not a HAR archive")
	}
	items := file.Log.Entries
	if len(items) > capacity {
		items = items[len(items)-capacity:]
	}
	var files *bodyFiles
	if archive {
		files = &bodyFiles{}
	}
	exchanges := make([]*Exchange, 0, len(items))
	for _, item := range items {
		x, ok := sessionExchange(item, files, decode)
		if ok {
			exchanges = append(exchanges, x)
		}
	}
	if len(exchanges) == 0 {
		if files != nil {
			files.close()
		}
		return r.Status(), errors.New("this HAR archive has no HTTP requests")
	}
	r.mu.Lock()
	if r.run != nil {
		r.mu.Unlock()
		if files != nil {
			files.close()
		}
		return r.Status(), ErrRecording
	}
	if r.files != nil {
		r.files.close()
	}
	r.files = files
	r.ring = [capacity]*Exchange{}
	r.count = 0
	r.cursor = 0
	for _, x := range exchanges {
		r.next++
		x.Entry.ID = r.next
		r.ring[r.cursor] = x
		r.cursor = (r.cursor + 1) % capacity
		r.count++
	}
	r.source = source
	status := r.status()
	r.mu.Unlock()
	return status, nil
}

func sessionExchange(item harEntry, files *bodyFiles, decode func(http.Header, string, int) (string, bool)) (*Exchange, bool) {
	u, err := url.Parse(item.Request.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "ws" && u.Scheme != "wss") {
		return nil, false
	}
	method := strings.ToUpper(strings.TrimSpace(item.Request.Method))
	if method == "" || method == http.MethodConnect {
		return nil, false
	}
	x := &Exchange{Entry: Entry{Method: method, Host: u.Host, URL: displayURL(u), Path: u.EscapedPath(), Status: item.Response.Status, Started: sessionStarted(item.Started)}}
	if x.Entry.Path == "" {
		x.Entry.Path = "/"
	}
	x.Entry.Protocol = sessionProtocol(item.Request.Version, item.Response.Version)
	if item.Time > 0 && !math.IsInf(item.Time, 0) {
		x.Entry.Duration = int64(math.Round(item.Time))
	}
	reqHeaders := sessionHeaders(item.Request.Headers)
	resHeaders := sessionHeaders(item.Response.Headers)
	reqBody := ""
	if post := item.Request.PostData; post != nil {
		reqBody = post.Text
		if post.Encoding == "base64" {
			if b, err := base64.StdEncoding.DecodeString(post.Text); err == nil {
				reqBody = string(b)
			}
		} else if post.Text == "" && len(post.Params) > 0 && strings.HasPrefix(strings.ToLower(post.MimeType), "application/x-www-form-urlencoded") {
			values := url.Values{}
			for _, p := range post.Params {
				values.Add(p.Name, p.Value)
			}
			reqBody = values.Encode()
		}
		if http.Header(reqHeaders).Get("Content-Type") == "" && post.MimeType != "" {
			reqHeaders["Content-Type"] = []string{post.MimeType}
		}
	}
	resBody := item.Response.Content.Text
	if item.Response.Content.Encoding == "base64" {
		if b, err := base64.StdEncoding.DecodeString(resBody); err == nil {
			resBody = string(b)
		}
	}
	if resBody != "" && http.Header(resHeaders).Get("Content-Encoding") != "" {
		if decode == nil {
			delete(resHeaders, "Content-Encoding")
		} else if _, ok := decode(resHeaders, resBody, maxBodyFile); !ok {
			delete(resHeaders, "Content-Encoding")
		}
	}
	var sent, received int64
	x.Request, sent = sessionMessage(files, reqHeaders, reqBody)
	x.Response, received = sessionMessage(files, resHeaders, resBody)
	x.Entry.Sent = firstSize(item.Request.BodySize, sent)
	x.Entry.Received = firstSize(item.Response.BodySize, item.Response.Content.Size, received)
	x.Entry.Error = item.Error
	if k := item.Kurlo; k != nil {
		x.Entry.Stream = k.Stream
		x.Entry.Process = k.Process
		x.Entry.Rule = k.Rule
		x.Entry.Rewritten = k.Rewritten
		x.Entry.Local = k.Local
		if k.Error != "" {
			x.Entry.Error = k.Error
		}
		x.Frames = k.Frames
		x.Timings = k.Timings
	} else if len(item.Messages) > 0 {
		x.Entry.Stream = "WebSocket"
		for _, m := range item.Messages {
			if len(x.Frames) >= 48 {
				break
			}
			direction := "Received"
			if m.Type == "send" {
				direction = "Sent"
			}
			kind := map[int]string{0: "Continuation", 1: "Text", 2: "Binary", 8: "Close", 9: "Ping", 10: "Pong"}[m.Opcode]
			if kind == "" {
				kind = "Reserved"
			}
			frame := Frame{Direction: direction, Kind: kind, Size: int64(len(m.Data))}
			if kind == "Text" || kind == "Continuation" {
				frame.Text = strings.ToValidUTF8(m.Data[:min(len(m.Data), 1024)], "�")
			}
			x.Frames = append(x.Frames, frame)
		}
	}
	if item.Kurlo == nil {
		x.Timings = sessionTimings(item.Timings, item.Time)
	}
	if x.Entry.Stream == "" && strings.HasPrefix(strings.ToLower(http.Header(resHeaders).Get("Content-Type")), "text/event-stream") {
		x.Entry.Stream = "SSE"
		x.Frames = eventFrames([]byte(resBody))
	}
	return x, true
}

func sessionProtocol(values ...string) string {
	for _, v := range values {
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "h2", "http/2", "http/2.0":
			return "HTTP/2.0"
		case "h3", "http/3", "http/3.0":
			return "HTTP/3.0"
		case "http/1.1":
			return "HTTP/1.1"
		case "http/1.0":
			return "HTTP/1.0"
		}
	}
	return ""
}

func sessionStarted(value string) string {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000-0700", "2006-01-02T15:04:05-0700"} {
		if t, err := time.Parse(layout, value); err == nil {
			return t.UTC().Format(time.RFC3339Nano)
		}
	}
	return value
}

func sessionHeaders(values []harValue) map[string][]string {
	out := map[string][]string{}
	for _, v := range values {
		name := strings.TrimSpace(v.Name)
		if name == "" || strings.HasPrefix(name, ":") {
			continue
		}
		key := http.CanonicalHeaderKey(name)
		out[key] = append(out[key], v.Value)
	}
	return out
}

func sessionMessage(files *bodyFiles, headers map[string][]string, body string) (Message, int64) {
	p := &preview{files: files}
	p.Write([]byte(body))
	return p.message(headers)
}

func firstSize(values ...int64) int64 {
	for _, v := range values {
		if v > 0 {
			return v
		}
	}
	return 0
}

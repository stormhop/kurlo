package proxycapture

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"mime"
	"mime/multipart"
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

type harParam struct {
	harValue
	FileName *string `json:"fileName"`
}

type harPostData struct {
	MimeType   string     `json:"mimeType"`
	Text       *string    `json:"text"`
	Encoding   string     `json:"_encoding"`
	Incomplete bool       `json:"_incomplete"`
	Params     []harParam `json:"params"`
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
		Version  string       `json:"httpVersion"`
		Method   string       `json:"method"`
		URL      string       `json:"url"`
		Headers  []harValue   `json:"headers"`
		BodySize int64        `json:"bodySize"`
		PostData *harPostData `json:"postData"`
	} `json:"request"`
	Response struct {
		Version    string     `json:"httpVersion"`
		Status     int        `json:"status"`
		StatusText *string    `json:"statusText"`
		Headers    []harValue `json:"headers"`
		BodySize   *int64     `json:"bodySize"`
		Content    struct {
			Size        *int64  `json:"size"`
			WireEncoded *bool   `json:"_wireEncoded"`
			Text        *string `json:"text"`
			MimeType    string  `json:"mimeType"`
			Incomplete  bool    `json:"_incomplete"`
			Encoding    string  `json:"encoding"`
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
			Creator struct {
				Name string `json:"name"`
			} `json:"creator"`
			Entries []harEntry `json:"entries"`
		} `json:"log"`
	}
	if err := json.Unmarshal(data, &file); err != nil || file.Log == nil {
		return r.Status(), errors.New("this file is not a HAR archive")
	}
	items := file.Log.Entries
	type selectedEntry struct {
		item   *harEntry
		url    *url.URL
		method string
	}
	eligible := make([]selectedEntry, 0, min(len(items), capacity))
	for i := len(items) - 1; i >= 0 && len(eligible) < capacity; i-- {
		if u, method, ok := sessionTarget(&items[i]); ok {
			eligible = append(eligible, selectedEntry{&items[i], u, method})
		}
	}
	var files *bodyFiles
	if archive {
		files = &bodyFiles{}
	}
	exchanges := make([]*Exchange, 0, len(eligible))
	for i := len(eligible) - 1; i >= 0; i-- {
		entry := eligible[i]
		exchanges = append(exchanges, sessionExchange(entry.item, entry.url, entry.method, files, decode, file.Log.Creator.Name == "Kurlo"))
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

func sessionTarget(item *harEntry) (*url.URL, string, bool) {
	method := strings.ToUpper(strings.TrimSpace(item.Request.Method))
	if method == "" || method == http.MethodConnect {
		return nil, "", false
	}
	u, err := url.Parse(item.Request.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "ws" && u.Scheme != "wss") {
		return nil, "", false
	}
	return u, method, true
}

func sessionExchange(item *harEntry, u *url.URL, method string, files *bodyFiles, decode func(http.Header, string, int) (string, bool), fromKurlo bool) *Exchange {
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
	reqIncomplete := item.Request.BodySize > 0
	if post := item.Request.PostData; post != nil {
		if http.Header(reqHeaders).Get("Content-Type") == "" && post.MimeType != "" {
			reqHeaders["Content-Type"] = []string{post.MimeType}
		}
		var present bool
		reqBody, present = post.body(reqHeaders)
		reqIncomplete = post.Incomplete || (!present && (post.Params != nil || post.Text != nil)) || (reqBody == "" && item.Request.BodySize > 0)
	}
	content := item.Response.Content
	if http.Header(resHeaders).Get("Content-Type") == "" && content.MimeType != "" {
		resHeaders["Content-Type"] = []string{content.MimeType}
	}
	resBody, present := sessionBody(content.Text, content.Encoding)
	expectsBody := method != http.MethodHead && item.Response.Status != http.StatusNotModified && item.Response.Status != http.StatusNoContent && (item.Response.Status == 0 || item.Response.Status >= 200)
	wireSize := int64(-1)
	if item.Response.BodySize != nil {
		wireSize = *item.Response.BodySize
	}
	contentSize := int64(len(resBody))
	if content.Size != nil {
		contentSize = *content.Size
	}
	missingBody := !present && firstSize(wireSize, contentSize) > 0 || resBody == "" && contentSize > 0
	resIncomplete := content.Incomplete || expectsBody && missingBody
	eventBody := resBody
	wireEncoded := content.WireEncoded != nil && *content.WireEncoded
	if decode != nil && resBody != "" && http.Header(resHeaders).Get("Content-Encoding") != "" {
		legacyRaw := content.WireEncoded == nil && content.Encoding == "base64" && (fromKurlo || content.Size == nil || contentSize != int64(len(resBody)))
		if wireEncoded || legacyRaw {
			if decoded, ok := decode(resHeaders, resBody, previewLimit); ok {
				eventBody = decoded
				wireEncoded = true
			}
		}
	}
	var sent, received int64
	x.Request, sent = sessionMessage(files, reqHeaders, reqBody, reqIncomplete)
	x.Response, received = sessionMessage(files, resHeaders, resBody, resIncomplete)
	x.Response.decoded = !wireEncoded
	x.harTimings = item.Timings
	x.harStatusText = item.Response.StatusText
	x.harBodySize = item.Response.BodySize
	x.harContentSize = content.Size
	if x.harContentSize == nil && present && !resIncomplete && !wireEncoded {
		x.harContentSize = &received
	}
	x.Entry.Sent = firstSize(item.Request.BodySize, sent)
	x.Entry.Received = wireSize
	if wireSize < 0 {
		x.Entry.Received = firstSize(contentSize, received)
	}
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
			if kind == "Binary" {
				if data, err := base64.StdEncoding.DecodeString(m.Data); err == nil {
					frame.Size = int64(len(data))
				}
			}
			if kind == "Text" || kind == "Continuation" {
				frame.Text = strings.ToValidUTF8(m.Data[:min(len(m.Data), 1024)], "�")
			}
			x.Frames = append(x.Frames, frame)
		}
	}
	if x.Timings == nil && !x.Entry.Local {
		x.Timings = sessionTimings(item.Timings, item.Time)
	}
	if x.Entry.Stream == "" && strings.HasPrefix(strings.ToLower(http.Header(resHeaders).Get("Content-Type")), "text/event-stream") {
		x.Entry.Stream = "SSE"
		x.Frames = eventFrames([]byte(eventBody[:min(len(eventBody), previewLimit)]))
	}
	return x
}

func sessionBody(text *string, encoding string) (string, bool) {
	if text == nil {
		return "", false
	}
	if encoding == "base64" {
		b, err := base64.StdEncoding.DecodeString(*text)
		return string(b), err == nil
	}
	return *text, true
}

func (p *harPostData) body(headers http.Header) (string, bool) {
	if p.Params == nil || (p.Text != nil && *p.Text != "") {
		return sessionBody(p.Text, p.Encoding)
	}
	media, params, _ := mime.ParseMediaType(headers.Get("Content-Type"))
	switch media {
	case "application/x-www-form-urlencoded":
		var values []string
		for _, param := range p.Params {
			values = append(values, url.QueryEscape(param.Name)+"="+url.QueryEscape(param.Value))
		}
		return strings.Join(values, "&"), true
	case "multipart/form-data":
		var body strings.Builder
		writer := multipart.NewWriter(&body)
		if boundary := params["boundary"]; boundary == "" || writer.SetBoundary(boundary) != nil {
			headers.Set("Content-Type", writer.FormDataContentType())
		}
		complete := true
		for _, param := range p.Params {
			if param.FileName != nil {
				complete = false
				continue
			}
			if err := writer.WriteField(param.Name, param.Value); err != nil {
				return "", false
			}
		}
		if err := writer.Close(); err != nil {
			return "", false
		}
		return body.String(), complete
	}
	return "", false
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

func sessionMessage(files *bodyFiles, headers map[string][]string, body string, incomplete bool) (Message, int64) {
	p := &preview{files: files}
	p.Write([]byte(body))
	m, size := p.message(headers)
	if incomplete {
		m.Truncated = true
		m.Archived = false
	}
	return m, size
}

func firstSize(values ...int64) int64 {
	for _, v := range values {
		if v > 0 {
			return v
		}
	}
	return 0
}

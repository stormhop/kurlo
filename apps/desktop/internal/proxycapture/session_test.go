package proxycapture

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoadRoundTripsRecordedSession(t *testing.T) {
	large := strings.Repeat("x", previewLimit*3)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/zipped":
			var buffer bytes.Buffer
			zw := gzip.NewWriter(&buffer)
			zw.Write([]byte(`{"invoice":"INV-7"}`))
			zw.Close()
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Content-Type", "application/json")
			w.Write(buffer.Bytes())
		case "/large":
			w.Write([]byte(large))
		default:
			w.Header().Set("X-Trace", "abc")
			w.WriteHeader(201)
			io.Copy(w, r.Body)
		}
	}))
	defer target.Close()
	r, client := startRecorder(t, Config{})
	resp, err := client.Post(target.URL+"/orders", "application/json", strings.NewReader(`{"id":1}`))
	responseText(t, resp, err)
	resp, err = client.Get(target.URL + "/zipped")
	responseText(t, resp, err)
	resp, err = client.Get(target.URL + "/large")
	responseText(t, resp, err)
	har, err := r.HARDecoded(nil, gunzip)
	if err != nil {
		t.Fatal(err)
	}
	r.Stop()

	loaded := &Recorder{}
	defer loaded.Close()
	status, err := loaded.Load([]byte(har), "orders.har", gunzip)
	if err != nil {
		t.Fatal(err)
	}
	if status.Source != "orders.har" || status.Count != 3 || status.Running {
		t.Fatalf("%+v", status)
	}
	entries := loaded.Entries()
	if entries[0].Method != "POST" || entries[0].Status != 201 || entries[0].Path != "/orders" || entries[0].Sent != 8 {
		t.Fatalf("%+v", entries[0])
	}
	post, err := loaded.Get(entries[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if post.Request.Body != `{"id":1}` || post.Response.Body != `{"id":1}` || http.Header(post.Response.Headers).Get("X-Trace") != "abc" {
		t.Fatalf("%+v", post)
	}
	zipped, _ := loaded.Get(entries[1].ID)
	if zipped.Response.Body != `{"invoice":"INV-7"}` || http.Header(zipped.Response.Headers).Get("Content-Encoding") != "gzip" || zipped.Response.HasContentEncoding() {
		t.Fatalf("%+v", zipped.Response)
	}
	big, _ := loaded.Get(entries[2].ID)
	if !big.Response.Truncated || !big.Response.Archived {
		t.Fatalf("%+v", big.Response.Truncated)
	}
	full, err := loaded.HAR([]int64{entries[2].ID})
	if err != nil || !strings.Contains(full, large) {
		t.Fatal("archived body was not kept", err)
	}
	if hits := loaded.Search("inv-7", gunzip); len(hits) != 1 {
		t.Fatal(hits)
	}
}

func TestLoadReadsBrowserHAR(t *testing.T) {
	var zipped bytes.Buffer
	zw := gzip.NewWriter(&zipped)
	zw.Write([]byte("compressed"))
	zw.Close()
	har := map[string]any{"log": map[string]any{"entries": []any{
		map[string]any{
			"startedDateTime": "2026-11-22T10:00:00.123+03:00",
			"time":            12.6,
			"request":         map[string]any{"method": "post", "url": "https://shop.test/login?token=secret&page=2", "headers": []any{map[string]string{"name": ":authority", "value": "shop.test"}, map[string]string{"name": "x-client", "value": "web"}}, "bodySize": -1, "postData": map[string]any{"mimeType": "application/x-www-form-urlencoded", "params": []any{map[string]string{"name": "user", "value": "ada"}}}},
			"response":        map[string]any{"status": 200, "headers": []any{map[string]string{"name": "content-encoding", "value": "gzip"}, map[string]string{"name": "content-type", "value": "text/plain"}}, "bodySize": 40, "content": map[string]any{"size": 7, "text": "decoded"}},
		},
		map[string]any{
			"startedDateTime": "2026-11-22T10:00:01Z",
			"time":            3,
			"request":         map[string]any{"method": "GET", "url": "https://shop.test/raw", "headers": []any{map[string]string{"name": "Accept-Encoding", "value": "gzip"}}},
			"response":        map[string]any{"status": 200, "headers": []any{map[string]string{"name": "Content-Encoding", "value": "gzip"}}, "content": map[string]any{"text": base64.StdEncoding.EncodeToString(zipped.Bytes()), "encoding": "base64"}},
		},
		map[string]any{
			"startedDateTime":    "2026-11-22T10:00:02Z",
			"request":            map[string]any{"method": "GET", "url": "wss://shop.test/live"},
			"response":           map[string]any{"status": 101},
			"_webSocketMessages": []any{map[string]any{"type": "send", "opcode": 1, "data": "hello"}, map[string]any{"type": "receive", "opcode": 2, "data": "AAEC"}},
		},
		map[string]any{"request": map[string]any{"method": "GET", "url": "chrome-extension://abc/x"}, "response": map[string]any{"status": 200}},
		map[string]any{"request": map[string]any{"method": "GET", "url": "https://shop.test/stream"}, "response": map[string]any{"status": 200, "content": map[string]any{"mimeType": "text/event-stream", "text": "data: one\n\ndata: two\n\n"}}},
		map[string]any{"_error": "net::ERR_CONNECTION_REFUSED", "request": map[string]any{"method": "GET", "url": "http://localhost:9/"}, "response": map[string]any{"status": 0}},
	}}}
	data, _ := json.Marshal(har)
	r := &Recorder{}
	defer r.Close()
	if _, err := r.Load(data, "chrome.har", gunzip); err != nil {
		t.Fatal(err)
	}
	entries := r.Entries()
	if len(entries) != 5 {
		t.Fatalf("%+v", entries)
	}
	login := entries[0]
	if login.Method != "POST" || login.Duration != 13 || login.Started != "2026-11-22T07:00:00.123Z" || strings.Contains(login.URL, "secret") || login.Received != 40 || login.Sent != 8 {
		t.Fatalf("%+v", login)
	}
	x, _ := r.Get(login.ID)
	if x.Request.Body != "user=ada" || http.Header(x.Request.Headers).Get("Content-Type") != "application/x-www-form-urlencoded" || http.Header(x.Request.Headers).Get("X-Client") != "web" || len(x.Request.Headers) != 2 {
		t.Fatalf("%+v", x.Request)
	}
	if x.Response.Body != "decoded" || http.Header(x.Response.Headers).Get("Content-Encoding") != "gzip" || x.Response.HasContentEncoding() {
		t.Fatalf("%+v", x.Response)
	}
	raw, _ := r.Get(entries[1].ID)
	if http.Header(raw.Response.Headers).Get("Content-Encoding") != "gzip" || !raw.Response.Binary {
		t.Fatalf("%+v", raw.Response)
	}
	if decoded, ok := gunzip(raw.Response.Headers, string(raw.Response.raw), 100); !ok || decoded != "compressed" {
		t.Fatal(decoded)
	}
	ws, _ := r.Get(entries[2].ID)
	if ws.Entry.Stream != "WebSocket" || len(ws.Frames) != 2 || ws.Frames[0] != (Frame{Direction: "Sent", Kind: "Text", Text: "hello", Size: 5}) || ws.Frames[1].Direction != "Received" || ws.Frames[1].Kind != "Binary" || ws.Frames[1].Size != 3 {
		t.Fatalf("%+v", ws)
	}
	sse, _ := r.Get(entries[3].ID)
	if sse.Entry.Stream != "SSE" || len(sse.Frames) != 2 {
		t.Fatalf("%+v", sse)
	}
	if entries[4].Error != "net::ERR_CONNECTION_REFUSED" || entries[4].Status != 0 {
		t.Fatalf("%+v", entries[4])
	}
}

func TestLoadKeepsKurloDetails(t *testing.T) {
	r := &Recorder{}
	defer r.Close()
	r.next = 1
	r.ring[0] = &Exchange{Entry: Entry{ID: 1, Method: "GET", Host: "api.test", URL: "https://api.test/feed", Path: "/feed", Status: 200, Stream: "SSE", Process: "node", Rule: "Feed mock", Local: true, Error: "stream closed"}, Frames: []Frame{{Direction: "Received", Kind: "message", Text: "one", Size: 3}}}
	r.count, r.cursor = 1, 1
	har, err := r.HAR(nil)
	if err != nil {
		t.Fatal(err)
	}
	loaded := &Recorder{}
	defer loaded.Close()
	if _, err := loaded.Load([]byte(har), "feed.har", nil); err != nil {
		t.Fatal(err)
	}
	x, _ := loaded.Get(loaded.Entries()[0].ID)
	want := r.ring[0]
	if x.Entry.Stream != "SSE" || x.Entry.Process != "node" || x.Entry.Rule != "Feed mock" || !x.Entry.Local || x.Entry.Error != "stream closed" || len(x.Frames) != 1 || x.Frames[0] != want.Frames[0] {
		t.Fatalf("%+v", x)
	}
}

func TestLoadRejectsInvalidFilesAndRecording(t *testing.T) {
	r := &Recorder{}
	defer r.Close()
	for _, data := range []string{"not json", `{"entries":[]}`, `{"log":{"entries":[]}}`, `{"log":{"entries":[{"request":{"method":"CONNECT","url":"https://a.test:443"}}]}}`} {
		if _, err := r.Load([]byte(data), "x.har", nil); err == nil {
			t.Fatal(data)
		}
	}
	running, _ := startRecorder(t, Config{})
	if _, err := running.Load([]byte(`{"log":{"entries":[{"request":{"method":"GET","url":"http://a.test/"},"response":{"status":200}}]}}`), "x.har", nil); !errors.Is(err, ErrRecording) {
		t.Fatal(err)
	}
}

func TestLoadKeepsNewestEntriesAndRecordClearsSource(t *testing.T) {
	entries := make([]string, capacity+5)
	for i := range entries {
		entries[i] = fmt.Sprintf(`{"request":{"method":"GET","url":"http://a.test/%d"},"response":{"status":200}}`, i)
	}
	r := &Recorder{}
	defer r.Close()
	for range capacity {
		entries = append(entries, `{"request":{"method":"CONNECT","url":"https://a.test/"}}`)
	}
	r.next = 40
	status, err := r.Load([]byte(`{"log":{"entries":[`+strings.Join(entries, ",")+`]}}`), "big.har", nil)
	if err != nil {
		t.Fatal(err)
	}
	list := r.Entries()
	if status.Count != capacity || list[0].Path != "/5" || list[0].ID != 41 {
		t.Fatalf("%d %+v", status.Count, list[0])
	}
	if _, err := r.Get(list[len(list)-1].ID); err != nil {
		t.Fatal(err)
	}
	if status := r.Clear(); status.Source != "" {
		t.Fatal(status)
	}
	r.Load([]byte(`{"log":{"entries":[`+entries[0]+`]}}`), "one.har", nil)
	if _, err := r.Start(Config{Port: 0}, nil); err != nil {
		t.Fatal(err)
	}
	if status := r.Status(); status.Source != "" || status.Count != 0 {
		t.Fatal(status)
	}
}

func TestSessionKeepsPartialAndMissingBodies(t *testing.T) {
	input := `{"log":{"entries":[
		{"request":{"method":"POST","url":"http://shop.test/a","bodySize":8000000,"postData":{"text":"prefix","_incomplete":true}},"response":{"status":200,"content":{"text":"partial","_incomplete":true}}},
		{"request":{"method":"POST","url":"http://shop.test/b","bodySize":32},"response":{"status":200,"content":{"size":50}}},
		{"request":{"method":"HEAD","url":"http://shop.test/a"},"response":{"status":200,"content":{"size":50}}}
	]}}`
	var r Recorder
	defer r.Close()
	if _, err := r.Load([]byte(input), "partial.har", nil); err != nil {
		t.Fatal(err)
	}
	for i, e := range r.Entries() {
		x, err := r.Get(e.ID)
		if err != nil {
			t.Fatal(err)
		}
		want := i < 2
		if x.Request.Truncated != want || x.Response.Truncated != want || x.Request.Archived || x.Response.Archived {
			t.Fatalf("%s: %+v", e.Path, x)
		}
	}
	data, err := r.HAR(nil)
	if err != nil || strings.Count(data, `"_incomplete":true`) != 4 || !strings.Contains(data, `"text":"prefix"`) {
		t.Fatal(data, err)
	}
}

func TestSessionMultipartParamsSurviveExport(t *testing.T) {
	for _, mimeType := range []string{"multipart/form-data; boundary=original", "multipart/form-data"} {
		input := fmt.Sprintf(`{"log":{"entries":[{"request":{"method":"POST","url":"http://shop.test/form","postData":{"mimeType":%q,"params":[{"name":"city","value":"Paris"},{"name":"city","value":"Rome"}]}},"response":{"status":201}}]}}`, mimeType)
		var r Recorder
		if _, err := r.Load([]byte(input), "form.har", nil); err != nil {
			t.Fatal(err)
		}
		x, _ := r.Get(r.Entries()[0].ID)
		out, err := r.HAR(nil)
		r.Close()
		if err != nil || x.Request.Truncated || !strings.Contains(x.Request.Body, "Paris") || !strings.Contains(out, `"params":[{"name":"city","value":"Paris"},{"name":"city","value":"Rome"}]`) {
			t.Fatal(x.Request, out, err)
		}
	}
}

func TestImportedHARResponseMetadataSurvivesReexport(t *testing.T) {
	const original = `{"log":{"entries":[{"request":{"method":"GET","url":"http://shop.test/a"},"response":{"status":201,"statusText":"Order stored","headers":[{"name":"Content-Encoding","value":"br"}],"bodySize":11,"content":{"size":40,"text":"0123456789012345678901234567890123456789"}}},{"request":{"method":"HEAD","url":"https://shop.test/b","httpVersion":"h2"},"response":{"status":200,"statusText":"","bodySize":0,"content":{"size":-1}}}]}}`
	r := &Recorder{}
	defer r.Close()
	data := original
	for range 2 {
		if _, err := r.Load([]byte(data), "external.har", nil); err != nil {
			t.Fatal(err)
		}
		var err error
		if data, err = r.HARDecoded(nil, func(http.Header, string, int) (string, bool) {
			t.Fatal("attempted to decompress an already decoded body")
			return "", false
		}); err != nil {
			t.Fatal(err)
		}
		var file struct {
			Log struct {
				Entries []harEntry
			}
		}
		if err := json.Unmarshal([]byte(data), &file); err != nil {
			t.Fatal(err)
		}
		response := file.Log.Entries[0].Response
		if response.StatusText == nil || *response.StatusText != "Order stored" || response.BodySize == nil || *response.BodySize != 11 || response.Content.Size == nil || *response.Content.Size != 40 || http.Header(sessionHeaders(response.Headers)).Get("Content-Encoding") != "br" {
			t.Fatal(data)
		}
		head := file.Log.Entries[1].Response
		if head.StatusText == nil || *head.StatusText != "" || head.BodySize == nil || *head.BodySize != 0 || head.Content.Size == nil || *head.Content.Size != -1 {
			t.Fatal(data)
		}
	}
}

func TestHARIdentifiesWireBytesInLegacyAndNewArchives(t *testing.T) {
	var packed bytes.Buffer
	writer := gzip.NewWriter(&packed)
	if _, err := io.WriteString(writer, "download"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name     string
		creator  string
		wireFlag string
		wantWire bool
	}{
		{"legacy Kurlo raw", "Kurlo", "", true},
		{"browser decoded gzip file", "Browser", "", false},
		{"Kurlo decoded gzip file", "Kurlo", `,"_wireEncoded":false`, false},
		{"Kurlo raw bytes", "Kurlo", `,"_wireEncoded":true`, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := fmt.Sprintf(`{"log":{"creator":{"name":%q},"entries":[{"request":{"method":"GET","url":"https://shop.test/download"},"response":{"status":200,"headers":[{"name":"Content-Encoding","value":"gzip"}],"content":{"size":%d,"encoding":"base64","text":%q%s}}}]}}`, test.creator, packed.Len(), base64.StdEncoding.EncodeToString(packed.Bytes()), test.wireFlag)
			var r Recorder
			defer r.Close()
			for range 2 {
				if _, err := r.Load([]byte(data), "recording.har", gunzip); err != nil {
					t.Fatal(err)
				}
				x, err := r.Get(r.Entries()[0].ID)
				if err != nil || x.Response.HasContentEncoding() != test.wantWire {
					t.Fatalf("encoded = %v, err = %v", x.Response.HasContentEncoding(), err)
				}
				data, err = r.HAR(nil)
				if err != nil {
					t.Fatal(err)
				}
			}
			final, err := r.HARDecoded(nil, gunzip)
			if err != nil {
				t.Fatal(err)
			}
			want := base64.StdEncoding.EncodeToString(packed.Bytes())
			if test.wantWire {
				want = "download"
			}
			if !strings.Contains(final, fmt.Sprintf(`"text":%q`, want)) {
				t.Fatal(final)
			}
		})
	}
}

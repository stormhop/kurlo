package proxycapture

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func gunzip(headers http.Header, raw string, limit int) (string, bool) {
	reader, err := gzip.NewReader(strings.NewReader(raw))
	if err != nil {
		return "", false
	}
	data, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if err != nil && err != io.ErrUnexpectedEOF || len(data) > limit {
		return "", false
	}
	return string(data), true
}

func TestSearchHeadersBodiesAndEncodedResponses(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/zipped" {
			var buffer bytes.Buffer
			zw := gzip.NewWriter(&buffer)
			zw.Write([]byte(`{"invoice":"INV-42-Paid"}`))
			zw.Close()
			w.Header().Set("Content-Encoding", "gzip")
			w.Write(buffer.Bytes())
			return
		}
		w.Header().Set("X-Trace", "trace-Alpha-7")
		io.Copy(w, r.Body)
	}))
	defer target.Close()
	r, client := startRecorder(t, Config{})
	resp, err := client.Post(target.URL+"/orders", "application/json", strings.NewReader(`{"customer":"Ada Lovelace"}`))
	responseText(t, resp, err)
	resp, err = client.Get(target.URL + "/zipped")
	responseText(t, resp, err)
	cases := map[string][]string{
		"ada lovelace":     {"request body", "response body"},
		"TRACE-alpha":      {"response headers"},
		"inv-42-paid":      {"response body"},
		"application/json": {"request headers"},
		"nothing-here":     nil,
		"  ":               nil,
	}
	for query, want := range cases {
		hits := r.Search(query, gunzip)
		if want == nil {
			if len(hits) != 0 {
				t.Fatal(query, hits)
			}
			continue
		}
		if len(hits) != 1 || strings.Join(hits[0].Where, ",") != strings.Join(want, ",") {
			t.Fatal(query, hits)
		}
	}
	if hits := r.Search("inv-42-paid", nil); len(hits) != 0 {
		t.Fatal("searched an encoded body without a decoder", hits)
	}
}

func TestClearKeepsRecording(t *testing.T) {
	big := strings.Repeat("x", previewLimit*2)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, big) }))
	defer target.Close()
	r, client := startRecorder(t, Config{})
	resp, err := client.Get(target.URL + "/large")
	responseText(t, resp, err)
	x, err := r.Get(r.Entries()[0].ID)
	if err != nil || x.Response.file == "" {
		t.Fatal("expected an archived body", err)
	}
	status := r.Clear()
	if status.Count != 0 || len(r.Entries()) != 0 || !status.Running {
		t.Fatal(status)
	}
	if _, err := os.Stat(x.Response.file); !os.IsNotExist(err) {
		t.Fatal("archived body was not removed", err)
	}
	if _, err := r.Get(x.Entry.ID); err == nil {
		t.Fatal("cleared entry is still available")
	}
	resp, err = client.Get(target.URL + "/next")
	responseText(t, resp, err)
	if rows := r.Entries(); len(rows) != 1 || rows[0].Path != "/next" || rows[0].ID <= x.Entry.ID {
		t.Fatal(rows)
	}
}

package proxycapture

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"unicode/utf8"
)

type pair struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

func pairs(m map[string][]string) []pair {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := []pair{}
	for _, k := range keys {
		for _, v := range m[k] {
			out = append(out, pair{k, v})
		}
	}
	return out
}

func harPost(m Message, body string) map[string]any {
	contentType := http.Header(m.Headers).Get("Content-Type")
	incomplete := m.Truncated && !m.Archived
	post := map[string]any{"mimeType": contentType, "text": body, "_incomplete": incomplete}
	if !utf8.ValidString(body) || strings.IndexByte(body, 0) >= 0 {
		post["text"] = base64.StdEncoding.EncodeToString([]byte(body))
		post["_encoding"] = "base64"
		post["_incomplete"] = true
	}
	media, params, _ := mime.ParseMediaType(contentType)
	if media == "multipart/form-data" {
		parts := []pair{}
		reader := multipart.NewReader(strings.NewReader(body), params["boundary"])
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil || part.FileName() != "" || len(parts) >= 1024 {
				post["_incomplete"] = true
				return post
			}
			b, err := io.ReadAll(part)
			part.Close()
			if err != nil || !utf8.Valid(b) || part.FormName() == "" {
				post["_incomplete"] = true
				return post
			}
			parts = append(parts, pair{part.FormName(), string(b)})
		}
		post["params"] = parts
		delete(post, "text")
	}
	return post
}

func (r *Recorder) HAR(ids []int64) (string, error) {
	return r.HARDecoded(ids, nil)
}

func (r *Recorder) HARDecoded(ids []int64, decode func(http.Header, string, int) (string, bool)) (string, error) {
	remaining := maxSessionFiles
	selected := make(map[int64]bool, len(ids))
	for _, id := range ids {
		selected[id] = true
	}
	r.mu.Lock()
	items := r.snapshotLocked()
	files := r.files
	if files != nil {
		files.retain()
	}
	r.mu.Unlock()
	if files != nil {
		defer files.release()
	}
	entries := []any{}
	for _, x := range items {
		e := x.Entry
		if ids != nil && !selected[e.ID] {
			continue
		}
		delete(selected, e.ID)
		if e.Method == "CONNECT" {
			continue
		}
		u, err := url.Parse(e.URL)
		if err != nil {
			return "", err
		}
		version := e.Protocol
		if version == "" {
			version = "HTTP/1.1"
		}
		req := map[string]any{"method": e.Method, "url": e.URL, "httpVersion": version, "headers": pairs(x.Request.Headers), "cookies": []any{}, "queryString": pairs(u.Query()), "headersSize": -1, "bodySize": e.Sent}
		reqBody, err := x.Request.archived()
		if err != nil {
			return "", err
		}
		resBody, err := x.Response.archived()
		if err != nil {
			return "", err
		}
		if e.Sent > 0 || x.Request.Truncated {
			req["postData"] = harPost(x.Request, reqBody)
		}
		binary := x.Response.Binary
		size := e.Received
		if decode != nil && remaining > 0 && (!x.Response.Truncated || x.Response.Archived) && http.Header(x.Response.Headers).Get("Content-Encoding") != "" {
			if decoded, ok := decode(x.Response.Headers, resBody, min(maxBodyFile, remaining)); ok {
				resBody = decoded
				size = int64(len(decoded))
				binary = !utf8.ValidString(decoded) || strings.IndexByte(decoded, 0) >= 0
				remaining -= len(decoded)
			}
		}
		content := map[string]any{"size": size, "mimeType": http.Header(x.Response.Headers).Get("Content-Type"), "text": resBody, "_incomplete": x.Response.Truncated && !x.Response.Archived}
		if binary || !utf8.ValidString(resBody) {
			content["encoding"] = "base64"
			content["text"] = base64.StdEncoding.EncodeToString([]byte(resBody))
		}
		resp := map[string]any{"status": e.Status, "statusText": http.StatusText(e.Status), "headers": pairs(x.Response.Headers), "cookies": []any{}, "content": content, "redirectURL": http.Header(x.Response.Headers).Get("Location"), "headersSize": -1, "bodySize": e.Received}
		resp["httpVersion"] = version
		item := map[string]any{"startedDateTime": e.Started, "time": e.Duration, "request": req, "response": resp, "cache": map[string]any{}, "timings": harTimings(x.Timings, e.Duration)}
		if ext := (harExtension{Stream: e.Stream, Process: e.Process, Error: e.Error, Rule: e.Rule, Rewritten: e.Rewritten, Local: e.Local, Frames: x.Frames, Timings: x.Timings}); ext.Stream != "" || ext.Process != "" || ext.Error != "" || ext.Rule != "" || ext.Rewritten != "" || ext.Local || len(ext.Frames) > 0 || ext.Timings != nil {
			item["_kurlo"] = ext
		}
		entries = append(entries, item)
	}
	if len(selected) > 0 {
		return "", errors.New("some selected entries have expired; refresh the capture")
	}
	b, err := json.Marshal(map[string]any{"log": map[string]any{"version": "1.2", "creator": map[string]string{"name": "Kurlo", "version": "1"}, "entries": entries}})
	return string(b), err
}

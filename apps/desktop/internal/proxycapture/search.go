package proxycapture

import (
	"net/http"
	"sort"
	"strings"
)

const searchDecodeLimit = 256 << 10

type SearchHit struct {
	ID    int64    `json:"id"`
	Where []string `json:"where"`
}

func (r *Recorder) Clear() Status {
	r.mu.Lock()
	if r.files != nil {
		for _, x := range r.snapshotLocked() {
			r.files.remove(x.Request.file)
			r.files.remove(x.Response.file)
		}
	}
	r.ring = [capacity]*Exchange{}
	r.count = 0
	r.cursor = 0
	r.source = ""
	s := r.run
	status := r.status()
	r.mu.Unlock()
	if s != nil {
		s.changed()
	}
	return status
}

func (r *Recorder) Delete(ids []int64) Status {
	selected := make(map[int64]bool, len(ids))
	for _, id := range ids {
		selected[id] = true
	}
	r.mu.Lock()
	removed := false
	for i, x := range r.ring {
		if x != nil && selected[x.Entry.ID] {
			if r.files != nil {
				r.files.remove(x.Request.file)
				r.files.remove(x.Response.file)
			}
			r.ring[i] = nil
			removed = true
		}
	}
	s := r.run
	status := r.status()
	r.mu.Unlock()
	if removed && s != nil {
		s.changed()
	}
	return status
}

func (r *Recorder) Search(query string, decode func(http.Header, string, int) (string, bool)) []SearchHit {
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return []SearchHit{}
	}
	r.mu.Lock()
	items := r.snapshotLocked()
	r.mu.Unlock()
	hits := []SearchHit{}
	for _, x := range items {
		where := []string{}
		if headersContain(x.Request.Headers, needle) {
			where = append(where, "request headers")
		}
		if messageContains(x.Request, needle, decode) {
			where = append(where, "request body")
		}
		if headersContain(x.Response.Headers, needle) {
			where = append(where, "response headers")
		}
		if messageContains(x.Response, needle, decode) {
			where = append(where, "response body")
		}
		for _, frame := range x.Frames {
			if strings.Contains(strings.ToLower(frame.Text), needle) {
				where = append(where, "messages")
				break
			}
		}
		if len(where) > 0 {
			hits = append(hits, SearchHit{ID: x.Entry.ID, Where: where})
		}
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].ID < hits[j].ID })
	return hits
}

func headersContain(headers map[string][]string, needle string) bool {
	for key, values := range headers {
		if strings.Contains(strings.ToLower(key), needle) {
			return true
		}
		for _, value := range values {
			if strings.Contains(strings.ToLower(value), needle) {
				return true
			}
		}
	}
	return false
}

func messageContains(m Message, needle string, decode func(http.Header, string, int) (string, bool)) bool {
	if !m.Binary {
		return strings.Contains(strings.ToLower(m.Body), needle)
	}
	headers := http.Header(m.Headers)
	if decode == nil || headers.Get("Content-Encoding") == "" || len(m.raw) == 0 {
		return false
	}
	text, ok := decode(headers, string(m.raw), searchDecodeLimit)
	return ok && strings.Contains(strings.ToLower(text), needle)
}

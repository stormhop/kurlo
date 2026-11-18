package proxycapture

import (
	"context"
	"crypto/sha256"
	"errors"

	"io"
	"math/rand/v2"
	"net/http"
	"strings"
	"time"
)

type LocalResponse struct {
	Pause        bool   `json:"pause"`
	Script       string `json:"script"`
	EntryID      int64  `json:"entryId"`
	Status       int    `json:"status"`
	ContentType  string `json:"contentType"`
	Body         string `json:"body"`
	RateKiB      int    `json:"rateKiB"`
	DelayMs      int    `json:"delayMs"`
	ErrorPercent int    `json:"errorPercent"`
}

type localRoute [32]byte

func routeFor(r *http.Request) localRoute {
	return sha256.Sum256([]byte(r.Method + " " + r.URL.String()))
}

func (r *Recorder) SetLocalResponse(config LocalResponse) error {
	if config.RateKiB < 0 || config.RateKiB > 16384 || config.Status < 200 || config.Status > 599 || config.DelayMs < 0 || config.DelayMs > 30000 || config.ErrorPercent < 0 || config.ErrorPercent > 100 {
		return errors.New("invalid local response status, delay or error rate")
	}
	if len(config.Script) > 16<<10 || len(config.Body) > 1<<20 || len(config.ContentType) > 256 || strings.ContainsAny(config.ContentType, "\r\n") {
		return errors.New("invalid local response content")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.run
	if s != nil && s.browserClose != nil {
		return errors.New("local response rules require a proxy session")
	}
	if s == nil {
		return errors.New("start a capture first")
	}
	for _, x := range r.ring {
		if x != nil && x.Entry.ID == config.EntryID && x.Entry.Method != "CONNECT" {
			s.mu.Lock()
			defer s.mu.Unlock()
			key := x.route
			if _, ok := s.rules[key]; !ok && len(s.rules) >= 32 {
				return errors.New("the session already has 32 local responses")
			}
			s.rules[key] = config
			return nil
		}
	}
	return errors.New("select an available HTTP entry")
}

func (r *Recorder) ClearLocalResponses() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s := r.run; s != nil {
		s.mu.Lock()
		clear(s.rules)
		s.mu.Unlock()
	}
}

func (s *session) serveLocal(w http.ResponseWriter, r *http.Request, x *Exchange) bool {
	s.mu.Lock()
	rule, ok := s.rules[routeFor(r)]
	s.mu.Unlock()
	if !ok {
		return false
	}
	x.Entry.Local = true
	var request preview
	request.files = s.files
	if r.Body != nil {
		_, err := io.Copy(&request, r.Body)
		if err != nil {
			x.Entry.Error = "Incomplete request body"
		}
	}
	x.Request, x.Entry.Sent = request.message(copyHeaders(r.Header))
	if x.Entry.Error == "Incomplete request body" {
		x.Request.Truncated = true
	}
	if rule.DelayMs > 0 {
		timer := time.NewTimer(time.Duration(rule.DelayMs) * time.Millisecond)
		defer timer.Stop()
		select {
		case <-r.Context().Done():
			x.Entry.Error = "Client disconnected"
			return true
		case <-timer.C:
		}
	}
	status, body := rule.Status, rule.Body
	if rule.ErrorPercent > 0 && rand.IntN(100) < rule.ErrorPercent {
		status, body = 503, "Simulated service unavailable"
	}
	if rule.Script != "" {
		var err error
		status, body, err = runLocalHooks(rule.Script, r, status, body)
		if err != nil {
			status, body = 500, "Local response hook failed"
			x.Entry.Error = err.Error()
		}
	}
	if rule.Pause {
		var err error
		status, body, err = s.pause(r.Context(), x.Entry, status, body)
		if err != nil {
			x.Entry.Error = err.Error()
			return true
		}
	}
	if r.Method == "HEAD" || status == 204 || status == 205 || status == 304 {
		body = ""
	}
	w.Header().Set("Content-Type", rule.ContentType)
	w.WriteHeader(status)
	n, writeErr := writeLocalBody(r.Context(), w, body, rule.RateKiB)
	if writeErr != nil {
		x.Entry.Error = "Incomplete local response"
	}
	x.Entry.Status = status
	x.Entry.Received = int64(n)
	response := preview{files: s.files}
	io.WriteString(&response, body[:n])
	x.Response, _ = response.message(copyHeaders(w.Header()))
	return true
}

func writeLocalBody(ctx context.Context, w http.ResponseWriter, body string, rateKiB int) (int, error) {
	if rateKiB == 0 || len(body) == 0 {
		return io.WriteString(w, body)
	}
	bytesPerSecond := rateKiB * 1024
	chunk := min(16<<10, max(1, bytesPerSecond/10))
	start := time.Now()
	written := 0
	for written < len(body) {
		end := min(len(body), written+chunk)
		due := start.Add(time.Duration(end) * time.Second / time.Duration(bytesPerSecond))
		timer := time.NewTimer(time.Until(due))
		select {
		case <-ctx.Done():
			timer.Stop()
			return written, ctx.Err()
		case <-timer.C:
		}
		n, err := io.WriteString(w, body[written:end])
		written += n
		if err != nil {
			return written, err
		}
		if n == 0 {
			return written, io.ErrShortWrite
		}
		if err := http.NewResponseController(w).Flush(); err != nil {
			return written, err
		}
	}
	return written, nil
}

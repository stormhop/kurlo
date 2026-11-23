package proxycapture

import (
	"context"
	"io"
	"math/rand/v2"
	"net/http"
	"time"
)

func (s *session) serveLocal(w http.ResponseWriter, r *http.Request, x *Exchange) bool {
	matches := s.rules.matching(RuleLocal, r)
	if len(matches) == 0 {
		return false
	}
	match := matches[0]
	match.hits.Add(1)
	rule := match.Local
	x.Entry.Local = true
	x.Entry.Rule = ruleNames(matches[:1])
	var request preview
	if s.includes(r.URL.Hostname()) {
		request.files = s.files
	}
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
	response := preview{}
	if s.includes(r.URL.Hostname()) {
		response.files = s.files
	}
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

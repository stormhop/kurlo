package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/script"
)

const (
	scriptSendTimeout       = 30 * time.Second
	scriptSendMaxBodyBytes  = 8 * 1024 * 1024
	scriptSendMaxRedirects  = 5
	scriptSendMaxHeaderSize = 64 * 1024
)

func newScriptSender(parent context.Context, allow bool, transportCfg model.HttpRequest) script.SendFunc {
	if !allow {
		return nil
	}
	return func(req script.SendRequest) script.SendResponse {
		return performScriptSend(parent, req, transportCfg)
	}
}

func scriptSendTimeoutMessage(timeout time.Duration) string {
	if timeout > 0 {
		return "script timed out after " + timeout.String()
	}
	return "script timed out"
}

func performScriptSend(parent context.Context, req script.SendRequest, transportCfg model.HttpRequest) script.SendResponse {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}

	target := normalizeRequestURL(strings.TrimSpace(req.URL))
	if strings.Contains(target, "{{") {
		return script.SendResponse{Error: "pm.sendRequest URL contains an unresolved {{variable}}"}
	}
	parsed, err := url.Parse(target)
	if err != nil {
		return script.SendResponse{Error: fmt.Sprintf("pm.sendRequest: invalid URL: %s", err)}
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return script.SendResponse{Error: fmt.Sprintf("pm.sendRequest: unsupported URL scheme %q (use http:// or https://)", parsed.Scheme)}
	}
	if parsed.Host == "" {
		return script.SendResponse{Error: "pm.sendRequest: invalid URL: missing host"}
	}

	if parent == nil {
		parent = context.Background()
	}
	sendTimeout := scriptSendTimeout
	limitedByScript := false
	if !req.Deadline.IsZero() {
		remaining := time.Until(req.Deadline)
		if remaining <= 0 {
			return script.SendResponse{Error: scriptSendTimeoutMessage(req.ScriptTimeout)}
		}
		if remaining < sendTimeout {
			sendTimeout = remaining
			limitedByScript = true
		}
	}
	ctx, cancel := context.WithTimeout(parent, sendTimeout)
	defer cancel()

	var body io.Reader
	if req.Body != "" {
		body = strings.NewReader(req.Body)
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return script.SendResponse{Error: "pm.sendRequest: " + err.Error()}
	}

	headerBytes := 0
	for key, value := range req.Headers {
		if key == "" {
			continue
		}
		headerBytes += len(key) + len(value)
		if headerBytes > scriptSendMaxHeaderSize {
			return script.SendResponse{Error: "pm.sendRequest: headers are too large"}
		}
		httpReq.Header.Set(key, value)
	}
	if req.Body != "" && httpReq.Header.Get("Content-Type") == "" {
		httpReq.Header.Set("Content-Type", "text/plain; charset=utf-8")
	}

	client := &http.Client{
		Transport: sharedHTTPTransport(transportCfg),
		Timeout:   scriptSendTimeout,
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) >= scriptSendMaxRedirects {
				return fmt.Errorf("stopped after %d redirects", scriptSendMaxRedirects)
			}
			return nil
		},
	}

	start := time.Now()
	resp, err := client.Do(httpReq)
	if err != nil {
		if limitedByScript && (errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded)) {
			return script.SendResponse{Error: scriptSendTimeoutMessage(req.ScriptTimeout)}
		}
		return script.SendResponse{Error: "pm.sendRequest: " + err.Error()}
	}
	defer resp.Body.Close()

	raw, truncated, readErr := readResponseBodyWithLimit(resp.Body, scriptSendMaxBodyBytes)
	if readErr != nil {
		if limitedByScript && errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return script.SendResponse{Error: scriptSendTimeoutMessage(req.ScriptTimeout)}
		}
		return script.SendResponse{Error: "pm.sendRequest: failed to read response: " + readErr.Error()}
	}
	elapsed := time.Since(start)

	raw, _ = decodeResponseBody(raw, resp)

	headers := make(map[string]string, len(resp.Header))
	for key := range resp.Header {
		headers[key] = resp.Header.Get(key)
	}

	out := script.SendResponse{
		StatusCode: resp.StatusCode,
		Status:     resp.Status,
		Headers:    headers,
		Body:       string(raw),
		DurationMs: elapsed.Milliseconds(),
		Size:       int64(len(raw)),
	}
	if truncated {
		out.Body += fmt.Sprintf("\n... [pm.sendRequest response truncated at %d MB]", scriptSendMaxBodyBytes/(1024*1024))
	}
	return out
}

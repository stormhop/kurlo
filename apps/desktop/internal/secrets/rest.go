package secrets

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxEntries = 1000

type Entry struct {
	Name   string `json:"name"`
	Path   string `json:"path,omitempty"`
	Field  string `json:"field,omitempty"`
	Browse string `json:"browse,omitempty"`
	Detail string `json:"detail,omitempty"`
}

type Lister interface {
	List(ctx context.Context, prefix string) ([]Entry, error)
}

func newRESTClient(config ProviderConfig) *http.Client {
	return &http.Client{Timeout: config.Timeout}
}

func restCall(ctx context.Context, client *http.Client, provider, method, endpoint string, headers map[string]string, body io.Reader) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, 0, newError(KindInvalidRef, provider, "invalid address or path")
	}
	req.Header.Set("Accept", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, transportError(provider, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxVaultResponseBytes))
	if err != nil {
		return nil, 0, transportError(provider, err)
	}
	return data, resp.StatusCode, nil
}

func statusKindError(provider string, status int, message, path string) error {
	if status >= 200 && status < 300 {
		return nil
	}
	if message == "" {
		message = "HTTP " + http.StatusText(status)
	}
	switch status {
	case http.StatusUnauthorized:
		return newError(KindNotAuthenticated, provider, "%s", message)
	case http.StatusForbidden:
		return newError(KindForbidden, provider, "%s", message)
	case http.StatusNotFound:
		return newError(KindNotFound, provider, "no secret at %s", path)
	default:
		return newError(KindUnavailable, provider, "%s", message)
	}
}

func listPermissionError(provider string, err error) error {
	return newError(KindForbidden, provider, "secret listing is forbidden: %v; a known secret may still be readable, so test a specific path", err)
}

type tokenCache struct {
	mu      sync.Mutex
	token   string
	source  string
	expires time.Time
}

func (c *tokenCache) get(now time.Time) (string, string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token == "" || (!c.expires.IsZero() && !now.Before(c.expires)) {
		return "", "", false
	}
	return c.token, c.source, true
}

func (c *tokenCache) set(token, source string, expires time.Time) {
	c.mu.Lock()
	c.token, c.source, c.expires = token, source, expires
	c.mu.Unlock()
}

func (c *tokenCache) clear() {
	c.mu.Lock()
	c.token, c.source, c.expires = "", "", time.Time{}
	c.mu.Unlock()
}

func expiryWithMargin(now time.Time, seconds int64) time.Time {
	if seconds <= 0 {
		return now.Add(10 * time.Minute)
	}
	lifetime := time.Duration(seconds) * time.Second
	margin := lifetime / 10
	if margin > time.Minute {
		margin = time.Minute
	}
	return now.Add(lifetime - margin)
}

type oauthTokenResponse struct {
	AccessToken      string `json:"access_token"`
	ExpiresIn        any    `json:"expires_in"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

func (r oauthTokenResponse) expiresIn() int64 {
	switch value := r.ExpiresIn.(type) {
	case float64:
		return int64(value)
	case string:
		var seconds int64
		for _, ch := range value {
			if ch < '0' || ch > '9' {
				return 0
			}
			seconds = seconds*10 + int64(ch-'0')
		}
		return seconds
	}
	return 0
}

func postTokenForm(ctx context.Context, client *http.Client, provider, endpoint string, form url.Values) (oauthTokenResponse, error) {
	data, status, err := restCall(ctx, client, provider, http.MethodPost, endpoint, map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, strings.NewReader(form.Encode()))
	if err != nil {
		return oauthTokenResponse{}, err
	}
	var decoded oauthTokenResponse
	_ = json.Unmarshal(data, &decoded)
	if status < 200 || status >= 300 || decoded.AccessToken == "" {
		message := strings.TrimSpace(decoded.Error + ": " + decoded.ErrorDescription)
		message = strings.Trim(message, ": ")
		if message == "" {
			message = "HTTP " + http.StatusText(status)
		}
		if len(message) > 300 {
			message = message[:300] + "…"
		}
		if status >= 500 {
			return oauthTokenResponse{}, newError(KindUnavailable, provider, "sign-in failed: %s", message)
		}
		return oauthTokenResponse{}, newError(KindNotAuthenticated, provider, "sign-in failed: %s", message)
	}
	return decoded, nil
}

func capEntries(entries []Entry) []Entry {
	if len(entries) > maxEntries {
		return entries[:maxEntries]
	}
	return entries
}

func shortText(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > 300 {
		return text[:300] + "…"
	}
	return text
}

func sortEntries(entries []Entry) {
	sort.Slice(entries, func(i, j int) bool { return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name) })
}

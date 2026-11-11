package api

import (
	"net/http"
	"sort"
	"sync"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type sentRequestRecorder struct {
	base http.RoundTripper

	mu       sync.Mutex
	requests []model.SentRequest
	secrets  []string
}

type ntlmHandshakeRecorder struct {
	base     http.RoundTripper
	recorder *sentRequestRecorder
	jar      http.CookieJar
}

func (s *ntlmHandshakeRecorder) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	if s.jar != nil {
		cookieSource := s.jar
		if browserJar, ok := cookieSource.(browserCredentialsJar); ok {
			cookieSource = browserJar.jar
		}
		if _, receiveOnly := cookieSource.(receiveOnlyCookieJar); !receiveOnly {
			req.Header.Del("Cookie")
			for _, cookie := range s.jar.Cookies(req.URL) {
				req.AddCookie(cookie)
			}
		}
	}
	s.recorder.record(req)
	resp, err := s.base.RoundTrip(req)
	if resp != nil && s.jar != nil {
		s.jar.SetCookies(req.URL, resp.Cookies())
	}
	return resp, err
}

func newSentRequestRecorder(base http.RoundTripper, secrets []string) *sentRequestRecorder {
	return &sentRequestRecorder{base: base, secrets: secrets}
}

func (s *sentRequestRecorder) RoundTrip(req *http.Request) (*http.Response, error) {
	s.record(req)
	return s.base.RoundTrip(req)
}

func (s *sentRequestRecorder) record(req *http.Request) {
	if req == nil {
		return
	}
	proto := req.Proto
	if proto == "" {
		proto = "HTTP/1.1"
	}
	url := ""
	if req.URL != nil {
		url = req.URL.String()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, model.SentRequest{
		Method:  req.Method,
		URL:     redactSecrets(url, s.secrets),
		Proto:   proto,
		Headers: redactedHeaderRows(req.Header, s.secrets),
	})
}

func (s *sentRequestRecorder) snapshot() []model.SentRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.requests) == 0 {
		return nil
	}
	out := make([]model.SentRequest, len(s.requests))
	copy(out, s.requests)
	return out
}

func redactedHeaderRows(headers http.Header, secrets []string) []model.KeyValue {
	rows := make([]model.KeyValue, 0, len(headers))
	for key, values := range headers {
		for _, value := range values {
			rows = append(rows, model.KeyValue{
				Key:     key,
				Value:   redactSecrets(value, secrets),
				Enabled: true,
			})
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Key == rows[j].Key {
			return rows[i].Value < rows[j].Value
		}
		return rows[i].Key < rows[j].Key
	})
	return rows
}

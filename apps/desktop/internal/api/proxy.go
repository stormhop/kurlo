package api

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/proxycapture"
)

func requestUsesProxy(req model.HttpRequest, httpReq *http.Request) bool {
	proxy := proxyForRequest(req)
	if proxy == nil || httpReq == nil {
		return false
	}
	proxyURL, err := proxy(httpReq)
	return err == nil && proxyURL != nil
}

func proxyForRequest(req model.HttpRequest) func(*http.Request) (*url.URL, error) {
	switch strings.ToLower(strings.TrimSpace(req.ProxyMode)) {
	case "off":
		return nil
	case "system":
		return systemProxyForRequest
	case "on":

	default:
		if strings.TrimSpace(req.ProxyURL) == "" {
			return systemProxyForRequest
		}
	}

	rawURL := strings.TrimSpace(req.ProxyURL)
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return func(*http.Request) (*url.URL, error) {
			if rawURL == "" {
				return nil, fmt.Errorf("proxy is enabled but no proxy URL is configured")
			}
			return nil, fmt.Errorf("invalid proxy URL %q", redactProxyURL(rawURL))
		}
	}

	bypass := parseProxyBypass(req.ProxyBypass)
	if len(bypass) == 0 {
		return http.ProxyURL(parsed)
	}
	return func(r *http.Request) (*url.URL, error) {
		if r != nil && r.URL != nil && hostMatchesProxyBypass(r.URL.Hostname(), bypass) {
			return nil, nil
		}
		return parsed, nil
	}
}

func systemProxyForRequest(req *http.Request) (*url.URL, error) {
	u, err := http.ProxyFromEnvironment(req)
	if err == nil && proxycapture.IsActiveAddress(u) {
		return nil, nil
	}
	return u, err
}

func redactProxyURL(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return s
	}
	scheme := ""
	rest := s
	if i := strings.Index(s, "://"); i >= 0 {
		scheme = s[:i+3]
		rest = s[i+3:]
	}
	authEnd := strings.IndexAny(rest, "/?#")
	if authEnd < 0 {
		authEnd = len(rest)
	}
	authority, tail := rest[:authEnd], rest[authEnd:]
	if at := strings.LastIndex(authority, "@"); at >= 0 {
		authority = "***@" + authority[at+1:]
	}
	return scheme + authority + tail
}

func parseProxyBypass(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '\n' || r == '\r' || r == ' ' || r == '\t'
	})
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		if v := strings.ToLower(strings.TrimSpace(field)); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func hostMatchesProxyBypass(host string, bypass []string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return false
	}
	for _, entry := range bypass {
		if entry == "*" {
			return true
		}
		entry = strings.TrimPrefix(strings.TrimPrefix(entry, "*"), ".")
		if entry == "" {
			continue
		}
		if host == entry || strings.HasSuffix(host, "."+entry) {
			return true
		}
	}
	return false
}

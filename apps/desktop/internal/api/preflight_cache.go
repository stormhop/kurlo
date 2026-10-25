package api

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const preflightMaxAgeCap = 300 * time.Second

const preflightCacheLimit = 1024

type preflightCacheEntry struct {
	allowOrigin      string
	allowCredentials bool
	allowMethods     string
	allowHeaders     string
	expiresAt        time.Time
}

type preflightCache struct {
	mu      sync.Mutex
	entries map[string]preflightCacheEntry
	now     func() time.Time
}

func newPreflightCache() *preflightCache {
	return &preflightCache{
		entries: make(map[string]preflightCacheEntry),
		now:     time.Now,
	}
}

func (c *preflightCache) lookup(key string) (preflightCacheEntry, bool) {
	if c == nil {
		return preflightCacheEntry{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return preflightCacheEntry{}, false
	}
	if !c.now().Before(entry.expiresAt) {
		delete(c.entries, key)
		return preflightCacheEntry{}, false
	}
	return entry, true
}

func (c *preflightCache) store(key string, entry preflightCacheEntry) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.entries[key]; !exists && len(c.entries) >= preflightCacheLimit {
		c.evictLocked()
	}
	c.entries[key] = entry
}

func (c *preflightCache) evictLocked() {
	now := c.now()
	for key, entry := range c.entries {
		if !now.Before(entry.expiresAt) {
			delete(c.entries, key)
		}
	}
	for len(c.entries) >= preflightCacheLimit {
		oldestKey := ""
		var oldest time.Time
		for key, entry := range c.entries {
			if oldestKey == "" || entry.expiresAt.Before(oldest) {
				oldestKey, oldest = key, entry.expiresAt
			}
		}
		delete(c.entries, oldestKey)
	}
}

func preflightCacheKey(origin, target string, withCredentials bool) string {
	creds := "0"
	if withCredentials {
		creds = "1"
	}
	return origin + "\x00" + target + "\x00" + creds
}

func cachePreflightResponse(c *preflightCache, key string, resp *http.Response) {
	if c == nil || resp == nil {
		return
	}
	maxAge := parsePreflightMaxAge(resp.Header.Get("Access-Control-Max-Age"))
	if maxAge <= 0 {
		return
	}
	if maxAge > preflightMaxAgeCap {
		maxAge = preflightMaxAgeCap
	}
	entry := preflightCacheEntry{
		allowOrigin:      strings.TrimSpace(resp.Header.Get("Access-Control-Allow-Origin")),
		allowCredentials: strings.EqualFold(strings.TrimSpace(resp.Header.Get("Access-Control-Allow-Credentials")), "true"),
		allowMethods:     resp.Header.Get("Access-Control-Allow-Methods"),
		allowHeaders:     resp.Header.Get("Access-Control-Allow-Headers"),
		expiresAt:        c.now().Add(maxAge),
	}
	c.store(key, entry)
}

func parsePreflightMaxAge(raw string) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds <= 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

func preflightCacheCovers(entry preflightCacheEntry, method string, requestHeaders []string, ctx browserSecurityContext) bool {
	if entry.allowOrigin == "" {
		return false
	}
	if ctx.withCredentials && entry.allowOrigin == "*" {
		return false
	}
	if entry.allowOrigin != "*" && entry.allowOrigin != ctx.origin {
		return false
	}
	if ctx.withCredentials && !entry.allowCredentials {
		return false
	}
	if !isSimpleCORSMethod(method) && !corsHeaderAllowsToken(entry.allowMethods, method, !ctx.withCredentials) {
		return false
	}
	for _, header := range requestHeaders {
		if !corsHeaderAllowsToken(entry.allowHeaders, header, !ctx.withCredentials) {
			return false
		}
	}
	return true
}

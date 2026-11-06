package api

import (
	"errors"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"golang.org/x/net/publicsuffix"
)

type trackedCookieJar struct {
	mu      sync.Mutex
	jar     http.CookieJar
	cookies map[string]model.Cookie
}

type receiveOnlyCookieJar struct {
	jar http.CookieJar
}

func (j receiveOnlyCookieJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	if j.jar != nil {
		j.jar.SetCookies(u, cookies)
	}
}

func (j receiveOnlyCookieJar) Cookies(*url.URL) []*http.Cookie {
	return nil
}

func newTrackedCookieJar() *trackedCookieJar {
	return &trackedCookieJar{
		jar:     newHTTPCookieJar(),
		cookies: make(map[string]model.Cookie),
	}
}

type cookieJarRegistry struct {
	mu   sync.Mutex
	jars map[string]*trackedCookieJar
}

func newCookieJarRegistry() *cookieJarRegistry {
	return &cookieJarRegistry{jars: make(map[string]*trackedCookieJar)}
}

func normalizeWorkspaceID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return "__default__"
	}
	return id
}

func (r *cookieJarRegistry) jar(workspaceID string) *trackedCookieJar {
	if r == nil {
		return nil
	}
	key := normalizeWorkspaceID(workspaceID)
	r.mu.Lock()
	defer r.mu.Unlock()
	jar, ok := r.jars[key]
	if !ok {
		jar = newTrackedCookieJar()
		r.jars[key] = jar
	}
	return jar
}

func singleJarRegistry(jar *trackedCookieJar) *cookieJarRegistry {
	r := newCookieJarRegistry()
	if jar != nil {
		r.jars[normalizeWorkspaceID("")] = jar
	}
	return r
}

func newHTTPCookieJar() http.CookieJar {
	jar, _ := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
	return jar
}

func (j *trackedCookieJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	j.mu.Lock()
	defer j.mu.Unlock()

	j.jar.SetCookies(u, cookies)
	now := time.Now()
	for _, cookie := range cookies {
		j.trackCookieLocked(u, cookie, now)
	}
	j.pruneExpiredLocked(now)
}

func (j *trackedCookieJar) Cookies(u *url.URL) []*http.Cookie {
	j.mu.Lock()
	defer j.mu.Unlock()

	j.pruneExpiredLocked(time.Now())
	cookies := j.jar.Cookies(u)
	sendable := cookies[:0]
	for _, cookie := range cookies {
		if _, unresolved := kurloSecretKeyFromPlaceholder(cookie.Value); unresolved {
			continue
		}
		sendable = append(sendable, cookie)
	}
	return sendable
}

func (j *trackedCookieJar) ListCookies() []model.Cookie {
	j.mu.Lock()
	defer j.mu.Unlock()

	j.pruneExpiredLocked(time.Now())
	return sortedCookies(j.cookies)
}

func (j *trackedCookieJar) UpsertCookie(cookie model.Cookie) ([]model.Cookie, error) {
	j.mu.Lock()
	defer j.mu.Unlock()

	next, err := normalizeEditableCookie(cookie, time.Now())
	if err != nil {
		return sortedCookies(j.cookies), err
	}
	j.cookies[cookieMapKey(next)] = next
	j.rebuildLocked()
	return sortedCookies(j.cookies), nil
}

func (j *trackedCookieJar) DeleteCookie(cookie model.Cookie) []model.Cookie {
	j.mu.Lock()
	defer j.mu.Unlock()

	delete(j.cookies, cookieMapKey(cookie))
	j.rebuildLocked()
	return sortedCookies(j.cookies)
}

func (j *trackedCookieJar) ClearCookies() []model.Cookie {
	j.mu.Lock()
	defer j.mu.Unlock()

	j.jar = newHTTPCookieJar()
	j.cookies = make(map[string]model.Cookie)
	return []model.Cookie{}
}

func (j *trackedCookieJar) trackCookieLocked(u *url.URL, cookie *http.Cookie, now time.Time) {
	if cookie == nil || cookie.Name == "" || u == nil {
		return
	}
	domain, hostOnly := normalizeCookieDomain(u, cookie.Domain)
	path := cookie.Path
	if path == "" {
		path = defaultCookiePath(u.Path)
	}
	expiresAt := int64(0)
	session := cookie.Expires.IsZero() && cookie.MaxAge == 0
	if !cookie.Expires.IsZero() {
		expiresAt = cookie.Expires.UnixMilli()
		session = false
	}
	if cookie.MaxAge > 0 {
		expiresAt = now.Add(time.Duration(cookie.MaxAge) * time.Second).UnixMilli()
		session = false
	}
	entry := model.Cookie{
		Name:      cookie.Name,
		Value:     cookie.Value,
		Domain:    domain,
		Path:      path,
		ExpiresAt: expiresAt,
		Session:   session,
		Secure:    cookie.Secure,
		HTTPOnly:  cookie.HttpOnly,
		SameSite:  sameSiteToString(cookie.SameSite),
		HostOnly:  hostOnly,
		UpdatedAt: now.UnixMilli(),
	}
	key := cookieMapKey(entry)
	if !j.responseCookieAcceptedLocked(u, cookie, entry, now) {
		return
	}
	if cookie.MaxAge < 0 || (!cookie.Expires.IsZero() && cookie.Expires.Before(now)) {
		delete(j.cookies, key)
		return
	}
	if existing, ok := j.cookies[key]; ok && existing.CreatedAt > 0 {
		entry.CreatedAt = existing.CreatedAt
	} else {
		entry.CreatedAt = entry.UpdatedAt
	}
	j.cookies[key] = entry
}

func (j *trackedCookieJar) pruneExpiredLocked(now time.Time) {
	changed := false
	for key, cookie := range j.cookies {
		if cookie.Session || cookie.ExpiresAt <= 0 {
			continue
		}
		if time.UnixMilli(cookie.ExpiresAt).Before(now) {
			delete(j.cookies, key)
			changed = true
		}
	}
	if changed {
		j.rebuildLocked()
	}
}

func (j *trackedCookieJar) rebuildLocked() {
	jar := newHTTPCookieJar()
	for _, cookie := range j.cookies {
		u := cookieURL(cookie)
		jar.SetCookies(u, []*http.Cookie{httpCookie(cookie)})
	}
	j.jar = jar
}

func (j *trackedCookieJar) responseCookieAcceptedLocked(u *url.URL, cookie *http.Cookie, entry model.Cookie, now time.Time) bool {
	probe := *cookie
	if probe.MaxAge < 0 || (!probe.Expires.IsZero() && probe.Expires.Before(now)) {
		probe.MaxAge = 3600
		probe.Expires = time.Time{}
	}
	jar := newHTTPCookieJar()
	jar.SetCookies(u, []*http.Cookie{&probe})
	for _, accepted := range jar.Cookies(cookieURL(entry)) {
		if accepted.Name == cookie.Name {
			return true
		}
	}
	return false
}

func normalizeEditableCookie(cookie model.Cookie, now time.Time) (model.Cookie, error) {
	cookie.Name = strings.TrimSpace(cookie.Name)
	cookie.Domain = strings.Trim(strings.ToLower(strings.TrimSpace(cookie.Domain)), ".")
	cookie.Path = strings.TrimSpace(cookie.Path)
	cookie.SameSite = normalizeSameSite(cookie.SameSite)
	if cookie.Name == "" {
		return cookie, errors.New("cookie name is required")
	}
	if cookie.Domain == "" {
		return cookie, errors.New("cookie domain is required")
	}
	if cookie.Path == "" {
		cookie.Path = "/"
	}
	if !strings.HasPrefix(cookie.Path, "/") {
		cookie.Path = "/" + cookie.Path
	}
	if cookie.Session {
		cookie.ExpiresAt = 0
	}
	if cookie.CreatedAt <= 0 {
		cookie.CreatedAt = now.UnixMilli()
	}
	cookie.UpdatedAt = now.UnixMilli()
	return cookie, nil
}

func normalizeCookieDomain(u *url.URL, domain string) (string, bool) {
	domain = strings.Trim(strings.ToLower(strings.TrimSpace(domain)), ".")
	if domain == "" {
		return strings.ToLower(u.Hostname()), true
	}
	return domain, false
}

func defaultCookiePath(path string) string {
	if path == "" || !strings.HasPrefix(path, "/") {
		return "/"
	}
	lastSlash := strings.LastIndex(path, "/")
	if lastSlash <= 0 {
		return "/"
	}
	return path[:lastSlash]
}

func cookieMapKey(cookie model.Cookie) string {
	return strings.Join([]string{
		strings.ToLower(strings.Trim(cookie.Domain, ".")),
		cookie.Path,
		cookie.Name,
		boolKey(cookie.HostOnly),
	}, "\x1f")
}

func boolKey(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

func sortedCookies(cookies map[string]model.Cookie) []model.Cookie {
	out := make([]model.Cookie, 0, len(cookies))
	for _, cookie := range cookies {
		out = append(out, cookie)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Domain != out[j].Domain {
			return out[i].Domain < out[j].Domain
		}
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func cookieURL(cookie model.Cookie) *url.URL {
	scheme := "http"
	if cookie.Secure {
		scheme = "https"
	}
	path := cookie.Path
	if path == "" {
		path = "/"
	}
	return &url.URL{Scheme: scheme, Host: strings.Trim(cookie.Domain, "."), Path: path}
}

func httpCookie(cookie model.Cookie) *http.Cookie {
	out := &http.Cookie{
		Name:     cookie.Name,
		Value:    cookie.Value,
		Path:     cookie.Path,
		Secure:   cookie.Secure,
		HttpOnly: cookie.HTTPOnly,
		SameSite: sameSiteFromString(cookie.SameSite),
	}
	if !cookie.HostOnly {
		out.Domain = strings.Trim(cookie.Domain, ".")
	}
	if !cookie.Session && cookie.ExpiresAt > 0 {
		out.Expires = time.UnixMilli(cookie.ExpiresAt)
	}
	return out
}

func sameSiteToString(value http.SameSite) string {
	switch value {
	case http.SameSiteStrictMode:
		return "strict"
	case http.SameSiteLaxMode:
		return "lax"
	case http.SameSiteNoneMode:
		return "none"
	default:
		return ""
	}
}

func sameSiteFromString(value string) http.SameSite {
	switch normalizeSameSite(value) {
	case "strict":
		return http.SameSiteStrictMode
	case "lax":
		return http.SameSiteLaxMode
	case "none":
		return http.SameSiteNoneMode
	default:
		return http.SameSiteDefaultMode
	}
}

func normalizeSameSite(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "strict", "lax", "none":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return ""
	}
}

func cookieDomainAllowed(domain string, allowed []string) bool {
	domain = strings.Trim(strings.ToLower(strings.TrimSpace(domain)), ".")
	if domain == "" {
		return false
	}
	for _, candidate := range allowed {
		if candidate == "" {
			continue
		}
		if domain == candidate || strings.HasSuffix(domain, "."+candidate) {
			return true
		}
	}
	return false
}

func (j *trackedCookieJar) ApplySyncedCookie(domains []string, cookie model.Cookie, removed bool) bool {
	j.mu.Lock()
	defer j.mu.Unlock()

	if !cookieDomainAllowed(cookie.Domain, domains) {
		return false
	}
	now := time.Now()
	next, err := normalizeEditableCookie(cookie, now)
	if err != nil {
		return false
	}
	key := cookieMapKey(next)
	if removed {
		if _, ok := j.cookies[key]; !ok {
			return false
		}
		delete(j.cookies, key)
		j.rebuildLocked()
		return true
	}
	if !next.Session && next.ExpiresAt > 0 && time.UnixMilli(next.ExpiresAt).Before(now) {
		if _, ok := j.cookies[key]; !ok {
			return false
		}
		delete(j.cookies, key)
		j.rebuildLocked()
		return true
	}
	if earlier, ok := j.cookies[key]; ok && earlier.CreatedAt > 0 {
		next.CreatedAt = earlier.CreatedAt
	}
	j.cookies[key] = next
	j.rebuildLocked()
	return true
}

func (j *trackedCookieJar) SyncCookies(domains []string, cookies []model.Cookie) (accepted int, removed int) {
	j.mu.Lock()
	defer j.mu.Unlock()

	now := time.Now()
	previous := make(map[string]model.Cookie)
	for key, existing := range j.cookies {
		if cookieDomainAllowed(existing.Domain, domains) {
			previous[key] = existing
			delete(j.cookies, key)
		}
	}
	for _, cookie := range cookies {
		next, err := normalizeEditableCookie(cookie, now)
		if err != nil || !cookieDomainAllowed(next.Domain, domains) {
			continue
		}
		if !next.Session && next.ExpiresAt > 0 && time.UnixMilli(next.ExpiresAt).Before(now) {
			continue
		}
		key := cookieMapKey(next)
		if earlier, ok := previous[key]; ok && earlier.CreatedAt > 0 {
			next.CreatedAt = earlier.CreatedAt
			delete(previous, key)
		}
		j.cookies[key] = next
		accepted++
	}
	j.rebuildLocked()
	return accepted, len(previous)
}

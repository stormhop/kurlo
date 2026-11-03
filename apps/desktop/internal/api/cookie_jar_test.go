package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func findCookie(cookies []model.Cookie, name string) (model.Cookie, bool) {
	for _, c := range cookies {
		if c.Name == name {
			return c, true
		}
	}
	return model.Cookie{}, false
}

func TestTrackedJarSetCookiesHostOnly(t *testing.T) {
	jar := newTrackedCookieJar()
	u := mustURL("https://example.com/app/page")
	jar.SetCookies(u, []*http.Cookie{
		{Name: "sid", Value: "abc", Path: "/", Expires: time.Now().Add(time.Hour)},
	})

	c, ok := findCookie(jar.ListCookies(), "sid")
	if !ok {
		t.Fatal("sid cookie not tracked")
	}
	if c.Domain != "example.com" || !c.HostOnly {
		t.Errorf("expected host-only example.com, got domain=%q hostOnly=%v", c.Domain, c.HostOnly)
	}
	if c.Session || c.ExpiresAt <= 0 {
		t.Errorf("expected persistent cookie, got session=%v expiresAt=%d", c.Session, c.ExpiresAt)
	}
	if c.Secure {
		t.Errorf("cookie was not marked Secure but tracked as secure")
	}
}

func TestTrackedJarExplicitDomainNotHostOnly(t *testing.T) {
	jar := newTrackedCookieJar()
	u := mustURL("https://app.example.com/")
	jar.SetCookies(u, []*http.Cookie{
		{Name: "shared", Value: "1", Domain: "example.com", Path: "/"},
	})
	c, ok := findCookie(jar.ListCookies(), "shared")
	if !ok {
		t.Fatal("shared cookie not tracked")
	}
	if c.Domain != "example.com" || c.HostOnly {
		t.Errorf("expected non-host-only example.com, got domain=%q hostOnly=%v", c.Domain, c.HostOnly)
	}
}

func TestTrackedJarSessionVsMaxAge(t *testing.T) {
	jar := newTrackedCookieJar()
	u := mustURL("https://example.com/")
	jar.SetCookies(u, []*http.Cookie{
		{Name: "sess", Value: "x", Path: "/"},
		{Name: "ttl", Value: "y", Path: "/", MaxAge: 3600},
	})
	list := jar.ListCookies()
	sess, _ := findCookie(list, "sess")
	if !sess.Session || sess.ExpiresAt != 0 {
		t.Errorf("expected session cookie, got %+v", sess)
	}
	ttl, _ := findCookie(list, "ttl")
	if ttl.Session || ttl.ExpiresAt <= time.Now().UnixMilli() {
		t.Errorf("expected MaxAge cookie with future expiry, got %+v", ttl)
	}
}

func TestTrackedJarMaxAgeNegativeDeletes(t *testing.T) {
	jar := newTrackedCookieJar()
	u := mustURL("https://example.com/")
	jar.SetCookies(u, []*http.Cookie{{Name: "gone", Value: "1", Path: "/", MaxAge: 3600}})
	if _, ok := findCookie(jar.ListCookies(), "gone"); !ok {
		t.Fatal("cookie should exist before deletion")
	}
	jar.SetCookies(u, []*http.Cookie{{Name: "gone", Value: "1", Path: "/", MaxAge: -1}})
	if _, ok := findCookie(jar.ListCookies(), "gone"); ok {
		t.Fatal("MaxAge<0 should delete the cookie")
	}
}

func TestTrackedJarExpiredNotTracked(t *testing.T) {
	jar := newTrackedCookieJar()
	u := mustURL("https://example.com/")
	jar.SetCookies(u, []*http.Cookie{
		{Name: "old", Value: "1", Path: "/", Expires: time.Now().Add(-time.Hour)},
	})
	if _, ok := findCookie(jar.ListCookies(), "old"); ok {
		t.Fatal("already-expired cookie should not be tracked")
	}
}

func TestTrackedJarDoesNotTrackRejectedResponseCookies(t *testing.T) {
	jar := newTrackedCookieJar()
	u := mustURL("https://example.com/")
	jar.SetCookies(u, []*http.Cookie{
		{Name: "foreign", Value: "1", Domain: "other.example.com", Path: "/"},
		{Name: "suffix", Value: "1", Domain: "com", Path: "/"},
		{Name: "ok", Value: "1", Domain: "example.com", Path: "/"},
	})

	if _, ok := findCookie(jar.ListCookies(), "foreign"); ok {
		t.Fatal("cookie for unrelated domain should not be tracked")
	}
	if _, ok := findCookie(jar.ListCookies(), "suffix"); ok {
		t.Fatal("cookie for public suffix should not be tracked")
	}
	if _, ok := findCookie(jar.ListCookies(), "ok"); !ok {
		t.Fatal("valid domain cookie should be tracked")
	}
}

func TestTrackedJarPrunesExpiredOnList(t *testing.T) {
	jar := newTrackedCookieJar()
	_, err := jar.UpsertCookie(model.Cookie{
		Name:      "stale",
		Value:     "v",
		Domain:    "example.com",
		Path:      "/",
		ExpiresAt: time.Now().Add(-time.Hour).UnixMilli(),
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if _, ok := findCookie(jar.ListCookies(), "stale"); ok {
		t.Fatal("expired cookie should be pruned on ListCookies")
	}
}

func TestTrackedJarUpsertServedByCookies(t *testing.T) {
	jar := newTrackedCookieJar()
	cookies, err := jar.UpsertCookie(model.Cookie{
		Name:    "manual",
		Value:   "yes",
		Domain:  "example.com",
		Path:    "/",
		Session: true,
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if _, ok := findCookie(cookies, "manual"); !ok {
		t.Fatal("upsert should return the new cookie")
	}
	served := jar.Cookies(mustURL("http://example.com/some/path"))
	found := false
	for _, c := range served {
		if c.Name == "manual" && c.Value == "yes" {
			found = true
		}
	}
	if !found {
		t.Fatalf("manual cookie should be served for matching URL, got %v", served)
	}
}

func TestTrackedJarUpsertValidation(t *testing.T) {
	jar := newTrackedCookieJar()
	if _, err := jar.UpsertCookie(model.Cookie{Name: "", Domain: "example.com"}); err == nil {
		t.Error("empty name should error")
	}
	if _, err := jar.UpsertCookie(model.Cookie{Name: "n", Domain: ""}); err == nil {
		t.Error("empty domain should error")
	}
	cookies, err := jar.UpsertCookie(model.Cookie{Name: "n", Domain: "example.com", Path: ""})
	if err != nil {
		t.Fatalf("valid upsert: %v", err)
	}
	c, _ := findCookie(cookies, "n")
	if c.Path != "/" {
		t.Errorf("path should default to /, got %q", c.Path)
	}
}

func TestTrackedJarDeleteAndClear(t *testing.T) {
	jar := newTrackedCookieJar()
	if _, err := jar.UpsertCookie(model.Cookie{Name: "a", Domain: "example.com", Path: "/", Session: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := jar.UpsertCookie(model.Cookie{Name: "b", Domain: "example.com", Path: "/", Session: true}); err != nil {
		t.Fatal(err)
	}
	remaining := jar.DeleteCookie(model.Cookie{Name: "a", Domain: "example.com", Path: "/"})
	if _, ok := findCookie(remaining, "a"); ok {
		t.Error("cookie a should be deleted")
	}
	if _, ok := findCookie(remaining, "b"); !ok {
		t.Error("cookie b should remain")
	}
	if cleared := jar.ClearCookies(); len(cleared) != 0 {
		t.Errorf("clear should empty the jar, got %v", cleared)
	}
	if len(jar.ListCookies()) != 0 {
		t.Error("jar should be empty after clear")
	}
}

func TestTrackedJarHostOnlyDistinctKeys(t *testing.T) {
	jar := newTrackedCookieJar()
	u := mustURL("https://example.com/")
	jar.SetCookies(u, []*http.Cookie{{Name: "dup", Value: "host", Path: "/"}})
	jar.SetCookies(u, []*http.Cookie{{Name: "dup", Value: "domain", Domain: "example.com", Path: "/"}})
	count := 0
	for _, c := range jar.ListCookies() {
		if c.Name == "dup" {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("expected host-only and domain cookies to coexist, got %d", count)
	}
}

func TestDefaultCookiePath(t *testing.T) {
	cases := map[string]string{
		"":        "/",
		"/":       "/",
		"/a":      "/",
		"/a/b/c":  "/a/b",
		"noslash": "/",
	}
	for in, want := range cases {
		if got := defaultCookiePath(in); got != want {
			t.Errorf("defaultCookiePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSameSiteConversions(t *testing.T) {
	pairs := []struct {
		s string
		v http.SameSite
	}{
		{"strict", http.SameSiteStrictMode},
		{"lax", http.SameSiteLaxMode},
		{"none", http.SameSiteNoneMode},
	}
	for _, p := range pairs {
		if got := sameSiteFromString(p.s); got != p.v {
			t.Errorf("sameSiteFromString(%q) = %v", p.s, got)
		}
		if got := sameSiteToString(p.v); got != p.s {
			t.Errorf("sameSiteToString(%v) = %q", p.v, got)
		}
	}
	if sameSiteFromString("bogus") != http.SameSiteDefaultMode {
		t.Error("unknown same-site should map to default mode")
	}
	if normalizeSameSite("STRICT") != "strict" {
		t.Error("normalizeSameSite should lowercase known values")
	}
	if normalizeSameSite("weird") != "" {
		t.Error("normalizeSameSite should drop unknown values")
	}
}

func TestCookieJarRegistryIsolatesWorkspaces(t *testing.T) {
	reg := newCookieJarRegistry()
	prodJar := reg.jar("prod")
	sandboxJar := reg.jar("sandbox")

	if prodJar == sandboxJar {
		t.Fatal("expected per-workspace jars to be distinct instances")
	}

	u := mustURL("https://api.example.com/")
	prodJar.SetCookies(u, []*http.Cookie{{Name: "sid", Value: "prod-secret", Path: "/", Expires: time.Now().Add(time.Hour)}})

	if got := prodJar.Cookies(u); len(got) != 1 || got[0].Value != "prod-secret" {
		t.Fatalf("prod jar lost its own cookie, got %v", got)
	}
	if got := sandboxJar.Cookies(u); len(got) != 0 {
		t.Fatalf("sandbox jar must not see prod's cookies, got %v", got)
	}

	if reg.jar("prod") != prodJar {
		t.Fatal("registry must return the same jar for repeated lookups")
	}
	if reg.jar("") == prodJar || reg.jar("") == sandboxJar {
		t.Fatal("empty workspace id must map to its own default jar")
	}
}

func TestCookieJarRegistryDefaultJarStable(t *testing.T) {
	reg := newCookieJarRegistry()
	a := reg.jar("")
	b := reg.jar("")
	if a != b {
		t.Fatal("default-workspace jar must be stable across lookups")
	}
}

func TestCookieJarNeverSendsAnUnresolvedSecretPlaceholder(t *testing.T) {
	jar := newCookieJarRegistry().jar("ws")
	u := mustURL("https://httpbin.org/get")
	jar.SetCookies(u, []*http.Cookie{
		{Name: "name", Value: "{{kurloSecret:workspace.ws.cookies.name.2ff83fa72e.value}}", Path: "/"},
		{Name: "theme", Value: "dark", Path: "/"},
	})
	got := jar.Cookies(u)
	if len(got) != 1 || got[0].Name != "theme" {
		t.Fatalf("cookies = %v", got)
	}
	if listed := jar.ListCookies(); len(listed) != 2 {
		t.Fatalf("the cookie stays in the jar so its value can be filled in, got %d", len(listed))
	}
}

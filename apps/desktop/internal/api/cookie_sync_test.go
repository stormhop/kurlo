package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type cookieSyncHarness struct {
	server *cookieSyncServer
	jars   *cookieJarRegistry
	base   string
	port   int
	token  string
}

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}

func startTestCookieSync(t *testing.T, domains ...string) *cookieSyncHarness {
	t.Helper()
	jars := newCookieJarRegistry()
	server := newCookieSyncServer(jars)
	server.token = "test-pairing-token-0123456789"

	var status model.CookieSyncStatus
	for attempt := 0; attempt < 5; attempt++ {
		status = server.start(model.CookieSyncConfig{
			Enabled: true,
			Port:    freeLoopbackPort(t),
			Domains: domains,
		}, "ws-1", nil)
		if status.Error == "" {
			break
		}
	}
	if status.Error != "" {
		t.Fatalf("start cookie sync: %s", status.Error)
	}
	t.Cleanup(func() { server.stopServer() })
	return &cookieSyncHarness{server: server, jars: jars, base: status.URL, port: status.Port, token: server.token}
}

func (h *cookieSyncHarness) get(t *testing.T, path string, origin string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, h.base+path, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return h.do(t, req)
}

func (h *cookieSyncHarness) post(t *testing.T, path string, payload map[string]any) (int, map[string]any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, h.base+path, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "chrome-extension://kurlotestextension")
	return h.do(t, req)
}

func (h *cookieSyncHarness) do(t *testing.T, req *http.Request) (int, map[string]any) {
	t.Helper()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", req.Method, req.URL.Path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	decoded := map[string]any{}
	_ = json.Unmarshal(raw, &decoded)
	return resp.StatusCode, decoded
}

func (h *cookieSyncHarness) dial(t *testing.T, token string) *websocket.Conn {
	t.Helper()
	url := fmt.Sprintf("ws://127.0.0.1:%d/ws?token=%s&browser=Chrome&version=1.4.0", h.port, token)
	headers := http.Header{}
	headers.Set("Origin", "chrome-extension://kurlotestextension")
	conn, _, err := websocket.DefaultDialer.Dial(url, headers)
	if err != nil {
		t.Fatalf("dial the bridge: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func readSyncMessage(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read from the bridge: %v", err)
	}
	decoded := map[string]any{}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("decode %q: %v", payload, err)
	}
	return decoded
}

func readSyncMessageOfType(t *testing.T, conn *websocket.Conn, want string) map[string]any {
	t.Helper()
	for attempt := 0; attempt < 5; attempt++ {
		message := readSyncMessage(t, conn)
		if message["type"] == want {
			return message
		}
	}
	t.Fatalf("never saw a %q message", want)
	return nil
}

func sendSyncMessage(t *testing.T, conn *websocket.Conn, message map[string]any) {
	t.Helper()
	payload, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("encode message: %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("write to the bridge: %v", err)
	}
}

func browserCookie(name string, domain string) map[string]any {
	return map[string]any{
		"name":           name,
		"value":          name + "-value",
		"domain":         domain,
		"path":           "/",
		"secure":         true,
		"httpOnly":       true,
		"sameSite":       "lax",
		"expirationDate": float64(time.Now().Add(time.Hour).Unix()),
	}
}

func (h *cookieSyncHarness) jarCookies() []model.Cookie {
	return h.jars.jar("ws-1").ListCookies()
}

func (h *cookieSyncHarness) connect(t *testing.T) *websocket.Conn {
	t.Helper()
	conn := h.dial(t, h.token)
	if hello := readSyncMessageOfType(t, conn, "hello"); hello["app"] != "kurlo" {
		t.Fatalf("unexpected greeting: %v", hello)
	}
	return conn
}

func TestCookieSyncDiscoveryAnswersExtensionsOnly(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")

	status, body := harness.get(t, "/discover", "chrome-extension://kurlotestextension")
	if status != http.StatusOK || body["app"] != "kurlo" {
		t.Fatalf("an extension should be able to find the bridge, got %d %v", status, body)
	}

	blocked, _ := harness.get(t, "/discover", "https://evil.test")
	if blocked != http.StatusForbidden {
		t.Fatalf("a web page must not be answered, got %d", blocked)
	}
}

func TestCookieSyncPairingWaitsForApprovalInKurlo(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")
	harness.server.token = ""

	status, body := harness.post(t, "/pair", map[string]any{"browser": "Chrome", "extensionId": "abc123"})
	if status != http.StatusOK || body["status"] != "pending" {
		t.Fatalf("expected a pending pairing, got %d %v", status, body)
	}
	code, _ := body["code"].(string)
	if !regexp.MustCompile(`^\d{6}$`).MatchString(code) {
		t.Fatalf("expected a six digit approval code, got %q", code)
	}
	requestID, _ := body["requestId"].(string)

	pendingStatus := harness.server.status()
	if pendingStatus.Pending.ID != requestID || pendingStatus.Pending.Code != code {
		t.Fatalf("Kurlo should be showing the same request and code, got %+v", pendingStatus.Pending)
	}
	if pendingStatus.Pending.Browser != "Chrome" {
		t.Fatalf("the prompt should name the browser, got %+v", pendingStatus.Pending)
	}

	_, waiting := harness.get(t, "/pair?requestId="+requestID, "chrome-extension://kurlotestextension")
	if waiting["status"] != "pending" {
		t.Fatalf("the extension should keep waiting until the user acts, got %v", waiting)
	}
	if _, leaked := waiting["token"]; leaked {
		t.Fatal("no token may be handed out before approval")
	}

	harness.server.approvePairing(requestID)
	_, approved := harness.get(t, "/pair?requestId="+requestID, "chrome-extension://kurlotestextension")
	if approved["status"] != "approved" {
		t.Fatalf("expected approval, got %v", approved)
	}
	token, _ := approved["token"].(string)
	if len(token) < 16 {
		t.Fatalf("approval should hand over the token, got %q", token)
	}
	if after := harness.server.status(); !after.Paired || after.Pending.ID != "" {
		t.Fatalf("Kurlo should record the pairing and clear the prompt, got %+v", after)
	}
}

func TestCookieSyncPairingCanBeDeniedAndThenCoolsDown(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")

	_, body := harness.post(t, "/pair", map[string]any{"browser": "Chrome", "extensionId": "abc123"})
	requestID, _ := body["requestId"].(string)
	harness.server.denyPairing(requestID)

	_, denied := harness.get(t, "/pair?requestId="+requestID, "chrome-extension://kurlotestextension")
	if denied["status"] != "denied" {
		t.Fatalf("expected a denial, got %v", denied)
	}
	if harness.server.status().Paired {
		t.Fatal("a denied request must not pair the browser")
	}

	status, retry := harness.post(t, "/pair", map[string]any{"browser": "Chrome", "extensionId": "abc123"})
	if status != http.StatusTooManyRequests {
		t.Fatalf("a denied extension should be told to wait, got %d %v", status, retry)
	}
}

func TestCookieSyncPairingNeverHandsOutAWaitingRequestAgain(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")

	_, first := harness.post(t, "/pair", map[string]any{"browser": "Chrome", "extensionId": "abc123"})
	requestID, _ := first["requestId"].(string)
	if !strings.HasPrefix(requestID, "pair-") || len(requestID) < 20 {
		t.Fatalf("the request id should be random, got %q", requestID)
	}
	status, second := harness.post(t, "/pair", map[string]any{"browser": "Chrome", "extensionId": "abc123"})
	if status != http.StatusConflict || second["requestId"] != nil {
		t.Fatalf("repeating the extension id must not reveal the waiting request, got %d %v", status, second)
	}
	if _, guessed := harness.get(t, "/pair?requestId=pair-1", "chrome-extension://kurlotestextension"); guessed["status"] != "expired" {
		t.Fatalf("a guessed request id should read as expired, got %v", guessed)
	}

	status, other := harness.post(t, "/pair", map[string]any{"browser": "Firefox", "extensionId": "zzz999"})
	if status != http.StatusConflict {
		t.Fatalf("a second browser should wait its turn, got %d %v", status, other)
	}
}

func TestCookieSyncSocketRefusesAWrongToken(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")

	url := fmt.Sprintf("ws://127.0.0.1:%d/ws?token=not-the-token", harness.port)
	headers := http.Header{}
	headers.Set("Origin", "chrome-extension://kurlotestextension")
	conn, resp, err := websocket.DefaultDialer.Dial(url, headers)
	if err == nil {
		_ = conn.Close()
		t.Fatal("the bridge accepted a socket without the pairing token")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %v", resp)
	}
	if cookies := harness.jarCookies(); len(cookies) != 0 {
		t.Fatalf("an unpaired caller reached the jar: %+v", cookies)
	}
}

func TestCookieSyncSocketGreetsWithTheAllowlist(t *testing.T) {
	harness := startTestCookieSync(t, "example.com", "other.test")
	conn := harness.dial(t, harness.token)

	hello := readSyncMessageOfType(t, conn, "hello")
	domains, _ := hello["domains"].([]any)
	if len(domains) != 2 || domains[0] != "example.com" || domains[1] != "other.test" {
		t.Fatalf("the greeting should carry the allowlist, got %v", hello["domains"])
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		status := harness.server.status()
		if status.Connected && status.Browser == "Chrome" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the bridge never reported a live connection, got %+v", status)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCookieSyncSnapshotReplacesWhatTheJarHeld(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")
	conn := harness.connect(t)

	sendSyncMessage(t, conn, map[string]any{
		"type":    "snapshot",
		"browser": "Chrome",
		"domains": []string{"example.com"},
		"cookies": []map[string]any{browserCookie("sid", ".example.com"), browserCookie("csrf", "app.example.com")},
	})
	synced := readSyncMessageOfType(t, conn, "synced")
	if synced["accepted"] != float64(2) {
		t.Fatalf("accepted = %v, want 2 (%v)", synced["accepted"], synced)
	}
	if len(harness.jarCookies()) != 2 {
		t.Fatalf("jar holds %+v", harness.jarCookies())
	}

	sendSyncMessage(t, conn, map[string]any{
		"type":    "snapshot",
		"domains": []string{"example.com"},
		"cookies": []map[string]any{browserCookie("csrf", "app.example.com")},
	})
	reconciled := readSyncMessageOfType(t, conn, "synced")
	if reconciled["removed"] != float64(1) {
		t.Fatalf("a snapshot must drop what the browser no longer has, got %v", reconciled)
	}
	cookies := harness.jarCookies()
	if len(cookies) != 1 || cookies[0].Name != "csrf" {
		t.Fatalf("jar holds %+v", cookies)
	}
}

func TestCookieSyncChangeUpdatesAndClearsOneCookie(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")
	conn := harness.connect(t)

	sendSyncMessage(t, conn, map[string]any{"type": "change", "cookie": browserCookie("sid", ".example.com")})
	added := readSyncMessageOfType(t, conn, "synced")
	if added["accepted"] != float64(1) {
		t.Fatalf("expected the cookie to be taken, got %v", added)
	}
	cookies := harness.jarCookies()
	if len(cookies) != 1 || cookies[0].Name != "sid" || cookies[0].HostOnly {
		t.Fatalf("jar holds %+v", cookies)
	}

	sendSyncMessage(t, conn, map[string]any{
		"type":    "change",
		"removed": true,
		"cause":   "explicit",
		"cookie":  browserCookie("sid", ".example.com"),
	})
	cleared := readSyncMessageOfType(t, conn, "synced")
	if cleared["removed"] != float64(1) {
		t.Fatalf("expected the cookie to be cleared, got %v", cleared)
	}
	if got := harness.jarCookies(); len(got) != 0 {
		t.Fatalf("the cookie should be gone, jar holds %+v", got)
	}
}

func TestCookieSyncChangeOutsideTheAllowlistIsSkipped(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")
	conn := harness.connect(t)

	sendSyncMessage(t, conn, map[string]any{"type": "change", "cookie": browserCookie("tracker", "ads.example.net")})
	skipped := readSyncMessageOfType(t, conn, "skipped")
	if skipped["domain"] != "ads.example.net" {
		t.Fatalf("expected the domain to be named in the refusal, got %v", skipped)
	}
	if got := harness.jarCookies(); len(got) != 0 {
		t.Fatalf("a domain outside the allowlist reached the jar: %+v", got)
	}
}

func TestCookieSyncSnapshotLeavesDomainsThePushDidNotClaim(t *testing.T) {
	harness := startTestCookieSync(t, "example.com", "other.test")
	conn := harness.connect(t)

	sendSyncMessage(t, conn, map[string]any{
		"type":    "snapshot",
		"domains": []string{"other.test"},
		"cookies": []map[string]any{browserCookie("keep", "other.test")},
	})
	readSyncMessageOfType(t, conn, "synced")

	sendSyncMessage(t, conn, map[string]any{
		"type":    "snapshot",
		"domains": []string{"example.com"},
		"cookies": []map[string]any{browserCookie("sid", "example.com")},
	})
	readSyncMessageOfType(t, conn, "synced")

	if cookies := harness.jarCookies(); len(cookies) != 2 {
		t.Fatalf("a scoped snapshot must not clear the other domain, jar holds %+v", cookies)
	}
}

func TestCookieSyncPushesTheAllowlistToLiveBrowsers(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")
	conn := harness.connect(t)

	harness.server.setDomains([]string{"example.com", "shop.example.com"})

	update := readSyncMessageOfType(t, conn, "domains")
	domains, _ := update["domains"].([]any)
	if len(domains) != 2 || domains[1] != "shop.example.com" {
		t.Fatalf("the browser should be told about the new allowlist, got %v", update["domains"])
	}
}

func TestCookieSyncRejectsAnOversizedSnapshot(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")
	conn := harness.connect(t)

	cookies := make([]map[string]any, 0, cookieSyncMaxCookies+1)
	for i := 0; i <= cookieSyncMaxCookies; i++ {
		cookies = append(cookies, browserCookie(fmt.Sprintf("c%d", i), "example.com"))
	}
	sendSyncMessage(t, conn, map[string]any{"type": "snapshot", "domains": []string{"example.com"}, "cookies": cookies})

	failure := readSyncMessageOfType(t, conn, "error")
	if !strings.Contains(fmt.Sprint(failure["error"]), "too many cookies") {
		t.Fatalf("expected the limit to be explained, got %v", failure)
	}
	if got := harness.jarCookies(); len(got) != 0 {
		t.Fatalf("an oversized snapshot wrote %d cookies", len(got))
	}
}

func TestCookieSyncRevokeDropsTheBrowser(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")
	conn := harness.connect(t)
	before := harness.server.status().PairingCode

	revoked := harness.server.revokePairing()
	if revoked.Paired || revoked.Connected {
		t.Fatalf("revoking should leave nothing paired, got %+v", revoked)
	}
	if revoked.PairingCode == before {
		t.Fatal("revoking must mint a new token")
	}

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}

	url := fmt.Sprintf("ws://127.0.0.1:%d/ws?token=%s", harness.port, harness.token)
	headers := http.Header{}
	headers.Set("Origin", "chrome-extension://kurlotestextension")
	if stale, _, err := websocket.DefaultDialer.Dial(url, headers); err == nil {
		_ = stale.Close()
		t.Fatal("the old token still opens a socket")
	}
}

func TestCookieSyncRevokeTellsTheBrowserWhy(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")
	conn := harness.connect(t)

	closed := make(chan int, 1)
	conn.SetCloseHandler(func(code int, _ string) error {
		closed <- code
		return nil
	})
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	harness.server.revokePairing()

	select {
	case code := <-closed:
		if code != websocket.ClosePolicyViolation {
			t.Fatalf("close code = %d, want %d so the extension knows to pair again", code, websocket.ClosePolicyViolation)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("revoking closed the socket without telling the browser why")
	}
}

func TestCookieSyncStopSaysItIsGoingAway(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")
	conn := harness.connect(t)

	closed := make(chan int, 1)
	conn.SetCloseHandler(func(code int, _ string) error {
		closed <- code
		return nil
	})
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	harness.server.stop()

	select {
	case code := <-closed:
		if code != websocket.CloseGoingAway {
			t.Fatalf("close code = %d, want %d so the extension keeps its token and waits", code, websocket.CloseGoingAway)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stopping closed the socket without a close frame")
	}
}

func TestCookieSyncReportsDomainsTheBrowserCannotRead(t *testing.T) {
	harness := startTestCookieSync(t, "example.com", "shop.example.net")
	conn := harness.connect(t)

	sendSyncMessage(t, conn, map[string]any{
		"type":    "snapshot",
		"domains": []string{"example.com"},
		"cookies": []map[string]any{browserCookie("sid", "example.com")},
	})
	readSyncMessageOfType(t, conn, "synced")

	status := harness.server.status()
	if strings.Join(status.Unreadable, ",") != "shop.example.net" {
		t.Fatalf("expected the ungranted domain to be reported, got %v", status.Unreadable)
	}

	sendSyncMessage(t, conn, map[string]any{
		"type":    "snapshot",
		"domains": []string{"example.com", "shop.example.net"},
		"cookies": []map[string]any{browserCookie("sid", "example.com")},
	})
	readSyncMessageOfType(t, conn, "synced")

	if got := harness.server.status().Unreadable; len(got) != 0 {
		t.Fatalf("granting the domain should clear the warning, got %v", got)
	}
}

func TestCookieSyncCannotApproveAnExpiredRequest(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")

	_, body := harness.post(t, "/pair", map[string]any{"browser": "Chrome", "extensionId": "abc123"})
	requestID, _ := body["requestId"].(string)

	harness.server.mu.Lock()
	harness.server.pending.expiresAt = time.Now().Add(-time.Second)
	harness.server.mu.Unlock()

	harness.server.approvePairing(requestID)
	_, answer := harness.get(t, "/pair?requestId="+requestID, "chrome-extension://kurlotestextension")
	if answer["status"] != "expired" {
		t.Fatalf("an expired request must not hand over a token, got %v", answer)
	}
	if harness.server.status().Paired {
		t.Fatal("an expired request must not pair the browser")
	}
}

func TestCookieSyncStopClosesTheBridge(t *testing.T) {
	harness := startTestCookieSync(t, "example.com")
	address := strings.TrimPrefix(harness.base, "http://")

	status := harness.server.stop()
	if status.Running || status.Enabled || status.PairingCode != "" {
		t.Fatalf("stop should leave the bridge closed, got %+v", status)
	}
	if conn, err := net.DialTimeout("tcp", address, 300*time.Millisecond); err == nil {
		_ = conn.Close()
		t.Fatal("the loopback listener is still accepting connections after stop")
	}
}

func TestNormalizeCookieSyncDomainsAcceptsWhatUsersPaste(t *testing.T) {
	got := normalizeCookieSyncDomains([]string{
		"https://API.Example.com/v1/orders?page=2",
		".example.com",
		"example.com:8443",
		"*.staging.example.com",
		"localhost:5173",
		"   ",
		"not a domain",
		"example.com",
	})
	want := []string{"api.example.com", "example.com", "localhost", "staging.example.com"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("normalized = %v, want %v", got, want)
	}
}

func TestCookieSyncDomainIsSyncableRejectsPublicSuffixes(t *testing.T) {
	for _, domain := range []string{"com", "co.uk", "github.io"} {
		if cookieSyncDomainIsSyncable(domain) {
			t.Errorf("%q is a public suffix and must not be syncable", domain)
		}
	}
	for _, domain := range []string{"example.com", "api.example.co.uk", "localhost", "127.0.0.1"} {
		if !cookieSyncDomainIsSyncable(domain) {
			t.Errorf("%q should be syncable", domain)
		}
	}
}

func TestSyncCookiesReplacesOnlyTheGivenDomains(t *testing.T) {
	jar := newTrackedCookieJar()
	if _, err := jar.UpsertCookie(model.Cookie{Name: "manual", Domain: "example.com", Path: "/", Session: true}); err != nil {
		t.Fatalf("seed manual cookie: %v", err)
	}
	if _, err := jar.UpsertCookie(model.Cookie{Name: "elsewhere", Domain: "other.test", Path: "/", Session: true}); err != nil {
		t.Fatalf("seed other cookie: %v", err)
	}

	accepted, removed := jar.SyncCookies([]string{"example.com"}, []model.Cookie{
		{Name: "sid", Domain: "example.com", Path: "/", Session: true},
	})
	if accepted != 1 || removed != 1 {
		t.Fatalf("accepted = %d, removed = %d, want 1 and 1", accepted, removed)
	}

	names := map[string]bool{}
	for _, cookie := range jar.ListCookies() {
		names[cookie.Name] = true
	}
	if names["manual"] {
		t.Error("a manual cookie for a synced domain should be replaced by the browser's view")
	}
	if !names["elsewhere"] {
		t.Error("a cookie outside the synced domains must survive")
	}
	if !names["sid"] {
		t.Error("the synced cookie is missing")
	}
}

func TestApplySyncedCookieHonoursTheAllowlistAndKeepsCreatedAt(t *testing.T) {
	jar := newTrackedCookieJar()
	scope := []string{"example.com"}

	if jar.ApplySyncedCookie(scope, model.Cookie{Name: "sid", Domain: "other.test", Path: "/", Session: true}, false) {
		t.Fatal("a cookie outside the allowlist must be refused")
	}
	if !jar.ApplySyncedCookie(scope, model.Cookie{Name: "sid", Value: "one", Domain: "example.com", Path: "/", Session: true}, false) {
		t.Fatal("an allowlisted cookie should be taken")
	}
	first := jar.ListCookies()[0]

	time.Sleep(2 * time.Millisecond)
	if !jar.ApplySyncedCookie(scope, model.Cookie{Name: "sid", Value: "two", Domain: "example.com", Path: "/", Session: true}, false) {
		t.Fatal("an update should be taken")
	}
	second := jar.ListCookies()[0]
	if second.Value != "two" {
		t.Fatalf("value = %q, want the updated one", second.Value)
	}
	if second.CreatedAt != first.CreatedAt {
		t.Fatalf("createdAt should survive an update: %d then %d", first.CreatedAt, second.CreatedAt)
	}

	if !jar.ApplySyncedCookie(scope, model.Cookie{Name: "sid", Domain: "example.com", Path: "/", Session: true}, true) {
		t.Fatal("a removal should be applied")
	}
	if got := jar.ListCookies(); len(got) != 0 {
		t.Fatalf("the cookie should be gone, jar holds %+v", got)
	}
	if jar.ApplySyncedCookie(scope, model.Cookie{Name: "sid", Domain: "example.com", Path: "/", Session: true}, true) {
		t.Fatal("removing what is not there should report nothing changed")
	}
}

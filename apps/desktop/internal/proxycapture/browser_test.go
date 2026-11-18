package proxycapture

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

func TestBrowserRecordsHTTPSNavigationAndPost(t *testing.T) {
	exe, err := browserExecutable()
	if err != nil {
		t.Skip(err)
	}
	site := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, `<!doctype html><title>Capture fixture</title><script>fetch('/orders?token=do-not-store',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer do-not-store'},body:'{"order":17}'})</script>`)
		case "/orders":
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Set-Cookie", "secret=do-not-store")
			w.WriteHeader(201)
			io.WriteString(w, `{"accepted":17}`)
		default:
			http.NotFound(w, r)
		}
	}))
	site.EnableHTTP2 = true
	site.StartTLS()
	defer site.Close()
	profile := t.TempDir()
	var rec Recorder
	defer rec.Close()
	pin := sha256.Sum256(site.Certificate().RawSubjectPublicKeyInfo)
	st, err := rec.startBrowser(nil, chromedp.ExecPath(exe), chromedp.UserDataDir(profile), chromedp.Headless, chromedp.Flag("no-proxy-server", true), chromedp.Flag("use-mock-keychain", true), chromedp.Flag("disable-background-networking", true), chromedp.Flag("ignore-certificate-errors-spki-list", base64.StdEncoding.EncodeToString(pin[:])))
	if err != nil || !st.Browser || !st.Running || st.Address != "" {
		t.Fatalf("start browser: %+v, %v", st, err)
	}
	rec.mu.Lock()
	tab := rec.run.ctx
	rec.mu.Unlock()
	parent, cancel := context.WithTimeout(tab, 12*time.Second)
	defer cancel()
	if _, err := chromedp.Call(parent, page.Navigate, page.NavigateParams{URL: site.URL}); err != nil {
		t.Fatalf("navigate: %v, rows: %+v", err, rec.Entries())
	}
	for {
		gotGET, gotPOST := false, false
		for _, row := range rec.Entries() {
			x, err := rec.Get(row.ID)
			if err != nil {
				t.Fatal(err)
			}
			switch row.Path {
			case "/":
				gotGET = row.Method == "GET" && row.Status == 200 && strings.Contains(x.Response.Body, "Capture fixture")
			case "/orders":
				u, _ := url.Parse(row.URL)
				if u.RawQuery != "" || http.Header(x.Request.Headers).Get("Authorization") != "" || http.Header(x.Response.Headers).Get("Set-Cookie") != "" {
					t.Fatal("sensitive metadata in capture")
				}
				gotPOST = row.Method == "POST" && row.Status == 201 && x.Response.Body == `{"accepted":17}` && x.Request.Body == `{"order":17}`
			}
		}
		if gotGET && gotPOST {
			break
		}
		select {
		case <-parent.Done():
			t.Fatalf("missing HTTPS exchanges: %+v", rec.Entries())
		case <-time.After(15 * time.Millisecond):
		}
	}
	rec.Stop()
	har, err := rec.HAR(nil)
	if err != nil || !strings.Contains(har, `"httpVersion":"HTTP/2.0"`) {
		t.Fatal("missing negotiated HTTP/2 in HAR", err)
	}
	if rec.Status().Running || len(rec.Entries()) < 2 {
		t.Fatal("stopped session lost its entries")
	}
}

func TestVisibleBrowserCaptureLifecycle(t *testing.T) {
	if os.Getenv("KURLO_VISIBLE_CAPTURE_TEST") != "1" {
		t.Skip("enable the visible browser integration test explicitly")
	}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, "<title>Kurlo capture</title>visible browser response")
	}))
	defer site.Close()
	var rec Recorder
	defer rec.Close()
	profile := t.TempDir()
	st, err := rec.StartBrowser(profile, nil)
	if err != nil || !st.Browser || !st.Running {
		t.Fatal(st, err)
	}
	rec.mu.Lock()
	tab := rec.run.ctx
	rec.mu.Unlock()
	ctx, cancel := context.WithTimeout(tab, 15*time.Second)
	defer cancel()
	if _, err = chromedp.Call(ctx, page.Navigate, page.NavigateParams{URL: site.URL}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	found := false
	for time.Now().Before(deadline) && !found {
		for _, entry := range rec.Entries() {
			x, _ := rec.Get(entry.ID)
			if entry.Path == "/" && strings.Contains(x.Response.Body, "visible browser response") {
				found = true
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !found {
		t.Fatal("missing visible browser response")
	}
	_, _ = chromedp.Call(ctx, page.Close, cdp.Empty{})
	deadline = time.Now().Add(8 * time.Second)
	for rec.Status().Running && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if rec.Status().Running {
		t.Fatal("closing the recording tab did not stop the capture")
	}
	if _, err = rec.StartBrowser(profile, nil); err != nil {
		t.Fatal("reopen recording profile:", err)
	}
	rec.Stop()
}

func TestBrowserURLHeadersOmitSensitiveQuery(t *testing.T) {
	h := browserHeaders(network.Headers{"Location": "/next?token=x&tab=1", "Referer": "https://shop.test/order?api_key=x", "Cookie": "sid=x"})
	if h.Get("Location") != "/next?tab=1" || h.Get("Referer") != "https://shop.test/order" || h.Get("Cookie") != "" {
		t.Fatal(h)
	}
}

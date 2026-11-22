package proxycapture

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func decryptingClient(t *testing.T, target *httptest.Server, http2 bool) (*Recorder, *http.Client) {
	t.Helper()
	trustUpstream(t, target)
	dir := t.TempDir()
	r, client := startRecorder(t, Config{SSLHosts: []string{"127.0.0.1:*"}, AuthorityDir: dir})
	transport := client.Transport.(*http.Transport)
	transport.TLSClientConfig = &tls.Config{RootCAs: authorityRoots(t, dir)}
	transport.ForceAttemptHTTP2 = http2
	return r, client
}

func TestHTTP2FromClientOnDecryptedHost(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/events":
			w.Header().Set("Content-Type", "text/event-stream")
			for _, event := range []string{"one", "two"} {
				fmt.Fprintf(w, "data: %s\n\n", event)
				w.(http.Flusher).Flush()
				time.Sleep(10 * time.Millisecond)
			}
		default:
			body, _ := io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"path":%q,"body":%q}`, r.URL.Path, body)
		}
	}))
	defer target.Close()
	r, client := decryptingClient(t, target, true)
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := client.Post(fmt.Sprintf("%s/orders/%d", target.URL, i), "application/json", strings.NewReader(fmt.Sprintf(`{"n":%d}`, i)))
			if err != nil {
				t.Error(err)
				return
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if resp.ProtoMajor != 2 || !strings.Contains(string(body), fmt.Sprintf(`{\"n\":%d}`, i)) {
				t.Error(resp.Proto, string(body))
			}
		}()
	}
	wg.Wait()
	resp, err := client.Get(target.URL + "/events")
	if text := responseText(t, resp, err); resp.ProtoMajor != 2 || !strings.Contains(text, "data: two") {
		t.Fatal(resp.Proto, text)
	}
	client.CloseIdleConnections()
	r.Stop()
	var posts int
	for _, e := range r.Entries() {
		switch {
		case e.Method == "CONNECT":
			t.Fatal("decrypted connection recorded as a tunnel", e)
		case e.Method == "POST":
			posts++
			x, _ := r.Get(e.ID)
			if e.Protocol != "HTTP/2.0" || e.Status != 200 || !strings.HasPrefix(x.Request.Body, `{"n":`) || !strings.Contains(x.Response.Body, `"path":"/orders/`) {
				t.Fatalf("%+v %+v", e, x)
			}
		case e.Path == "/events":
			x, _ := r.Get(e.ID)
			if e.Protocol != "HTTP/2.0" || e.Stream != "SSE" || len(x.Frames) != 2 || x.Timings == nil {
				t.Fatalf("%+v %+v", e, x.Frames)
			}
		}
	}
	if posts != 4 {
		t.Fatal(r.Entries())
	}
}

func TestHTTP1ClientStillWorksOnDecryptedHost(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) }))
	defer target.Close()
	r, client := decryptingClient(t, target, false)
	resp, err := client.Get(target.URL + "/plain")
	if text := responseText(t, resp, err); text != "ok" || resp.ProtoMajor != 1 {
		t.Fatal(resp.Proto, text)
	}
	r.Stop()
	if e := r.Entries()[0]; e.Protocol != "HTTP/1.1" {
		t.Fatal(e)
	}
}

func TestTimingsBreakDownUpstreamPhases(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(40 * time.Millisecond)
		w.Write([]byte("first"))
		w.(http.Flusher).Flush()
		time.Sleep(30 * time.Millisecond)
		w.Write([]byte(" second"))
	}))
	defer target.Close()
	r, client := decryptingClient(t, target, false)
	for range 2 {
		resp, err := client.Get(target.URL + "/slow")
		if text := responseText(t, resp, err); text != "first second" {
			t.Fatal(text)
		}
	}
	r.Stop()
	entries := r.Entries()
	if len(entries) != 2 {
		t.Fatal(entries)
	}
	first, _ := r.Get(entries[0].ID)
	second, _ := r.Get(entries[1].ID)
	ft := first.Timings
	if ft == nil {
		t.Fatal("no timings")
	}
	if ft.TCPHandshake <= 0 || ft.TLSHandshake <= 0 || ft.WaitingTTFB < 35 || ft.Download < 25 || ft.Total < ft.WaitingTTFB+ft.Download {
		t.Fatalf("%+v", *ft)
	}
	sum := ft.Prepare + ft.SocketInitialization + ft.DNSLookup + ft.TCPHandshake + ft.TLSHandshake + ft.WaitingTTFB + ft.Download + ft.Process
	if diff := sum - ft.Total; diff > 0.1 || diff < -0.1 {
		t.Fatalf("phases add up to %v, total %v", sum, ft.Total)
	}
	if diff := float64(entries[0].Duration) - ft.Total; diff > 2 || diff < -2 {
		t.Fatalf("duration %d, total %v", entries[0].Duration, ft.Total)
	}
	if st := second.Timings; st == nil || st.TCPHandshake != 0 || st.TLSHandshake != 0 || st.WaitingTTFB < 35 || st.Download < 25 {
		t.Fatalf("%+v", st)
	}
	har, err := r.HAR(nil)
	if err != nil {
		t.Fatal(err)
	}
	var log struct {
		Log struct {
			Entries []struct {
				Timings map[string]float64 `json:"timings"`
				Request struct {
					Version string `json:"httpVersion"`
				} `json:"request"`
			} `json:"entries"`
		} `json:"log"`
	}
	json.Unmarshal([]byte(har), &log)
	h := log.Log.Entries[0].Timings
	if h["wait"] != ft.WaitingTTFB || h["receive"] != ft.Download || h["connect"] != ft.TCPHandshake+ft.TLSHandshake || h["ssl"] != ft.TLSHandshake || h["send"] != 0 || log.Log.Entries[0].Request.Version != "HTTP/1.1" {
		t.Fatal(h, log.Log.Entries[0].Request.Version)
	}
	if h2 := log.Log.Entries[1].Timings; h2["connect"] != -1 || h2["ssl"] != -1 {
		t.Fatal(h2)
	}
	loaded := &Recorder{}
	defer loaded.Close()
	if _, err := loaded.Load([]byte(har), "slow.har", nil); err != nil {
		t.Fatal(err)
	}
	back, _ := loaded.Get(loaded.Entries()[0].ID)
	if back.Timings == nil || *back.Timings != *ft {
		t.Fatalf("%+v", back.Timings)
	}
}

func TestLocalAnswerHasNoNetworkTimings(t *testing.T) {
	r, client := startRecorder(t, Config{})
	r.SetRules([]Rule{localRule("l", "GET", "http://local.test/*", LocalAnswer{Status: 200, Body: "mock", ContentType: "text/plain"})})
	resp, err := client.Get("http://local.test/a")
	responseText(t, resp, err)
	r.Stop()
	x, _ := r.Get(r.Entries()[0].ID)
	if x.Timings != nil || x.Entry.Protocol != "HTTP/1.1" {
		t.Fatalf("%+v", x)
	}
}

func TestLoadReadsBrowserTimingsAndProtocol(t *testing.T) {
	data := `{"log":{"entries":[
		{"time":120.5,"request":{"method":"GET","url":"https://a.test/x","httpVersion":"h2"},"response":{"status":200,"httpVersion":"h2"},"timings":{"blocked":2,"dns":10,"connect":30,"ssl":20,"send":0.5,"wait":60,"receive":18}},
		{"time":5,"request":{"method":"GET","url":"https://a.test/y","httpVersion":"HTTP/1.1"},"response":{"status":200},"timings":{"blocked":-1,"dns":-1,"connect":-1,"ssl":-1,"send":0,"wait":0,"receive":0}},
		{"time":5,"request":{"method":"GET","url":"https://a.test/z","httpVersion":"http/3"},"response":{"status":200}}
	]}}`
	r := &Recorder{}
	defer r.Close()
	if _, err := r.Load([]byte(data), "chrome.har", nil); err != nil {
		t.Fatal(err)
	}
	entries := r.Entries()
	if entries[0].Protocol != "HTTP/2.0" || entries[1].Protocol != "HTTP/1.1" || entries[2].Protocol != "HTTP/3.0" {
		t.Fatal(entries)
	}
	x, _ := r.Get(entries[0].ID)
	got := x.Timings
	if got == nil || got.Prepare != 2 || got.DNSLookup != 10 || got.TCPHandshake != 10 || got.TLSHandshake != 20 || got.WaitingTTFB != 60.5 || got.Download != 18 || got.Total != 120.5 || got.Process != 0 {
		t.Fatalf("%+v", got)
	}
	for _, e := range entries[1:] {
		if y, _ := r.Get(e.ID); y.Timings != nil {
			t.Fatalf("%+v", y.Timings)
		}
	}
}

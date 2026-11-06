package auth

import (
	"encoding/base64"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

func TestNTLMHandshakeUsesOneConnectionAndReplaysBody(t *testing.T) {
	challenge := make([]byte, 48)
	copy(challenge, "NTLMSSP\x00")
	binary.LittleEndian.PutUint32(challenge[8:], 2)
	binary.LittleEndian.PutUint32(challenge[20:], 0x00080201)
	copy(challenge[24:], "abcd1234")
	var mu sync.Mutex
	var remote string
	var steps []uint32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		body, _ := io.ReadAll(r.Body)
		if string(body) != "payload" {
			t.Errorf("body = %q", body)
		}
		if remote == "" {
			remote = r.RemoteAddr
		} else if r.RemoteAddr != remote {
			t.Errorf("handshake changed connection: %s -> %s", remote, r.RemoteAddr)
		}
		value := r.Header.Get("Authorization")
		if value == "" {
			steps = append(steps, 0)
			w.Header().Set("WWW-Authenticate", "NTLM")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		message, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, "NTLM "))
		if err != nil || len(message) < 12 || !strings.HasPrefix(value, "NTLM ") {
			t.Errorf("unexpected authorization header %q", value)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		step := binary.LittleEndian.Uint32(message[8:])
		steps = append(steps, step)
		if step == 1 {
			w.Header().Set("WWW-Authenticate", "NTLM "+base64.StdEncoding.EncodeToString(challenge))
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer server.Close()
	origin, _ := url.Parse(server.URL)
	client := &http.Client{Transport: NewNTLMTransport(http.DefaultTransport.(*http.Transport), origin, "DOMAIN\\user", "password")}
	resp, err := client.Post(server.URL, "text/plain", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	mu.Lock()
	defer mu.Unlock()
	if resp.StatusCode != 200 || len(steps) != 3 || steps[0] != 0 || steps[1] != 1 || steps[2] != 3 {
		t.Fatalf("status=%d handshake=%v", resp.StatusCode, steps)
	}
}

func TestNTLMDoesNotFallBackToBasicOrFollowCrossOriginCredentials(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if value := r.Header.Get("Authorization"); value != "" {
			t.Errorf("unexpected credentials %q", value)
		}
		w.Header().Set("WWW-Authenticate", `Basic realm="target"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if value := r.Header.Get("Authorization"); value != "" {
			t.Errorf("unexpected credentials %q", value)
		}
		if r.URL.Path == "/basic" {
			w.Header().Set("WWW-Authenticate", `Basic realm="origin"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer server.Close()
	origin, _ := url.Parse(server.URL)
	client := &http.Client{Transport: NewNTLMTransport(http.DefaultTransport.(*http.Transport), origin, "user", "password")}
	for _, path := range []string{"/basic", "/redirect"} {
		resp, err := client.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s status = %d", path, resp.StatusCode)
		}
	}
}

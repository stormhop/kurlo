package proxycapture

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestAuthorityPersistsAndIssuesHostCertificates(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadAuthority(dir, false); !os.IsNotExist(err) {
		t.Fatal(err)
	}
	first, err := LoadAuthority(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	again, err := LoadAuthority(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if first.Info().Fingerprint != again.Info().Fingerprint || !strings.HasPrefix(first.Info().Subject, "Kurlo Capture CA ") {
		t.Fatal(first.Info(), again.Info())
	}
	_, keyPath := AuthorityPaths(dir)
	if info, err := os.Stat(keyPath); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatal(info, err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(again.Certificate())
	for _, host := range []string{"api.example.test", "127.0.0.1"} {
		leaf, err := first.leaf(host)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := leaf.Leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: host}); err != nil {
			t.Fatal(host, err)
		}
		if leaf.Leaf.NotAfter.Sub(leaf.Leaf.NotBefore) > 31*24*time.Hour {
			t.Fatal(leaf.Leaf.NotAfter)
		}
	}
}

func TestSSLHostPatterns(t *testing.T) {
	hosts, err := NormalizeSSLHosts([]string{" API.example.test ", "*.example.dev", "local.test:8443", "api.example.test", ""})
	if err != nil || strings.Join(hosts, ",") != "api.example.test,*.example.dev,local.test:8443" {
		t.Fatal(hosts, err)
	}
	for _, bad := range []string{"https://example.test", "exa*mple.test", "*.", "example.test:99999", "a b"} {
		if _, err := NormalizeSSLHosts([]string{bad}); err == nil {
			t.Fatal(bad)
		}
	}
	cases := map[string]bool{"api.example.test:443": true, "api.example.test:8443": false, "v1.example.dev:443": true, "example.dev:443": false, "local.test:8443": true, "local.test:443": false, "other.test:443": false}
	for target, want := range cases {
		if matchSSLHost(hosts, target) != want {
			t.Fatal(target, want)
		}
	}
	if !matchSSLHost([]string{"*:*"}, "any.test:8080") || matchSSLHost(nil, "any.test:443") {
		t.Fatal("wildcard")
	}
}

func authorityRoots(t *testing.T, dir string) *x509.CertPool {
	t.Helper()
	authority, err := LoadAuthority(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(authority.Certificate())
	return roots
}

func trustUpstream(t *testing.T, server *httptest.Server) {
	t.Helper()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	upstreamRoots = roots
	t.Cleanup(func() { upstreamRoots = nil })
}

func TestDecryptSelectedHostsWithCaptureAuthority(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"path":"` + r.URL.Path + `"}`))
	}))
	defer target.Close()
	trustUpstream(t, target)
	dir := t.TempDir()
	r, client := startRecorder(t, Config{SSLHosts: []string{"other.test"}, AuthorityDir: dir})
	client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: authorityRoots(t, dir)}
	client.Transport.(*http.Transport).TLSClientConfig.RootCAs.AddCert(target.Certificate())
	resp, err := client.Get(target.URL + "/tunnel")
	if responseText(t, resp, err) == "" {
		t.Fatal("empty tunnel response")
	}
	client.CloseIdleConnections()
	status, err := r.SetSSLHosts([]string{"127.0.0.1:*"})
	if err != nil || strings.Join(status.Config.SSLHosts, ",") != "127.0.0.1:*" {
		t.Fatal(status, err)
	}
	client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: authorityRoots(t, dir)}
	resp, err = client.Get(target.URL + "/orders?id=7")
	if body := responseText(t, resp, err); body != `{"path":"/orders"}` {
		t.Fatal(body)
	}
	client.CloseIdleConnections()
	r.Stop()
	rows := r.Entries()
	if len(rows) != 2 || rows[0].Method != "CONNECT" || rows[1].Method != "GET" {
		t.Fatal(rows)
	}
	x, err := r.Get(rows[1].ID)
	if err != nil || x.Entry.URL != target.URL+"/orders?id=7" || x.Response.Body != `{"path":"/orders"}` || x.Entry.Status != 200 {
		t.Fatal(x, err)
	}
}

func TestDecryptionReportsUntrustedClientAndUpstream(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("reached an unverified upstream") }))
	defer target.Close()
	dir := t.TempDir()
	r, client := startRecorder(t, Config{SSLHosts: []string{"127.0.0.1:*"}, AuthorityDir: dir})
	if _, err := client.Get(target.URL); err == nil {
		t.Fatal("client accepted an untrusted capture certificate")
	}
	client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: authorityRoots(t, dir)}
	resp, err := client.Get(target.URL + "/pay")
	responseText(t, resp, err)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatal(resp.Status)
	}
	client.CloseIdleConnections()
	r.Stop()
	rows := r.Entries()
	if len(rows) != 2 || rows[0].Method != "CONNECT" || !strings.Contains(rows[0].Error, "rejected the Kurlo certificate") || rows[1].Error != "Upstream connection failed" {
		t.Fatal(rows)
	}
}

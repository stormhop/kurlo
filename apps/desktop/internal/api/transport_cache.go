package api

import (
	"crypto/tls"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const maxCachedTransports = 16

type transportKey struct {
	httpVersion   string
	skipTLSVerify bool
	proxyMode     string
	proxyURL      string
	proxyBypass   string
	clientCert    string
}

func newTransportKey(req model.HttpRequest) transportKey {
	key := transportKey{
		httpVersion:   strings.ToLower(strings.TrimSpace(req.HTTPVersion)),
		skipTLSVerify: !req.EnableSSLVerification,
		proxyMode:     strings.ToLower(strings.TrimSpace(req.ProxyMode)),
		clientCert:    clientCertConfigFor(req).cacheKey(),
	}
	if key.proxyMode != "off" {
		key.proxyURL = strings.TrimSpace(req.ProxyURL)
		key.proxyBypass = strings.TrimSpace(req.ProxyBypass)
	}
	return key
}

type cachedTransport struct {
	transport *http.Transport
	lastUsed  time.Time
}

type transportCache struct {
	mu      sync.Mutex
	entries map[transportKey]*cachedTransport
	now     func() time.Time
}

func newTransportCache() *transportCache {
	return &transportCache{
		entries: make(map[transportKey]*cachedTransport),
		now:     time.Now,
	}
}

var httpTransports = newTransportCache()

func (c *transportCache) get(req model.HttpRequest) *http.Transport {
	key := newTransportKey(req)

	c.mu.Lock()
	if entry, ok := c.entries[key]; ok {
		entry.lastUsed = c.now()
		c.mu.Unlock()
		return entry.transport
	}

	c.mu.Unlock()
	transport := newBaseHTTPTransport(req)
	c.mu.Lock()
	defer c.mu.Unlock()
	if entry, ok := c.entries[key]; ok {
		entry.lastUsed = c.now()
		transport.CloseIdleConnections()
		return entry.transport
	}
	c.evictLocked()
	c.entries[key] = &cachedTransport{transport: transport, lastUsed: c.now()}
	return transport
}

func (c *transportCache) evictLocked() {
	if len(c.entries) < maxCachedTransports {
		return
	}
	var oldestKey transportKey
	var oldest *cachedTransport
	for key, entry := range c.entries {
		if oldest == nil || entry.lastUsed.Before(oldest.lastUsed) {
			oldestKey, oldest = key, entry
		}
	}
	if oldest == nil {
		return
	}
	oldest.transport.CloseIdleConnections()
	delete(c.entries, oldestKey)
}

func (c *transportCache) closeAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, entry := range c.entries {
		entry.transport.CloseIdleConnections()
		delete(c.entries, key)
	}
}

func newBaseHTTPTransport(req model.HttpRequest) *http.Transport {
	baseTransport, _ := http.DefaultTransport.(*http.Transport)
	if baseTransport == nil {
		baseTransport = &http.Transport{}
	}
	transport := baseTransport.Clone()
	transport.ForceAttemptHTTP2 = req.HTTPVersion != "1.1"
	if req.HTTPVersion == "1.1" {
		transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	}
	if !req.EnableSSLVerification {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}
	} else if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	} else if transport.TLSClientConfig.MinVersion < tls.VersionTLS12 {
		transport.TLSClientConfig = transport.TLSClientConfig.Clone()
		transport.TLSClientConfig.MinVersion = tls.VersionTLS12
	}
	if config := clientCertConfigFor(req); config.enabled() {
		if cert, err := clientCerts.load(config); err == nil {
			cfg := transport.TLSClientConfig
			if cfg == nil {
				cfg = &tls.Config{MinVersion: tls.VersionTLS12}
				transport.TLSClientConfig = cfg
			}
			cfg.Certificates = []tls.Certificate{cert}
		}
	}
	transport.Proxy = proxyForRequest(req)
	return transport
}

func validateClientCertificate(req model.HttpRequest) string {
	config := clientCertConfigFor(req)
	if !config.enabled() {
		return ""
	}
	if _, err := clientCerts.load(config); err != nil {
		clientCerts.forget(config)
		return err.Error()
	}
	return ""
}

func sharedHTTPTransport(req model.HttpRequest) *http.Transport {
	return httpTransports.get(req)
}

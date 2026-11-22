package proxycapture

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Port            int      `json:"port"`
	Include         string   `json:"include"`
	Service         string   `json:"service"`
	Certificate     string   `json:"certificate"`
	Key             string   `json:"key"`
	ListenIP        string   `json:"listenIP"`
	ClientIP        string   `json:"clientIP"`
	IdentifyProcess bool     `json:"identifyProcess"`
	SSLHosts        []string `json:"sslHosts"`
	SystemProxy     bool     `json:"systemProxy"`
	AuthorityDir    string   `json:"-"`
}
type serviceTLS struct {
	authority string
	server    *tls.Config
	upstream  *tls.Config
}

func loadService(config Config) (*serviceTLS, error) {
	if config.Service == "" && config.Certificate == "" && config.Key == "" {
		return nil, nil
	}
	host, port, err := net.SplitHostPort(config.Service)
	number, portErr := strconv.Atoi(port)
	if err != nil || host == "" || portErr != nil || number < 1 || number > 65535 || strconv.Itoa(number) != port {
		return nil, errors.New("enter the HTTPS service as host:port")
	}
	cert, err := tls.LoadX509KeyPair(config.Certificate, config.Key)
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return nil, err
	}
	if leaf.IsCA {
		return nil, errors.New("select the service certificate, not a CA certificate")
	}
	if err := leaf.VerifyHostname(host); err != nil {
		return nil, err
	}
	now := time.Now()
	if now.Before(leaf.NotBefore) || now.After(leaf.NotAfter) {
		return nil, errors.New("the service certificate is outside its validity period")
	}
	roots := x509.NewCertPool()
	roots.AddCert(leaf)
	return &serviceTLS{authority: strings.ToLower(config.Service), server: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12, NextProtos: []string{"h2", "http/1.1"}}, upstream: &tls.Config{RootCAs: roots, ServerName: host, MinVersion: tls.VersionTLS12, VerifyConnection: func(s tls.ConnectionState) error {
		if len(s.PeerCertificates) == 0 || !s.PeerCertificates[0].Equal(leaf) {
			return errors.New("upstream certificate differs from the configured service")
		}
		return nil
	}}}, nil
}

type bufferedConn struct {
	net.Conn
	reader io.Reader
	done   chan struct{}
	once   sync.Once
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.reader.Read(b) }
func (c *bufferedConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { close(c.done) })
	return err
}

type serviceListener struct {
	conn     net.Conn
	done     <-chan struct{}
	accepted bool
}

func (l *serviceListener) Accept() (net.Conn, error) {
	if !l.accepted {
		l.accepted = true
		return l.conn, nil
	}
	<-l.done
	return nil, net.ErrClosed
}
func (l *serviceListener) Close() error   { return l.conn.Close() }
func (l *serviceListener) Addr() net.Addr { return l.conn.LocalAddr() }

func (s *session) serveService(w http.ResponseWriter, outer *http.Request) {
	s.intercept(w, outer, s.service.server, s.service.authority, nil)
}

func (s *session) serveDecrypted(w http.ResponseWriter, outer *http.Request, authority *Authority, x Exchange) {
	target := strings.ToLower(outer.Host)
	host, port, err := net.SplitHostPort(target)
	if err != nil || host == "" {
		http.Error(w, "Expected host:port", 400)
		return
	}
	origin := target
	if port == "443" {
		origin = host
		if strings.Contains(host, ":") {
			origin = "[" + host + "]"
		}
	}
	server := &tls.Config{MinVersion: tls.VersionTLS12, NextProtos: []string{"h2", "http/1.1"}, GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		name := hello.ServerName
		if name == "" {
			name = host
		}
		return authority.leaf(name)
	}}
	s.intercept(w, outer, server, origin, func() {
		if s.include != "" && !strings.EqualFold(host, s.include) {
			return
		}
		x.Entry.Status = 200
		x.Entry.Error = "The client rejected the Kurlo certificate. Trust the Kurlo CA or remove " + host + " from SSL proxying."
		if s.identifyProcess {
			x.Entry.Process = s.processes.source(s.ctx, s.addr, outer.RemoteAddr)
		}
		s.record(x)
	})
}

func (s *session) intercept(w http.ResponseWriter, outer *http.Request, config *tls.Config, origin string, rejected func()) {
	raw, buffer, err := http.NewResponseController(w).Hijack()
	if err != nil {
		http.Error(w, "HTTPS inspection unavailable", 500)
		return
	}
	client := &bufferedConn{Conn: raw, reader: io.MultiReader(io.LimitReader(buffer.Reader, int64(buffer.Reader.Buffered())), raw), done: make(chan struct{})}
	defer client.Close()
	stop := context.AfterFunc(s.ctx, func() { client.Close() })
	defer stop()
	if _, err := buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if err := buffer.Flush(); err != nil {
		return
	}
	tlsConn := tls.Server(client, config)
	if rejected != nil {
		ctx, cancel := context.WithTimeout(outer.Context(), 15*time.Second)
		err := tlsConn.HandshakeContext(ctx)
		cancel()
		if err != nil {
			rejected()
			return
		}
	}
	server := http.Server{
		BaseContext:       func(net.Listener) context.Context { return outer.Context() },
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 << 10,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodConnect || r.URL.IsAbs() || r.URL.Host != "" {
				http.Error(w, "Expected an origin-form request", 400)
				return
			}
			r.URL.Scheme = "https"
			r.URL.Host = origin
			r.Host = origin
			s.ServeHTTP(w, r)
		}),
	}
	server.Serve(&serviceListener{conn: tlsConn, done: client.done})
}

var upstreamRoots *x509.CertPool

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func (s *session) newTransport(config *tls.Config) *http.Transport {
	if config == nil && upstreamRoots != nil {
		config = &tls.Config{RootCAs: upstreamRoots}
	}
	return &http.Transport{DialContext: s.dial, TLSClientConfig: config, DisableCompression: true, MaxIdleConns: 64, IdleConnTimeout: 60 * time.Second, ResponseHeaderTimeout: 60 * time.Second, TLSHandshakeTimeout: 15 * time.Second}
}

func (s *session) roundTrip(r *http.Request) (*http.Response, error) {
	if s.serviceHTTP != nil && strings.EqualFold(r.URL.Host, s.service.authority) {
		return s.serviceHTTP.RoundTrip(r)
	}
	return s.transport.RoundTrip(r)
}

func (s *session) decryptingAuthority(target string) *Authority {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.authority == nil || !matchSSLHost(s.sslHosts, target) {
		return nil
	}
	return s.authority
}

func (r *Recorder) SetSSLHosts(hosts []string) (Status, error) {
	normalized, err := NormalizeSSLHosts(hosts)
	if err != nil {
		return r.Status(), err
	}
	r.mu.Lock()
	s := r.run
	dir := r.config.AuthorityDir
	r.mu.Unlock()
	var authority *Authority
	if s != nil && len(normalized) > 0 {
		s.mu.Lock()
		authority = s.authority
		s.mu.Unlock()
		if authority == nil {
			if authority, err = LoadAuthority(dir, true); err != nil {
				return r.Status(), err
			}
		}
	}
	r.mu.Lock()
	r.config.SSLHosts = normalized
	if r.run == s && s != nil {
		s.mu.Lock()
		s.sslHosts = normalized
		if authority != nil {
			s.authority = authority
		}
		s.mu.Unlock()
	}
	status := r.status()
	r.mu.Unlock()
	if s != nil {
		s.changed()
	}
	return status, nil
}

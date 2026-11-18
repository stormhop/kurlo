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
	Port            int    `json:"port"`
	Include         string `json:"include"`
	Service         string `json:"service"`
	Certificate     string `json:"certificate"`
	Key             string `json:"key"`
	ListenIP        string `json:"listenIP"`
	ClientIP        string `json:"clientIP"`
	IdentifyProcess bool   `json:"identifyProcess"`
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
	return &serviceTLS{authority: strings.ToLower(config.Service), server: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}}, upstream: &tls.Config{RootCAs: roots, ServerName: host, MinVersion: tls.VersionTLS12, VerifyConnection: func(s tls.ConnectionState) error {
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
	tlsConn := tls.Server(client, s.service.server)
	server := http.Server{
		BaseContext:       func(net.Listener) context.Context { return outer.Context() },
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 << 10,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodConnect || r.URL.IsAbs() || r.URL.Host != "" {
				http.Error(w, "Expected an origin-form request", 400)
				return
			}
			r.URL.Scheme = "https"
			r.URL.Host = s.service.authority
			r.Host = s.service.authority
			s.ServeHTTP(w, r)
		}),
	}
	server.Serve(&serviceListener{conn: tlsConn, done: client.done})
}

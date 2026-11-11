package auth

import (
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/Azure/go-ntlmssp"
)

type NTLMTransport struct {
	WrapTransport func(http.RoundTripper) http.RoundTripper
	base          *http.Transport
	handshake     *http.Transport
	origin        *url.URL
	username      string
	password      string
}

func NewNTLMTransport(base *http.Transport, origin *url.URL, username, password string) *NTLMTransport {
	handshake := base.Clone()
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	handshake.Protocols = protocols
	handshake.DisableKeepAlives = false
	return &NTLMTransport{base: base, handshake: handshake, origin: origin, username: username, password: password}
}

func (t *NTLMTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if t.origin == nil || !strings.EqualFold(req.URL.Scheme, t.origin.Scheme) || !strings.EqualFold(req.URL.Host, t.origin.Host) || req.Method == http.MethodOptions && req.Header.Get("Access-Control-Request-Method") != "" {
		return t.wrap(t.base).RoundTrip(req)
	}
	port := req.URL.Port()
	if port == "" {
		port = "80"
		if req.URL.Scheme == "https" {
			port = "443"
		}
	}
	conn, err := t.handshake.NewClientConn(req.Context(), req.URL.Scheme, net.JoinHostPort(req.URL.Hostname(), port))
	if err != nil {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, err
	}
	copy := req.Clone(req.Context())
	copy.SetBasicAuth(t.username, t.password)
	negotiator := ntlmssp.Negotiator{RoundTripper: t.wrap(conn)}
	response, err := negotiator.RoundTrip(copy)
	if err != nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		_ = conn.Close()
		return nil, err
	}
	response.Body = &ntlmResponseBody{ReadCloser: response.Body, conn: conn}
	return response, nil
}

func (t *NTLMTransport) wrap(base http.RoundTripper) http.RoundTripper {
	if t.WrapTransport != nil {
		return t.WrapTransport(base)
	}
	return base
}

type ntlmResponseBody struct {
	io.ReadCloser
	conn *http.ClientConn
}

func (b *ntlmResponseBody) Close() error {
	defer b.conn.Close()
	return b.ReadCloser.Close()
}

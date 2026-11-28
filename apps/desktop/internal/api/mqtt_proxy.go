package api

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"golang.org/x/net/proxy"
)

func mqttTCPProxy(req model.HttpRequest, target mqttTarget) (*url.URL, error) {
	mode := strings.ToLower(strings.TrimSpace(req.ProxyMode))
	if mode == "off" || mode == "system" || (mode != "on" && strings.TrimSpace(req.ProxyURL) == "") {
		return nil, nil
	}
	pick := proxyForRequest(req)
	if pick == nil {
		return nil, nil
	}
	scheme := "http"
	if target.scheme == "mqtts" {
		scheme = "https"
	}
	return pick(&http.Request{URL: &url.URL{Scheme: scheme, Host: target.addr}})
}

func dialMqttTCP(ctx context.Context, req model.HttpRequest, target mqttTarget) (net.Conn, error) {
	proxyURL, err := mqttTCPProxy(req, target)
	if err != nil {
		return nil, err
	}
	if proxyURL == nil {
		return (&net.Dialer{}).DialContext(ctx, "tcp", target.addr)
	}
	switch strings.ToLower(proxyURL.Scheme) {
	case "socks5", "socks5h":
		var auth *proxy.Auth
		if proxyURL.User != nil {
			password, _ := proxyURL.User.Password()
			auth = &proxy.Auth{User: proxyURL.User.Username(), Password: password}
		}
		dialer, err := proxy.SOCKS5("tcp", mqttProxyAddr(proxyURL, "1080"), auth, &net.Dialer{})
		if err != nil {
			return nil, err
		}
		conn, err := dialer.(proxy.ContextDialer).DialContext(ctx, "tcp", target.addr)
		if err != nil {
			return nil, fmt.Errorf("SOCKS5 proxy %s: %w", redactProxyURL(proxyURL.String()), err)
		}
		return conn, nil
	case "http", "https":
		return dialMqttHTTPProxy(ctx, req, proxyURL, target.addr)
	}
	return nil, fmt.Errorf("unsupported proxy scheme %q for MQTT", proxyURL.Scheme)
}

func mqttProxyAddr(u *url.URL, fallback string) string {
	if u.Port() != "" {
		return u.Host
	}
	return net.JoinHostPort(u.Hostname(), fallback)
}

func dialMqttHTTPProxy(ctx context.Context, req model.HttpRequest, proxyURL *url.URL, addr string) (net.Conn, error) {
	secure := strings.EqualFold(proxyURL.Scheme, "https")
	port := "80"
	if secure {
		port = "443"
	}
	proxyAddr := mqttProxyAddr(proxyURL, port)
	label := redactProxyURL(proxyURL.String())
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return nil, fmt.Errorf("could not reach the proxy %s: %w", label, err)
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if secure {
		tlsConn := tls.Client(conn, &tls.Config{MinVersion: tls.VersionTLS12, ServerName: proxyURL.Hostname(), InsecureSkipVerify: !req.EnableSSLVerification})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("TLS handshake with the proxy %s: %w", label, err)
		}
		conn = tlsConn
	}
	connect := &http.Request{Method: http.MethodConnect, URL: &url.URL{Opaque: addr}, Host: addr, Header: http.Header{"User-Agent": []string{"Kurlo/" + appVersion}}}
	if proxyURL.User != nil {
		password, _ := proxyURL.User.Password()
		connect.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(proxyURL.User.Username()+":"+password)))
	}
	if err := connect.Write(conn); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("proxy %s: %w", label, err)
	}
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, connect)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("proxy %s did not answer CONNECT: %w", label, err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_ = conn.Close()
		return nil, fmt.Errorf("proxy %s refused the tunnel to %s: %s", label, addr, resp.Status)
	}
	if !stop() && ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if reader.Buffered() > 0 {
		return &mqttBufferedConn{Conn: conn, reader: reader}, nil
	}
	return conn, nil
}

type mqttBufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *mqttBufferedConn) Read(p []byte) (int, error) {
	return c.reader.Read(p)
}

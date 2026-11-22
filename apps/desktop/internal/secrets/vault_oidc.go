package secrets

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const oidcLoginTimeout = 3 * time.Minute

func (c ProviderConfig) CallTimeout() time.Duration {
	if c.Type == TypeVault && c.Auth.Method == "oidc" {
		return c.Timeout + oidcLoginTimeout
	}
	return c.Timeout
}

func validLoopbackRedirect(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" {
		return errors.New("must be an http:// address on this computer, like " + defaultOIDCRedirectURI)
	}
	switch parsed.Hostname() {
	case "localhost", "127.0.0.1", "::1":
	default:
		return errors.New("must point to localhost, like " + defaultOIDCRedirectURI)
	}
	if parsed.Port() == "" {
		return errors.New("needs a port, like " + defaultOIDCRedirectURI)
	}
	return nil
}

func randomToken() string {
	buf := make([]byte, 24)
	_, _ = rand.Read(buf)
	return base64.RawURLEncoding.EncodeToString(buf)
}

type oidcCallback struct {
	code  string
	state string
	err   error
}

func (p *vaultProvider) oidcLogin(ctx context.Context) ([]byte, error) {
	if p.env.OpenBrowser == nil {
		return nil, newError(KindNotAuthenticated, p.config.ID, "OIDC sign-in needs a browser; sign in from the Kurlo app, or use a token here (VAULT_TOKEN)")
	}
	redirect, _ := url.Parse(p.config.Auth.RedirectURI)
	host := redirect.Hostname()
	if host == "localhost" {
		host = "127.0.0.1"
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(host, redirect.Port()))
	if err != nil {
		return nil, newError(KindUnavailable, p.config.ID, "cannot listen on %s for the sign-in redirect: %v", redirect.Host, err)
	}
	defer listener.Close()
	nonce := randomToken()
	authURLBody, err := p.postLogin(ctx, "auth/"+p.config.Auth.Mount+"/oidc/auth_url", map[string]string{"role": p.config.Auth.Role, "redirect_uri": p.config.Auth.RedirectURI, "client_nonce": nonce})
	if err != nil {
		return nil, err
	}
	var started struct {
		Data struct {
			AuthURL string `json:"auth_url"`
		} `json:"data"`
	}
	_ = json.Unmarshal(authURLBody, &started)
	if started.Data.AuthURL == "" {
		return nil, newError(KindNotAuthenticated, p.config.ID, "Vault returned no sign-in URL; add %s to allowed_redirect_uris of the role", p.config.Auth.RedirectURI)
	}
	outcome := make(chan oidcCallback, 1)
	mux := http.NewServeMux()
	mux.HandleFunc(redirect.EscapedPath(), func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		result := oidcCallback{code: query.Get("code"), state: query.Get("state")}
		message := "Signed in to Vault. You can close this tab and return to Kurlo."
		if problem := query.Get("error"); problem != "" {
			result.err = errors.New(strings.TrimSpace(problem + " " + query.Get("error_description")))
			message = "Sign-in failed: " + result.err.Error()
		} else if result.code == "" {
			result.err = errors.New("the identity provider returned no code")
			message = "Sign-in failed: no code was returned."
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprintf(w, "<!doctype html><meta charset=\"utf-8\"><title>Kurlo</title><p style=\"font:16px system-ui;margin:3em\">%s</p>", html.EscapeString(message))
		select {
		case outcome <- result:
		default:
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	if err := p.env.OpenBrowser(started.Data.AuthURL); err != nil {
		return nil, newError(KindUnavailable, p.config.ID, "cannot open the browser: %v", err)
	}
	var result oidcCallback
	select {
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, newError(KindTimeout, p.config.ID, "OIDC sign-in was not finished in the browser in time")
		}
		return nil, newError(KindUnavailable, p.config.ID, "OIDC sign-in was cancelled")
	case result = <-outcome:
	}
	if result.err != nil {
		return nil, newError(KindNotAuthenticated, p.config.ID, "OIDC sign-in failed: %s", result.err.Error())
	}
	query := url.Values{"code": {result.code}, "state": {result.state}, "client_nonce": {nonce}}
	body, status, err := p.do(ctx, http.MethodGet, "auth/"+p.config.Auth.Mount+"/oidc/callback", query, nil, "")
	if err != nil {
		return nil, err
	}
	if status == http.StatusBadRequest || status == http.StatusForbidden || status == http.StatusUnauthorized {
		return nil, newError(KindNotAuthenticated, p.config.ID, "OIDC login failed: %s", vaultErrors(body, status))
	}
	if err := p.statusError(status, body, "auth/"+p.config.Auth.Mount+"/oidc/callback"); err != nil {
		return nil, err
	}
	return body, nil
}

type vaultMount struct {
	Path    string
	Type    string
	Version string
}

func (p *vaultProvider) mounts(ctx context.Context, token string) ([]vaultMount, error) {
	body, status, err := p.do(ctx, http.MethodGet, "sys/internal/ui/mounts", nil, nil, token)
	if err != nil {
		return nil, err
	}
	if err := p.statusError(status, body, "sys/internal/ui/mounts"); err != nil {
		return nil, err
	}
	var decoded struct {
		Data struct {
			Secret map[string]struct {
				Type    string            `json:"type"`
				Options map[string]string `json:"options"`
			} `json:"secret"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, newError(KindUnavailable, p.config.ID, "unexpected answer from sys/internal/ui/mounts")
	}
	var out []vaultMount
	for path, mount := range decoded.Data.Secret {
		out = append(out, vaultMount{Path: strings.Trim(path, "/") + "/", Type: mount.Type, Version: mount.Options["version"]})
	}
	return out, nil
}

func (p *vaultProvider) mountFor(ctx context.Context, token, prefix string) (vaultMount, error) {
	body, status, err := p.do(ctx, http.MethodGet, "sys/internal/ui/mounts/"+strings.Trim(prefix, "/"), nil, nil, token)
	if err != nil {
		return vaultMount{}, err
	}
	if err := p.statusError(status, body, prefix); err != nil {
		return vaultMount{}, err
	}
	var decoded struct {
		Data struct {
			Path    string            `json:"path"`
			Type    string            `json:"type"`
			Options map[string]string `json:"options"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil || decoded.Data.Path == "" {
		return vaultMount{}, newError(KindNotFound, p.config.ID, "no secrets engine at %s", prefix)
	}
	return vaultMount{Path: strings.Trim(decoded.Data.Path, "/") + "/", Type: decoded.Data.Type, Version: decoded.Data.Options["version"]}, nil
}

func (p *vaultProvider) List(ctx context.Context, prefix string) ([]Entry, error) {
	token, err := p.token(ctx)
	if err != nil {
		return nil, err
	}
	prefix = strings.TrimLeft(strings.TrimSpace(prefix), "/")
	if prefix == "" {
		mounts, err := p.mounts(ctx, token)
		if err != nil {
			return nil, err
		}
		var entries []Entry
		for _, mount := range mounts {
			if mount.Type != "kv" && mount.Type != "generic" {
				continue
			}
			detail := "KV v1"
			if mount.Version == "2" {
				detail = "KV v2"
			}
			entries = append(entries, Entry{Name: mount.Path, Browse: mount.Path, Detail: detail})
		}
		sortEntries(entries)
		return entries, nil
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	mount, err := p.mountFor(ctx, token, prefix)
	if err != nil {
		return nil, err
	}
	rest := strings.TrimPrefix(prefix, mount.Path)
	if mount.Version == "2" {
		rest = strings.TrimPrefix(strings.TrimPrefix(rest, "data/"), "metadata/")
	}
	listPath := mount.Path + rest
	if mount.Version == "2" {
		listPath = mount.Path + "metadata/" + rest
	}
	body, status, err := p.do(ctx, http.MethodGet, strings.TrimSuffix(listPath, "/"), url.Values{"list": {"true"}}, nil, token)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return []Entry{}, nil
	}
	if err := p.statusError(status, body, listPath); err != nil {
		return nil, err
	}
	var decoded struct {
		Data struct {
			Keys []string `json:"keys"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, newError(KindUnavailable, p.config.ID, "unexpected answer when listing %s", listPath)
	}
	entries := make([]Entry, 0, len(decoded.Data.Keys))
	for _, key := range decoded.Data.Keys {
		if strings.HasSuffix(key, "/") {
			entries = append(entries, Entry{Name: key, Browse: mount.Path + rest + key})
			continue
		}
		path := mount.Path + rest + key
		if mount.Version == "2" {
			path = mount.Path + "data/" + rest + key
		}
		entries = append(entries, Entry{Name: key, Path: path})
	}
	return capEntries(entries), nil
}

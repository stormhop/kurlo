package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	openRouterConnectEvent = "ai:openrouter-connect"
	openRouterKeyLabel     = "Kurlo"
)

var (
	openRouterAuthURL        = "https://openrouter.ai/auth"
	openRouterKeysURL        = "https://openrouter.ai/api/v1/auth/keys"
	openRouterBridgeURL      = "https://kurlo.dev/connect/openrouter/"
	openRouterBridgeTimeout  = 3 * time.Second
	openRouterConnectTimeout = 5 * time.Minute
	openRouterOpenBrowser    = func(a *App, target string) error { return a.openAuthorizeURL(target) }
)

type openRouterConnector struct {
	mu      sync.Mutex
	seq     uint64
	state   model.OpenRouterConnectState
	cancel  context.CancelFunc
	servers []*http.Server
}

var openRouterConnect = &openRouterConnector{state: model.OpenRouterConnectState{Status: model.OpenRouterConnectIdle}}

func openRouterRandom(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func openRouterVerifier() (string, string, error) {
	verifier, err := openRouterRandom(32)
	if err != nil {
		return "", "", err
	}
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

func openRouterListeners() ([]net.Listener, int, error) {
	var lastErr error
	for attempt := 0; attempt < 8; attempt++ {
		primary, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			return nil, 0, fmt.Errorf("Kurlo could not open a local port for the sign-in: %v", err)
		}
		port := primary.Addr().(*net.TCPAddr).Port
		secondary, err := net.Listen("tcp6", fmt.Sprintf("[::1]:%d", port))
		if err == nil {
			return []net.Listener{primary, secondary}, port, nil
		}
		lastErr = err
		if probe, probeErr := net.Listen("tcp6", "[::1]:0"); probeErr != nil {
			return []net.Listener{primary}, port, nil
		} else {
			_ = probe.Close()
		}
		_ = primary.Close()
	}
	return nil, 0, fmt.Errorf("Kurlo could not open a local port for the sign-in: %v", lastErr)
}

func openRouterBridgeAvailable(ctx context.Context) bool {
	if openRouterBridgeURL == "" {
		return false
	}
	probeCtx, cancel := context.WithTimeout(ctx, openRouterBridgeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodHead, openRouterBridgeURL, nil)
	if err != nil {
		return false
	}
	resp, err := aiConnectionHTTPClient.Do(req)
	if err != nil {
		log.Printf("kurlo: OpenRouter sign-in bridge is not reachable (%v); using a localhost callback", err)
		return false
	}
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("kurlo: OpenRouter sign-in bridge answered %d; using a localhost callback", resp.StatusCode)
		return false
	}
	return true
}

func openRouterAuthorizeURL(challenge, state string, port int, bridge bool) string {
	callback := fmt.Sprintf("http://localhost:%d/callback", port)
	if bridge {
		callback = openRouterBridgeURL
	}
	query := url.Values{}
	query.Set("callback_url", callback)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	query.Set("state", state)
	query.Set("key_label", openRouterKeyLabel)
	return openRouterAuthURL + "?" + query.Encode()
}

func (c *openRouterConnector) snapshot() model.OpenRouterConnectState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

func (c *openRouterConnector) stopLocked() {
	if c.cancel != nil {
		c.cancel()
		c.cancel = nil
	}
	servers := c.servers
	c.servers = nil
	for _, server := range servers {
		go func(server *http.Server) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = server.Shutdown(ctx)
		}(server)
	}
}

func (c *openRouterConnector) finish(a *App, seq uint64, state model.OpenRouterConnectState) bool {
	c.mu.Lock()
	if seq != c.seq || c.state.Status != model.OpenRouterConnectWaiting {
		c.mu.Unlock()
		return false
	}
	state.AuthURL = c.state.AuthURL
	c.state = state
	c.stopLocked()
	c.mu.Unlock()
	if state.Error != "" {
		log.Printf("kurlo: OpenRouter sign-in %s: %s", state.Status, state.Error)
	} else {
		log.Printf("kurlo: OpenRouter sign-in %s", state.Status)
	}
	if a != nil && a.ctx != nil {
		runtime.EventsEmit(a.ctx, openRouterConnectEvent, state)
	}
	return true
}

func exchangeOpenRouterCode(ctx context.Context, client *http.Client, code, verifier string) (string, error) {
	body, err := aiConnectionPost(ctx, client, openRouterKeysURL, http.Header{"Accept": []string{"application/json"}}, map[string]string{
		"code":                  code,
		"code_verifier":         verifier,
		"code_challenge_method": "S256",
	})
	var httpErr *aiHTTPError
	if errors.As(err, &httpErr) {
		if httpErr.status == http.StatusForbidden || httpErr.status == http.StatusBadRequest {
			return "", errors.New("OpenRouter did not accept the sign-in code; connect again")
		}
		return "", fmt.Errorf("OpenRouter could not finish the sign-in: %s", httpErr.message)
	}
	if err != nil {
		return "", err
	}
	var payload struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || strings.TrimSpace(payload.Key) == "" {
		return "", errors.New("OpenRouter finished the sign-in without returning a key; connect again")
	}
	return strings.TrimSpace(payload.Key), nil
}

func saveOpenRouterKey(key string) (model.AiConnection, error) {
	input := model.AiConnectionInput{Kind: model.AiConnectionOpenRouter, Key: key}
	if connections, err := loadSavedAiConnections(); err == nil {
		for _, connection := range connections {
			if connection.Kind == model.AiConnectionOpenRouter {
				input.ID = connection.ID
				input.Label = connection.Label
				input.BaseURL = connection.BaseURL
				input.Model = connection.Model
				break
			}
		}
	}
	saved, _, err := upsertAiConnection(input)
	if err != nil {
		return model.AiConnection{}, err
	}
	return aiConnectionView(saved), nil
}

func openRouterCallbackPage(ok bool, title, detail string) string {
	mark := "&#10007;"
	color := "#f85149"
	if ok {
		mark = "&#10003;"
		color = "#3fb950"
	}
	return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Kurlo</title>" +
		"<style>body{font-family:-apple-system,system-ui,sans-serif;background:#111113;color:#ececef;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}" +
		"main{max-width:26rem;padding:2rem;text-align:center}.mark{width:3rem;height:3rem;border-radius:50%;margin:0 auto 1.25rem;display:flex;align-items:center;justify-content:center;font-size:1.5rem;border:1px solid #2d2d32;color:" + color + "}" +
		"h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}p{color:#a6a6ae;line-height:1.5;margin:0}.brand{margin-top:2rem;color:#85858e;font-size:.8rem;letter-spacing:.04em}</style></head>" +
		"<body><main><div class=\"mark\">" + mark + "</div><h1>" + html.EscapeString(title) + "</h1><p>" + html.EscapeString(detail) + "</p><div class=\"brand\">KURLO</div></main>" +
		"<script>setTimeout(function(){window.close()},1500)</script></body></html>"
}

func (c *openRouterConnector) callbackHandler(a *App, seq uint64, ctx context.Context, verifier, state string) http.Handler {
	var once sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		query := r.URL.Query()
		if got := query.Get("state"); subtle.ConstantTimeCompare([]byte(got), []byte(state)) != 1 {
			log.Printf("kurlo: OpenRouter sign-in callback ignored: the state does not match this sign-in")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(openRouterCallbackPage(false, "This sign-in link is not for this Kurlo window", "Go back to Kurlo and click Connect OpenRouter again.")))
			return
		}
		handled := false
		once.Do(func() {
			handled = true
			code := strings.TrimSpace(query.Get("code"))
			if code == "" {
				message := "OpenRouter did not return a sign-in code; connect again"
				c.finish(a, seq, model.OpenRouterConnectState{Status: model.OpenRouterConnectFailed, Error: message})
				_, _ = w.Write([]byte(openRouterCallbackPage(false, "Sign-in did not finish", message)))
				return
			}
			key, err := exchangeOpenRouterCode(ctx, aiConnectionHTTPClient, code, verifier)
			var connection model.AiConnection
			if err == nil {
				connection, err = saveOpenRouterKey(key)
			}
			if err != nil {
				c.finish(a, seq, model.OpenRouterConnectState{Status: model.OpenRouterConnectFailed, Error: err.Error()})
				_, _ = w.Write([]byte(openRouterCallbackPage(false, "Sign-in did not finish", err.Error())))
				return
			}
			c.finish(a, seq, model.OpenRouterConnectState{Status: model.OpenRouterConnectConnected, Connection: &connection})
			_, _ = w.Write([]byte(openRouterCallbackPage(true, "Kurlo is connected to OpenRouter", "You can close this tab and go back to Kurlo.")))
		})
		if !handled {
			w.WriteHeader(http.StatusGone)
			_, _ = w.Write([]byte(openRouterCallbackPage(false, "This sign-in link was already used", "Go back to Kurlo and connect again if you need to.")))
		}
	})
	return mux
}

func (c *openRouterConnector) start(a *App) model.OpenRouterConnectState {
	verifier, challenge, err := openRouterVerifier()
	if err != nil {
		return model.OpenRouterConnectState{Status: model.OpenRouterConnectFailed, Error: err.Error()}
	}
	nonce, err := openRouterRandom(18)
	if err != nil {
		return model.OpenRouterConnectState{Status: model.OpenRouterConnectFailed, Error: err.Error()}
	}
	listeners, port, err := openRouterListeners()
	if err != nil {
		return model.OpenRouterConnectState{Status: model.OpenRouterConnectFailed, Error: err.Error()}
	}
	bridge := openRouterBridgeAvailable(a.appContext())
	state := fmt.Sprintf("%d.%s", port, nonce)
	authURL := openRouterAuthorizeURL(challenge, state, port, bridge)

	c.mu.Lock()
	c.stopLocked()
	c.seq++
	seq := c.seq
	ctx, cancel := context.WithTimeout(context.Background(), openRouterConnectTimeout)
	c.cancel = cancel
	c.state = model.OpenRouterConnectState{Status: model.OpenRouterConnectWaiting, AuthURL: authURL}
	handler := c.callbackHandler(a, seq, ctx, verifier, state)
	for _, listener := range listeners {
		server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
		c.servers = append(c.servers, server)
		go func(server *http.Server, listener net.Listener) { _ = server.Serve(listener) }(server, listener)
	}
	current := c.state
	c.mu.Unlock()
	log.Printf("kurlo: OpenRouter sign-in started on port %d (%d listeners, bridge %v)", port, len(listeners), bridge)

	go func() {
		<-ctx.Done()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			c.finish(a, seq, model.OpenRouterConnectState{Status: model.OpenRouterConnectFailed, Error: "The sign-in timed out; connect again"})
		}
	}()

	if err := openRouterOpenBrowser(a, authURL); err != nil {
		c.finish(a, seq, model.OpenRouterConnectState{Status: model.OpenRouterConnectFailed, Error: "Kurlo could not open the browser: " + err.Error()})
		return c.snapshot()
	}
	return current
}

func (c *openRouterConnector) cancelConnect(a *App) model.OpenRouterConnectState {
	c.mu.Lock()
	seq := c.seq
	c.mu.Unlock()
	c.finish(a, seq, model.OpenRouterConnectState{Status: model.OpenRouterConnectCancelled})
	return c.snapshot()
}

func (a *App) StartOpenRouterConnect() model.OpenRouterConnectState {
	return openRouterConnect.start(a)
}

func (a *App) CancelOpenRouterConnect() model.OpenRouterConnectState {
	return openRouterConnect.cancelConnect(a)
}

func (a *App) OpenRouterConnectStatus() model.OpenRouterConnectState {
	return openRouterConnect.snapshot()
}

func (a *App) ReopenOpenRouterConnect() model.OpenRouterConnectState {
	state := openRouterConnect.snapshot()
	if state.Status == model.OpenRouterConnectWaiting && state.AuthURL != "" {
		if err := openRouterOpenBrowser(a, state.AuthURL); err != nil {
			state.Error = "Kurlo could not open the browser: " + err.Error()
		}
	}
	return state
}

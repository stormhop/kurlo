package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/proxycapture"
)

func TestSuppliedCaptureMetadata(t *testing.T) {
	file := filepath.Join(t.TempDir(), "session.har")
	if err := os.WriteFile(file, []byte(`{"log":{"entries":[{"request":{"method":"GET","url":"https://dev.test/v1/orders/42?token=omit","headers":[{"name":"Authorization","value":"omit"}]},"response":{"status":200,"content":{"text":"omit"}},"time":16}]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	server := newMCPServer(mcpServerOptions{captureHAR: file, readOnly: true}, os.Stdout)
	result, err := server.callTool(context.Background(), json.RawMessage(`{"name":"list_captured","arguments":{"host":"dev.test"}}`))
	b, _ := json.Marshal(result)
	if err != nil || strings.Contains(string(b), "omit") || !strings.Contains(string(b), "/v1/orders/42") {
		t.Fatal(string(b), err)
	}
	items, err := loadCaptureObservations(file)
	if err != nil {
		t.Fatal(err)
	}
	report, err := compareCaptureOperations(`{"openapi":"3.0.0","paths":{"/orders/{id}":{"get":{}}}}`, "dev.test", "/v1", items)
	b, _ = json.Marshal(report)
	if err != nil || !strings.Contains(string(b), `"matched":1`) {
		t.Fatal(string(b), err)
	}
}

func TestCreateCollectionFromCapturedMetadata(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := writeYAMLWorkspace(t, "http://localhost")
	file := filepath.Join(t.TempDir(), "session.har")
	err := os.WriteFile(file, []byte(`{"log":{"entries":[{"request":{"method":"GET","url":"https://dev.test/orders?token=hidden"},"response":{"status":201}},{"request":{"method":"GET","url":"https://dev.test/orders?token=another"},"response":{"status":201}}]}}`), 0600)
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"name": "Capture", "host": "dev.test"}
	h := startMCPHarness(t, mcpServerOptions{workspace: root, captureHAR: file})
	var saved struct{ Requests int }
	if res := h.tool("create_captured_collection", args, &saved); res.IsError || saved.Requests != 1 {
		t.Fatal(res, saved)
	}
	server := newMCPServer(mcpServerOptions{workspace: root, captureHAR: file, readOnly: true}, os.Stdout)
	if _, err := server.callTool(context.Background(), json.RawMessage(`{"name":"create_captured_collection","arguments":{"name":"Another","host":"dev.test"}}`)); err == nil {
		t.Fatal("read-only server created a collection")
	}
}

func TestCompressedCaptureExport(t *testing.T) {
	var encoded bytes.Buffer
	zip := gzip.NewWriter(&encoded)
	io.WriteString(zip, `{"orders":42}`)
	zip.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		w.Write(encoded.Bytes())
	}))
	defer origin.Close()
	app := NewApp()
	st, err := app.capture.Start(proxycapture.Config{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer app.capture.Close()
	addr, _ := url.Parse("http://" + st.Address)
	tr := &http.Transport{Proxy: http.ProxyURL(addr), DisableCompression: true}
	defer tr.CloseIdleConnections()
	client := http.Client{Transport: tr}
	resp, err := client.Get(origin.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || !bytes.Equal(body, encoded.Bytes()) {
		t.Fatal("wire data changed", err)
	}
	app.capture.Stop()
	rows := app.ProxyCaptureEntries()
	entry, err := app.ProxyCaptureEntry(rows[0].ID)
	if err != nil || entry.Response.Body != `{"orders":42}` {
		t.Fatal(entry, err)
	}
	har, err := app.ProxyCaptureHAR(nil)
	var payload struct {
		Log struct {
			Entries []struct {
				Response struct{ Content struct{ Text string } }
			}
		}
	}
	if err != nil || json.Unmarshal([]byte(har), &payload) != nil || len(payload.Log.Entries) != 1 || payload.Log.Entries[0].Response.Content.Text != entry.Response.Body {
		t.Fatal(har, err)
	}
}

func TestAgentReadsLiveCaptureWithBodies(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	if err := saveLocalKurloStore(requestStorePath(), map[string]any{"secrets": map[string]string{"stripe": "sk_live_capture42"}}); err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	zip := gzip.NewWriter(&encoded)
	io.WriteString(zip, `{"order":{"id":42,"total":"19.90"},"key":"sk_live_capture42"}`)
	zip.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Set-Cookie", "session=hidden")
		w.WriteHeader(201)
		w.Write(encoded.Bytes())
	}))
	defer origin.Close()
	app := NewApp()
	st, err := app.capture.Start(proxycapture.Config{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer app.capture.Close()
	addr, _ := url.Parse("http://" + st.Address)
	tr := &http.Transport{Proxy: http.ProxyURL(addr), DisableCompression: true}
	defer tr.CloseIdleConnections()
	req, _ := http.NewRequest("POST", origin.URL+"/orders?token=hidden", strings.NewReader(`{"sku":"A-1","qty":2}`))
	req.Header.Set("Authorization", "Bearer hidden")
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	app.capture.Stop()

	rt := &agentRuntime{app: app, bridges: map[string]*agentToolBridge{}}
	bridge := rt.bridge(model.AgentChat{ID: "chat"}, writeYAMLWorkspace(t, "http://localhost"))
	names := map[string]bool{}
	for _, d := range bridge.toolDefinitions() {
		names[d["name"].(string)] = true
	}
	for _, name := range []string{"proxy_status", "list_captured", "get_captured", "create_captured_collection"} {
		if !names[name] {
			t.Fatal("missing tool", name)
		}
	}
	if d := bridge.decide("get_captured", json.RawMessage(`{"id":1}`)); d.ask || d.kind != model.AgentToolRead {
		t.Fatal(d)
	}
	if d := bridge.decide("create_captured_collection", json.RawMessage(`{"name":"x","host":"y"}`)); !d.ask {
		t.Fatal(d)
	}
	server := bridge.server
	id := app.capture.Entries()[0].ID
	result, err := server.callTool(context.Background(), json.RawMessage(fmt.Sprintf(`{"name":"get_captured","arguments":{"id":%d}}`, id)))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(result)
	text := string(b)
	for _, want := range []string{`\"sku\":\"A-1\"`, `\"total\":\"19.90\"`, `[secret]`, `"status":201`, `"timings"`, `untrusted`, `"protocol":"HTTP/1.1"`} {
		if !strings.Contains(text, want) {
			t.Fatal(want, text)
		}
	}
	for _, leak := range []string{"hidden", "sk_live_capture42", "Authorization"} {
		if strings.Contains(text, leak) {
			t.Fatal(leak, text)
		}
	}
	result, err = server.callTool(context.Background(), json.RawMessage(`{"name":"list_captured","arguments":{"query":"19.90"}}`))
	b, _ = json.Marshal(result)
	if err != nil || !strings.Contains(string(b), `"total":1`) || !strings.Contains(string(b), "response body") || strings.Contains(string(b), "A-1") {
		t.Fatal(string(b), err)
	}
	result, _ = server.callTool(context.Background(), json.RawMessage(`{"name":"list_captured","arguments":{"query":"nothing-like-this"}}`))
	if b, _ = json.Marshal(result); !strings.Contains(string(b), `"total":0`) {
		t.Fatal(string(b))
	}
	result, _ = server.callTool(context.Background(), json.RawMessage(`{"name":"proxy_status","arguments":{}}`))
	if b, _ = json.Marshal(result); !strings.Contains(string(b), `"source":"capture"`) || !strings.Contains(string(b), `"entries":1`) {
		t.Fatal(string(b))
	}
	result, _ = server.callTool(context.Background(), json.RawMessage(`{"name":"get_captured","arguments":{"id":999}}`))
	if b, _ = json.Marshal(result); !strings.Contains(string(b), "no captured exchange 999") {
		t.Fatal(string(b))
	}
}

func TestSuppliedCaptureBodiesAndReload(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	file := filepath.Join(t.TempDir(), "session.har")
	write := func(body string) {
		data := `{"log":{"entries":[{"request":{"method":"GET","url":"https://dev.test/v1/orders/42?token=omit","headers":[{"name":"Authorization","value":"omit"},{"name":"Accept","value":"application/json"}]},"response":{"status":200,"headers":[{"name":"Content-Type","value":"application/json"}],"content":{"text":"` + body + `"}},"time":16}]}}`
		if err := os.WriteFile(file, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{\"id\":42}`)
	server := newMCPServer(mcpServerOptions{captureHAR: file, readOnly: true}, os.Stdout)
	result, err := server.callTool(context.Background(), json.RawMessage(`{"name":"get_captured","arguments":{"id":1}}`))
	b, _ := json.Marshal(result)
	if err != nil || !strings.Contains(string(b), `{\"id\":42}`) || strings.Contains(string(b), "omit") || !strings.Contains(string(b), "Accept") {
		t.Fatal(string(b), err)
	}
	write(`{\"id\":43,\"padding\":\"longer file\"}`)
	result, _ = server.callTool(context.Background(), json.RawMessage(`{"name":"get_captured","arguments":{"id":1}}`))
	if b, _ = json.Marshal(result); !strings.Contains(string(b), `\"id\":43`) {
		t.Fatal(string(b))
	}
	names := map[string]bool{}
	for _, d := range server.captureTools() {
		names[d["name"].(string)] = true
	}
	if !names["get_captured"] || names["create_captured_collection"] {
		t.Fatal(names)
	}
}

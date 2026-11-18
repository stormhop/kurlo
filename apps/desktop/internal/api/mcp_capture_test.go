package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

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

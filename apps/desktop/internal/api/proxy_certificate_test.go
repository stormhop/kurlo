package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/pem"
	"net/http"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/proxycapture"
	"github.com/stormhop/kurlo/apps/desktop/internal/systemproxy"
)

func TestProxyCertificateLifecycle(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	app := &App{}
	info, err := app.ProxyCertificate()
	if err != nil || info.Exists || !strings.HasSuffix(info.Path, "kurlo-capture-ca.pem") {
		t.Fatal(info, err)
	}
	var calls [][]string
	original := runTrustCommand
	runTrustCommand = func(_ context.Context, name string, args ...string) error {
		calls = append(calls, append([]string{name}, args...))
		return nil
	}
	t.Cleanup(func() { runTrustCommand = original })
	trusted, err := app.TrustProxyCertificate()
	switch goruntime.GOOS {
	case "darwin":
		if err != nil || len(calls) != 1 || strings.Join(calls[0][:7], " ") != "security add-trusted-cert -r trustRoot -p ssl -k" || calls[0][8] != trusted.Path {
			t.Fatal(calls, err)
		}
	case "windows":
		if err != nil || len(calls) != 1 || strings.Join(calls[0][:4], " ") != "certutil -user -addstore Root" {
			t.Fatal(calls, err)
		}
	default:
		if err == nil || len(calls) != 0 {
			t.Fatal(calls, err)
		}
	}
	created, err := app.ProxyCertificate()
	if err != nil || !created.Exists || created.Fingerprint == "" {
		t.Fatal(created, err)
	}
	text, err := app.ProxyCertificatePEM()
	if block, _ := pem.Decode([]byte(text)); err != nil || block == nil || block.Type != "CERTIFICATE" {
		t.Fatal(text, err)
	}
	var stdout, stderr bytes.Buffer
	if code := runProxyCLI(context.Background(), []string{"ca"}, &stdout, &stderr); code != 0 || !strings.Contains(stdout.String(), created.Fingerprint) {
		t.Fatal(code, stdout.String(), stderr.String())
	}
	stdout.Reset()
	if code := runProxyCLI(context.Background(), []string{"ca", "--pem"}, &stdout, &stderr); code != 0 || stdout.String() != text {
		t.Fatal(code, stdout.String())
	}
}

func TestProxyCLIRejectsInvalidSSLHost(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	var stdout, stderr bytes.Buffer
	if code := runProxyCLI(context.Background(), []string{"--port", "65001", "--ssl-host", "https://example.test"}, &stdout, &stderr); code != 1 || !strings.Contains(stderr.String(), "host name") {
		t.Fatal(stdout.String(), stderr.String())
	}
}

func TestProxySystemProxyFollowsRecording(t *testing.T) {
	dir := t.TempDir()
	useTempConfigDir(t, dir)
	settings := map[string]string{"mode": "'none'", "autoconfig-url": "''"}
	original := newSystemProxy
	newSystemProxy = func() *systemproxy.Manager {
		return &systemproxy.Manager{Path: filepath.Join(dir, "capture-system-proxy.json"), GOOS: "linux", Run: func(_ context.Context, name string, args ...string) (string, error) {
			if args[0] == "get" {
				return settings[args[2]], nil
			}
			settings[args[2]] = "'" + args[3] + "'"
			return "", nil
		}}
	}
	t.Cleanup(func() { newSystemProxy = original })
	app := &App{}
	t.Cleanup(app.capture.Close)
	status, err := app.StartProxyCapture(proxycapture.Config{Port: 18431, SystemProxy: true})
	if err != nil || !status.SystemProxy || settings["mode"] != "'auto'" || settings["autoconfig-url"] != "'http://"+status.Address+"/proxy.pac'" {
		t.Fatal(status, settings, err)
	}
	if !app.ProxyCaptureStatus().SystemProxy {
		t.Fatal("status lost the system proxy")
	}
	status, err = app.StopProxyCapture()
	if err != nil || status.SystemProxy || settings["mode"] != "'none'" || settings["autoconfig-url"] != "''" {
		t.Fatal(status, settings, err)
	}
}

func TestDecodeCapturePreviewAcceptsTruncatedGzip(t *testing.T) {
	var buffer bytes.Buffer
	zw := gzip.NewWriter(&buffer)
	zw.Write([]byte(strings.Repeat(`{"invoice":"INV-42"},`, 4000)))
	zw.Close()
	raw := buffer.Bytes()[:buffer.Len()/2]
	text, ok := decodeCapturePreview(http.Header{"Content-Encoding": {"gzip"}}, string(raw), 256<<10)
	if !ok || !strings.Contains(text, "INV-42") {
		t.Fatal(ok, len(text))
	}
}

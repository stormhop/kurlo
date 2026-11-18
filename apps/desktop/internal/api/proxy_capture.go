package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/skip2/go-qrcode"
	"github.com/stormhop/kurlo/apps/desktop/internal/proxycapture"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) StartProxyCapture(config proxycapture.Config) (proxycapture.Status, error) {
	if config.Port < 1 {
		return a.capture.Status(), errors.New("enter a port between 1 and 65535")
	}
	return a.capture.Start(config, a.captureNotify())
}

func (a *App) StartBrowserCapture() (proxycapture.Status, error) {
	return a.capture.StartBrowser(filepath.Join(requestStoreDir(), "capture-browser"), a.captureNotify())
}

func (a *App) captureNotify() func() {
	emit := func() {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "proxy:changed")
		}
	}
	batch := newEventBatcher(256, 100*time.Millisecond, func(struct{}) { emit() }, func([]struct{}) { emit() })
	return func() { batch.add(struct{}{}) }
}

func (a *App) StopProxyCapture() proxycapture.Status     { return a.capture.Stop() }
func (a *App) ProxyCaptureStatus() proxycapture.Status   { return a.capture.Status() }
func (a *App) ProxyCaptureEntries() []proxycapture.Entry { return a.capture.Entries() }
func (a *App) ProxyCaptureEntry(id int64) (proxycapture.Exchange, error) {
	x, err := a.capture.Get(id)
	if err != nil || x.Response.IsDecoded() || http.Header(x.Response.Headers).Get("Content-Encoding") == "" {
		return x, err
	}
	reader, closeReader := newDecodingReader(x.Response.EncodedPreview(), &http.Response{Header: x.Response.Headers})
	defer closeReader()
	const limit = 16 << 10
	data, readErr := io.ReadAll(io.LimitReader(reader, limit+1))
	if readErr != nil && !(readErr == io.ErrUnexpectedEOF && x.Response.Truncated) {
		return x, nil
	}
	if len(data) > 0 && utf8.Valid(data) && !bytes.ContainsRune(data, 0) {
		x.Response.Body = strings.ToValidUTF8(string(data[:min(len(data), limit)]), "�")
		x.Response.Binary = false
		x.Response.Truncated = x.Response.Truncated || len(data) > limit
	}
	return x, nil
}
func (a *App) ProxyCaptureHAR(ids []int64) (string, error) {
	return a.capture.HARDecoded(ids, decodeCaptureBody)
}

func decodeCaptureBody(headers http.Header, raw string, limit int) (string, bool) {
	reader, closeReader := newDecodingReader(strings.NewReader(raw), &http.Response{Header: headers})
	defer closeReader()
	body, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if err != nil || len(body) > limit {
		return "", false
	}
	return string(body), true
}

func (a *App) ProxyCaptureQR() (string, error) {
	status := a.capture.Status()
	if !status.Running || status.Browser {
		return "", errors.New("start the proxy first")
	}
	image, err := qrcode.Encode("http://"+status.Address, qrcode.Medium, 160)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(image), nil
}

func RunProxyCLI(args []string, stdout, stderr io.Writer) int {
	ctx, done := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer done()
	return runProxyCLI(ctx, args, stdout, stderr)
}

func runProxyCLI(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("kurlo proxy", flag.ContinueOnError)
	fs.SetOutput(stderr)
	port := fs.Int("port", 9090, "loopback listening port")
	include := fs.String("include", "", "capture only this exact hostname")
	service := fs.String("service", "", "HTTPS development service as host:port")
	cert := fs.String("cert", "", "service certificate PEM")
	key := fs.String("key", "", "service private key PEM")
	listen := fs.String("listen", "127.0.0.1", "loopback or private LAN interface IPv4")
	peer := fs.String("client-ip", "", "client IPv4 allowed on the LAN interface")
	processes := fs.Bool("process", false, "identify local macOS client processes when available")
	out := fs.String("out", "", "write the HTTP session as HAR on exit")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() != 0 || *port < 1 || *port > 65535 {
		fmt.Fprintln(stderr, "Expected a port between 1 and 65535 and no positional arguments")
		return 2
	}
	var recorder proxycapture.Recorder
	defer recorder.Close()
	status, err := recorder.Start(proxycapture.Config{Port: *port, Include: *include, Service: *service, Certificate: *cert, Key: *key, ListenIP: *listen, ClientIP: *peer, IdentifyProcess: *processes}, nil)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "Listening on http://%s\n", status.Address)
	<-ctx.Done()
	recorder.Stop()
	if *out != "" {
		data, err := recorder.HARDecoded(nil, decodeCaptureBody)
		if err == nil {
			err = replaceFileAtomicMode(*out, []byte(data), 0600)
		}
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	fmt.Fprintf(stdout, "Captured %d entries\n", recorder.Status().Count)
	return 0
}

func (a *App) SetProxyLocalResponse(rule proxycapture.LocalResponse) error {
	return a.capture.SetLocalResponse(rule)
}
func (a *App) ClearProxyLocalResponses() { a.capture.ClearLocalResponses() }

func (a *App) ProxyPausedResponses() []proxycapture.Paused { return a.capture.Paused() }
func (a *App) ResumeProxyResponse(id int64, status int, body string) error {
	return a.capture.Continue(id, status, body)
}

func (a *App) ReadProxyResponseFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return "", errors.New("choose a regular text file up to 1 MiB")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if err != nil {
		return "", err
	}
	if len(data) > 1<<20 || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return "", errors.New("choose a UTF-8 text file up to 1 MiB")
	}
	return string(data), nil
}

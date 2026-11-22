package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
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
	"github.com/stormhop/kurlo/apps/desktop/internal/systemproxy"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) StartProxyCapture(config proxycapture.Config) (proxycapture.Status, error) {
	if config.Port < 1 {
		return a.capture.Status(), errors.New("enter a port between 1 and 65535")
	}
	emit := func() {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "proxy:changed")
		}
	}
	config.AuthorityDir = captureAuthorityDir()
	a.loadCaptureRules()
	batch := newEventBatcher(256, 100*time.Millisecond, func(struct{}) { emit() }, func([]struct{}) { emit() })
	status, err := a.capture.Start(config, func() { batch.add(struct{}{}) })
	if err != nil || !config.SystemProxy {
		return a.withSystemProxy(status), err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	err = newSystemProxy().Enable(ctx, "http://"+status.Address+"/proxy.pac")
	return a.withSystemProxy(status), err
}

func (a *App) StopProxyCapture() (proxycapture.Status, error) {
	status := a.capture.Stop()
	err := restoreSystemProxy()
	return a.withSystemProxy(status), err
}

func (a *App) ProxyCaptureStatus() proxycapture.Status {
	a.loadCaptureRules()
	return a.withSystemProxy(a.capture.Status())
}

func (a *App) withSystemProxy(status proxycapture.Status) proxycapture.Status {
	status.SystemProxy = status.Running && newSystemProxy().Active()
	return status
}

var newSystemProxy = func() *systemproxy.Manager {
	return systemproxy.New(filepath.Join(requestStoreDir(), "capture-system-proxy.json"))
}

func restoreSystemProxy() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	return newSystemProxy().Recover(ctx)
}

func (a *App) ProxyCaptureEntries() []proxycapture.Entry { return a.capture.Entries() }
func (a *App) ProxyCaptureEntry(id int64) (proxycapture.Exchange, error) {
	x, err := a.capture.Get(id)
	if err != nil || http.Header(x.Response.Headers).Get("Content-Encoding") == "" {
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
	if !status.Running {
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
	if len(args) > 0 && args[0] == "ca" {
		return runProxyCACLI(args[1:], stdout, stderr)
	}
	fs := flag.NewFlagSet("kurlo proxy", flag.ContinueOnError)
	fs.SetOutput(stderr)
	port := fs.Int("port", 9090, "loopback listening port")
	include := fs.String("include", "", "capture only this exact hostname")
	service := fs.String("service", "", "HTTPS development service as host:port")
	cert := fs.String("cert", "", "service certificate PEM")
	key := fs.String("key", "", "service private key PEM")
	listen := fs.String("listen", "127.0.0.1", "loopback or private LAN interface IPv4")
	peer := fs.String("client-ip", "", "client IPv4 allowed on the LAN interface")
	var sslHosts []string
	fs.Func("ssl-host", "decrypt HTTPS for this host with the Kurlo CA; repeat or separate with commas", func(value string) error {
		sslHosts = append(sslHosts, strings.Split(value, ",")...)
		return nil
	})
	systemProxy := fs.Bool("system-proxy", false, "set this proxy as the system automatic proxy while recording")
	rulesFile := fs.String("rules", "", "apply Map local and Rewrite rules from a JSON file")
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
	if *rulesFile != "" {
		rules, err := readCaptureRules(*rulesFile)
		if err == nil {
			err = recorder.SetRules(rules)
		}
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	status, err := recorder.Start(proxycapture.Config{Port: *port, Include: *include, Service: *service, Certificate: *cert, Key: *key, ListenIP: *listen, ClientIP: *peer, IdentifyProcess: *processes, SSLHosts: sslHosts, AuthorityDir: captureAuthorityDir()}, nil)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "Listening on http://%s\n", status.Address)
	if *systemProxy {
		if err := newSystemProxy().Enable(ctx, "http://"+status.Address+"/proxy.pac"); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		defer func() {
			if err := restoreSystemProxy(); err != nil {
				fmt.Fprintln(stderr, err)
			}
		}()
		fmt.Fprintln(stdout, "System proxy set to this recorder")
	}
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

func runProxyCACLI(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("kurlo proxy ca", flag.ContinueOnError)
	fs.SetOutput(stderr)
	printPEM := fs.Bool("pem", false, "print the certificate PEM instead of its details")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(stderr, "Expected no positional arguments")
		return 2
	}
	info, authority, err := captureAuthorityInfo(true)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if *printPEM {
		stdout.Write(authority.PEM())
		return 0
	}
	trusted := "no"
	if info.Trusted {
		trusted = "yes"
	}
	fmt.Fprintf(stdout, "Certificate: %s\nSubject: %s\nSHA-256: %s\nTrusted by this system: %s\n", info.Path, info.Subject, info.Fingerprint, trusted)
	return 0
}

func (a *App) OpenProxyCaptureSession(path string) (proxycapture.Status, error) {
	info, err := os.Stat(path)
	if err != nil {
		return a.withSystemProxy(a.capture.Status()), err
	}
	if !info.Mode().IsRegular() || info.Size() > proxycapture.MaxSessionFile {
		return a.withSystemProxy(a.capture.Status()), errors.New("choose a HAR file up to 256 MiB")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return a.withSystemProxy(a.capture.Status()), err
	}
	status, err := a.capture.Load(data, filepath.Base(path), decodeCapturePreview)
	return a.withSystemProxy(status), err
}

func (a *App) ClearProxyCapture() proxycapture.Status {
	return a.withSystemProxy(a.capture.Clear())
}

func (a *App) SearchProxyCapture(query string) []proxycapture.SearchHit {
	return a.capture.Search(query, decodeCapturePreview)
}

func decodeCapturePreview(headers http.Header, raw string, limit int) (string, bool) {
	reader, closeReader := newDecodingReader(strings.NewReader(raw), &http.Response{Header: headers})
	defer closeReader()
	body, err := io.ReadAll(io.LimitReader(reader, int64(limit)))
	if len(body) == 0 || (err != nil && !errors.Is(err, io.ErrUnexpectedEOF)) {
		return "", false
	}
	return strings.ToValidUTF8(string(body), ""), true
}

var captureRulesPath = func() string { return filepath.Join(requestStoreDir(), "capture-rules.json") }

func readCaptureRules(path string) ([]proxycapture.Rule, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var rules []proxycapture.Rule
	if err := json.Unmarshal(data, &rules); err != nil {
		return nil, fmt.Errorf("read capture rules: %w", err)
	}
	return rules, nil
}

func (a *App) loadCaptureRules() {
	a.captureRulesOnce.Do(func() {
		rules, err := readCaptureRules(captureRulesPath())
		if err == nil {
			err = a.capture.SetRules(rules)
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("kurlo: capture rules: %v", err)
		}
	})
}

func (a *App) ProxyRules() []proxycapture.Rule {
	a.loadCaptureRules()
	return a.capture.Rules()
}

func (a *App) SetProxyRules(rules []proxycapture.Rule) ([]proxycapture.Rule, error) {
	a.loadCaptureRules()
	if rules == nil {
		rules = []proxycapture.Rule{}
	}
	if err := a.capture.SetRules(rules); err != nil {
		return a.capture.Rules(), err
	}
	saved := a.capture.Rules()
	for i := range saved {
		saved[i].Hits = 0
	}
	data, err := json.MarshalIndent(saved, "", "  ")
	if err == nil {
		err = os.MkdirAll(filepath.Dir(captureRulesPath()), 0o700)
	}
	if err == nil {
		err = replaceFileAtomicMode(captureRulesPath(), append(data, '\n'), 0o600)
	}
	if err != nil {
		return a.capture.Rules(), fmt.Errorf("could not save capture rules: %w", err)
	}
	return a.capture.Rules(), nil
}

func (a *App) DeleteProxyEntries(ids []int64) proxycapture.Status {
	return a.withSystemProxy(a.capture.Delete(ids))
}

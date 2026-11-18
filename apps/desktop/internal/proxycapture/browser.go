package proxycapture

import (
	"context"

	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/network"

	"github.com/chromedp/chromedp"
)

const browserBodyLimit = 1 << 20

func browserExecutable() (string, error) {
	candidates := []string{"google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"}
	switch runtime.GOOS {
	case "darwin":
		home, _ := os.UserHomeDir()
		for _, name := range []string{"Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"} {
			for _, dir := range []string{"/Applications", filepath.Join(home, "Applications")} {
				candidates = append(candidates, filepath.Join(dir, name+".app", "Contents", "MacOS", name))
			}
		}
	case "windows":
		for _, dir := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
			if dir != "" {
				candidates = append(candidates, filepath.Join(dir, "Google", "Chrome", "Application", "chrome.exe"), filepath.Join(dir, "Microsoft", "Edge", "Application", "msedge.exe"), filepath.Join(dir, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
			}
		}
	}
	cache, err := os.UserCacheDir()
	if err == nil {
		var pattern string
		switch runtime.GOOS {
		case "darwin":
			pattern = "chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
		case "windows":
			pattern = "chrome-win*/chrome.exe"
		default:
			pattern = "chrome-linux*/chrome"
		}
		paths, _ := filepath.Glob(filepath.Join(cache, "ms-playwright", "chromium-*", pattern))
		slices.Reverse(paths)
		candidates = append(candidates, paths...)
	}
	for _, candidate := range candidates {
		if path, err := exec.LookPath(candidate); err == nil {
			return path, nil
		}
	}
	return "", errors.New("install Chrome, Chromium, Edge or Brave to record a browser tab")
}

func (r *Recorder) StartBrowser(profile string, notify func()) (Status, error) {
	executable, err := browserExecutable()
	if err != nil {
		return r.Status(), err
	}
	if err := os.MkdirAll(profile, 0700); err != nil {
		return r.Status(), err
	}
	return r.startBrowser(notify, chromedp.ExecPath(executable), chromedp.UserDataDir(profile))
}

type browserLaunch struct {
	cancel context.CancelFunc
	done   chan struct{}
}

func (r *Recorder) startBrowser(notify func(), options ...chromedp.ExecAllocatorOption) (Status, error) {
	r.mu.Lock()
	if r.run != nil || r.launch != nil {
		status := r.status()
		r.mu.Unlock()
		return status, errors.New("stop the active capture first")
	}
	lifetime, abort := context.WithCancel(context.Background())
	launch := &browserLaunch{cancel: abort, done: make(chan struct{})}
	r.launch = launch
	r.mu.Unlock()
	defer func() { r.mu.Lock(); r.launch = nil; close(launch.done); r.mu.Unlock() }()
	if notify == nil {
		notify = func() {}
	}
	opts := []chromedp.ExecAllocatorOption{chromedp.NoFirstRun, chromedp.NoDefaultBrowserCheck, chromedp.Flag("disable-sync", true)}
	alloc, release := chromedp.NewExecAllocator(lifetime, append(opts, options...)...)
	var active atomic.Pointer[browserJournal]
	tab, closeTab := chromedp.NewContext(alloc, chromedp.WithRuntimeDisabled(), chromedp.WithListener(func(ev any) {
		if j := active.Load(); j != nil {
			j.event(ev)
		}
	}))
	ctx, cancel := context.WithCancel(tab)
	timeout := time.AfterFunc(20*time.Second, abort)
	_, err := chromedp.Call(tab, network.Enable, network.EnableParams{MaxResourceBufferSize: new(int64(browserBodyLimit)), MaxTotalBufferSize: new(int64(16 << 20)), MaxPostDataSize: new(int64(previewLimit))})
	timerStopped := timeout.Stop()
	r.mu.Lock()
	if !timerStopped || err != nil || lifetime.Err() != nil {
		r.mu.Unlock()
		cancel()
		closeTab()
		release()
		abort()
		if err == nil {
			err = context.DeadlineExceeded
		}
		return r.Status(), fmt.Errorf("open capture browser: %w", err)
	}
	defer r.mu.Unlock()
	closed, _ := chromedp.Detached(tab)
	journal := &browserJournal{pending: make(map[network.RequestID]*browserRequest), bodies: make(chan browserBody, capacity)}
	s := &session{files: &bodyFiles{}, ctx: ctx, cancel: cancel, changed: notify, browserClose: func() {
		active.Store(nil)
		journal.stop()
		shutdown, done := context.WithTimeout(tab, 3*time.Second)
		defer done()
		_ = chromedp.Cancel(shutdown)
		closeTab()
		release()
		abort()
	}}
	r.beginSession(s, r.config, "")
	journal.session = s
	for range 4 {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			for job := range journal.bodies {
				s.readBrowserBody(ctx, job)
			}
		}()
	}
	active.Store(journal)
	go func() {
		select {
		case <-tab.Done():
		case <-closed:
		}
		r.stopSession(s)
	}()
	return r.status(), nil
}

type browserRequest struct {
	exchange Exchange
	start    cdp.MonotonicTime
	size     int64
}

func browserHeaders(source network.Headers) http.Header {
	h := http.Header{}
	for k, v := range source {
		if sensitive(k) {
			continue
		}
		if text, ok := v.(string); ok {
			for _, value := range strings.Split(text, "\n") {
				if strings.EqualFold(k, "Referer") || strings.EqualFold(k, "Location") {
					u, err := url.Parse(value)
					if err != nil {
						continue
					}
					value = displayURL(u)
				}
				h.Add(k, value)
			}
		}
	}
	return h
}

func newBrowserRequest(e *network.EventRequestWillBeSent) *browserRequest {
	u, err := url.Parse(e.Request.URL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil
	}
	entry := Entry{Method: e.Request.Method, Host: u.Host, URL: displayURL(u), Path: u.EscapedPath(), Started: time.Unix(0, int64(float64(e.WallTime)*float64(time.Second))).UTC().Format(time.RFC3339Nano)}
	if entry.Path == "" {
		entry.Path = "/"
	}
	var p preview
	for _, part := range e.Request.PostDataEntries {
		if part == nil {
			continue
		}
		p.Write(part.Bytes)
	}
	msg, n := p.message(browserHeaders(e.Request.Headers))
	if e.Request.HasPostData && n == 0 {
		msg.Truncated = true
	}
	entry.Sent = n
	return &browserRequest{exchange: Exchange{Entry: entry, Request: msg}, start: e.Timestamp}
}

func (b *browserRequest) response(resp *network.Response) {
	switch proto := strings.ToUpper(resp.Protocol); proto {
	case "H2":
		b.exchange.httpVersion = "HTTP/2.0"
	case "H3":
		b.exchange.httpVersion = "HTTP/3.0"
	default:
		b.exchange.httpVersion = proto
	}
	b.exchange.Entry.Status = int(resp.Status)
	b.exchange.Response.Headers = browserHeaders(resp.Headers)
}

type browserBody struct {
	id   network.RequestID
	item *browserRequest
}

type browserJournal struct {
	mu      sync.Mutex
	closed  bool
	session *session
	pending map[network.RequestID]*browserRequest
	bodies  chan browserBody
}

func (j *browserJournal) stop() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.closed = true
	close(j.bodies)
	for _, item := range j.pending {
		j.finish(item, "Recording stopped before completion")
	}
	clear(j.pending)
}

func (j *browserJournal) finish(item *browserRequest, message string) {
	item.exchange.Entry.InProgress = false
	item.exchange.Entry.Error = message
	item.exchange.Entry.Received = item.size
	if message != "" {
		item.exchange.Response.Truncated = true
	}
	j.session.record(item.exchange)
}

func (j *browserJournal) event(ev any) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return
	}
	switch e := ev.(type) {
	case *network.EventRequestWillBeSent:
		if prev := j.pending[e.RequestID]; prev != nil {
			if e.RedirectResponse != nil {
				prev.response(e.RedirectResponse)
			}
			prev.exchange.Entry.Duration = int64((e.Timestamp - prev.start) * 1000)
			j.finish(prev, "")
			delete(j.pending, e.RequestID)
		}
		item := newBrowserRequest(e)
		if item == nil {
			return
		}
		if len(j.pending) >= capacity {
			for key, old := range j.pending {
				j.finish(old, "Pending request limit reached")
				delete(j.pending, key)
				break
			}
		}
		item.exchange.Entry.InProgress = true
		item.exchange.Entry.ID = j.session.record(item.exchange)
		j.pending[e.RequestID] = item
	case *network.EventResponseReceived:
		if item := j.pending[e.RequestID]; item != nil {
			item.response(e.Response)
			j.session.record(item.exchange)
		}
	case *network.EventDataReceived:
		if item := j.pending[e.RequestID]; item != nil {
			item.size += e.DataLength
		}
	case *network.EventLoadingFailed:
		if item := j.pending[e.RequestID]; item != nil {
			item.exchange.Entry.Duration = int64((e.Timestamp - item.start) * 1000)
			j.finish(item, e.ErrorText)
			delete(j.pending, e.RequestID)
		}
	case *network.EventLoadingFinished:
		item := j.pending[e.RequestID]
		if item == nil {
			return
		}
		delete(j.pending, e.RequestID)
		item.exchange.Entry.Duration = int64((e.Timestamp - item.start) * 1000)
		switch {
		case item.size > browserBodyLimit:
			j.finish(item, "Response body exceeds the 1 MiB browser limit")
		case item.exchange.Entry.Method == "HEAD" || item.exchange.Entry.Status == 204 || item.exchange.Entry.Status == 304:
			j.finish(item, "")
		default:
			select {
			case j.bodies <- browserBody{e.RequestID, item}:
			default:
				j.finish(item, "Browser response queue is full")
			}
		}
	}
}

func (s *session) readBrowserBody(ctx context.Context, job browserBody) {
	x := job.item.exchange
	x.Entry.InProgress = false
	x.Entry.Received = job.item.size
	readCtx, done := context.WithTimeout(ctx, 2*time.Second)
	defer done()
	res, err := chromedp.Call(readCtx, network.GetResponseBody, network.GetResponseBodyParams{RequestID: job.id})
	switch {
	case err != nil:
		x.Entry.Error = "Response body unavailable from the browser"
		x.Response.Truncated = true
	case len(res.Body) > browserBodyLimit:
		x.Entry.Error = "Response body exceeds the 1 MiB browser limit"
		x.Response.Truncated = true
	default:
		p := preview{files: s.files}
		p.Write(res.Body)
		x.Response, x.Entry.Received = p.message(x.Response.Headers)
		x.Response.decoded = true
	}
	s.record(x)
}

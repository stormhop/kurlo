package proxycapture

import (
	"context"
	"errors"

	"net/http"
	"sort"
	"sync/atomic"
	"time"

	"github.com/dop251/goja"
)

type Paused struct {
	ID     int64  `json:"id"`
	Method string `json:"method"`
	URL    string `json:"url"`
	Status int    `json:"status"`
	Body   string `json:"body"`
}
type pauseSlot struct {
	item   Paused
	resume chan Paused
}

var pauseID atomic.Int64

func (r *Recorder) Paused() []Paused {
	r.mu.Lock()
	defer r.mu.Unlock()
	items := []Paused{}
	if s := r.run; s != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, p := range s.pauses {
			items = append(items, p.item)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}
func (r *Recorder) Continue(id int64, status int, body string) error {
	if status < 200 || status > 599 || len(body) > 1<<20 {
		return errors.New("invalid local response")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.run
	if s == nil {
		return errors.New("capture has stopped")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	slot, ok := s.pauses[id]
	if !ok {
		return errors.New("this response is no longer paused")
	}
	select {
	case slot.resume <- Paused{Status: status, Body: body}:
		return nil
	default:
		return errors.New("already resumed")
	}
}
func (s *session) pause(ctx context.Context, x Entry, status int, body string) (int, string, error) {
	slot := pauseSlot{item: Paused{ID: pauseID.Add(1), Method: x.Method, URL: x.URL, Status: status, Body: body}, resume: make(chan Paused, 1)}
	s.mu.Lock()
	if len(s.pauses) >= 8 {
		s.mu.Unlock()
		return 503, "Too many paused responses", nil
	}
	s.pauses[slot.item.ID] = slot
	s.mu.Unlock()
	s.changed()
	defer func() { s.mu.Lock(); delete(s.pauses, slot.item.ID); s.mu.Unlock(); s.changed() }()
	timer := time.NewTimer(60 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return 0, "", ctx.Err()
	case <-timer.C:
		return 504, "Local breakpoint timed out", nil
	case item := <-slot.resume:
		return item.Status, item.Body, nil
	}
}

func runLocalHooks(script string, request *http.Request, status int, body string) (int, string, error) {
	program, err := goja.Compile("local-response.js", script, false)
	if err != nil {
		return 0, "", err
	}
	vm := goja.New()
	vm.SetMaxCallStackSize(256)
	timer := time.AfterFunc(200*time.Millisecond, func() { vm.Interrupt("local response hook timed out") })
	defer timer.Stop()
	req := map[string]any{"method": request.Method, "path": request.URL.EscapedPath()}
	res := map[string]any{"status": status, "body": body}
	if err := vm.Set("request", req); err != nil {
		return 0, "", err
	}
	if err := vm.Set("response", res); err != nil {
		return 0, "", err
	}
	if _, err = vm.RunProgram(program); err != nil {
		return 0, "", err
	}
	result, err := vm.RunString(`(() => {
		if (typeof onRequest !== "undefined") onRequest(request, response);
		if (typeof onResponse !== "undefined") onResponse(request, response);
		return [response.status, response.body];
	})()`)
	if err != nil {
		return 0, "", err
	}
	pair := result.ToObject(vm)
	codeValue := pair.Get("0")
	textValue := pair.Get("1")
	if codeValue == nil || textValue == nil {
		return 0, "", errors.New("hook removed the status or body")
	}
	code, ok := int64(0), false
	if _, object := codeValue.(*goja.Object); !object {
		code, ok = codeValue.Export().(int64)
	}
	str, okBody := textValue.(goja.String)
	if !ok || code < 200 || code > 599 || !okBody || str.Length() > 1<<20 {
		return 0, "", errors.New("hook produced an invalid local response")
	}
	content := str.String()
	if len(content) > 1<<20 {
		return 0, "", errors.New("hook body exceeds 1 MiB")
	}
	return int(code), content, nil
}

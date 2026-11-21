package secrets

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRefreshDuringFetch(t *testing.T) {
	for _, action := range []string{"clear cache", "forget provider", "refresh path"} {
		t.Run(action, func(t *testing.T) {
			started, release := make(chan struct{}), make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			defer unblock()
			var reads atomic.Int32
			config := mustProvider(t, map[string]any{"id": "env", "type": "env"})
			manager := NewManager(&fakeSource{configs: []ProviderConfig{config}}, Environment{Getenv: func(key string) (string, bool) {
				if reads.Add(1) == 1 {
					close(started)
					<-release
					return "before", true
				}
				return "after", true
			}})
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			ref := Ref{Provider: "env", Path: "TOKEN"}
			old := make(chan string, 1)
			go func() {
				value, _ := manager.Value(ctx, "ws", ref)
				old <- value
			}()
			select {
			case <-started:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			switch action {
			case "clear cache":
				manager.ClearCache()
			case "forget provider":
				manager.ForgetProvider("ws", "env")
			case "refresh path":
				if got, _, err := manager.Refresh(ctx, "ws", ref); err != nil || got.Raw != "after" {
					t.Fatalf("fresh read = %q, %v", got.Raw, err)
				}
			}
			if got, err := manager.Value(ctx, "ws", ref); got != "after" || err != nil {
				t.Fatalf("new read joined the old fetch: %q, %v", got, err)
			}
			unblock()
			if got := <-old; got != "before" {
				t.Fatalf("original read = %q", got)
			}
			if got, err := manager.Value(ctx, "ws", ref); got != "after" || err != nil || reads.Load() != 2 {
				t.Fatalf("cached value = %q, %v, reads = %d", got, err, reads.Load())
			}
		})
	}
}

func TestEmptyLinkedValue(t *testing.T) {
	for _, test := range []struct {
		secret Secret
		field  string
	}{
		{Secret{}, ""},
		{Secret{Fields: map[string]string{"key": ""}}, ""},
		{Secret{Fields: map[string]string{"key": "", "other": "x"}}, "key"},
		{Secret{Raw: `{"key":null}`}, "key"},
	} {
		if _, err := test.secret.Value("env", Ref{Provider: "env", Path: "token", Field: test.field}); err == nil || KindOf(err) != KindInvalidRef {
			t.Fatalf("expected an empty value error for %+v, got %v", test, err)
		}
	}
	if got, err := (Secret{Raw: "  "}).Value("env", Ref{Path: "token"}); err != nil || got != "  " {
		t.Fatalf("significant whitespace changed: %q, %v", got, err)
	}
}

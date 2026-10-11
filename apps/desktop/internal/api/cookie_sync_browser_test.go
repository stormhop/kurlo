package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const cookieSyncBrowserTestEnv = "KURLO_BROWSER_EXTENSION_TEST"

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("working directory: %v", err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("could not find the repository root")
	return ""
}

type browserEvent struct {
	Event     string `json:"event"`
	Error     string `json:"error"`
	LastError string `json:"lastError"`
}

func TestCookieSyncWithARealBrowserExtension(t *testing.T) {
	if os.Getenv(cookieSyncBrowserTestEnv) == "" {
		t.Skipf("set %s=1 to drive the extension in a real browser", cookieSyncBrowserTestEnv)
	}

	root := repoRoot(t)
	harness := startTestCookieSync(t, "kurlo.test")

	approvals := make(chan string, 4)
	stopApprover := make(chan struct{})
	var approverDone sync.WaitGroup
	approverDone.Add(1)
	go func() {
		defer approverDone.Done()
		for {
			select {
			case <-stopApprover:
				return
			case <-time.After(100 * time.Millisecond):
				pending := harness.server.status().Pending
				if pending.ID == "" {
					continue
				}
				harness.server.approvePairing(pending.ID)
				select {
				case approvals <- pending.ID:
				default:
				}
			}
		}
	}()
	t.Cleanup(func() {
		close(stopApprover)
		approverDone.Wait()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, "node", "e2e/cookie-sync-extension.mjs")
	cmd.Dir = filepath.Join(root, "apps", "desktop", "frontend")
	cmd.Env = append(os.Environ(),
		"KURLO_BRIDGE_PORT="+strconv.Itoa(harness.port),
		"KURLO_EXTENSION_DIR="+filepath.Join(root, "apps", "desktop", "extension"),
		"KURLO_COOKIE_DOMAIN=kurlo.test",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start the browser harness: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	events := make(chan browserEvent, 16)
	go func() {
		defer close(events)
		scanner := bufio.NewScanner(io.LimitReader(stdout, 1<<20))
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if !strings.HasPrefix(line, "{") {
				t.Logf("browser: %s", line)
				continue
			}
			var event browserEvent
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				t.Logf("browser: %s", line)
				continue
			}
			t.Logf("browser event: %s", line)
			events <- event
		}
	}()

	waitForEvent := func(name string, timeout time.Duration) browserEvent {
		t.Helper()
		expire := time.After(timeout)
		for {
			select {
			case event, ok := <-events:
				if !ok {
					t.Fatalf("the browser harness exited before %q", name)
				}
				if event.Event == "failed" {
					t.Fatalf("the browser harness failed: %s", event.Error)
				}
				if event.Event == name {
					return event
				}
			case <-expire:
				t.Fatalf("timed out waiting for the browser to report %q", name)
			}
		}
	}

	waitUntil := func(what string, timeout time.Duration, check func(model.CookieSyncStatus, []model.Cookie) bool) {
		t.Helper()
		expire := time.After(timeout)
		for {
			status := harness.server.status()
			cookies := harness.jarCookies()
			if check(status, cookies) {
				return
			}
			select {
			case <-expire:
				t.Fatalf("timed out waiting for %s (status %+v, jar %+v)", what, status, cookies)
			case <-time.After(150 * time.Millisecond):
			}
		}
	}

	cookieNamed := func(cookies []model.Cookie, name string) bool {
		for _, cookie := range cookies {
			if cookie.Name == name {
				return true
			}
		}
		return false
	}

	waitForEvent("loaded", 60*time.Second)
	waitForEvent("paired", 60*time.Second)
	waitUntil("the extension to open its socket", 30*time.Second, func(status model.CookieSyncStatus, _ []model.Cookie) bool {
		return status.Connected && status.Browser != ""
	})
	if version := harness.server.status().ExtensionVersion; version == "" {
		t.Fatal("the extension should report its manifest version when it connects")
	}

	waitForEvent("cookie-added", 30*time.Second)
	waitUntil("the browser cookie to reach the jar", 30*time.Second, func(_ model.CookieSyncStatus, cookies []model.Cookie) bool {
		return cookieNamed(cookies, "sid")
	})

	waitForEvent("cookie-cleared", 30*time.Second)
	waitUntil("the cleared cookie to leave the jar", 30*time.Second, func(_ model.CookieSyncStatus, cookies []model.Cookie) bool {
		return !cookieNamed(cookies, "sid")
	})

	harness.server.revokePairing()
	waitForEvent("repaired", 90*time.Second)
	waitUntil("the browser to reconnect after being disconnected", 30*time.Second, func(status model.CookieSyncStatus, _ []model.Cookie) bool {
		return status.Connected
	})

	waitForEvent("cookie-added-again", 30*time.Second)
	waitUntil("cookies to flow again after the new pairing", 30*time.Second, func(_ model.CookieSyncStatus, cookies []model.Cookie) bool {
		return cookieNamed(cookies, "sid2")
	})

	done := waitForEvent("done", 30*time.Second)
	if done.LastError != "" {
		t.Fatalf("the extension ended with an error: %s", done.LastError)
	}
	if len(approvals) < 2 {
		t.Fatalf("expected the extension to ask for approval twice, got %d", len(approvals))
	}
}

package api

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestClaudeAgentStreamsAndResumes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a Unix executable script")
	}
	useTempConfigDir(t, t.TempDir())
	bin := t.TempDir()
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("KURLO_CLAUDE_EXPECT_RESUME", "")
	t.Setenv("KURLO_CLAUDE_READY", "")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "2.1.0 (Claude Code)"
  exit 0
fi
if [ "$1" = "--restricted" ] && [ "$2" = "auth" ]; then
  printf '%s\n' '{"loggedIn":true,"authMethod":"claude.ai","email":"dev@example.com","subscriptionType":"pro"}'
  exit 0
fi
for arg in "$@"; do
  if [ "$arg" = "--no-session-persistence" ]; then
    cat >/dev/null
    printf '%s\n' '{"type":"system","subtype":"init","model":"claude-sonnet-5-5"}' '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Current session: 12% used · resets 3pm\nCurrent week (all models): 50% used · resets Jan 2 at 11am"}]}}' '{"type":"result","subtype":"success","result":""}'
    exit 0
  fi
done
resume=
chosen=
effort=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--resume" ]; then
    resume="$2"
    shift
  elif [ "$1" = "--model" ]; then
    chosen="$2"
    shift
  elif [ "$1" = "--effort" ]; then
    effort="$2"
    shift
  fi
  shift
done
[ "$resume" = "$KURLO_CLAUDE_EXPECT_RESUME" ] || exit 2
[ "$chosen" = "claude-sonnet-5-5" ] || exit 3
[ "$effort" = "$KURLO_CLAUDE_EXPECT_EFFORT" ] || exit 4
cat >/dev/null
if [ -n "$KURLO_CLAUDE_READY" ]; then
  printf '%s\n' '{"type":"system","subtype":"init","session_id":"claude-session"}'
  : > "$KURLO_CLAUDE_READY"
  sleep 60
fi
printf '%s\n' '{"type":"system","subtype":"init","session_id":"claude-session","model":"claude-sonnet-5-5"}' '{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":2000,"cache_creation_input_tokens":500,"output_tokens":1}}}}' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}' '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.23,"resetsAt":4102444800},"seven_day":{"utilization":0.61,"resetsAt":4102444800}}}}' '{"type":"result","subtype":"success","result":"Hello","total_cost_usd":0.25,"modelUsage":{"claude-sonnet-5-5":{"inputTokens":10,"outputTokens":40,"cacheReadInputTokens":2000,"cacheCreationInputTokens":500,"thinkingTokens":5,"costUSD":0.25,"contextWindow":200000}}}'
`
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	input := model.AgentSendInput{Driver: "claude-code", Text: "Hello"}
	if blocked := app.SendAgentMessage(input); blocked.Error != "Connect Claude Code in Settings → AI first." {
		t.Fatalf("unconnected Claude Code should be rejected, got %+v", blocked)
	}
	status := app.ClaudeCodeStatus("")
	if !status.Installed || !status.Authenticated || status.Connected || status.Account != "dev@example.com · pro" || status.AuthMethod != "subscription" || status.Version != "2.1.0 (Claude Code)" || status.Model != "claude-sonnet-5-5" || status.DefaultModel != "claude-sonnet-5-5" || len(status.Models) != 4 || len(status.RateLimits) != 1 || status.RateLimits[0].Primary.UsedPercent != 12 || status.RateLimits[0].Secondary.UsedPercent != 50 {
		t.Fatalf("unexpected status before connect: %+v", status)
	}
	if bad := app.ConnectClaudeCode(model.ClaudeConnection{Model: "gpt-5"}); bad.Error == "" || bad.Connected {
		t.Fatalf("unknown model should be rejected: %+v", bad)
	}
	if connected := app.ConnectClaudeCode(model.ClaudeConnection{Model: "claude-sonnet-5-5"}); connected.Error != "" || !connected.Connected || connected.Model != "claude-sonnet-5-5" {
		t.Fatalf("connect failed: %+v", connected)
	}
	if again := NewApp().ClaudeCodeStatus(""); !again.Connected || again.Model != "claude-sonnet-5-5" {
		t.Fatalf("connection was not saved: %+v", again)
	}
	t.Setenv("KURLO_CLAUDE_EXPECT_EFFORT", "max")
	input.Effort = "max"
	first := app.SendAgentMessage(input)
	if first.Error != "" || first.Text != "Hello" || first.Chat.ExternalThreadID != "claude-session" {
		t.Fatalf("unexpected first turn: %+v", first)
	}
	wantUsage := model.AiUsage{Input: 10, Output: 40, CacheRead: 2000, CacheWrite: 500, Reasoning: 5, Cost: 0.25}
	if !first.HasUsage || first.Usage != wantUsage || first.Chat.Usage != wantUsage || first.Chat.ContextTokens != 2510 || first.Chat.ContextWindow != 200000 {
		t.Fatalf("usage and context were not recorded: %+v", first)
	}
	saved, _, _ := savedClaudeConnection()
	limits := claudeCurrentRateLimit(saved.RateLimit, time.Now().Unix())
	if len(limits) != 1 || limits[0].Primary == nil || limits[0].Primary.UsedPercent != 23 || limits[0].Primary.WindowMinutes != 300 || limits[0].Secondary == nil || limits[0].Secondary.UsedPercent != 61 || limits[0].Secondary.WindowMinutes != 10080 {
		t.Fatalf("plan limits were not saved: %+v", limits)
	}
	t.Setenv("KURLO_CLAUDE_EXPECT_EFFORT", "high")
	input.Effort = "bogus"
	t.Setenv("KURLO_CLAUDE_EXPECT_RESUME", "claude-session")
	input.ChatID = first.Chat.ID
	second := NewApp().SendAgentMessage(input)
	if second.Error != "" || second.Text != "Hello" || second.Chat.ID != first.Chat.ID {
		t.Fatalf("unexpected resumed turn: %+v", second)
	}
	ready := filepath.Join(bin, "ready")
	t.Setenv("KURLO_CLAUDE_READY", ready)
	input.TurnID = "claude-stop"
	done := make(chan model.AgentTurn, 1)
	go func() { done <- app.SendAgentMessage(input) }()
	defer app.StopAgentTurn(input.TurnID)
	deadline := time.After(5 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
waitForProcess:
	for {
		select {
		case early := <-done:
			t.Fatalf("turn exited before Stop: %s", early.Error)
		case <-deadline:
			t.Fatal("CLI never started")
		case <-ticker.C:
			if _, err := os.Stat(ready); err == nil {
				break waitForProcess
			}
		}
	}
	app.StopAgentTurn(input.TurnID)
	select {
	case stopped := <-done:
		if stopped.Error == "" || stopped.Chat.ExternalThreadID != "claude-session" {
			t.Fatalf("unexpected stopped turn: %+v", stopped)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not terminate the CLI")
	}
	if removed := app.RemoveClaudeCodeConnection(); !removed.Ok {
		t.Fatalf("remove failed: %s", removed.Error)
	}
	if after := app.ClaudeCodeStatus(""); after.Connected {
		t.Fatalf("connection still saved after remove: %+v", after)
	}
}

func TestClaudeSignInUsesNativeCLI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a Unix executable script")
	}
	useTempConfigDir(t, t.TempDir())
	bin := t.TempDir()
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("KURLO_CLAUDE_TEST_LOGIN", filepath.Join(bin, "signed-in"))
	script := `#!/bin/sh
if [ "$*" = "auth login --claudeai" ]; then
  : > "$KURLO_CLAUDE_TEST_LOGIN"
elif [ "$*" = "--restricted auth status" ] && [ -f "$KURLO_CLAUDE_TEST_LOGIN" ]; then
  printf '%s\n' '{"loggedIn":true,"authMethod":"claude.ai"}'
else
  exit 1
fi
`
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if result := NewApp().SignInClaudeCode(""); !result.Ok {
		t.Fatalf("native sign-in failed: %s", result.Error)
	}
}

func TestClaudeStatusUsesChosenExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a Unix executable script")
	}
	useTempConfigDir(t, t.TempDir())
	t.Setenv("PATH", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	if missing := NewApp().ClaudeCodeStatus(""); missing.Installed || missing.Error == "" {
		t.Fatalf("missing CLI should be reported: %+v", missing)
	}
	custom := filepath.Join(t.TempDir(), "my-claude")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.2.0 (Claude Code)"; exit 0; fi
printf '%s\n' '{"loggedIn":true,"authMethod":"api_key"}'
`
	if err := os.WriteFile(custom, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	status := app.ClaudeCodeStatus(custom)
	if status.Error != "" || status.Path != custom || status.Account != "API key" || status.AuthMethod != "api_key" {
		t.Fatalf("unexpected status for chosen executable: %+v", status)
	}
	if connected := app.ConnectClaudeCode(model.ClaudeConnection{Path: custom}); !connected.Connected || connected.Path != custom {
		t.Fatalf("connect with chosen executable failed: %+v", connected)
	}
	if saved := NewApp().ClaudeCodeStatus(""); saved.Path != custom || !saved.Connected {
		t.Fatalf("chosen executable was not remembered: %+v", saved)
	}
}

func TestClaudeStreamReportsFailureReason(t *testing.T) {
	stream := strings.NewReader(`{"type":"result","subtype":"success","is_error":true,"result":"Fable 5.1 requires usage credits."}` + "\n")
	err := readClaudeStream(stream, func(claudeStreamEvent) error { return nil })
	if err == nil || err.Error() != "Claude Code: Fable 5.1 requires usage credits." {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := claudeCurrentRateLimit(&model.CodexRateLimit{Primary: &model.CodexRateWindow{UsedPercent: 90, ResetsAt: 10}, Secondary: &model.CodexRateWindow{UsedPercent: 40, ResetsAt: 30}}, 20); len(got) != 1 || got[0].Primary != nil || got[0].Secondary == nil {
		t.Fatalf("expired window should be dropped: %+v", got)
	}
}

func TestParseClaudeUsage(t *testing.T) {
	moscow, err := time.LoadLocation("Europe/Moscow")
	if err != nil {
		t.Skip("no tz database")
	}
	now := time.Date(2026, 12, 30, 12, 0, 0, 0, moscow)
	text := "You are currently using your subscription\n\nCurrent session: 39% used · resets Dec 30 at 3:20pm (Europe/Moscow)\nCurrent week (all models): 63% used · resets Jan 2 at 11am (Europe/Moscow)\n\nLast 24h · 651 requests"
	limit := parseClaudeUsage(text, now)
	if limit == nil || limit.Primary == nil || limit.Secondary == nil {
		t.Fatalf("limits not parsed: %+v", limit)
	}
	if limit.Primary.UsedPercent != 39 || limit.Primary.WindowMinutes != 300 || limit.Primary.ResetsAt != time.Date(2026, 12, 30, 15, 20, 0, 0, moscow).Unix() {
		t.Fatalf("unexpected session window: %+v", limit.Primary)
	}
	if limit.Secondary.UsedPercent != 63 || limit.Secondary.WindowMinutes != 10080 || limit.Secondary.ResetsAt != time.Date(2027, 1, 2, 11, 0, 0, 0, moscow).Unix() {
		t.Fatalf("unexpected weekly window: %+v", limit.Secondary)
	}
	if parseClaudeUsage("Unknown command", now) != nil {
		t.Fatal("text without limits should give nothing")
	}
}

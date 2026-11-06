package api

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func claudeTurnArgs(mcpConfig, sessionID string) []string {
	args := []string{
		"--print", "--verbose", "--output-format", "stream-json",
		"--include-partial-messages", "--restricted", "--tools", "",
		"--strict-mcp-config", "--mcp-config", mcpConfig,
	}
	if sessionID != "" {
		args = append(args, "--resume", sessionID)
	}
	return args
}

type claudeTokenUsage struct {
	Input      int `json:"input_tokens"`
	Output     int `json:"output_tokens"`
	CacheRead  int `json:"cache_read_input_tokens"`
	CacheWrite int `json:"cache_creation_input_tokens"`
}

type claudeModelUsage struct {
	Input         int     `json:"inputTokens"`
	Output        int     `json:"outputTokens"`
	CacheRead     int     `json:"cacheReadInputTokens"`
	CacheWrite    int     `json:"cacheCreationInputTokens"`
	Thinking      int     `json:"thinkingTokens"`
	Cost          float64 `json:"costUSD"`
	ContextWindow int64   `json:"contextWindow"`
}

type claudeRateWindow struct {
	Utilization float64 `json:"utilization"`
	ResetsAt    int64   `json:"resetsAt"`
}

type claudeStreamEvent struct {
	Type       string                      `json:"type"`
	Subtype    string                      `json:"subtype"`
	SessionID  string                      `json:"session_id"`
	Model      string                      `json:"model"`
	Result     string                      `json:"result"`
	IsError    bool                        `json:"is_error"`
	Errors     []string                    `json:"errors"`
	TotalCost  float64                     `json:"total_cost_usd"`
	ModelUsage map[string]claudeModelUsage `json:"modelUsage"`
	RateLimit  struct {
		Windows map[string]claudeRateWindow `json:"unifiedWindows"`
	} `json:"rate_limit_info"`
	Event struct {
		Type  string `json:"type"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
		Message struct {
			Model string           `json:"model"`
			Usage claudeTokenUsage `json:"usage"`
		} `json:"message"`
	} `json:"event"`
}

func (event claudeStreamEvent) failure() string {
	parts := []string{}
	for _, item := range event.Errors {
		if item = strings.TrimSpace(item); item != "" {
			parts = append(parts, item)
		}
	}
	if len(parts) == 0 {
		if result := strings.TrimSpace(event.Result); result != "" {
			parts = append(parts, result)
		}
	}
	if len(parts) == 0 {
		return "Claude Code reported a failed turn"
	}
	return "Claude Code: " + strings.Join(parts, "; ")
}

func claudeRateLimit(windows map[string]claudeRateWindow) *model.CodexRateLimit {
	toWindow := func(window claudeRateWindow, minutes int64) *model.CodexRateWindow {
		used := int(math.Round(window.Utilization * 100))
		return &model.CodexRateWindow{UsedPercent: max(0, min(100, used)), WindowMinutes: minutes, ResetsAt: window.ResetsAt}
	}
	limit := &model.CodexRateLimit{ID: "claude", Name: "Claude"}
	if window, ok := windows["five_hour"]; ok {
		limit.Primary = toWindow(window, 300)
	}
	if window, ok := windows["seven_day"]; ok {
		limit.Secondary = toWindow(window, 7*24*60)
	}
	if limit.Primary == nil && limit.Secondary == nil {
		return nil
	}
	return limit
}

func claudeCurrentRateLimit(limit *model.CodexRateLimit, now int64) []model.CodexRateLimit {
	if limit == nil {
		return nil
	}
	current := model.CodexRateLimit{ID: limit.ID, Name: limit.Name}
	if limit.Primary != nil && (limit.Primary.ResetsAt == 0 || limit.Primary.ResetsAt > now) {
		current.Primary = limit.Primary
	}
	if limit.Secondary != nil && (limit.Secondary.ResetsAt == 0 || limit.Secondary.ResetsAt > now) {
		current.Secondary = limit.Secondary
	}
	if current.Primary == nil && current.Secondary == nil {
		return nil
	}
	return []model.CodexRateLimit{current}
}

func readClaudeStream(output io.Reader, handle func(claudeStreamEvent) error) error {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		if len(strings.TrimSpace(scanner.Text())) == 0 {
			continue
		}
		var event claudeStreamEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			return fmt.Errorf("invalid Claude Code stream event: %w", err)
		}
		if err := handle(event); err != nil {
			return err
		}
		if event.Type == "result" {
			if event.IsError {
				return errors.New(event.failure())
			}
			return nil
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return io.ErrUnexpectedEOF
}

var claudeUsageLine = regexp.MustCompile(`(?m)^\s*Current (session|week \(all models\)):\s*(\d+)% used(?:\s*·\s*resets\s+(.+?))?\s*$`)
var claudeResetZone = regexp.MustCompile(`\s*\(([^)]+)\)\s*$`)

func parseClaudeUsage(text string, now time.Time) *model.CodexRateLimit {
	limit := &model.CodexRateLimit{ID: "claude", Name: "Claude"}
	for _, match := range claudeUsageLine.FindAllStringSubmatch(text, -1) {
		used, err := strconv.Atoi(match[2])
		if err != nil {
			continue
		}
		window := &model.CodexRateWindow{UsedPercent: max(0, min(100, used)), ResetsAt: parseClaudeReset(match[3], now)}
		if match[1] == "session" {
			window.WindowMinutes = 300
			limit.Primary = window
		} else {
			window.WindowMinutes = 7 * 24 * 60
			limit.Secondary = window
		}
	}
	if limit.Primary == nil && limit.Secondary == nil {
		return nil
	}
	return limit
}

func parseClaudeReset(value string, now time.Time) int64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	location := now.Location()
	if zone := claudeResetZone.FindStringSubmatch(value); zone != nil {
		if loaded, err := time.LoadLocation(zone[1]); err == nil {
			location = loaded
		}
		value = strings.TrimSpace(value[:len(value)-len(zone[0])])
	}
	value = strings.Replace(value, " at ", " ", 1)
	for _, layout := range []string{"Jan 2 3:04pm", "Jan 2 3pm", "3:04pm", "3pm"} {
		parsed, err := time.ParseInLocation(layout, value, location)
		if err != nil {
			continue
		}
		local := now.In(location)
		year, month, day := local.Date()
		if strings.HasPrefix(layout, "Jan") {
			month, day = parsed.Month(), parsed.Day()
		}
		reset := time.Date(year, month, day, parsed.Hour(), parsed.Minute(), 0, 0, location)
		if reset.Before(local.Add(-24 * time.Hour)) {
			if strings.HasPrefix(layout, "Jan") {
				reset = reset.AddDate(1, 0, 0)
			} else {
				reset = reset.AddDate(0, 0, 1)
			}
		}
		return reset.Unix()
	}
	return 0
}

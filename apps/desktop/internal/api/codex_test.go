package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func init() {
	if os.Getenv("KURLO_CODEX_HELPER") != "1" {
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("codex-cli test")
		os.Exit(0)
	}
	scanner := bufio.NewScanner(os.Stdin)
	send := func(value any) { data, _ := json.Marshal(value); fmt.Println(string(data)) }
	event := func(method string, params any) { send(map[string]any{"method": method, "params": params}) }
	loopTool := 1
	for scanner.Scan() {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
			Result map[string]any  `json:"result"`
		}
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			os.Exit(2)
		}
		if path := os.Getenv("KURLO_CODEX_CAPTURE"); path != "" {
			f, _ := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			_, _ = f.Write(append(append([]byte{}, scanner.Bytes()...), '\n'))
			_ = f.Close()
		}
		result := any(map[string]any{})
		switch message.Method {
		case "initialized":
			continue
		case "initialize":
			result = map[string]any{"userAgent": "test"}
		case "config/read":
			result = map[string]any{"config": map[string]any{"model_reasoning_effort": "medium", "mcp_servers": map[string]any{"external": map[string]any{"command": "dangerous"}}, "plugins": map[string]any{"test@marketplace": map[string]any{"enabled": true}}}}
		case "account/read":
			var account any = map[string]any{"type": "chatgpt", "email": "test@example.test", "planType": "plus"}
			if os.Getenv("KURLO_CODEX_NO_AUTH") == "1" {
				account = nil
			}
			result = map[string]any{"account": account, "requiresOpenaiAuth": true}
		case "model/list":
			if cursor, exists := message.Params["cursor"]; exists && cursor == "" {
				send(map[string]any{"id": message.ID, "error": map[string]any{"code": -32602, "message": "invalid cursor:"}})
				continue
			}
			if os.Getenv("KURLO_CODEX_MODEL_ERROR") == "1" {
				send(map[string]any{"id": message.ID, "error": map[string]any{"code": -32000, "message": "models unavailable"}})
				continue
			}
			result = map[string]any{"data": []map[string]any{{"id": "test", "model": "test-model", "displayName": "Test model", "isDefault": true, "defaultReasoningEffort": "low", "supportedReasoningEfforts": []map[string]any{{"reasoningEffort": "low"}, {"reasoningEffort": "medium"}, {"reasoningEffort": "high"}}}}, "nextCursor": nil}
			if os.Getenv("KURLO_CODEX_PAGINATE") == "1" {
				if _, exists := message.Params["cursor"]; !exists {
					result = map[string]any{"data": []map[string]any{{"id": "first", "model": "first-model", "displayName": "First", "isDefault": true}}, "nextCursor": "opaque-next-page"}
				} else if message.Params["cursor"] != "opaque-next-page" {
					send(map[string]any{"id": message.ID, "error": map[string]any{"code": -32602, "message": "invalid cursor"}})
					continue
				}
			}
		case "account/rateLimits/read":
			if os.Getenv("KURLO_CODEX_NO_LIMITS") == "1" {
				send(map[string]any{"id": message.ID, "error": map[string]any{"code": -32601, "message": "rate limits unavailable"}})
				continue
			}
			result = map[string]any{"rateLimits": map[string]any{"limitId": "codex", "limitName": "Codex", "primary": map[string]any{"usedPercent": 25, "windowDurationMins": 300, "resetsAt": 1800000000}, "secondary": map[string]any{"usedPercent": 40, "windowDurationMins": 10080}}}
		case "account/login/start":
			result = map[string]any{"type": "chatgpt", "authUrl": "https://auth.openai.com/test", "loginId": "login-1"}
		case "thread/start", "thread/resume":
			result = map[string]any{"thread": map[string]any{"id": "thread-1"}, "sandbox": map[string]any{"type": "readOnly"}}
			if os.Getenv("KURLO_CODEX_UNSAFE") == "1" {
				result = map[string]any{"thread": map[string]any{"id": "thread-1"}, "sandbox": map[string]any{"type": "workspaceWrite"}}
			}
		case "turn/start":
			if os.Getenv("KURLO_CODEX_CRASH") == "1" {
				os.Exit(4)
			}
			send(map[string]any{"id": message.ID, "result": map[string]any{"turn": map[string]any{"id": "turn-1"}}})
			if os.Getenv("KURLO_CODEX_COMPACTION") == "1" {
				event("item/started", map[string]any{"threadId": "unrelated", "turnId": "turn-1", "item": map[string]any{"type": "contextCompaction"}})
				event("item/started", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]any{"id": "compact-1", "type": "contextCompaction"}})
			}
			if os.Getenv("KURLO_CODEX_HANG") == "1" {
				continue
			}
			send(map[string]any{"id": "tool-1", "method": "item/tool/call", "params": map[string]any{"threadId": "thread-1", "turnId": "turn-1", "callId": "call-1", "tool": "set_variable", "arguments": map[string]any{"environment": "Local", "key": "region", "value": "eu"}}})
			if marker := os.Getenv("KURLO_CODEX_CRASH_ON_APPROVAL"); marker != "" {
				for attempt := 0; attempt < 500; attempt++ {
					if _, err := os.Stat(marker); err == nil {
						os.Exit(7)
					}
					time.Sleep(10 * time.Millisecond)
				}
				os.Exit(8)
			}
			continue
		case "":
			if os.Getenv("KURLO_CODEX_TOOL_LOOP") == "1" {
				loopTool++
				call := fmt.Sprintf("loop-%d", loopTool)
				send(map[string]any{"id": call, "method": "item/tool/call", "params": map[string]any{"threadId": "thread-1", "turnId": "turn-1", "callId": call, "tool": "list_requests", "arguments": map[string]any{}}})
				continue
			}
			if os.Getenv("KURLO_CODEX_COMPACTION") == "1" {
				event("item/completed", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]any{"id": "compact-1", "type": "contextCompaction"}})
			}
			event("item/agentMessage/delta", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "itemId": "answer-1", "delta": "Done."})
			event("item/completed", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]any{"id": "answer-1", "type": "agentMessage", "text": "Done."}})
			event("thread/tokenUsage/updated", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "tokenUsage": map[string]any{"modelContextWindow": 1000, "total": map[string]any{"totalTokens": 15000}, "last": map[string]any{"totalTokens": 110, "inputTokens": 100, "cachedInputTokens": 20, "outputTokens": 10}}})
			event("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]any{"id": "turn-1", "status": "completed"}})
			continue
		}
		send(map[string]any{"id": message.ID, "result": result})
	}
	os.Exit(0)
}

func setupCodexTest(t *testing.T) (*App, string) {
	t.Helper()
	useTempConfigDir(t, t.TempDir())
	t.Setenv("KURLO_CODEX_HELPER", "1")
	t.Setenv("GORACE", strings.TrimSpace(os.Getenv("GORACE")+" atexit_sleep_ms=0"))
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	status := app.ConnectCodex(model.CodexConnection{Path: executable})
	if status.Error != "" || !status.Connected || status.Model != "test-model" || status.AuthType != "chatgpt" {
		t.Fatalf("connection: %+v", status)
	}
	t.Cleanup(func() { app.CancelCodexLogin() })
	return app, executable
}

func TestCodexConnectionUsesExistingLoginAndKeepsCredentialsOutOfPreferences(t *testing.T) {
	app, _ := setupCodexTest(t)
	saved, connected, err := savedCodexConnection()
	if err != nil || !connected || saved.Model != "test-model" {
		t.Fatalf("saved: %+v %v %v", saved, connected, err)
	}
	data, err := os.ReadFile(appPreferencesPath())
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"test@example.test", "accessToken", "refreshToken"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("stored account credential: %s", secret)
		}
	}
	if result := app.RemoveCodexConnection(); !result.Ok {
		t.Fatal(result.Error)
	}
	_, connected, err = savedCodexConnection()
	if err != nil || connected {
		t.Fatalf("remove: %v %v", connected, err)
	}
}

func TestCodexRunsApprovedToolsAndResumesItsOwnChat(t *testing.T) {
	t.Setenv("KURLO_CODEX_COMPACTION", "1")
	var compaction []bool
	app, _ := setupCodexTest(t)
	capture := t.TempDir() + "/messages.jsonl"
	t.Setenv("KURLO_CODEX_CAPTURE", capture)
	root := fileWorkspaceStorePath()
	copyWorkspaceTo(t, agentTestWorkspace(t, "http://127.0.0.1:1"), root)
	approvals := 0
	app.agentEmit = func(name string, payload any) {
		if name == "agent:compaction" {
			compaction = append(compaction, payload.(map[string]any)["active"].(bool))
		}

		if name == "agent:approval" {
			approvals++
			id := payload.(model.AgentApproval).ID
			go app.AnswerAgentApproval(id, model.AgentApprovalAllow)
		}
	}
	turn := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: "shop", Driver: "codex", Text: "Set region", Environment: "Local", Collection: "Smoke"})
	if turn.Error != "" || turn.Text != "Done." || turn.Chat.ExternalThreadID != "thread-1" || turn.Chat.Driver != "codex" || approvals != 1 {
		t.Fatalf("turn=%+v approvals=%d", turn, approvals)
	}
	if turn.Chat.ContextTokens != 110 || turn.Chat.ContextWindow != 1000 {
		t.Fatalf("context: %+v", turn.Chat)
	}
	if turn.Usage.Input != 80 || turn.Usage.CacheRead != 20 {
		t.Fatalf("usage=%+v", turn.Usage)
	}
	if !strings.Contains(readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml"), "region") {
		t.Fatal("approved tool did not write")
	}
	next := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: "shop", Driver: "codex", ChatID: turn.Chat.ID, Text: "Continue", Environment: "Local"})
	if next.Error != "" {
		t.Fatal(next.Error)
	}
	if wrong := app.SendAgentMessage(model.AgentSendInput{ChatID: turn.Chat.ID, Text: "wrong driver"}); wrong.Error == "" {
		t.Fatal("API agent continued a Codex chat")
	}
	if wrong := app.SendAgentMessage(model.AgentSendInput{WorkspaceID: "other", Driver: "codex", ChatID: turn.Chat.ID, Text: "wrong workspace"}); !strings.Contains(wrong.Error, "another agent or workspace") {
		t.Fatalf("Codex continued a foreign chat: %+v", wrong)
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	var started, resumed bool
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var message struct {
			Method string                     `json:"method"`
			Params map[string]json.RawMessage `json:"params"`
		}
		_ = json.Unmarshal([]byte(line), &message)
		if message.Method != "thread/start" && message.Method != "thread/resume" {
			continue
		}
		started = started || message.Method == "thread/start"
		resumed = resumed || message.Method == "thread/resume"
		if message.Method == "thread/resume" && string(message.Params["excludeTurns"]) != "true" {
			t.Fatal("resume loaded the whole CLI history")
		}
		if string(message.Params["sandbox"]) != `"read-only"` || string(message.Params["approvalPolicy"]) != `"never"` {
			t.Fatal("unsafe thread policy")
		}
		var config map[string]any
		_ = json.Unmarshal(message.Params["config"], &config)
		for _, key := range []string{"features.shell_tool", "features.unified_exec", "features.hooks", "features.apps"} {
			if config[key] != false {
				t.Fatalf("enabled %s", key)
			}
		}
		if _, disabled := config["features.code_mode_host"]; disabled {
			t.Fatal("the code-mode host carries dynamic tool calls and must stay on")
		}
		for _, kind := range []string{"mcp_servers", "plugins"} {
			for _, value := range config[kind].(map[string]any) {
				if value.(map[string]any)["enabled"] != false {
					t.Fatal("inherited tool was enabled")
				}
			}
		}
		if message.Method == "thread/start" && len(message.Params["dynamicTools"]) < 100 {
			t.Fatal("Kurlo tools not registered")
		}
	}
	if fmt.Sprint(compaction) != "[true false true false]" {
		t.Fatalf("compaction events: %v", compaction)
	}
	if !started || !resumed {
		t.Fatalf("start=%v resume=%v", started, resumed)
	}
	chats := app.AgentChats("shop")
	if len(chats) != 1 || chats[0].Driver != "codex" {
		t.Fatalf("summaries=%+v", chats)
	}
}

func TestCodexDeclinedWriteDoesNotChangeWorkspace(t *testing.T) {
	app, _ := setupCodexTest(t)
	root := fileWorkspaceStorePath()
	copyWorkspaceTo(t, agentTestWorkspace(t, "http://127.0.0.1:1"), root)
	before := readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml")
	app.agentEmit = func(name string, payload any) {
		if name == "agent:approval" {
			go app.AnswerAgentApproval(payload.(model.AgentApproval).ID, model.AgentApprovalReject)
		}
	}
	turn := app.SendAgentMessage(model.AgentSendInput{Driver: "codex", Text: "Set region", Environment: "Local"})
	if turn.Error != "" {
		t.Fatal(turn.Error)
	}
	if after := readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml"); after != before {
		t.Fatal("declined write changed files")
	}
	if len(turn.Steps) == 0 || !turn.Steps[0].ToolResults[0].IsError {
		t.Fatal("decline was not sent to Codex")
	}
}

func TestCodexCancellationAndProcessExitReturn(t *testing.T) {
	for _, scenario := range []string{"KURLO_CODEX_HANG", "KURLO_CODEX_CRASH"} {
		t.Run(scenario, func(t *testing.T) {
			app, _ := setupCodexTest(t)
			t.Setenv(scenario, "1")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			app.ctx = ctx
			done := make(chan model.AgentTurn, 1)
			app.agentEmit = func(name string, payload any) {
				if name == "ai:deltas" && scenario == "KURLO_CODEX_HANG" {
					go func() { time.Sleep(100 * time.Millisecond); cancel() }()
				}
			}
			go func() { done <- app.SendAgentMessage(model.AgentSendInput{Driver: "codex", Text: "Hello"}) }()
			select {
			case result := <-done:
				if result.Error == "" {
					t.Fatal("missing error")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("Codex did not stop")
			}
		})
	}
}

func TestCodexRequiresAuthenticationAndCanCancelLogin(t *testing.T) {
	app, path := setupCodexTest(t)
	t.Setenv("KURLO_CODEX_NO_AUTH", "1")
	if status := app.ConnectCodex(model.CodexConnection{Path: path}); status.Error == "" {
		t.Fatal("connected without authentication")
	}
	status := app.StartCodexLogin(path)
	if status.Error != "" || !status.Waiting || status.AuthURL == "" {
		t.Fatalf("login=%+v", status)
	}
	app.CancelCodexLogin()
	rt := app.agentRuntime()
	rt.mu.Lock()
	pending := rt.codexLogin
	rt.mu.Unlock()
	if pending != nil {
		t.Fatal("login not cancelled")
	}
}

func TestCodexResolvesNativeBinaryBesideNpmWrapper(t *testing.T) {
	root := t.TempDir()
	wrapper := filepath.Join(root, "codex.cmd")
	if err := os.WriteFile(wrapper, []byte("wrapper"), 0700); err != nil {
		t.Fatal(err)
	}
	nativeDir := filepath.Join(root, "node_modules", "@openai", "codex", "vendor", "x86_64-pc-windows-msvc", "codex")
	if err := os.MkdirAll(nativeDir, 0700); err != nil {
		t.Fatal(err)
	}
	native := filepath.Join(nativeDir, "codex.exe")
	if err := os.WriteFile(native, []byte("native"), 0700); err != nil {
		t.Fatal(err)
	}
	resolved, err := codexExecutable(wrapper)
	if err != nil || resolved != native {
		t.Fatalf("resolved=%q err=%v", resolved, err)
	}
	if err := os.Remove(native); err != nil {
		t.Fatal(err)
	}
	if _, err = codexExecutable(wrapper); err == nil {
		t.Fatal("shell wrapper was accepted without a native executable")
	}
}

func TestCodexRefusesUnexpectedSandboxPolicy(t *testing.T) {
	app, _ := setupCodexTest(t)
	t.Setenv("KURLO_CODEX_UNSAFE", "1")
	turn := app.SendAgentMessage(model.AgentSendInput{Driver: "codex", Text: "Hello"})
	if !strings.Contains(turn.Error, "read-only sandbox") || len(turn.Steps) > 0 {
		t.Fatalf("unsafe session started a turn: %+v", turn)
	}
}

func TestCodexModelListOmitsInitialCursorAndUsesOpaqueNextCursor(t *testing.T) {
	app, executable := setupCodexTest(t)
	t.Setenv("KURLO_CODEX_PAGINATE", "1")
	capture := t.TempDir() + "/models.jsonl"
	t.Setenv("KURLO_CODEX_CAPTURE", capture)
	status := app.CodexStatus(executable)
	if status.Error != "" || len(status.Models) != 2 || status.Models[0].ID != "first-model" || status.Models[1].ID != "test-model" {
		t.Fatalf("model list: %+v", status)
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	requests := []map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var message struct {
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.Unmarshal([]byte(line), &message); err != nil {
			t.Fatal(err)
		}
		if message.Method == "model/list" {
			requests = append(requests, message.Params)
		}
	}
	if len(requests) != 2 {
		t.Fatalf("requests: %+v", requests)
	}
	if _, exists := requests[0]["cursor"]; exists {
		t.Fatalf("first page included a cursor: %+v", requests[0])
	}
	if requests[1]["cursor"] != "opaque-next-page" {
		t.Fatalf("next page cursor: %+v", requests[1])
	}
}

func TestCodexModelFailurePreservesCliAndAccountStatus(t *testing.T) {
	app, executable := setupCodexTest(t)
	t.Setenv("KURLO_CODEX_MODEL_ERROR", "1")
	status := app.CodexStatus(executable)
	if !status.Installed || !status.Authenticated || status.Account == "" || !strings.Contains(status.Error, "Could not load Codex models") {
		t.Fatalf("status: %+v", status)
	}
}

func TestCodexEffortPersistsAndDefaultResetsTheNativeTurn(t *testing.T) {
	app, path := setupCodexTest(t)
	status := app.CodexStatus(path)
	if status.Models[0].DefaultEffort != "medium" || len(status.Models[0].Efforts) != 3 {
		t.Fatalf("efforts: %+v", status.Models)
	}
	root := fileWorkspaceStorePath()
	copyWorkspaceTo(t, agentTestWorkspace(t, "http://127.0.0.1:1"), root)
	app.agentEmit = func(name string, payload any) {
		if name == "agent:approval" {
			go app.AnswerAgentApproval(payload.(model.AgentApproval).ID, model.AgentApprovalAllow)
		}
	}
	capture := t.TempDir() + "/effort.jsonl"
	t.Setenv("KURLO_CODEX_CAPTURE", capture)
	first := app.SendAgentMessage(model.AgentSendInput{Driver: "codex", Text: "Set region", Environment: "Local", Effort: "high"})
	if first.Error != "" || first.Chat.Effort != "high" {
		t.Fatalf("first: %+v", first)
	}
	stored, err := app.AgentChat(first.Chat.ID)
	if err != nil || stored.Effort != "high" {
		t.Fatalf("stored effort=%s err=%v", stored.Effort, err)
	}
	second := app.SendAgentMessage(model.AgentSendInput{Driver: "codex", ChatID: first.Chat.ID, Text: "Continue with default", Environment: "Local", Effort: ""})
	if second.Error != "" || second.Chat.Effort != "" {
		t.Fatalf("second: %+v", second)
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	efforts := []string{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var message struct {
			Method string `json:"method"`
			Params struct {
				Effort string `json:"effort"`
			} `json:"params"`
		}
		_ = json.Unmarshal([]byte(line), &message)
		if message.Method == "turn/start" {
			efforts = append(efforts, message.Params.Effort)
		}
	}
	if strings.Join(efforts, ",") != "high,medium" {
		t.Fatalf("turn efforts: %+v", efforts)
	}
	rejected := app.SendAgentMessage(model.AgentSendInput{Driver: "codex", Text: "Unsupported effort", Effort: "ultra"})
	if !strings.Contains(rejected.Error, "not supported") {
		t.Fatalf("unsupported effort accepted: %+v", rejected)
	}
}

func TestCodexEffortFallsBackToModelDefaultWhenCliSettingIsUnsupported(t *testing.T) {
	models := []model.AiConnectionModel{{ID: "test", DefaultEffort: "low", Efforts: []string{"low", "high"}}}
	if effort, err := codexTurnEffort(models, "test", ""); err != nil || effort != "low" {
		t.Fatalf("effort=%s err=%v", effort, err)
	}
	if _, err := codexTurnEffort(models, "test", "medium"); err == nil {
		t.Fatal("unsupported effort accepted")
	}
}

func TestCodexLaunchesFromAPathWithSpacesAndUnicode(t *testing.T) {
	app, executable := setupCodexTest(t)
	directory := filepath.Join(t.TempDir(), "Local agents", "Пользователь")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(directory, filepath.Base(executable))
	data, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, data, 0700); err != nil {
		t.Fatal(err)
	}
	status := app.ConnectCodex(model.CodexConnection{Path: target})
	if status.Error != "" || !status.Connected || status.Path != target {
		t.Fatalf("path connection: %+v", status)
	}
}

func TestCodexLimitsAreOptionalAndKeepSeparateQuotaWindows(t *testing.T) {
	app, path := setupCodexTest(t)
	status := app.CodexStatus(path)
	if status.Error != "" || len(status.RateLimits) != 1 || status.RateLimits[0].Primary.UsedPercent != 25 || status.RateLimits[0].Secondary.WindowMinutes != 10080 {
		t.Fatalf("rate limits: %+v", status)
	}
	t.Setenv("KURLO_CODEX_NO_LIMITS", "1")
	status = app.CodexStatus(path)
	if status.Error != "" || len(status.Models) == 0 || len(status.RateLimits) != 0 {
		t.Fatalf("missing rate limits blocked models: %+v", status)
	}
}

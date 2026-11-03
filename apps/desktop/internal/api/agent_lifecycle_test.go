package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func assertAgentReleased(t *testing.T, app *App) {
	t.Helper()
	rt := app.agentRuntime()
	rt.mu.Lock()
	running, bridges, approvals := len(rt.running), len(rt.bridges), len(rt.approvals)
	rt.mu.Unlock()
	app.requestMu.Lock()
	cancels := len(app.requestCancels)
	app.requestMu.Unlock()
	if running != 0 || bridges != 0 || approvals != 0 || cancels != 0 {
		t.Fatalf("retained running=%d bridges=%d approvals=%d cancels=%d", running, bridges, approvals, cancels)
	}
}

func awaitAgentLifecycleTurn(t *testing.T, done <-chan model.AgentTurn) model.AgentTurn {
	t.Helper()
	select {
	case turn := <-done:
		return turn
	case <-time.After(5 * time.Second):
		t.Fatal("the agent did not finish")
		return model.AgentTurn{}
	}
}

func TestAgentLifecycleDoesNotRetainCompletedBridges(t *testing.T) {
	rt := newAgentRuntime()
	root := t.TempDir()
	for i := 0; i < 1000; i++ {
		id := fmt.Sprint(i)
		if !rt.begin(id) {
			t.Fatal("could not start")
		}
		rt.bridge(model.AgentChat{ID: id}, root)
		rt.end(id)
	}
	if len(rt.running) != 0 || len(rt.bridges) != 0 {
		t.Fatal("completed chats retained their runtime")
	}
}

func TestAgentLifecycleApprovalExpiryStopsWithoutAnotherModelRequest(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	root := fileWorkspaceStorePath()
	copyWorkspaceTo(t, agentTestWorkspace(t, "http://127.0.0.1:1"), root)
	before := readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml")
	server := newAiTestServer(t, sseScript{events: []string{
		openAIChunkEvent(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"write-1","type":"function","function":{"name":"set_variable","arguments":"{\"environment\":\"Local\",\"key\":\"region\",\"value\":\"eu\"}"}}]},"finish_reason":"tool_calls"}]}`), openAIChunkEvent(`[DONE]`),
	}})
	app := NewApp()
	app.agentRuntime().approvalTimeout = 150 * time.Millisecond
	if saved := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: server.URL, Key: "test", Model: "test-model"}); saved.Error != "" {
		t.Fatal(saved.Error)
	}
	asked := make(chan string, 1)
	app.agentEmit = func(name string, payload any) {
		if name == "agent:approval" {
			asked <- payload.(model.AgentApproval).ID
		}
	}
	done := make(chan model.AgentTurn, 1)
	go func() { done <- app.SendAgentMessage(model.AgentSendInput{Text: "Set region", Environment: "Local"}) }()
	var approvalID string
	select {
	case approvalID = <-asked:
	case <-time.After(5 * time.Second):
		t.Fatal("missing approval")
	}
	select {
	case <-done:
		t.Fatal("approval did not wait for the user")
	case <-time.After(40 * time.Millisecond):
	}
	server.mu.Lock()
	whileWaiting := len(server.bodies)
	server.mu.Unlock()
	if whileWaiting != 1 {
		t.Fatalf("model kept running while waiting: %d", whileWaiting)
	}
	turn := awaitAgentLifecycleTurn(t, done)
	if !strings.Contains(turn.Error, "Approval expired") || approvalID == "" {
		t.Fatalf("turn: %+v", turn)
	}
	server.mu.Lock()
	requests := len(server.bodies)
	server.mu.Unlock()
	if requests != 1 {
		t.Fatalf("expiry spent another request: %d", requests)
	}
	if readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml") != before {
		t.Fatal("an expired approval wrote files")
	}
	if app.AnswerAgentApproval(approvalID, model.AgentApprovalAllow).Ok {
		t.Fatal("a late approval was accepted")
	}
	assertAgentReleased(t, app)
}

func TestAgentLifecycleStopBeforeFirstTokenAndStaleStop(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	entered := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		entered <- struct{}{}
		<-r.Context().Done()
	}))
	defer server.Close()
	app := NewApp()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	app.ctx = ctx
	app.agentEmit = func(string, any) {}
	if result := app.SaveAiConnection(model.AiConnectionInput{Kind: model.AiConnectionCompatible, BaseURL: server.URL, Model: "test-model"}); result.Error != "" {
		t.Fatal(result.Error)
	}
	done := make(chan model.AgentTurn, 1)
	go func() { done <- app.SendAgentMessage(model.AgentSendInput{Text: "Hello", TurnID: "early-turn"}) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("provider not reached")
	}
	app.StopAgentTurn("early-turn")
	first := awaitAgentLifecycleTurn(t, done)
	if !strings.Contains(first.Error, "Cancelled") {
		t.Fatalf("stop: %s", first.Error)
	}
	assertAgentReleased(t, app)
	go func() {
		done <- app.SendAgentMessage(model.AgentSendInput{Text: "Continue", ChatID: first.Chat.ID, TurnID: "next-turn"})
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("provider not reached again")
	}
	app.StopAgentTurn("early-turn")
	select {
	case <-done:
		t.Fatal("stale stop cancelled the new turn")
	case <-time.After(25 * time.Millisecond):
	}
	app.StopAgentTurn("next-turn")
	awaitAgentLifecycleTurn(t, done)
	assertAgentReleased(t, app)
}

func TestCodexLifecycleWaitExpiryStopCrashAndIdle(t *testing.T) {
	for _, scenario := range []string{"expire", "stop", "delete", "shutdown", "crash", "idle", "wait"} {
		t.Run(scenario, func(t *testing.T) {
			app, _ := setupCodexTest(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			app.ctx = ctx
			root := fileWorkspaceStorePath()
			copyWorkspaceTo(t, agentTestWorkspace(t, "http://127.0.0.1:1"), root)
			before := readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml")
			capture := filepath.Join(t.TempDir(), "calls.jsonl")
			t.Setenv("KURLO_CODEX_CAPTURE", capture)
			marker := filepath.Join(t.TempDir(), "crash")
			if scenario == "crash" {
				t.Setenv("KURLO_CODEX_CRASH_ON_APPROVAL", marker)
			}
			if scenario == "expire" {
				app.agentRuntime().approvalTimeout = 30 * time.Millisecond
			}
			if scenario == "idle" {
				t.Setenv("KURLO_CODEX_HANG", "1")
				app.agentRuntime().codexIdleTimeout = 30 * time.Millisecond
			}
			if scenario == "wait" {
				app.agentRuntime().codexIdleTimeout = 100 * time.Millisecond
			}
			asked := make(chan model.AgentApproval, 1)
			app.agentEmit = func(name string, payload any) {
				if name == "agent:approval" {
					approval := payload.(model.AgentApproval)
					if scenario == "crash" {
						_ = os.WriteFile(marker, []byte("ready"), 0600)
					}
					asked <- approval
				}
			}
			done := make(chan model.AgentTurn, 1)
			go func() {
				done <- app.SendAgentMessage(model.AgentSendInput{Driver: "codex", TurnID: "lifecycle-turn", Text: "Set region", Environment: "Local"})
			}()
			if scenario != "idle" {
				var approval model.AgentApproval
				select {
				case approval = <-asked:
				case <-time.After(5 * time.Second):
					t.Fatal("no approval")
				}
				switch scenario {
				case "stop":
					app.StopAgentTurn("lifecycle-turn")
				case "delete":
					if result := app.DeleteAgentChat(approval.ChatID); !result.Ok {
						t.Fatal(result.Error)
					}
				case "shutdown":
					app.Shutdown(context.Background())
				case "wait":
					select {
					case <-done:
						t.Fatal("idle timeout ended the user's approval wait")
					case <-time.After(250 * time.Millisecond):
					}
					if !app.AnswerAgentApproval(approval.ID, model.AgentApprovalAllow).Ok {
						t.Fatal("the approval expired early")
					}
				}
			}
			result := awaitAgentLifecycleTurn(t, done)
			if scenario == "wait" {
				if result.Error != "" {
					t.Fatal(result.Error)
				}
			} else {
				if result.Error == "" {
					t.Fatal("missing terminal error")
				}
				if readWorkspaceFile(t, root, "workspaces/Demo/environments/Local.yml") != before {
					t.Fatal("unapproved files changed")
				}
				file, err := os.Open(capture)
				if err != nil {
					t.Fatal(err)
				}
				scanner := bufio.NewScanner(file)
				for scanner.Scan() {
					var message map[string]json.RawMessage
					_ = json.Unmarshal(scanner.Bytes(), &message)
					if string(message["id"]) == `"tool-1"` {
						t.Fatal("resumed the model after stopping")
					}
				}
				_ = file.Close()
			}
			if scenario == "expire" && !strings.Contains(result.Error, "Approval expired") {
				t.Fatal(result.Error)
			}
			if scenario == "idle" && !strings.Contains(result.Error, "No progress") {
				t.Fatal(result.Error)
			}
			assertAgentReleased(t, app)
		})
	}
}

func TestCodexLifecycleStopsToolLoops(t *testing.T) {
	app, _ := setupCodexTest(t)
	t.Setenv("KURLO_CODEX_TOOL_LOOP", "1")
	root := fileWorkspaceStorePath()
	copyWorkspaceTo(t, agentTestWorkspace(t, "http://127.0.0.1:1"), root)
	app.agentEmit = func(name string, payload any) {
		if name == "agent:approval" {
			go app.AnswerAgentApproval(payload.(model.AgentApproval).ID, model.AgentApprovalAllow)
		}
	}
	turn := app.SendAgentMessage(model.AgentSendInput{Driver: "codex", Text: "Run", Environment: "Local"})
	if !strings.Contains(turn.Error, "50 tool calls") || len(turn.Steps) != 50 {
		t.Fatalf("loop: %q steps=%d", turn.Error, len(turn.Steps))
	}
	assertAgentReleased(t, app)
}

func TestCodexLifecycleDuplicateRepliesDoNotBlockReader(t *testing.T) {
	client := &codexClient{pending: map[string]chan codexMessage{"1": make(chan codexMessage, 1)}, done: make(chan struct{}), events: make(chan codexMessage, 1)}
	done := make(chan struct{})
	go func() {
		client.read(strings.NewReader("{\"id\":1,\"result\":{}}\n{\"id\":1,\"result\":{}}\n"))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("reader blocked on duplicate reply")
	}
	if client.err == nil || !strings.Contains(client.err.Error(), "duplicate") {
		t.Fatalf("error=%v", client.err)
	}
}

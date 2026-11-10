package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestAgentHostPolicyUsesEffectiveSessionAndCallVariables(t *testing.T) {
	for _, source := range []string{"call", "session", "call-over-session", "removed"} {
		t.Run(source, func(t *testing.T) {
			useTempConfigDir(t, t.TempDir())
			known, knownHits := countingServer(t)
			foreign, foreignHits := countingServer(t)
			foreignURL := strings.Replace(foreign.URL, "127.0.0.1", "localhost", 1)
			bridge, approvals := newTestAgentBridge(t, agentTestWorkspace(t, known.URL))
			args := map[string]any{"url": "{{baseUrl}}/health"}
			switch source {
			case "call":
				args["variables"] = map[string]any{"baseUrl": foreignURL}
			case "session":
				bridge.server.session["local"] = &mcpSessionScope{set: map[string]string{"baseUrl": foreignURL}, removed: map[string]bool{}}
			case "call-over-session":
				bridge.server.session["local"] = &mcpSessionScope{set: map[string]string{"baseUrl": foreignURL}, removed: map[string]bool{}}
				args["variables"] = map[string]any{"baseUrl": known.URL}
			case "removed":
				bridge.server.session["local"] = &mcpSessionScope{set: map[string]string{}, removed: map[string]bool{"baseUrl": true}}
			}
			text, isError := agentBridgeCall(t, bridge, "send_request", args)
			if source == "call-over-session" {
				if isError || approvals.count() != 0 || knownHits.Load() != 1 {
					t.Fatalf("override must restore known host: %v %s approvals=%d hits=%d", isError, text, approvals.count(), knownHits.Load())
				}
			} else if !isError || approvals.count() != 1 {
				t.Fatalf("effective foreign or unresolved URL requires approval: %v %s approvals=%d", isError, text, approvals.count())
			}
			if foreignHits.Load() != 0 {
				t.Fatalf("sent to unapproved host: %d", foreignHits.Load())
			}
		})
	}
}

func TestAgentTrustedHostNeverUsesTheUnmodifiedURLForUnsafeCalls(t *testing.T) {
	for _, tool := range []string{"send_request", "run_request", "run_collection"} {
		t.Run(tool, func(t *testing.T) {
			useTempConfigDir(t, t.TempDir())
			known, _ := countingServer(t)
			foreign, foreignHits := countingServer(t)
			root := agentTestWorkspace(t, known.URL)
			agentChainPost(t, root)
			bridge, approvals := newTestAgentBridge(t, root)
			bridge.setChat(model.AgentChat{AllowedHosts: []string{"127.0.0.1"}}, nil)
			args := map[string]any{"method": "POST", "url": "{{baseUrl}}/health", "request": "Smoke/Chain", "collection": "Smoke", "variables": map[string]any{"baseUrl": strings.Replace(foreign.URL, "127.0.0.1", "localhost", 1)}}
			if tool != "send_request" {
				delete(args, "method")
				delete(args, "url")
			}
			if tool != "run_request" {
				delete(args, "request")
			}
			if tool != "run_collection" {
				delete(args, "collection")
			}
			text, isError := agentBridgeCall(t, bridge, tool, args)
			if !isError || approvals.count() != 1 || foreignHits.Load() != 0 {
				t.Fatalf("trusted original host must not approve effective foreign host: %v %s approvals=%d hits=%d", isError, text, approvals.count(), foreignHits.Load())
			}
		})
	}
}

func TestAgentEffectiveHostPreservesSandboxAndProtectedEnvironmentPolicies(t *testing.T) {
	for _, protected := range []bool{false, true} {
		t.Run(map[bool]string{false: "sandbox", true: "protected-sandbox"}[protected], func(t *testing.T) {
			useTempConfigDir(t, t.TempDir())
			known, _ := countingServer(t)
			foreign, foreignHits := countingServer(t)
			root := agentTestWorkspace(t, known.URL)
			st, err := loadMCPStore(root)
			if err != nil {
				t.Fatal(err)
			}
			st.environments[0]["sandbox"] = true
			st.environments[0]["protected"] = protected
			if err := st.save(); err != nil {
				t.Fatal(err)
			}
			bridge, approvals := newTestAgentBridge(t, root, model.AgentApprovalAllow)
			bridge.setChat(model.AgentChat{AllowedHosts: []string{"localhost"}}, nil)
			text, isError := agentBridgeCall(t, bridge, "send_request", map[string]any{"method": "POST", "url": "{{baseUrl}}/health", "variables": map[string]any{"baseUrl": strings.Replace(foreign.URL, "127.0.0.1", "localhost", 1)}})
			if protected {
				if !isError || !strings.Contains(text, "protected") || foreignHits.Load() != 0 {
					t.Fatalf("protected must never execute: %v %s hits=%d", isError, text, foreignHits.Load())
				}
			} else if isError || approvals.count() != 0 || foreignHits.Load() != 1 {
				t.Fatalf("sandbox should permit effective destination: %v %s approvals=%d hits=%d", isError, text, approvals.count(), foreignHits.Load())
			}
		})
	}
}

func TestAgentChecksSessionHostWrittenByRequestScript(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	known, _ := countingServer(t)
	foreign, foreignHits := countingServer(t)
	foreignURL := strings.Replace(foreign.URL, "127.0.0.1", "localhost", 1)
	root := agentTestWorkspace(t, known.URL)
	st, err := loadMCPStore(root)
	if err != nil {
		t.Fatal(err)
	}
	st.requests[0]["testScriptJs"] = "pm.environment.set(\"baseUrl\", " + importJSON(foreignURL) + ");"
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	bridge, approvals := newTestAgentBridge(t, root)
	args, _ := json.Marshal(map[string]any{"request": "Smoke/Ok"})
	if _, err := bridge.server.toolRunRequest(context.Background(), args); err != nil {
		t.Fatal(err)
	}
	text, isError := agentBridgeCall(t, bridge, "send_request", map[string]any{"url": "{{baseUrl}}/health"})
	if !isError || approvals.count() != 1 || foreignHits.Load() != 0 {
		t.Fatalf("script session host requires approval: %v %s approvals=%d hits=%d", isError, text, approvals.count(), foreignHits.Load())
	}
}

func TestAgentSavedGETRequiresApprovalWhenVariablesChangeItsHost(t *testing.T) {
	for _, tool := range []string{"run_request", "run_collection"} {
		t.Run(tool, func(t *testing.T) {
			useTempConfigDir(t, t.TempDir())
			known, _ := countingServer(t)
			foreign, hits := countingServer(t)
			bridge, approvals := newTestAgentBridge(t, agentTestWorkspace(t, known.URL))
			args := map[string]any{"variables": map[string]any{"baseUrl": strings.Replace(foreign.URL, "127.0.0.1", "localhost", 1)}}
			if tool == "run_request" {
				args["request"] = "Smoke/Ok"
			} else {
				args["collection"] = "Smoke"
			}
			text, isError := agentBridgeCall(t, bridge, tool, args)
			if !isError || approvals.count() != 1 || hits.Load() != 0 {
				t.Fatalf("saved GET changed to foreign host: %v %s approvals=%d hits=%d", isError, text, approvals.count(), hits.Load())
			}
		})
	}
}

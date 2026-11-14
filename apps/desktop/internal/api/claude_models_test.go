package api

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const claudeModelsFixture = `
for arg in "$@"; do
  if [ "$arg" = "--input-format" ]; then
    IFS= read -r request
    case "$request" in
      *'"subtype":"initialize"'*) ;;
      *) exit 8 ;;
    esac
    if [ -n "$KURLO_CLAUDE_MODEL_RESPONSE" ]; then
      printf '%s\n' "$KURLO_CLAUDE_MODEL_RESPONSE"
    else
      printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"kurlo-models","response":{"models":[{"value":"default","resolvedModel":"claude-sonnet-5-5","displayName":"Default (recommended)","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"sonnet","resolvedModel":"claude-sonnet-5-5","displayName":"Sonnet","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"claude-nova-9[1m]","resolvedModel":"claude-nova-9[1m]","displayName":"Nova 9","supportsEffort":true,"supportedEffortLevels":["low","max"]},{"value":"haiku","resolvedModel":"claude-haiku-5-5","displayName":"Haiku","supportsEffort":false}]}}}'
    fi
    exit 0
  fi
done
`

func writeClaudeModelsFixture(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a Unix executable script")
	}
	path := filepath.Join(t.TempDir(), "claude")
	script := "#!/bin/sh\n" + claudeModelsFixture + `
if [ "$1" = "--version" ]; then
  printf '%s\n' '2.1.308 (Claude Code)'
elif [ "$2" = "auth" ]; then
  if [ -n "$KURLO_CLAUDE_AUTH" ]; then
    printf '%s\n' "$KURLO_CLAUDE_AUTH"
  else
    printf '%s\n' '{"loggedIn":true,"authMethod":"api_key"}'
  fi
fi
`
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestClaudeModelList(t *testing.T) {
	entries := []claudeModelInfo{
		{Value: "default", ResolvedModel: "claude-future-9[1m]", DisplayName: "Default", SupportsEffort: true, SupportedEffortLevels: []string{"low", "high", "ultra"}},
		{Value: "future", ResolvedModel: "claude-future-9[1m]", DisplayName: "Future", SupportsEffort: true, SupportedEffortLevels: []string{"low", "high", "ultra"}},
		{Value: "custom-provider-model", DisplayName: "Custom", SupportsEffort: true, SupportedEffortLevels: []string{"medium", "medium", "", "max"}},
		{Value: "fast", DisplayName: "Fast", SupportedEffortLevels: []string{"high"}},
		{Value: "unknown", SupportsEffort: true},
		{},
	}
	want := []model.AiConnectionModel{
		{ID: "claude-future-9[1m]", Name: "Future", Recommended: true, Efforts: []string{"low", "high", "ultra"}, DefaultEffort: "high"},
		{ID: "custom-provider-model", Name: "Custom", Efforts: []string{"medium", "max"}, DefaultEffort: "medium"},
		{ID: "fast", Name: "Fast"},
		{ID: "unknown", Name: "unknown"},
	}
	got, defaultModel := claudeModelList(entries)
	if !reflect.DeepEqual(got, want) || defaultModel != want[0].ID {
		t.Fatalf("unexpected models: %+v, default %q", got, defaultModel)
	}
	entries[0], entries[1] = entries[1], entries[0]
	if reversed, defaultModel := claudeModelList(entries); !reflect.DeepEqual(reversed, want) || defaultModel != want[0].ID {
		t.Fatalf("default should not duplicate or rename a model: %+v, default %q", reversed, defaultModel)
	}
	if chosen := claudeChosenModel("custom-provider-model", defaultModel, got); chosen != "custom-provider-model" {
		t.Fatalf("saved model should be selected: %q", chosen)
	}
	if chosen := claudeChosenModel("removed", defaultModel, got); chosen != defaultModel {
		t.Fatalf("removed model should fall back to CLI default: %q", chosen)
	}
	if chosen := claudeChosenModel("removed", "", got); chosen != got[0].ID {
		t.Fatalf("missing default should fall back to the first model: %q", chosen)
	}
	for _, test := range []struct{ id, effort, want string }{
		{"claude-future-9[1m]", "ultra", "ultra"},
		{"claude-future-9[1m]", "bogus", "high"},
		{"custom-provider-model", "high", "medium"},
		{"fast", "high", ""},
		{"unknown", "high", ""},
		{"removed", "max", ""},
	} {
		if effort := claudeEffortArg(test.id, test.effort, got); effort != test.want {
			t.Errorf("effort for %s: got %q, want %q", test.id, effort, test.want)
		}
	}
}

func TestReadClaudeModels(t *testing.T) {
	path := writeClaudeModelsFixture(t)
	models, defaultModel, err := readClaudeModels(context.Background(), path)
	if err != nil || len(models) != 3 || defaultModel != "claude-sonnet-5-5" || models[1].ID != "claude-nova-9[1m]" || !reflect.DeepEqual(models[1].Efforts, []string{"low", "max"}) {
		t.Fatalf("unexpected initialize result: %+v, %q, %v", models, defaultModel, err)
	}
	for _, test := range []struct{ name, response, message string }{
		{"empty", `{"type":"control_response","response":{"subtype":"success","request_id":"kurlo-models","response":{"models":[]}}}`, "no available models"},
		{"error", `{"type":"control_response","response":{"subtype":"error","request_id":"kurlo-models","error":"Unsupported initialize request"}}`, "Unsupported initialize request"},
		{"malformed", `not JSON`, "did not return"},
		{"wrong request", `{"type":"control_response","response":{"subtype":"success","request_id":"other","response":{"models":[{"value":"wrong"}]}}}`, "did not return"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("KURLO_CLAUDE_MODEL_RESPONSE", test.response)
			if _, _, err := readClaudeModels(context.Background(), path); err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
	t.Setenv("KURLO_CLAUDE_MODEL_RESPONSE", "noise\n"+`{"type":"control_response","response":{"subtype":"success","request_id":"kurlo-models","response":{"models":[{"value":"provider-latest","displayName":"Latest"}]}}}`)
	if models, defaultModel, err := readClaudeModels(context.Background(), path); err != nil || len(models) != 1 || models[0].ID != "provider-latest" || defaultModel != "" {
		t.Fatalf("alias without resolvedModel should work: %+v, %q, %v", models, defaultModel, err)
	}
}

func TestReadClaudeModelsCancellation(t *testing.T) {
	path := writeClaudeModelsFixture(t)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nIFS= read -r request\nIFS= read -r request\n"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, _, err := readClaudeModels(ctx, path); err == nil || !strings.Contains(err.Error(), "deadline exceeded") {
		t.Fatalf("expected cancellation error: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("canceled CLI did not stop promptly: %v", elapsed)
	}
}

func TestClaudeModelsRefreshAndPersist(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	path := writeClaudeModelsFixture(t)
	status := NewApp().ConnectClaudeCode(model.ClaudeConnection{Path: path, Model: "claude-nova-9[1m]"})
	if status.Error != "" || !status.Connected || status.Model != "claude-nova-9[1m]" {
		t.Fatalf("could not connect with a discovered model: %+v", status)
	}
	saved, connected, err := savedClaudeConnection()
	if err != nil || !connected || !reflect.DeepEqual(saved.Models, status.Models) || saved.DefaultModel != status.DefaultModel {
		t.Fatalf("models and default were not saved: %+v, %v", saved, err)
	}
	t.Setenv("KURLO_CLAUDE_MODEL_RESPONSE", "unavailable")
	if cached := NewApp().ClaudeCodeStatus(""); cached.Error != "" || cached.Model != status.Model || !reflect.DeepEqual(cached.Models, status.Models) {
		t.Fatalf("last successful models should survive a restart and CLI failure: %+v", cached)
	}
	t.Setenv("KURLO_CLAUDE_MODEL_RESPONSE", `{"type":"control_response","response":{"subtype":"success","request_id":"kurlo-models","response":{"models":[{"value":"default","resolvedModel":"claude-new-10","displayName":"New 10","supportsEffort":true,"supportedEffortLevels":["medium"]}]}}}`)
	refreshed := NewApp().ClaudeCodeStatus("")
	if refreshed.Error != "" || refreshed.Model != "claude-new-10" || refreshed.DefaultModel != "claude-new-10" || len(refreshed.Models) != 1 || refreshed.Models[0].DefaultEffort != "medium" {
		t.Fatalf("fresh catalog should replace cached models: %+v", refreshed)
	}
	t.Setenv("KURLO_CLAUDE_MODEL_RESPONSE", "unavailable")
	if cached := NewApp().ClaudeCodeStatus(""); cached.Error != "" || !reflect.DeepEqual(cached.Models, refreshed.Models) {
		t.Fatalf("refreshed catalog was not saved: %+v", cached)
	}
	otherPath := writeClaudeModelsFixture(t)
	if other := NewApp().ClaudeCodeStatus(otherPath); other.Error == "" || len(other.Models) != 0 {
		t.Fatalf("another executable must not reuse the saved catalog: %+v", other)
	}
	t.Setenv("KURLO_CLAUDE_AUTH", `{"loggedIn":true,"authMethod":"claude.ai","email":"other@example.test","subscriptionType":"max"}`)
	if other := NewApp().ClaudeCodeStatus(""); other.Error == "" || len(other.Models) != 0 {
		t.Fatalf("another account must not reuse the saved catalog: %+v", other)
	}
	t.Setenv("KURLO_CLAUDE_AUTH", `{"loggedIn":false}`)
	if signedOut := NewApp().ClaudeCodeStatus(""); signedOut.Authenticated || len(signedOut.Models) != 0 || signedOut.Error != "" {
		t.Fatalf("signed out CLI must not expose cached models: %+v", signedOut)
	}
}

func TestClaudeModelsFailureWithoutCache(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	path := writeClaudeModelsFixture(t)
	t.Setenv("KURLO_CLAUDE_MODEL_RESPONSE", "unavailable")
	status := NewApp().ConnectClaudeCode(model.ClaudeConnection{Path: path})
	if status.Error == "" || status.Connected || len(status.Models) != 0 {
		t.Fatalf("failed discovery without cache should prevent connecting: %+v", status)
	}
}

func TestClaudeModelsRefreshExistingConnection(t *testing.T) {
	useTempConfigDir(t, t.TempDir())
	path := writeClaudeModelsFixture(t)
	connection := model.ClaudeConnection{Path: path, Model: "claude-nova-9[1m]", DefaultModel: "retired-default"}
	if err := saveAppPreferences(appPreferences{Claude: &claudeConnectionPreferences{ClaudeConnection: connection}}); err != nil {
		t.Fatal(err)
	}
	status := NewApp().ClaudeCodeStatus("")
	if status.Error != "" || !status.Connected || status.Model != connection.Model || status.DefaultModel != "claude-sonnet-5-5" || len(status.Models) != 3 {
		t.Fatalf("existing connection should discover models without reconnecting: %+v", status)
	}
	t.Setenv("KURLO_CLAUDE_MODEL_RESPONSE", "unavailable")
	if cached := NewApp().ClaudeCodeStatus(""); cached.Error != "" || cached.Model != connection.Model || !reflect.DeepEqual(cached.Models, status.Models) {
		t.Fatalf("existing connection should persist discovered models: %+v", cached)
	}
}

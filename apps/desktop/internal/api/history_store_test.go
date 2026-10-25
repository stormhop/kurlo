package api

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withHistoryStore(t *testing.T) {
	t.Helper()
	configDir := t.TempDir()
	useTempConfigDir(t, configDir)

	key := bytes.Repeat([]byte{7}, requestStoreKeySize)
	previousProvider := requestStoreKeyProvider
	previousLoader := requestStoreKeyLoader
	requestStoreKeyMu.Lock()
	requestStoreKeyCache = nil
	requestStoreKeyMu.Unlock()
	requestStoreKeyProvider = func() ([]byte, error) { return append([]byte(nil), key...), nil }
	requestStoreKeyLoader = requestStoreKeyProvider
	t.Cleanup(func() {
		requestStoreKeyProvider = previousProvider
		requestStoreKeyLoader = previousLoader
		requestStoreKeyMu.Lock()
		requestStoreKeyCache = nil
		requestStoreKeyMu.Unlock()
	})
}

func TestHistoryResponseRoundTrip(t *testing.T) {
	withHistoryStore(t)
	app := &App{}

	payload := `{"statusCode":200,"body":"{\"token\":\"secret\"}"}`
	if result := app.SaveHistoryResponse("history-1", payload); !result.Stored || result.Error != "" {
		t.Fatalf("save: %+v", result)
	}

	loaded := app.LoadHistoryResponse("history-1")
	if loaded.Error != "" || !loaded.Stored {
		t.Fatalf("load: %+v", loaded)
	}
	if loaded.Payload != payload {
		t.Errorf("payload = %q, want %q", loaded.Payload, payload)
	}
}

func TestHistoryResponseIsEncryptedOnDisk(t *testing.T) {
	withHistoryStore(t)
	app := &App{}

	app.SaveHistoryResponse("history-1", `{"body":"super-secret-token"}`)

	raw, err := os.ReadFile(filepath.Join(historyResponseDir(), "history-1.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if strings.Contains(string(raw), "super-secret-token") {
		t.Fatal("the response body is on disk in plain text")
	}
}

func TestMissingHistoryResponseIsNotAnError(t *testing.T) {
	withHistoryStore(t)
	app := &App{}

	result := app.LoadHistoryResponse("never-stored")
	if result.Error != "" {
		t.Errorf("unexpected error: %s", result.Error)
	}
	if result.Stored {
		t.Error("nothing was stored, so Stored should be false")
	}
}

func TestOversizedHistoryResponseIsNotStoredHalfCut(t *testing.T) {
	withHistoryStore(t)
	app := &App{}

	oversized := strings.Repeat("x", maxHistoryResponseBytes+4096)
	result := app.SaveHistoryResponse("history-1", oversized)
	if result.Stored || !result.Truncated {
		t.Fatalf("expected an oversized response to be reported and skipped, got %+v", result)
	}
	if loaded := app.LoadHistoryResponse("history-1"); loaded.Stored || loaded.Payload != "" {
		t.Errorf("a cut payload should not be stored, got %+v", loaded)
	}
}

func TestPruneHistoryResponsesKeepsOnlyLiveEntries(t *testing.T) {
	withHistoryStore(t)
	app := &App{}

	for _, id := range []string{"keep-1", "keep-2", "expired"} {
		app.SaveHistoryResponse(id, `{"statusCode":200}`)
	}
	if err := app.PruneHistoryResponses([]string{"keep-1", "keep-2"}); err != "" {
		t.Fatalf("prune: %s", err)
	}

	if !app.LoadHistoryResponse("keep-1").Stored || !app.LoadHistoryResponse("keep-2").Stored {
		t.Error("a live entry lost its response")
	}
	if app.LoadHistoryResponse("expired").Stored {
		t.Error("an expired entry kept its response")
	}
}

func TestClearHistoryResponsesRemovesEverything(t *testing.T) {
	withHistoryStore(t)
	app := &App{}

	app.SaveHistoryResponse("history-1", `{"statusCode":200}`)
	if err := app.ClearHistoryResponses(); err != "" {
		t.Fatalf("clear: %s", err)
	}
	if app.LoadHistoryResponse("history-1").Stored {
		t.Error("clearing history left a stored response behind")
	}
	if err := app.ClearHistoryResponses(); err != "" {
		t.Errorf("clearing an already-empty history should be a no-op, got %s", err)
	}
}

func TestHistoryResponseIdCannotEscapeTheDirectory(t *testing.T) {
	withHistoryStore(t)
	app := &App{}

	for _, id := range []string{"../escape", "sub/dir", "", "..", `..\windows`, "with space"} {
		if result := app.SaveHistoryResponse(id, `{"statusCode":200}`); result.Error == "" {
			t.Errorf("id %q was accepted; it must be rejected", id)
		}
		if result := app.LoadHistoryResponse(id); result.Error == "" && result.Stored {
			t.Errorf("id %q loaded something; it must be rejected", id)
		}
	}
}

package api

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const (
	historyResponseDirName  = "history"
	maxHistoryResponseBytes = 2 * 1024 * 1024
)

var historyStoreMu sync.Mutex

func historyResponseDir() string {
	return filepath.Join(requestStoreDir(), historyResponseDirName)
}

func historyResponsePath(id string) (string, error) {
	if id == "" {
		return "", fmt.Errorf("history id is empty")
	}
	for _, ch := range id {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9', ch == '-', ch == '_':
		default:
			return "", fmt.Errorf("invalid history id %q", id)
		}
	}
	return filepath.Join(historyResponseDir(), id+".json"), nil
}

type HistoryResponseResult struct {
	Stored    bool   `json:"stored"`
	Truncated bool   `json:"truncated"`
	Payload   string `json:"payload,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (a *App) SaveHistoryResponse(id string, payload string) HistoryResponseResult {
	historyStoreMu.Lock()
	defer historyStoreMu.Unlock()

	path, err := historyResponsePath(id)
	if err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	truncated := false
	if len(payload) > maxHistoryResponseBytes {
		payload = payload[:maxHistoryResponseBytes]
		truncated = true
	}
	if err := os.MkdirAll(historyResponseDir(), 0o700); err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	encrypted, err := encryptRequestStorePayload([]byte(payload))
	if err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	if err := writeFileAtomic(path, encrypted); err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	return HistoryResponseResult{Stored: true, Truncated: truncated}
}

func (a *App) LoadHistoryResponse(id string) HistoryResponseResult {
	return readHistoryResponse(id)
}

func readHistoryResponse(id string) HistoryResponseResult {
	path, err := historyResponsePath(id)
	if err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return HistoryResponseResult{}
	}
	if err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	payload, err := decryptRequestStorePayload(data)
	if err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	return HistoryResponseResult{Stored: true, Payload: string(payload)}
}

func (a *App) StoredHistoryResponseIDs() []string {
	ids := make([]string, 0)
	for id := range storedHistoryResponseIDs() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func storedHistoryResponseIDs() map[string]bool {
	stored := map[string]bool{}
	entries, err := os.ReadDir(historyResponseDir())
	if err != nil {
		return stored
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		stored[strings.TrimSuffix(name, ".json")] = true
	}
	return stored
}

func (a *App) PruneHistoryResponses(keepIDs []string) string {
	historyStoreMu.Lock()
	defer historyStoreMu.Unlock()

	entries, err := os.ReadDir(historyResponseDir())
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		return err.Error()
	}
	keep := make(map[string]struct{}, len(keepIDs))
	for _, id := range keepIDs {
		keep[id] = struct{}{}
	}

	var failures []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		if _, wanted := keep[strings.TrimSuffix(name, ".json")]; wanted {
			continue
		}
		if err := os.Remove(filepath.Join(historyResponseDir(), name)); err != nil && !os.IsNotExist(err) {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) == 0 {
		return ""
	}
	sort.Strings(failures)
	return strings.Join(failures, "; ")
}

func (a *App) ClearHistoryResponses() string {
	historyStoreMu.Lock()
	defer historyStoreMu.Unlock()

	if err := os.RemoveAll(historyResponseDir()); err != nil && !os.IsNotExist(err) {
		return err.Error()
	}
	return ""
}

func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".history-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		tmp.Close()
		os.Remove(tmpName)
	}()

	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := replaceFile(tmpName, path); err != nil {
		return err
	}
	return syncDir(dir)
}

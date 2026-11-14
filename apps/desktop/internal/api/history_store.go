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

type historyResponseStore struct {
	mu    sync.Mutex
	dir   func() string
	codec *requestStoreCodec
}

var defaultHistoryResponseStore = &historyResponseStore{dir: historyResponseDir, codec: defaultRequestStoreCodec}

func (a *App) historyResponses() *historyResponseStore {
	if a.historyStore != nil {
		return a.historyStore
	}
	return defaultHistoryResponseStore
}

func historyResponseDir() string {
	return filepath.Join(requestStoreDir(), historyResponseDirName)
}

func (s *historyResponseStore) path(id string) (string, error) {
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
	return filepath.Join(s.dir(), id+".json"), nil
}

type HistoryResponseResult struct {
	Stored    bool   `json:"stored"`
	Truncated bool   `json:"truncated"`
	Payload   string `json:"payload,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (s *historyResponseStore) save(id string, payload string) HistoryResponseResult {
	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := s.path(id)
	if err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	if len(payload) > maxHistoryResponseBytes {
		return HistoryResponseResult{Stored: false, Truncated: true}
	}
	if err := os.MkdirAll(s.dir(), 0o700); err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	encrypted, err := s.codec.encrypt([]byte(payload))
	if err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	if err := writeFileAtomic(path, encrypted); err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	return HistoryResponseResult{Stored: true}
}

func (s *historyResponseStore) load(id string) HistoryResponseResult {
	path, err := s.path(id)
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
	payload, err := s.codec.decrypt(data)
	if err != nil {
		return HistoryResponseResult{Error: err.Error()}
	}
	return HistoryResponseResult{Stored: true, Payload: string(payload)}
}

func (s *historyResponseStore) ids() []string {
	ids := make([]string, 0)
	for id := range s.storedIDs() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (s *historyResponseStore) storedIDs() map[string]bool {
	stored := map[string]bool{}
	entries, err := os.ReadDir(s.dir())
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

func (s *historyResponseStore) prune(keepIDs []string) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := os.ReadDir(s.dir())
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
		if err := os.Remove(filepath.Join(s.dir(), name)); err != nil && !os.IsNotExist(err) {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) == 0 {
		return ""
	}
	sort.Strings(failures)
	return strings.Join(failures, "; ")
}

func (s *historyResponseStore) clear() string {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.RemoveAll(s.dir()); err != nil && !os.IsNotExist(err) {
		return err.Error()
	}
	return ""
}

func (a *App) SaveHistoryResponse(id string, payload string) HistoryResponseResult {
	return a.historyResponses().save(id, payload)
}

func (a *App) LoadHistoryResponse(id string) HistoryResponseResult {
	return a.historyResponses().load(id)
}

func (a *App) StoredHistoryResponseIDs() []string { return a.historyResponses().ids() }

func (a *App) PruneHistoryResponses(keepIDs []string) string {
	return a.historyResponses().prune(keepIDs)
}

func (a *App) ClearHistoryResponses() string { return a.historyResponses().clear() }

func readHistoryResponse(id string) HistoryResponseResult {
	return defaultHistoryResponseStore.load(id)
}

func storedHistoryResponseIDs() map[string]bool {
	return defaultHistoryResponseStore.storedIDs()
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

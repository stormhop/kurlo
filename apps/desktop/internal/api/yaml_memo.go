package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"
)

const workspaceYAMLMemoLimit = 50000

type workspaceYAMLMemoEntry struct {
	key  [sha256.Size]byte
	yaml [sha256.Size]byte
}

var workspaceYAMLMemo = struct {
	sync.Mutex
	entries map[string]workspaceYAMLMemoEntry
}{entries: map[string]workspaceYAMLMemoEntry{}}

func workspaceYAMLMemoKey(value any) ([sha256.Size]byte, bool) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return [sha256.Size]byte{}, false
	}
	return sha256.Sum256(encoded), true
}

func workspaceYAMLForWrite(path string, value any, journal *saveJournal) ([]byte, bool, error) {
	key, keyed := workspaceYAMLMemoKey(value)
	if keyed {
		known, ok := journal.knownHash(path)
		workspaceYAMLMemo.Lock()
		entry, hit := workspaceYAMLMemo.entries[path]
		workspaceYAMLMemo.Unlock()
		if ok && hit && entry.key == key && hex.EncodeToString(entry.yaml[:]) == known {
			return nil, true, nil
		}
	}
	data, err := marshalWorkspaceYAML(value)
	if err != nil {
		return nil, false, err
	}
	sum := sha256.Sum256(data)
	if keyed {
		workspaceYAMLMemo.Lock()
		if len(workspaceYAMLMemo.entries) >= workspaceYAMLMemoLimit {
			workspaceYAMLMemo.entries = map[string]workspaceYAMLMemoEntry{}
		}
		workspaceYAMLMemo.entries[path] = workspaceYAMLMemoEntry{key: key, yaml: sum}
		workspaceYAMLMemo.Unlock()
	}
	known, ok := journal.knownHash(path)
	return data, ok && known == hex.EncodeToString(sum[:]), nil
}

func forgetWorkspaceYAML(paths ...string) {
	workspaceYAMLMemo.Lock()
	defer workspaceYAMLMemo.Unlock()
	for _, path := range paths {
		delete(workspaceYAMLMemo.entries, path)
	}
}

func resetWorkspaceYAMLMemo() {
	workspaceYAMLMemo.Lock()
	defer workspaceYAMLMemo.Unlock()
	workspaceYAMLMemo.entries = map[string]workspaceYAMLMemoEntry{}
}

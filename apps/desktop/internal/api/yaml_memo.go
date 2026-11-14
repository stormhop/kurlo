package api

import (
	"crypto/sha256"
	"encoding/json"
	"sync"
)

type workspaceYAMLMemoEntry struct {
	key  [sha256.Size]byte
	data []byte
}

var workspaceYAMLMemo = struct {
	sync.Mutex
	entries map[string]workspaceYAMLMemoEntry
}{entries: map[string]workspaceYAMLMemoEntry{}}

func marshalWorkspaceYAMLFor(path string, value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return marshalWorkspaceYAML(value)
	}
	key := sha256.Sum256(encoded)
	workspaceYAMLMemo.Lock()
	entry, ok := workspaceYAMLMemo.entries[path]
	workspaceYAMLMemo.Unlock()
	if ok && entry.key == key {
		return entry.data, nil
	}
	data, err := marshalWorkspaceYAML(value)
	if err != nil {
		return nil, err
	}
	workspaceYAMLMemo.Lock()
	workspaceYAMLMemo.entries[path] = workspaceYAMLMemoEntry{key: key, data: data}
	workspaceYAMLMemo.Unlock()
	return data, nil
}

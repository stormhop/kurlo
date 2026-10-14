package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	workspaceDiskPollInterval   = time.Second
	workspaceExternalChangeNote = "files changed outside Kurlo"
)

type workspaceFileStamp struct {
	size int64
	mod  int64
	hash string
}

type workspaceSnapshot map[string]workspaceFileStamp

type workspaceExternalChange struct {
	rel     string
	deleted bool
	content []byte
}

type workspaceDiskTracker struct {
	mu        sync.Mutex
	root      string
	known     workspaceSnapshot
	announced string
}

var workspaceDisk = &workspaceDiskTracker{}

func workspaceTrackedFile(rel string) bool {
	if rel == fileStoreRootIndex {
		return true
	}
	if !strings.HasPrefix(rel, fileStoreWorkspacesDir+"/") {
		return false
	}
	base := filepath.Base(rel)
	return !strings.HasSuffix(base, ".tmp") && !strings.HasPrefix(base, ".")
}

func scanWorkspaceFiles(root string, previous workspaceSnapshot, withHash bool) (workspaceSnapshot, error) {
	snapshot := workspaceSnapshot{}
	add := func(path string, info fs.FileInfo) error {
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !workspaceTrackedFile(rel) || !info.Mode().IsRegular() {
			return nil
		}
		stamp := workspaceFileStamp{size: info.Size(), mod: info.ModTime().UnixNano()}
		if withHash {
			if prev, ok := previous[rel]; ok && prev.hash != "" && prev.size == stamp.size && prev.mod == stamp.mod {
				stamp.hash = prev.hash
			} else {
				data, err := os.ReadFile(path)
				if err != nil {
					if errors.Is(err, os.ErrNotExist) {
						return nil
					}
					return err
				}
				stamp.hash = contentHash(data)
			}
		}
		snapshot[rel] = stamp
		return nil
	}
	if info, err := os.Lstat(filepath.Join(root, fileStoreRootIndex)); err == nil {
		if err := add(filepath.Join(root, fileStoreRootIndex), info); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	err := filepath.WalkDir(filepath.Join(root, fileStoreWorkspacesDir), func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		if entry.IsDir() || entry.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		return add(path, info)
	})
	if err != nil {
		return nil, err
	}
	return snapshot, nil
}

func contentHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s workspaceSnapshot) fingerprint() string {
	keys := make([]string, 0, len(s))
	for rel := range s {
		keys = append(keys, rel)
	}
	sort.Strings(keys)
	hash := sha256.New()
	for _, rel := range keys {
		stamp := s[rel]
		hash.Write([]byte(rel + "\x00" + strconv.FormatInt(stamp.size, 10) + "\x00" + strconv.FormatInt(stamp.mod, 10) + "\n"))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func sameStamp(left, right workspaceFileStamp) bool {
	return left.size == right.size && left.mod == right.mod
}

func (t *workspaceDiskTracker) remember(root string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	var previous workspaceSnapshot
	if sameWorkspaceRoot(t.root, root) {
		previous = t.known
	}
	snapshot, err := scanWorkspaceFiles(root, previous, true)
	if err != nil {
		t.root, t.known, t.announced = "", nil, ""
		return
	}
	t.root = root
	t.known = snapshot
	t.announced = snapshot.fingerprint()
}

func (t *workspaceDiskTracker) trackedRoot() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.root
}

func (t *workspaceDiskTracker) knownFor(root string) workspaceSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.known == nil || !sameWorkspaceRoot(t.root, root) {
		return nil
	}
	return t.known
}

func (t *workspaceDiskTracker) externalChanges(root string) (workspaceSnapshot, []workspaceExternalChange, error) {
	known := t.knownFor(root)
	if known == nil {
		return nil, nil, nil
	}
	current, err := scanWorkspaceFiles(root, nil, false)
	if err != nil {
		return nil, nil, err
	}
	var changes []workspaceExternalChange
	for rel, stamp := range current {
		if prev, ok := known[rel]; ok && sameStamp(prev, stamp) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, nil, err
		}
		if prev, ok := known[rel]; ok && prev.hash == contentHash(data) {
			continue
		}
		changes = append(changes, workspaceExternalChange{rel: rel, content: data})
	}
	for rel := range known {
		if _, ok := current[rel]; !ok {
			changes = append(changes, workspaceExternalChange{rel: rel, deleted: true})
		}
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].rel < changes[j].rel })
	return known, changes, nil
}

func reapplyExternalChanges(root string, before workspaceSnapshot, changes []workspaceExternalChange) error {
	for _, change := range changes {
		path := filepath.Join(root, filepath.FromSlash(change.rel))
		data, err := os.ReadFile(path)
		exists := err == nil
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		prev, known := before[change.rel]
		untouched := (known && exists && contentHash(data) == prev.hash) || (!known && !exists)
		if !untouched {
			continue
		}
		if change.deleted {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := writeTextFileAtomic(path, change.content); err != nil {
			return err
		}
	}
	return removeEmptyDirs(filepath.Join(root, fileStoreWorkspacesDir))
}

func (t *workspaceDiskTracker) unannouncedChange(root string) bool {
	known := t.knownFor(root)
	if known == nil {
		return false
	}
	current, err := scanWorkspaceFiles(root, nil, false)
	if err != nil {
		return false
	}
	fingerprint := current.fingerprint()
	t.mu.Lock()
	defer t.mu.Unlock()
	if !sameWorkspaceRoot(t.root, root) || fingerprint == t.announced {
		return false
	}
	t.announced = fingerprint
	return true
}

func (t *workspaceDiskTracker) markAnnounced(root string) {
	current, err := scanWorkspaceFiles(root, nil, false)
	if err != nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if sameWorkspaceRoot(t.root, root) {
		t.announced = current.fingerprint()
	}
}

func (a *App) watchWorkspaceDisk(ctx context.Context) {
	ticker := time.NewTicker(workspaceDiskPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if a.workspaceChangedOutside() {
				a.emitWorkspaceChanged(workspaceExternalChangeNote)
			}
		}
	}
}

func (a *App) workspaceChangedOutside() bool {
	if !gitOperationMu.TryRLock() {
		return false
	}
	defer gitOperationMu.RUnlock()
	root := workspaceDisk.trackedRoot()
	if root == "" {
		return false
	}
	unlock, ok := tryLockWorkspaceWrites(root)
	if !ok {
		return false
	}
	defer unlock()
	return workspaceDisk.unannouncedChange(root)
}

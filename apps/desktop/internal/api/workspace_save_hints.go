package api

import "path/filepath"

type workspaceSaveHints struct {
	disk       map[string]string
	known      map[string]string
	segments   map[string]string
	healthy    bool
	replaceAll bool
}

func (h *workspaceSaveHints) cachedDisk() map[string]string {
	if h == nil {
		return nil
	}
	return h.disk
}

func (h *workspaceSaveHints) mayHoldLegacyExampleBodies() bool {
	if h.known == nil {
		return true
	}
	for path := range h.known {
		if filepath.Ext(path) != fileStoreYAMLExt && filepath.Base(filepath.Dir(filepath.Dir(path))) == fileStoreExamplesDir {
			return true
		}
	}
	return false
}

func (t *workspaceDiskTracker) saveHints(root string) *workspaceSaveHints {
	t.mu.Lock()
	defer t.mu.Unlock()
	hints := &workspaceSaveHints{}
	if !sameWorkspaceRoot(t.root, root) || t.known == nil {
		return hints
	}
	hints.known = make(map[string]string, len(t.known))
	for rel, stamp := range t.known {
		if stamp.hash != "" {
			hints.known[filepath.Join(root, filepath.FromSlash(rel))] = stamp.hash
		}
	}
	hints.disk = t.savedSegments
	return hints
}

func (t *workspaceDiskTracker) rememberSavedSegments(root string, segments map[string]string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if sameWorkspaceRoot(t.root, root) && t.known != nil {
		t.savedSegments = segments
	}
}

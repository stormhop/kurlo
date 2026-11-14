package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const workspaceLockWait = 15 * time.Second

var errWorkspaceLockBusy = errors.New("workspace lock is busy")

func workspaceLockKey(root string) string {
	abs, err := filepath.Abs(root)
	if err != nil {
		abs = root
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return filepath.Clean(abs)
}

func workspaceLockPath(root string) string {
	return filepath.Join(requestStoreDir(), "locks", shortHash(workspaceLockKey(root))+".lock")
}

func openWorkspaceLockFile(root string) (*os.File, error) {
	path := workspaceLockPath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
}

func releaseWorkspaceLock(file *os.File) func() {
	return func() {
		_ = unlockFile(file)
		_ = file.Close()
	}
}

func tryLockWorkspaceWrites(root string) (func(), bool) {
	file, err := openWorkspaceLockFile(root)
	if err != nil {
		return nil, false
	}
	if err := tryLockFile(file); err != nil {
		_ = file.Close()
		if errors.Is(err, errWorkspaceLockBusy) {
			return nil, false
		}
		return nil, false
	}
	return releaseWorkspaceLock(file), true
}

func lockWorkspaceWrites(root string) (func(), error) {
	file, err := openWorkspaceLockFile(root)
	if err != nil {
		return nil, fmt.Errorf("could not open the workspace lock file: %w", err)
	}
	deadline := time.Now().Add(workspaceLockWait)
	for {
		err := tryLockFile(file)
		if err == nil {
			return releaseWorkspaceLock(file), nil
		}
		if !errors.Is(err, errWorkspaceLockBusy) {
			_ = file.Close()
			return nil, fmt.Errorf("could not lock the workspace: %w", err)
		}
		if time.Now().After(deadline) {
			_ = file.Close()
			return nil, fmt.Errorf("another Kurlo process has been saving this workspace for over %s; try again", workspaceLockWait)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func loadKurloStorePayloadLocked(localStorePath, root string) (string, []WorkspaceDiagnostic, error) {
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return "", nil, err
	}
	defer unlock()
	return loadKurloStorePayloadWithDiagnostics(localStorePath, root)
}

func loadKurloStorePayloadRemembering(localStorePath, root string, examplesBroken func()) (string, []WorkspaceDiagnostic, error) {
	payload, diagnostics, _, err := loadKurloStoreRemembering(localStorePath, root, examplesBroken)
	return payload, diagnostics, err
}

func loadKurloStoreRemembering(localStorePath, root string, examplesBroken func()) (string, []WorkspaceDiagnostic, int64, error) {
	unlock, err := lockWorkspaceWrites(root)
	if err != nil {
		return "", nil, 0, err
	}
	defer unlock()
	var deferred *deferredRequestExamples
	if !loadedRequestExamples.needsEagerLoad(root) {
		deferred = &deferredRequestExamples{}
	}
	store, diagnostics, err := loadKurloStoreDeferring(localStorePath, root, deferred)
	var revision int64
	if hasYAMLWorkspaceStore(root) {
		workspaceDisk.remember(root)
		if err == nil && len(diagnostics) == 0 {
			workspaceDisk.rememberSavedSegments(root, diskItemSegments(mapSlice(store["workspaces"]), mapSlice(store["collections"]), mapSlice(store["requests"]), mapSlice(store["environments"])))
			shape := storeShapeFromPayload(store)
			shape.revision = storeSaveRevision.Add(1)
			if workspaceDisk.rememberSavedShape(root, shape) {
				revision = shape.revision
			}
		}
	}
	if err != nil {
		return "", diagnostics, 0, err
	}
	if deferred != nil {
		loadedRequestExamples.loadLater(root, deferred, examplesBroken)
	} else {
		loadedRequestExamples.replace(root, moveRequestExamplesOut(store))
		if len(diagnostics) == 0 {
			loadedRequestExamples.healthy(root)
		}
	}
	payload, err := json.Marshal(store)
	if err != nil {
		return "", diagnostics, 0, err
	}
	return string(payload), diagnostics, revision, nil
}

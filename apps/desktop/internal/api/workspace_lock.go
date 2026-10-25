package api

import (
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
		return func() {}, true
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
			return func() {}, nil
		}
		if time.Now().After(deadline) {
			_ = file.Close()
			return nil, fmt.Errorf("another Kurlo process has been saving this workspace for over %s; try again", workspaceLockWait)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func loadKurloStorePayloadLocked(localStorePath, root string) (string, []WorkspaceDiagnostic, error) {
	if unlock, err := lockWorkspaceWrites(root); err == nil {
		defer unlock()
	}
	return loadKurloStorePayloadWithDiagnostics(localStorePath, root)
}

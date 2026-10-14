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

func openWorkspaceLockFile(root string) *os.File {
	path := workspaceLockPath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil
	}
	return file
}

func releaseWorkspaceLock(file *os.File) func() {
	return func() {
		_ = unlockFile(file)
		_ = file.Close()
	}
}

func tryLockWorkspaceWrites(root string) (func(), bool) {
	file := openWorkspaceLockFile(root)
	if file == nil {
		return func() {}, true
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
	file := openWorkspaceLockFile(root)
	if file == nil {
		return func() {}, nil
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

package api

import (
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const workspaceDiskSafetyPoll = 15 * time.Second

type workspaceNativeWatch interface {
	changes() <-chan struct{}
	close()
}

type workspaceWatchSignal struct {
	ch   chan struct{}
	once sync.Once
}

func newWorkspaceWatchSignal() *workspaceWatchSignal {
	return &workspaceWatchSignal{ch: make(chan struct{}, 1)}
}

func (s *workspaceWatchSignal) notify() {
	select {
	case s.ch <- struct{}{}:
	default:
	}
}

func (s *workspaceWatchSignal) lost() {
	s.once.Do(func() { close(s.ch) })
}

func workspaceWatchRelevant(rel string) bool {
	rel = strings.Trim(strings.ToLower(filepath.ToSlash(rel)), "/")
	if rel == "" || rel == "." || rel == fileStoreRootIndex || rel == fileStoreWorkspacesDir {
		return true
	}
	if !strings.HasPrefix(rel, fileStoreWorkspacesDir+"/") {
		return false
	}
	base := rel[strings.LastIndex(rel, "/")+1:]
	return !strings.HasSuffix(base, ".tmp")
}

type workspaceDiskLoop struct {
	start    func(root string) (workspaceNativeWatch, error)
	watch    workspaceNativeWatch
	root     string
	failed   string
	dirty    bool
	lastScan time.Time
}

func newWorkspaceDiskLoop() *workspaceDiskLoop {
	return &workspaceDiskLoop{start: startWorkspaceNativeWatch, dirty: true}
}

func (l *workspaceDiskLoop) changes() <-chan struct{} {
	if l.watch == nil {
		return nil
	}
	return l.watch.changes()
}

func (l *workspaceDiskLoop) follow(root string) {
	if root == l.root && (l.watch != nil || root == "" || root == l.failed) {
		return
	}
	l.stop()
	l.root = root
	l.dirty = true
	if root == "" || root == l.failed {
		return
	}
	watch, err := l.start(root)
	if err != nil || watch == nil {
		l.failed = root
		return
	}
	l.failed = ""
	l.watch = watch
}

func (l *workspaceDiskLoop) changed(open bool) {
	l.dirty = true
	if !open {
		l.stop()
		l.failed = l.root
	}
}

func (l *workspaceDiskLoop) due(now time.Time) bool {
	return l.watch == nil || l.dirty || now.Sub(l.lastScan) >= workspaceDiskSafetyPoll
}

func (l *workspaceDiskLoop) scanned(now time.Time) {
	l.dirty = false
	l.lastScan = now
}

func (l *workspaceDiskLoop) stop() {
	if l.watch != nil {
		l.watch.close()
		l.watch = nil
	}
}

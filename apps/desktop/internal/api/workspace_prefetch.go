package api

import (
	"sync"
	"sync/atomic"
	"time"
)

const workspacePrefetchMaxAge = 10 * time.Second

type workspaceOperationLock struct {
	sync.RWMutex
	writes atomic.Uint64
}

func (l *workspaceOperationLock) Lock() {
	l.RWMutex.Lock()
	l.writes.Add(1)
}

type workspacePrefetch struct {
	root     string
	writes   uint64
	done     chan struct{}
	result   WorkspaceLoadResult
	finished time.Time
}

type workspacePrefetchSlot struct {
	mu      sync.Mutex
	pending *workspacePrefetch
}

func (a *App) prefetchWorkspace() {
	prefetch := &workspacePrefetch{root: fileWorkspaceStorePath(), done: make(chan struct{})}
	a.workspacePrefetch.mu.Lock()
	a.workspacePrefetch.pending = prefetch
	a.workspacePrefetch.mu.Unlock()
	go func() {
		defer close(prefetch.done)
		gitOperationMu.RLock()
		defer gitOperationMu.RUnlock()
		prefetch.writes = gitOperationMu.writes.Load()
		prefetch.result = a.loadWorkspaceLocked(prefetch.root)
		prefetch.finished = time.Now()
	}()
}

func (a *App) takePrefetchedWorkspace(root string) (WorkspaceLoadResult, bool) {
	a.workspacePrefetch.mu.Lock()
	prefetch := a.workspacePrefetch.pending
	a.workspacePrefetch.pending = nil
	a.workspacePrefetch.mu.Unlock()
	if prefetch == nil || prefetch.root != root {
		return WorkspaceLoadResult{}, false
	}
	<-prefetch.done
	if gitOperationMu.writes.Load() != prefetch.writes || time.Since(prefetch.finished) > workspacePrefetchMaxAge {
		return WorkspaceLoadResult{}, false
	}
	return prefetch.result, true
}

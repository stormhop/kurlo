//go:build darwin && cgo

package api

/*
#cgo LDFLAGS: -framework CoreServices
#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <stdint.h>
#include <stdlib.h>

extern void kurloWorkspaceFSEvents(uintptr_t handle, size_t count, char **paths, uint32_t *flags);

typedef struct {
	FSEventStreamRef stream;
	dispatch_queue_t queue;
} kurloWorkspaceStream;

static void kurloWorkspaceFSEventsCallback(ConstFSEventStreamRef stream, void *info, size_t count, void *paths, const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
	kurloWorkspaceFSEvents((uintptr_t)info, count, (char **)paths, (uint32_t *)flags);
}

static void kurloWorkspaceQueueDrained(void *context) {
}

static kurloWorkspaceStream *kurloWorkspaceStreamStart(const char *path, uintptr_t handle) {
	CFStringRef root = CFStringCreateWithCString(NULL, path, kCFStringEncodingUTF8);
	if (root == NULL) {
		return NULL;
	}
	CFArrayRef paths = CFArrayCreate(NULL, (const void **)&root, 1, &kCFTypeArrayCallBacks);
	CFRelease(root);
	if (paths == NULL) {
		return NULL;
	}
	FSEventStreamContext context = {0, (void *)handle, NULL, NULL, NULL};
	FSEventStreamRef stream = FSEventStreamCreate(NULL, kurloWorkspaceFSEventsCallback, &context, paths, kFSEventStreamEventIdSinceNow, 0.2,
		kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer);
	CFRelease(paths);
	if (stream == NULL) {
		return NULL;
	}
	dispatch_queue_t queue = dispatch_queue_create("dev.kurlo.workspace-watch", DISPATCH_QUEUE_SERIAL);
	FSEventStreamSetDispatchQueue(stream, queue);
	if (!FSEventStreamStart(stream)) {
		FSEventStreamInvalidate(stream);
		FSEventStreamRelease(stream);
		dispatch_release(queue);
		return NULL;
	}
	kurloWorkspaceStream *out = malloc(sizeof(kurloWorkspaceStream));
	out->stream = stream;
	out->queue = queue;
	return out;
}

static void kurloWorkspaceStreamStop(kurloWorkspaceStream *watch) {
	FSEventStreamStop(watch->stream);
	FSEventStreamInvalidate(watch->stream);
	FSEventStreamRelease(watch->stream);
	dispatch_sync_f(watch->queue, NULL, kurloWorkspaceQueueDrained);
	dispatch_release(watch->queue);
	free(watch);
}
*/
import "C"

import (
	"errors"
	"path/filepath"
	"runtime/cgo"
	"sync"
	"unsafe"
)

type darwinWorkspaceWatch struct {
	*workspaceWatchSignal
	roots  []string
	handle cgo.Handle
	stream *C.kurloWorkspaceStream
	once   sync.Once
}

func startWorkspaceNativeWatch(root string) (workspaceNativeWatch, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	roots := []string{filepath.Clean(absolute)}
	if real, err := filepath.EvalSymlinks(absolute); err == nil && real != roots[0] {
		roots = append(roots, filepath.Clean(real))
	}
	watch := &darwinWorkspaceWatch{workspaceWatchSignal: newWorkspaceWatchSignal(), roots: roots}
	watch.handle = cgo.NewHandle(watch)
	path := C.CString(roots[len(roots)-1])
	defer C.free(unsafe.Pointer(path))
	watch.stream = C.kurloWorkspaceStreamStart(path, C.uintptr_t(watch.handle))
	if watch.stream == nil {
		watch.handle.Delete()
		return nil, errors.New("could not start FSEvents")
	}
	return watch, nil
}

func (w *darwinWorkspaceWatch) changes() <-chan struct{} {
	return w.ch
}

func (w *darwinWorkspaceWatch) close() {
	w.once.Do(func() {
		C.kurloWorkspaceStreamStop(w.stream)
		w.handle.Delete()
	})
}

func (w *darwinWorkspaceWatch) relevant(path string) bool {
	for _, root := range w.roots {
		rel, err := filepath.Rel(root, path)
		if err == nil && filepath.IsLocal(rel) {
			return workspaceWatchRelevant(rel)
		}
		if err == nil && rel == "." {
			return true
		}
	}
	return true
}

//go:build windows

package api

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

const windowsWorkspaceNotifyMask = windows.FILE_NOTIFY_CHANGE_FILE_NAME | windows.FILE_NOTIFY_CHANGE_DIR_NAME | windows.FILE_NOTIFY_CHANGE_SIZE | windows.FILE_NOTIFY_CHANGE_LAST_WRITE | windows.FILE_NOTIFY_CHANGE_CREATION

type windowsWorkspaceWatch struct {
	*workspaceWatchSignal
	dir     windows.Handle
	io      windows.Handle
	stop    windows.Handle
	storage []uint64
	done    chan struct{}
	once    sync.Once
}

func startWorkspaceNativeWatch(root string) (workspaceNativeWatch, error) {
	path, err := windows.UTF16PtrFromString(filepath.Clean(root))
	if err != nil {
		return nil, err
	}
	dir, err := windows.CreateFile(path, windows.FILE_LIST_DIRECTORY, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		return nil, err
	}
	io, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		windows.CloseHandle(dir)
		return nil, err
	}
	stop, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		windows.CloseHandle(io)
		windows.CloseHandle(dir)
		return nil, err
	}
	watch := &windowsWorkspaceWatch{workspaceWatchSignal: newWorkspaceWatchSignal(), dir: dir, io: io, stop: stop, storage: make([]uint64, 8*1024), done: make(chan struct{})}
	overlapped := &windows.Overlapped{HEvent: io}
	if err := watch.read(overlapped); err != nil {
		watch.release()
		return nil, err
	}
	go watch.run(overlapped)
	return watch, nil
}

func (w *windowsWorkspaceWatch) buffer() []byte {
	return unsafe.Slice((*byte)(unsafe.Pointer(&w.storage[0])), len(w.storage)*8)
}

func (w *windowsWorkspaceWatch) read(overlapped *windows.Overlapped) error {
	if err := windows.ResetEvent(w.io); err != nil {
		return err
	}
	buffer := w.buffer()
	return windows.ReadDirectoryChanges(w.dir, &buffer[0], uint32(len(buffer)), true, windowsWorkspaceNotifyMask, nil, overlapped, 0)
}

func (w *windowsWorkspaceWatch) run(overlapped *windows.Overlapped) {
	defer close(w.done)
	for {
		event, err := windows.WaitForMultipleObjects([]windows.Handle{w.io, w.stop}, false, windows.INFINITE)
		if err != nil {
			w.cancel(overlapped)
			w.lost()
			return
		}
		if event == windows.WAIT_OBJECT_0+1 {
			w.cancel(overlapped)
			return
		}
		var transferred uint32
		if err := windows.GetOverlappedResult(w.dir, overlapped, &transferred, false); err != nil {
			if !errors.Is(err, windows.ERROR_NOTIFY_ENUM_DIR) {
				w.lost()
				return
			}
			transferred = 0
		}
		if transferred == 0 {
			w.notify()
		} else if w.relevant(w.buffer()[:transferred]) {
			w.notify()
		}
		if err := w.read(overlapped); err != nil {
			w.lost()
			return
		}
	}
}

func (w *windowsWorkspaceWatch) cancel(overlapped *windows.Overlapped) {
	if err := windows.CancelIoEx(w.dir, overlapped); err == nil {
		var transferred uint32
		_ = windows.GetOverlappedResult(w.dir, overlapped, &transferred, true)
	}
}

func (w *windowsWorkspaceWatch) relevant(events []byte) bool {
	for offset := 0; offset+12 <= len(events); {
		info := (*windows.FileNotifyInformation)(unsafe.Pointer(&events[offset]))
		length := int(info.FileNameLength) / 2
		if offset+12+int(info.FileNameLength) > len(events) {
			return true
		}
		name := windows.UTF16ToString(unsafe.Slice(&info.FileName, length))
		if workspaceWatchRelevant(strings.ReplaceAll(name, `\`, "/")) {
			return true
		}
		if info.NextEntryOffset == 0 {
			break
		}
		offset += int(info.NextEntryOffset)
	}
	return false
}

func (w *windowsWorkspaceWatch) changes() <-chan struct{} {
	return w.ch
}

func (w *windowsWorkspaceWatch) close() {
	w.once.Do(func() {
		_ = windows.SetEvent(w.stop)
		<-w.done
		w.release()
	})
}

func (w *windowsWorkspaceWatch) release() {
	windows.CloseHandle(w.stop)
	windows.CloseHandle(w.io)
	windows.CloseHandle(w.dir)
}

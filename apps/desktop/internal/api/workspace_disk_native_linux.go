//go:build linux

package api

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	inotifyWorkspaceDirMask  = unix.IN_CREATE | unix.IN_DELETE | unix.IN_MODIFY | unix.IN_CLOSE_WRITE | unix.IN_MOVED_FROM | unix.IN_MOVED_TO | unix.IN_ATTRIB | unix.IN_DELETE_SELF | unix.IN_MOVE_SELF | unix.IN_ONLYDIR
	inotifyWorkspaceRootMask = inotifyWorkspaceDirMask
)

type linuxWorkspaceWatch struct {
	*workspaceWatchSignal
	root  string
	fd    int
	wake  [2]int
	dirs  map[int]string
	done  chan struct{}
	once  sync.Once
	mutex sync.Mutex
}

func startWorkspaceNativeWatch(root string) (workspaceNativeWatch, error) {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return nil, err
	}
	watch := &linuxWorkspaceWatch{workspaceWatchSignal: newWorkspaceWatchSignal(), root: filepath.Clean(root), fd: fd, dirs: map[int]string{}, done: make(chan struct{})}
	if err := unix.Pipe2(watch.wake[:], unix.O_CLOEXEC|unix.O_NONBLOCK); err != nil {
		unix.Close(fd)
		return nil, err
	}
	if err := watch.add(watch.root, inotifyWorkspaceRootMask); err != nil {
		watch.release()
		return nil, err
	}
	if err := watch.addTree(filepath.Join(watch.root, fileStoreWorkspacesDir)); err != nil {
		watch.release()
		return nil, err
	}
	go watch.run()
	return watch, nil
}

func (w *linuxWorkspaceWatch) changes() <-chan struct{} {
	return w.ch
}

func (w *linuxWorkspaceWatch) close() {
	w.once.Do(func() {
		_, _ = unix.Write(w.wake[1], []byte{0})
		<-w.done
		w.release()
	})
}

func (w *linuxWorkspaceWatch) release() {
	unix.Close(w.fd)
	unix.Close(w.wake[0])
	unix.Close(w.wake[1])
}

func (w *linuxWorkspaceWatch) add(dir string, mask uint32) error {
	wd, err := unix.InotifyAddWatch(w.fd, dir, mask)
	if err != nil {
		return err
	}
	w.mutex.Lock()
	w.dirs[wd] = dir
	w.mutex.Unlock()
	return nil
}

func (w *linuxWorkspaceWatch) addTree(dir string) error {
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		if !entry.IsDir() {
			return nil
		}
		if err := w.add(path, inotifyWorkspaceDirMask); err != nil && !errors.Is(err, unix.ENOENT) && !errors.Is(err, unix.ENOTDIR) {
			return err
		}
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (w *linuxWorkspaceWatch) run() {
	defer close(w.done)
	buffer := make([]byte, 64*1024)
	polls := []unix.PollFd{{Fd: int32(w.fd), Events: unix.POLLIN}, {Fd: int32(w.wake[0]), Events: unix.POLLIN}}
	for {
		polls[0].Revents, polls[1].Revents = 0, 0
		if _, err := unix.Poll(polls, -1); err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			w.lost()
			return
		}
		if polls[1].Revents != 0 {
			return
		}
		n, err := unix.Read(w.fd, buffer)
		if err != nil {
			if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
				continue
			}
			w.lost()
			return
		}
		if !w.handle(buffer[:n]) {
			w.lost()
			return
		}
	}
}

func (w *linuxWorkspaceWatch) handle(events []byte) bool {
	relevant := false
	for offset := 0; offset+unix.SizeofInotifyEvent <= len(events); {
		event := (*unix.InotifyEvent)(unsafe.Pointer(&events[offset]))
		nameStart := offset + unix.SizeofInotifyEvent
		nameEnd := nameStart + int(event.Len)
		if nameEnd > len(events) {
			break
		}
		name := strings.TrimRight(string(events[nameStart:nameEnd]), "\x00")
		offset = nameEnd
		if event.Mask&unix.IN_Q_OVERFLOW != 0 {
			relevant = true
			continue
		}
		w.mutex.Lock()
		dir, known := w.dirs[int(event.Wd)]
		if event.Mask&unix.IN_IGNORED != 0 {
			delete(w.dirs, int(event.Wd))
		}
		w.mutex.Unlock()
		if !known {
			continue
		}
		path := dir
		if name != "" {
			path = filepath.Join(dir, name)
		}
		rel, err := filepath.Rel(w.root, path)
		if err != nil {
			relevant = true
			continue
		}
		if !workspaceWatchRelevant(rel) {
			continue
		}
		relevant = true
		if event.Mask&unix.IN_ISDIR != 0 && event.Mask&(unix.IN_CREATE|unix.IN_MOVED_TO) != 0 {
			if err := w.addTree(path); err != nil {
				return false
			}
		}
	}
	if relevant {
		w.notify()
	}
	return true
}

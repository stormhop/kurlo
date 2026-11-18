package proxycapture

import (
	"errors"
	"os"
	"sync"
)

const maxBodyFile = 8 << 20
const maxSessionFiles = 64 << 20

type bodyFiles struct {
	readers int
	retired bool
	pending []string
	mu      sync.Mutex
	dir     string
	bytes   int64
	sizes   map[string]int64
}

func (f *bodyFiles) append(file **os.File, first, chunk []byte) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	size := int64(len(first) + len(chunk))
	if f.bytes+size > maxSessionFiles {
		return false
	}
	if *file == nil {
		if f.dir == "" {
			dir, err := os.MkdirTemp("", "kurlo-proxy-*")
			if err != nil {
				return false
			}
			f.dir = dir
			f.sizes = map[string]int64{}
		}
		tmp, err := os.CreateTemp(f.dir, "body-*")
		if err != nil {
			return false
		}
		*file = tmp
	}
	for _, b := range [][]byte{first, chunk} {
		n, err := (*file).Write(b)
		f.bytes += int64(n)
		f.sizes[(*file).Name()] += int64(n)
		if err != nil {
			return false
		}
	}
	return true
}
func (f *bodyFiles) remove(path string) {
	if path == "" {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.readers > 0 {
		f.pending = append(f.pending, path)
		return
	}
	f.removeLocked(path)
}
func (f *bodyFiles) removeLocked(path string) {
	if n, ok := f.sizes[path]; ok {
		if err := os.Remove(path); err == nil || os.IsNotExist(err) {
			f.bytes -= n
			delete(f.sizes, path)
		}
	}
}
func (f *bodyFiles) close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.retired = true
	if f.readers == 0 {
		f.cleanup()
	}
}
func (f *bodyFiles) retain() { f.mu.Lock(); defer f.mu.Unlock(); f.readers++ }
func (f *bodyFiles) release() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.readers--
	if f.readers != 0 {
		return
	}
	if f.retired {
		f.cleanup()
	} else {
		for _, p := range f.pending {
			f.removeLocked(p)
		}
	}
	f.pending = nil
}
func (f *bodyFiles) cleanup() {
	if f.dir != "" {
		os.RemoveAll(f.dir)
		f.dir = ""
		f.bytes = 0
		f.sizes = nil
	}
}

func (m Message) archived() (string, error) {
	if m.file == "" {
		if m.Binary {
			return string(m.raw), nil
		}
		return m.Body, nil
	}
	content, err := os.ReadFile(m.file)
	if err != nil {
		return "", errors.New("the archived body is no longer available")
	}
	return string(content), nil
}

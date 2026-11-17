package perftrack

import "sync"

var registry = struct {
	sync.RWMutex
	labels map[int]string
}{labels: make(map[int]string)}

func Track(pid int, label string) {
	registry.Lock()
	registry.labels[pid] = label
	registry.Unlock()
}

func Forget(pid int) {
	registry.Lock()
	delete(registry.labels, pid)
	registry.Unlock()
}

func Labels() map[int]string {
	registry.RLock()
	defer registry.RUnlock()
	labels := make(map[int]string, len(registry.labels))
	for pid, label := range registry.labels {
		labels[pid] = label
	}
	return labels
}

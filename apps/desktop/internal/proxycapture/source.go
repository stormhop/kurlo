package proxycapture

import (
	"context"
	"net"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type processLookup struct {
	mu        sync.Mutex
	last      time.Time
	processes map[string]string
	active    bool
}

func (p *processLookup) source(ctx context.Context, addr net.Addr, remote string) string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.active && time.Since(p.last) > time.Second {
		p.active = true
		p.last = time.Now()
		go func() {
			ctx, cancel := context.WithTimeout(ctx, time.Second)
			defer cancel()
			_, port, _ := net.SplitHostPort(addr.String())
			data, _ := exec.CommandContext(ctx, "/usr/sbin/lsof", "-nP", "-a", "-iTCP:"+port, "-sTCP:ESTABLISHED", "-Fpcn").Output()
			processes := parseProcesses(string(data), addr.String())
			p.mu.Lock()
			p.processes = processes
			p.active = false
			p.mu.Unlock()
		}()
	}
	return p.processes[remote]
}

func parseProcesses(output, addr string) map[string]string {
	out := map[string]string{}
	var pid, name string
	for _, line := range strings.Split(output, "\n") {
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case 'p':
			pid, name = line[1:], ""
		case 'c':
			name = line[1:]
		case 'n':
			source, dest, ok := strings.Cut(line[1:], "->")
			if _, err := strconv.Atoi(pid); ok && dest == addr && name != "" && err == nil {
				out[source] = name + " (" + pid + ")"
			}
		}
	}
	return out
}

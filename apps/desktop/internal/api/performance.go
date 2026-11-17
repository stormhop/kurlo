package api

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/perftrack"
)

type perfRawProcess struct {
	pid, parentPID int
	related        bool
	name           string
	cpuSeconds     *float64
	memoryBytes    *uint64
	started        time.Time
}

type performanceMonitor struct {
	mu        sync.Mutex
	previous  map[int]perfRawProcess
	sampledAt time.Time
	stop      chan struct{}
	done      chan struct{}
}

var perfProcessSensor = nativePerformanceProcesses
var perfStarted = time.Now()

func perfTrackProcess(pid int, label string) { perftrack.Track(pid, label) }
func perfForgetProcess(pid int)              { perftrack.Forget(pid) }

func perfWebview(name string) bool {
	name = strings.ToLower(name)
	return strings.Contains(name, "webcontent") || strings.Contains(name, "msedgewebview2") || strings.Contains(name, "webkitwebprocess") || strings.Contains(name, "webkitnetworkprocess") || strings.Contains(name, "webkitgpuprocess") || strings.Contains(name, "webkit.gpuprocess") || strings.Contains(name, "webkit.networking") || strings.Contains(name, "webkit.gpu")
}

func (a *App) PerformanceStatus() model.PerformanceSample {
	p := &a.performance
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sample()
}

func (p *performanceMonitor) sample() model.PerformanceSample {
	now := time.Now()
	raw, limited := perfProcessSensor()
	mainPID := os.Getpid()
	labels := perftrack.Labels()
	selected := map[int]bool{mainPID: true}
	for pid := range labels {
		selected[pid] = true
	}
	for changed := true; changed; {
		changed = false
		for _, process := range raw {
			if !selected[process.pid] && (selected[process.parentPID] || process.related) {
				selected[process.pid] = true
				changed = true
			}
		}
	}
	sample := model.PerformanceSample{SampledAt: now.UnixMilli(), MainPID: mainPID, MainUptimeSeconds: now.Sub(perfStarted).Seconds(), Processes: []model.PerformanceProcess{}, SensorLimited: limited}
	if !p.sampledAt.IsZero() {
		sample.IntervalMs = now.Sub(p.sampledAt).Milliseconds()
	}
	next := make(map[int]perfRawProcess)
	totalCPU, totalMemory := 0.0, uint64(0)
	cpuKnown, memoryKnown := !limited, !limited
	selfFound := false
	for _, process := range raw {
		if !selected[process.pid] {
			continue
		}
		row := model.PerformanceProcess{PID: process.pid, ParentPID: process.parentPID, Name: filepath.Base(process.name), Kind: "child", Role: "Child process", MemoryBytes: process.memoryBytes}
		if process.pid == mainPID {
			selfFound = true
			row.Kind = "main"
			row.Name = "Kurlo (main)"
			row.Role = "Application"
		} else if perfWebview(process.name) {
			row.Kind = "webview"
			row.Role = "Webview"
		}
		if label := labels[process.pid]; label != "" {
			row.Role = label
		}
		if !process.started.IsZero() {
			uptime := max(0, now.Sub(process.started).Seconds())
			row.UptimeSeconds = &uptime
			if process.pid == mainPID {
				sample.MainUptimeSeconds = uptime
			}
		}
		previous, ok := p.previous[process.pid]
		if ok && previous.started.Equal(process.started) && process.cpuSeconds != nil && previous.cpuSeconds != nil && sample.IntervalMs > 0 {
			cpu := max(0, (*process.cpuSeconds-*previous.cpuSeconds)/now.Sub(p.sampledAt).Seconds()*100)
			row.CPUPercent = &cpu
		}
		if row.CPUPercent == nil {
			cpuKnown = false
		} else {
			totalCPU += *row.CPUPercent
		}
		if row.MemoryBytes == nil {
			sample.SensorLimited = true
			memoryKnown = false
		} else {
			totalMemory += *row.MemoryBytes
		}
		next[process.pid] = process
		sample.Processes = append(sample.Processes, row)
	}
	if !selfFound {
		cpuKnown = false
		memoryKnown = false
		sample.SensorLimited = true
	}
	if cpuKnown {
		sample.TotalCPUPercent = &totalCPU
	}
	if memoryKnown {
		sample.TotalMemoryBytes = &totalMemory
	}
	sort.Slice(sample.Processes, func(i, j int) bool {
		if sample.Processes[i].Kind == "main" && sample.Processes[j].Kind != "main" {
			return true
		}
		if sample.Processes[j].Kind == "main" {
			return false
		}
		return sample.Processes[i].PID < sample.Processes[j].PID
	})
	p.previous, p.sampledAt = next, now
	return sample
}

func (a *App) StartPerformanceStream(intervalMs int) {
	p := &a.performance
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stop != nil {
		return
	}
	interval := time.Duration(max(1000, min(intervalMs, 10000))) * time.Millisecond
	stop, done := make(chan struct{}), make(chan struct{})
	p.stop, p.done = stop, done
	p.previous, p.sampledAt = nil, time.Time{}
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if workspaceWindowMinimised(a.ctx) {
					continue
				}
				p.mu.Lock()
				select {
				case <-stop:
					p.mu.Unlock()
					return
				default:
				}
				sample := p.sample()
				a.emit("perf:sample", sample)
				p.mu.Unlock()
			}
		}
	}()
}

func (a *App) StopPerformanceStream() {
	p := &a.performance
	p.mu.Lock()
	done := p.done
	if p.stop != nil {
		close(p.stop)
		p.stop = nil
	}
	p.previous, p.sampledAt = nil, time.Time{}
	p.mu.Unlock()
	if done != nil {
		<-done
	}
}

package api

import (
	"context"
	"io"
	"os"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"
)

func TestPerformanceSnapshot(t *testing.T) {
	app := NewApp()
	sample := app.PerformanceStatus()
	if sample.MainPID != os.Getpid() {
		t.Fatalf("main PID: %d", sample.MainPID)
	}
	for _, process := range sample.Processes {
		if process.PID == os.Getpid() {
			if !sample.SensorLimited && (process.MemoryBytes == nil || *process.MemoryBytes == 0) {
				t.Fatal("missing resident memory")
			}
			return
		}
	}
	t.Fatal("self missing")
}

func TestPerformanceDeltaAndClassification(t *testing.T) {
	previous := perfProcessSensor
	defer func() { perfProcessSensor = previous }()
	cpu, memory := 1.0, uint64(1024)
	start := time.Now().Add(-time.Hour)
	perfProcessSensor = func() ([]perfRawProcess, bool) {
		value := cpu
		return []perfRawProcess{
			{pid: os.Getpid(), name: "Kurlo", cpuSeconds: &value, memoryBytes: &memory, started: start},
			{pid: 200, parentPID: 1, related: true, name: "com.apple.WebKit.WebContent", cpuSeconds: &value, memoryBytes: &memory, started: start},
			{pid: 300, parentPID: os.Getpid(), name: "node", cpuSeconds: &value, memoryBytes: &memory, started: start},
			{pid: 301, parentPID: 300, name: "worker", cpuSeconds: &value, memoryBytes: &memory, started: start},
			{pid: 400, parentPID: 1, name: "com.apple.WebKit.WebContent", cpuSeconds: &value, memoryBytes: &memory, started: start},
		}, false
	}
	perfTrackProcess(300, "MCP server")
	defer perfForgetProcess(300)
	app := NewApp()
	first := app.PerformanceStatus()
	if first.TotalCPUPercent != nil || len(first.Processes) != 4 {
		t.Fatalf("first: %+v", first)
	}
	app.performance.sampledAt = time.Now().Add(-time.Second)
	cpu += 0.25
	second := app.PerformanceStatus()
	if second.TotalCPUPercent == nil || *second.TotalCPUPercent < 90 {
		t.Fatalf("CPU: %+v", second)
	}
	for _, process := range second.Processes {
		if process.PID == 200 && process.Kind != "webview" {
			t.Fatal("webview kind")
		}
		if process.PID == 300 && process.Role != "MCP server" {
			t.Fatal("child role")
		}
	}
	start = start.Add(time.Minute)
	if app.PerformanceStatus().TotalCPUPercent != nil {
		t.Fatal("reused PID inherited CPU delta")
	}
}

func TestPerformanceStreamLifecycle(t *testing.T) {
	app := NewApp()
	app.StartPerformanceStream(1000)
	done, stop := app.performance.done, app.performance.stop
	app.StartPerformanceStream(1000)
	if app.performance.stop != stop {
		t.Fatal("duplicate stream")
	}
	app.StopPerformanceStream()
	app.StopPerformanceStream()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stream did not stop")
	}
	app.StartPerformanceStream(1000)
	if app.performance.stop == stop {
		t.Fatal("stream did not restart")
	}
	app.StopPerformanceStream()
}

func TestPerformanceUnknownMetrics(t *testing.T) {
	previous := perfProcessSensor
	defer func() { perfProcessSensor = previous }()
	perfProcessSensor = func() ([]perfRawProcess, bool) { return []perfRawProcess{{pid: os.Getpid()}}, true }
	sample := NewApp().PerformanceStatus()
	if sample.TotalCPUPercent != nil || sample.TotalMemoryBytes != nil || !sample.SensorLimited {
		t.Fatal("unknown metrics reported as measured")
	}
}

func TestPerformanceNativeCPUDelta(t *testing.T) {
	app := NewApp()
	first := app.PerformanceStatus()
	if first.SensorLimited {
		t.Skip("native CPU sensor unavailable")
	}
	until := time.Now().Add(30 * time.Millisecond)
	for time.Now().Before(until) {
	}
	second := app.PerformanceStatus()
	for _, process := range second.Processes {
		if process.PID == os.Getpid() && process.CPUPercent != nil && *process.CPUPercent > 0 {
			return
		}
	}
	t.Fatal("native sensor did not measure consumed CPU")
}

func TestPerformanceStreamPausesWhenMinimised(t *testing.T) {
	previousSensor, previousWindow := perfProcessSensor, workspaceWindowMinimised
	defer func() { perfProcessSensor, workspaceWindowMinimised = previousSensor, previousWindow }()
	var calls atomic.Int32
	var minimised atomic.Bool
	minimised.Store(true)
	workspaceWindowMinimised = func(context.Context) bool { return minimised.Load() }
	perfProcessSensor = func() ([]perfRawProcess, bool) { calls.Add(1); return nil, true }
	app := NewApp()
	app.StartPerformanceStream(1000)
	defer app.StopPerformanceStream()
	time.Sleep(1100 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatal("sampled while minimised")
	}
	minimised.Store(false)
	deadline := time.After(2 * time.Second)
	for calls.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("sampling did not resume")
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}
	app.StopPerformanceStream()
	<-app.performance.done
}

func TestPerformanceChildHelper(t *testing.T) {
	if os.Getenv("KURLO_PERFORMANCE_CHILD") != "1" {
		return
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(0)
}

func TestPerformanceNativeChild(t *testing.T) {
	if NewApp().PerformanceStatus().SensorLimited {
		t.Skip("native process sensor unavailable")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestPerformanceChildHelper$")
	cmd.Env = append(os.Environ(), "KURLO_PERFORMANCE_CHILD=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { stdin.Close(); cmd.Wait() }()
	perfTrackProcess(cmd.Process.Pid, "MCP server")
	defer perfForgetProcess(cmd.Process.Pid)
	sample := NewApp().PerformanceStatus()
	for _, process := range sample.Processes {
		if process.PID == cmd.Process.Pid {
			if process.Kind != "child" || process.Role != "MCP server" {
				t.Fatalf("unexpected child: %+v", process)
			}
			return
		}
	}
	t.Fatal("running child missing from native sample")
}

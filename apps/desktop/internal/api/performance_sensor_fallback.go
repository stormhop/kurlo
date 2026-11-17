//go:build (darwin && !cgo) || (!darwin && !linux && !windows)

package api

import "os"

func nativePerformanceProcesses() ([]perfRawProcess, bool) {
	return []perfRawProcess{{pid: os.Getpid(), parentPID: os.Getppid(), name: "Kurlo", started: perfStarted}}, true
}

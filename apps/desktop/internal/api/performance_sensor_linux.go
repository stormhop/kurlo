package api

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func nativePerformanceProcesses() ([]perfRawProcess, bool) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, true
	}
	boot := time.Time{}
	if data, err := os.ReadFile("/proc/stat"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "btime ") {
				seconds, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "btime ")), 10, 64)
				if err == nil {
					boot = time.Unix(seconds, 0)
				}
				break
			}
		}
	}
	processes := []perfRawProcess{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue
		}
		stat := string(data)
		first, last := strings.Index(stat, "("), strings.LastIndex(stat, ")")
		if first < 0 || last < first {
			continue
		}
		fields := strings.Fields(stat[last+1:])
		if len(fields) < 22 {
			continue
		}
		parent, _ := strconv.Atoi(fields[1])
		user, e1 := strconv.ParseFloat(fields[11], 64)
		kernel, e2 := strconv.ParseFloat(fields[12], 64)
		start, e3 := strconv.ParseFloat(fields[19], 64)
		process := perfRawProcess{pid: pid, parentPID: parent, name: stat[first+1 : last]}
		if name, err := os.Readlink(filepath.Join("/proc", entry.Name(), "exe")); err == nil {
			process.name = name
		}
		if e1 == nil && e2 == nil {
			cpu := (user + kernel) / 100
			process.cpuSeconds = &cpu
		}
		if e3 == nil && !boot.IsZero() {
			process.started = boot.Add(time.Duration(start / 100 * 1e9))
		}
		if pages, err := strconv.ParseUint(fields[21], 10, 64); err == nil {
			memory := pages * uint64(os.Getpagesize())
			process.memoryBytes = &memory
		}
		processes = append(processes, process)
	}
	return processes, false
}

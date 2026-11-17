package api

import (
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type perfMemoryCounters struct {
	Size, PageFaultCount                                                                                                                                                   uint32
	PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage uintptr
}

var perfGetMemory = windows.NewLazySystemDLL("psapi.dll").NewProc("GetProcessMemoryInfo")

func nativePerformanceProcesses() ([]perfRawProcess, bool) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, true
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	processes := []perfRawProcess{}
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		process := perfRawProcess{pid: int(entry.ProcessID), parentPID: int(entry.ParentProcessID), name: windows.UTF16ToString(entry.ExeFile[:])}
		handle, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ, false, entry.ProcessID)
		if err != nil {
			handle, err = windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
		}
		if err == nil {
			var created, exited, kernel, user windows.Filetime
			if windows.GetProcessTimes(handle, &created, &exited, &kernel, &user) == nil {
				cpu := float64((uint64(kernel.HighDateTime)<<32|uint64(kernel.LowDateTime))+(uint64(user.HighDateTime)<<32|uint64(user.LowDateTime))) / 1e7
				process.cpuSeconds = &cpu
				process.started = time.Unix(0, created.Nanoseconds())
			}
			counters := perfMemoryCounters{Size: uint32(unsafe.Sizeof(perfMemoryCounters{}))}
			if result, _, _ := perfGetMemory.Call(uintptr(handle), uintptr(unsafe.Pointer(&counters)), uintptr(counters.Size)); result != 0 {
				memory := uint64(counters.WorkingSetSize)
				process.memoryBytes = &memory
			}
			windows.CloseHandle(handle)
		}
		processes = append(processes, process)
	}
	return processes, false
}

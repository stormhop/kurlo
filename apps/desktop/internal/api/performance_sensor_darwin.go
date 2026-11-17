//go:build darwin && cgo

package api

/*
#include <libproc.h>
#include <stdlib.h>
#include <sys/proc_info.h>

#define KURLO_PROC_PIDCOALITIONINFO 20

static uint64_t kurloPerformanceCoalition(int pid) {
 uint64_t info[5] = {0};
 if (proc_pidinfo(pid, KURLO_PROC_PIDCOALITIONINFO, 0, info, sizeof(info)) != sizeof(info)) return 0;
 return info[1];
}
*/
import "C"

import (
	"os"
	"time"
	"unsafe"
)

func nativePerformanceProcesses() ([]perfRawProcess, bool) {
	count := C.proc_listallpids(nil, 0)
	if count <= 0 {
		return nil, true
	}
	pids := make([]C.int, int(count)+256)
	count = C.proc_listallpids(unsafe.Pointer(&pids[0]), C.int(len(pids)*4))
	if count <= 0 {
		return nil, true
	}
	if int(count) > len(pids) {
		count = C.int(len(pids))
	}
	processes := make([]perfRawProcess, 0, int(count))
	coalition := C.kurloPerformanceCoalition(C.int(os.Getpid()))
	for _, pid := range pids[:int(count)] {
		if pid <= 0 {
			continue
		}
		var bsd C.struct_proc_bsdinfo
		if C.proc_pidinfo(pid, C.PROC_PIDTBSDINFO, 0, unsafe.Pointer(&bsd), C.int(unsafe.Sizeof(bsd))) != C.int(unsafe.Sizeof(bsd)) {
			continue
		}
		process := perfRawProcess{pid: int(pid), parentPID: int(bsd.pbi_ppid), name: C.GoString(&bsd.pbi_comm[0]), started: time.Unix(int64(bsd.pbi_start_tvsec), int64(bsd.pbi_start_tvusec)*1000)}
		var path [C.PROC_PIDPATHINFO_MAXSIZE]C.char
		if C.proc_pidpath(pid, unsafe.Pointer(&path[0]), C.uint32_t(len(path))) > 0 {
			process.name = C.GoString(&path[0])
		}
		if coalition != 0 && perfWebview(process.name) {
			process.related = C.kurloPerformanceCoalition(pid) == coalition
		}
		var task C.struct_proc_taskinfo
		if C.proc_pidinfo(pid, C.PROC_PIDTASKINFO, 0, unsafe.Pointer(&task), C.int(unsafe.Sizeof(task))) == C.int(unsafe.Sizeof(task)) {
			cpu := float64(task.pti_total_user+task.pti_total_system) / 1e9
			memory := uint64(task.pti_resident_size)
			process.cpuSeconds, process.memoryBytes = &cpu, &memory
		}
		processes = append(processes, process)
	}
	return processes, false
}

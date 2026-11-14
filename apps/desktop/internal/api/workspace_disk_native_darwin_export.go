//go:build darwin && cgo

package api

/*
#include <stddef.h>
#include <stdint.h>
*/
import "C"

import (
	"runtime/cgo"
	"unsafe"
)

const (
	fsEventMustScanSubDirs = 0x00000001
	fsEventUserDropped     = 0x00000002
	fsEventKernelDropped   = 0x00000004
	fsEventRootChanged     = 0x00000020
)

//export kurloWorkspaceFSEvents
func kurloWorkspaceFSEvents(handle C.uintptr_t, count C.size_t, paths **C.char, flags *C.uint32_t) {
	watch, ok := cgo.Handle(handle).Value().(*darwinWorkspaceWatch)
	if !ok || count == 0 {
		return
	}
	pathList := unsafe.Slice(paths, int(count))
	flagList := unsafe.Slice(flags, int(count))
	for index := range pathList {
		if uint32(flagList[index])&(fsEventMustScanSubDirs|fsEventUserDropped|fsEventKernelDropped|fsEventRootChanged) != 0 || watch.relevant(C.GoString(pathList[index])) {
			watch.notify()
			return
		}
	}
}

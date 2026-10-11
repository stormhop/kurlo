package api

import (
	"os"
	"syscall"
)

func flushFile(f *os.File) error {
	return syscall.Fsync(int(f.Fd()))
}

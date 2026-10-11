//go:build !darwin

package api

import "os"

func flushFile(f *os.File) error {
	return f.Sync()
}

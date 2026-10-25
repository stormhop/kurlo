//go:build darwin

package api

import "golang.org/x/sys/unix"

func exchangePaths(a, b string) error {
	return unix.RenamexNp(a, b, unix.RENAME_SWAP)
}

//go:build !windows

package api

import "os/exec"

func explorerSelectCommand(target string) *exec.Cmd {
	return exec.Command("explorer", "/select,"+target)
}

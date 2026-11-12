//go:build windows

package api

import (
	"os/exec"
	"syscall"
)

func explorerSelectCommand(target string) *exec.Cmd {
	cmd := exec.Command("explorer")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer /select,"` + target + `"`}
	return cmd
}

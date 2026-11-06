//go:build windows

package api

import (
	"os/exec"
	"syscall"
)

func configureMCPStdioProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

func killMCPStdioProcess(cmd *exec.Cmd) {
	_ = killCodexProcess(cmd)
}

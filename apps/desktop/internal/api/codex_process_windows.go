package api

import (
	"context"
	"os/exec"
	"strconv"
	"time"
)

func configureAgentProcess(cmd *exec.Cmd) {
	cmd.Cancel = func() error { return killCodexProcess(cmd) }
}

func killCodexProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	killer := exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
	hideCmdWindow(killer)
	if err := killer.Run(); err != nil {
		return cmd.Process.Kill()
	}
	return nil
}

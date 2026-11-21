//go:build !windows

package secrets

import "os/exec"

func hideWindow(*exec.Cmd) {}

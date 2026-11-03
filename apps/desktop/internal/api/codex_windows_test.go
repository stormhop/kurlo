package api

import (
	"context"
	"testing"
)

func TestCodexCommandsHideTheConsoleWindow(t *testing.T) {
	cmd := codexCommand(context.Background(), "codex.exe", "--version")
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow {
		t.Fatal("Codex commands must not open a console window")
	}
}

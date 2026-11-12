//go:build windows

package api

import (
	"os/exec"
	"strings"
	"testing"
)

func TestExplorerSelectCommandQuotesThePath(t *testing.T) {
	target := `C:\Users\me\Kurlo\Orders API\list orders.yml`
	cmd := explorerSelectCommand(target)
	if !strings.HasSuffix(cmd.SysProcAttr.CmdLine, `/select,"`+target+`"`) {
		t.Fatalf("expected explorer /select with a quoted path, got %q", cmd.SysProcAttr.CmdLine)
	}
}

func TestFileManagerWindowsAreNotStartedHidden(t *testing.T) {
	for _, cmd := range []*exec.Cmd{explorerSelectCommand(`C:\Kurlo\list orders.yml`), fileManagerCommand(`C:\Kurlo`)} {
		if cmd.SysProcAttr != nil && (cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&createNoWindow != 0) {
			t.Fatalf("explorer must open a visible window, got %+v", cmd.SysProcAttr)
		}
	}
}

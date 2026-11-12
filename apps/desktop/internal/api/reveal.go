package api

import (
	"os/exec"
	"path/filepath"
	goruntime "runtime"
)

var revealInFileManager = func(dir string) error {
	return startFileManager(fileManagerCommand(dir))
}

func startFileManager(cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func fileManagerCommand(dir string) *exec.Cmd {
	switch goruntime.GOOS {
	case "darwin":
		return exec.Command("open", dir)
	case "windows":
		return exec.Command("explorer", filepath.FromSlash(dir))
	default:
		return exec.Command("xdg-open", dir)
	}
}

package secrets

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const maxToolOutputBytes = 1 << 20

type limitedBuffer struct {
	bytes.Buffer
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if remaining := maxToolOutputBytes - b.Len(); remaining > 0 {
		if len(p) > remaining {
			b.Buffer.Write(p[:remaining])
		} else {
			b.Buffer.Write(p)
		}
	}
	return len(p), nil
}

func systemRun(ctx context.Context, path string, args []string, env []string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdin = nil
	var stdout, stderr limitedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	hideWindow(cmd)
	err := cmd.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

func toolCandidates(name string) []string {
	if runtime.GOOS == "windows" {
		var out []string
		for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("LOCALAPPDATA")} {
			if base == "" {
				continue
			}
			switch name {
			case "op":
				out = append(out, filepath.Join(base, "1Password CLI", "op.exe"), filepath.Join(base, "Microsoft", "WinGet", "Links", "op.exe"))
			case "aws":
				out = append(out, filepath.Join(base, "Amazon", "AWSCLIV2", "aws.exe"))
			}
		}
		return out
	}
	return []string{"/opt/homebrew/bin/" + name, "/usr/local/bin/" + name, "/usr/bin/" + name, "/snap/bin/" + name}
}

func systemLookPath(name string) (string, error) {
	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}
	for _, candidate := range toolCandidates(name) {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", errors.New(name + " not found")
}

func toolMessage(stderr []byte, err error) string {
	text := strings.TrimSpace(string(stderr))
	if text == "" && err != nil {
		text = err.Error()
	}
	text = strings.TrimPrefix(text, "[ERROR] ")
	if index := strings.Index(text, "[ERROR] "); index >= 0 {
		text = text[index+len("[ERROR] "):]
	}
	if len(text) > 300 {
		text = text[:300] + "…"
	}
	return strings.Join(strings.Fields(text), " ")
}

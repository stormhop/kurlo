package secrets

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
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

type spawnedProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	once   sync.Once
}

func (p *spawnedProcess) Read(buf []byte) (int, error)  { return p.stdout.Read(buf) }
func (p *spawnedProcess) Write(buf []byte) (int, error) { return p.stdin.Write(buf) }

func (p *spawnedProcess) Close() error {
	p.once.Do(func() {
		_ = p.stdin.Close()
		done := make(chan struct{})
		go func() {
			_ = p.cmd.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			_ = p.cmd.Process.Kill()
			<-done
		}
	})
	return nil
}

func systemSpawn(ctx context.Context, path string, args []string) (io.ReadWriteCloser, error) {
	cmd := exec.Command(path, args...)
	cmd.Stderr = io.Discard
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	process := &spawnedProcess{cmd: cmd, stdin: stdin, stdout: stdout}
	if ctx.Err() != nil {
		_ = process.Close()
		return nil, ctx.Err()
	}
	return process, nil
}

func toolCandidates(name string) []string {
	return toolCandidatesFor(runtime.GOOS, os.Getenv, name)
}

func toolCandidatesFor(goos string, getenv func(string) string, name string) []string {
	if goos != "windows" {
		out := []string{"/opt/homebrew/bin/" + name, "/usr/local/bin/" + name, "/usr/bin/" + name, "/snap/bin/" + name}
		if name == keepassxcProxy {
			out = append(out, "/Applications/KeePassXC.app/Contents/MacOS/keepassxc-proxy", "/snap/bin/keepassxc.proxy")
		}
		return out
	}
	var out []string
	for _, base := range []string{getenv("ProgramFiles"), getenv("ProgramFiles(x86)"), getenv("LOCALAPPDATA")} {
		if base == "" {
			continue
		}
		out = append(out, filepath.Join(base, "Microsoft", "WinGet", "Links", name+".exe"))
		switch name {
		case "op":
			out = append(out, filepath.Join(base, "1Password CLI", "op.exe"))
		case "aws":
			out = append(out, filepath.Join(base, "Amazon", "AWSCLIV2", "aws.exe"))
		case "az":
			out = append(out, filepath.Join(base, "Microsoft SDKs", "Azure", "CLI2", "wbin", "az.cmd"))
		case keepassxcProxy:
			out = append(out, filepath.Join(base, "KeePassXC", "keepassxc-proxy.exe"))
		case "gcloud":
			out = append(out, filepath.Join(base, "Google", "Cloud SDK", "google-cloud-sdk", "bin", "gcloud.cmd"))
		}
	}
	return out
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

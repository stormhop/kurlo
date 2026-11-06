//go:build darwin || linux

package api

import (
	"bufio"
	"context"
	"io"
	"testing"
	"time"
)

func TestCodexLifecycleClosesDescendantsWithInheritedPipes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := codexCommand(ctx, "/bin/sh", "-c", "sleep 30 & echo ready; wait")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(stdout)
	if line, err := reader.ReadString('\n'); err != nil || line != "ready\n" {
		t.Fatalf("ready=%q %v", line, err)
	}
	cancel()
	done := make(chan error, 1)
	go func() { _, err := reader.ReadByte(); done <- err }()
	select {
	case err := <-done:
		if err != io.EOF {
			t.Fatalf("pipe: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a descendant kept the CLI pipe open")
	}
	_ = cmd.Wait()
}

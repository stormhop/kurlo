package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	mcpStdioProtocolVersion = "2025-06-18"
	mcpStdioMaxLine         = 16 * 1024 * 1024
	mcpStdioStderrBytes     = 4096
)

type mcpStdioMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type mcpStdioClient struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int64
	pending map[string]chan mcpStdioMessage
	done    chan struct{}
	err     error
	stderr  []byte
}

func startMCPStdio(ctx context.Context, command string, args []string, env []string) (*mcpStdioClient, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil, errors.New("enter the command that starts the MCP server")
	}
	cmd := exec.Command(command, args...)
	cmd.Env = append(os.Environ(), env...)
	configureMCPStdioProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("could not start %s: %v", command, err)
	}
	client := &mcpStdioClient{cmd: cmd, stdin: stdin, pending: map[string]chan mcpStdioMessage{}, done: make(chan struct{})}
	go client.readErrors(stderr)
	go client.read(stdout)
	go func() {
		err := cmd.Wait()
		client.finish(err)
	}()
	initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, err = client.request(initCtx, "initialize", map[string]any{
		"protocolVersion": mcpStdioProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "Kurlo agent", "version": appVersion},
	})
	if err != nil {
		client.close()
		return nil, err
	}
	if err := client.notify("notifications/initialized", nil); err != nil {
		client.close()
		return nil, err
	}
	return client, nil
}

func (c *mcpStdioClient) readErrors(stderr io.Reader) {
	buf := make([]byte, 1024)
	for {
		n, err := stderr.Read(buf)
		if n > 0 {
			c.mu.Lock()
			c.stderr = append(c.stderr, buf[:n]...)
			if len(c.stderr) > mcpStdioStderrBytes {
				c.stderr = c.stderr[len(c.stderr)-mcpStdioStderrBytes:]
			}
			c.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (c *mcpStdioClient) read(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), mcpStdioMaxLine)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var message mcpStdioMessage
		if json.Unmarshal([]byte(line), &message) != nil {
			continue
		}
		if message.Method != "" {
			if len(message.ID) > 0 {
				_ = c.send(map[string]any{"jsonrpc": "2.0", "id": message.ID, "error": map[string]any{"code": -32601, "message": "Kurlo does not support " + message.Method}})
			}
			continue
		}
		c.mu.Lock()
		waiter := c.pending[string(message.ID)]
		delete(c.pending, string(message.ID))
		c.mu.Unlock()
		if waiter != nil {
			waiter <- message
		}
	}
	if err := scanner.Err(); err != nil {
		c.finish(err)
	}
}

func (c *mcpStdioClient) finish(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.done:
		return
	default:
	}
	if err == nil {
		err = errors.New("the MCP server exited")
	}
	if tail := strings.TrimSpace(string(c.stderr)); tail != "" {
		err = fmt.Errorf("%v: %s", err, tail)
	}
	c.err = err
	close(c.done)
}

func (c *mcpStdioClient) send(message any) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.stdin.Write(append(data, '\n'))
	return err
}

func (c *mcpStdioClient) notify(method string, params any) error {
	message := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		message["params"] = params
	}
	return c.send(message)
}

func (c *mcpStdioClient) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	select {
	case <-c.done:
		err := c.err
		c.mu.Unlock()
		return nil, err
	default:
	}
	c.nextID++
	id := fmt.Sprintf("%d", c.nextID)
	waiter := make(chan mcpStdioMessage, 1)
	c.pending[id] = waiter
	c.mu.Unlock()
	message := map[string]any{"jsonrpc": "2.0", "id": c.nextID, "method": method}
	if params != nil {
		message["params"] = params
	}
	if err := c.send(message); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}
	select {
	case reply := <-waiter:
		if reply.Error != nil {
			return nil, fmt.Errorf("%s (code %d)", reply.Error.Message, reply.Error.Code)
		}
		return reply.Result, nil
	case <-c.done:
		c.mu.Lock()
		err := c.err
		c.mu.Unlock()
		return nil, err
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		_ = c.notify("notifications/cancelled", map[string]any{"requestId": c.nextID, "reason": "cancelled"})
		return nil, ctx.Err()
	}
}

func (c *mcpStdioClient) alive() bool {
	select {
	case <-c.done:
		return false
	default:
		return true
	}
}

func (c *mcpStdioClient) close() {
	_ = c.stdin.Close()
	select {
	case <-c.done:
	case <-time.After(2 * time.Second):
		if c.cmd.Process != nil {
			killMCPStdioProcess(c.cmd)
		}
	}
}

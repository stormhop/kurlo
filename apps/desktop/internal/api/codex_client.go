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
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type codexMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type codexClient struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	mu      sync.Mutex
	writeMu sync.Mutex
	seq     uint64
	pending map[string]chan codexMessage
	events  chan codexMessage
	done    chan struct{}
	exited  chan struct{}
	err     error
	once    sync.Once
}

func codexExecutable(path string) (string, error) {
	path, err := expandUserPath(strings.TrimSpace(path))
	if err != nil {
		return "", err
	}
	auto := path == ""
	if auto {
		path = "codex"
	}
	resolved, err := exec.LookPath(path)
	if err != nil && auto {
		home, _ := os.UserHomeDir()
		for _, candidate := range []string{
			filepath.Join(home, ".local", "bin", "codex"),
			"/opt/homebrew/bin/codex", "/usr/local/bin/codex",
			"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
			"/Applications/Codex.app/Contents/Resources/codex",
		} {
			if resolved, err = exec.LookPath(candidate); err == nil {
				break
			}
		}
	}
	if err != nil {
		return "", errors.New("Codex CLI was not found. Install it or choose its executable.")
	}
	if ext := strings.ToLower(filepath.Ext(resolved)); ext == ".cmd" || ext == ".ps1" || ext == ".bat" {
		root := filepath.Join(filepath.Dir(resolved), "node_modules", "@openai", "codex")
		for _, pattern := range []string{
			filepath.Join(root, "vendor", "*", "codex", "codex.exe"),
			filepath.Join(root, "node_modules", "@openai", "codex-win32-*", "vendor", "*", "codex", "codex.exe"),
			filepath.Join(filepath.Dir(resolved), "node_modules", "@openai", "codex-win32-*", "vendor", "*", "codex", "codex.exe"),
		} {
			matches, _ := filepath.Glob(pattern)
			for _, candidate := range matches {
				if native, nativeErr := exec.LookPath(candidate); nativeErr == nil {
					return filepath.Abs(native)
				}
			}
		}
		return "", errors.New("Choose the native codex.exe executable from your Codex installation instead of its shell wrapper.")
	}
	return filepath.Abs(resolved)
}

func codexConfig() map[string]any {
	config := map[string]any{
		"sandbox_mode": "read-only", "approval_policy": "never", "web_search": "disabled",
		"agents.enabled": false, "notify": []string{}, "developer_instructions": "", "project_doc_max_bytes": 0, "mcp_servers": map[string]any{}, "plugins": map[string]any{},
	}
	for _, feature := range []string{"shell_tool", "unified_exec", "hooks", "apps", "browser_use", "computer_use", "multi_agent", "multi_agent_v2", "remote_plugin", "image_generation", "code_mode", "workspace_dependencies", "skill_mcp_dependency_install", "js_repl", "artifact", "view_image", "imagegenext"} {
		config["features."+feature] = false
	}
	return config
}

func startCodexClient(ctx context.Context, path string) (*codexClient, error) {
	resolved, err := codexExecutable(path)
	if err != nil {
		return nil, err
	}
	args := []string{"app-server"}
	for key, value := range codexConfig() {
		encoded, _ := json.Marshal(value)
		if _, ok := value.(map[string]any); ok {
			encoded = []byte("{}")
		}
		args = append(args, "-c", key+"="+string(encoded))
	}
	cmd := codexCommand(ctx, resolved, args...)
	cmd.Dir = os.TempDir()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("Could not start Codex: %w", err)
	}
	c := &codexClient{cmd: cmd, stdin: stdin, pending: map[string]chan codexMessage{}, events: make(chan codexMessage, 512), done: make(chan struct{}), exited: make(chan struct{})}
	go c.read(stdout)
	go func() {
		err := cmd.Wait()
		if err == nil {
			err = errors.New("Codex exited. Check its installation and reconnect.")
		}
		c.fail(err)
		close(c.exited)
	}()
	var initialized json.RawMessage
	if err := c.call(ctx, "initialize", map[string]any{"clientInfo": map[string]any{"name": "kurlo", "title": "Kurlo", "version": appVersion}, "capabilities": map[string]any{"experimentalApi": true}}, &initialized); err != nil {
		c.close()
		return nil, fmt.Errorf("Codex app-server could not initialize: %w", err)
	}
	if err := c.write(map[string]any{"method": "initialized"}); err != nil {
		c.close()
		return nil, err
	}
	return c, nil
}

func (c *codexClient) fail(err error) {
	c.once.Do(func() {
		c.mu.Lock()
		c.err = err
		c.mu.Unlock()
		close(c.done)
	})
}

func (c *codexClient) read(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var message codexMessage
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			c.fail(errors.New("Codex sent an invalid protocol message."))
			return
		}
		if message.Method == "" && len(message.ID) > 0 {
			c.mu.Lock()
			pending := c.pending[string(message.ID)]
			c.mu.Unlock()
			if pending != nil {
				select {
				case pending <- message:
				case <-c.done:
					return
				default:
					c.fail(errors.New("Codex sent a duplicate response."))
					return
				}
			}
			continue
		}
		select {
		case c.events <- message:
		case <-c.done:
			return
		default:
			c.fail(errors.New("Codex produced too many pending events. Stop and retry the turn."))
			return
		}
	}
	err := scanner.Err()
	if err == nil {
		err = errors.New("Codex closed its connection. Reconnect and try again.")
	}
	c.fail(err)
}

func (c *codexClient) write(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.stdin.Write(append(data, '\n'))
	return err
}

func (c *codexClient) call(ctx context.Context, method string, params, target any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c.mu.Lock()
	c.seq++
	id := c.seq
	key := fmt.Sprint(id)
	response := make(chan codexMessage, 1)
	c.pending[key] = response
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, key)
		c.mu.Unlock()
	}()
	if err := c.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return err
	}
	select {
	case message := <-response:
		if message.Error != nil {
			return fmt.Errorf("%s: %s", method, message.Error.Message)
		}
		if target != nil {
			return json.Unmarshal(message.Result, target)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.err
	}
}

func (c *codexClient) reply(id json.RawMessage, result any) error {
	return c.write(map[string]any{"id": id, "result": result})
}

func (c *codexClient) close() {
	_ = c.stdin.Close()
	_ = killCodexProcess(c.cmd)
	<-c.exited
}

func codexCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, executable, args...)
	hideCmdWindow(cmd)
	configureAgentProcess(cmd)
	return cmd
}

package api

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type fakeMCPInstallHost struct {
	*mcpInstallHost
	calls []string
	env   map[string]string
	paths map[string]string
	added bool
}

func newFakeMCPInstallHost(t *testing.T, goos string) *fakeMCPInstallHost {
	t.Helper()
	home := t.TempDir()
	fake := &fakeMCPInstallHost{env: map[string]string{}, paths: map[string]string{}}
	fake.mcpInstallHost = &mcpInstallHost{
		home:       home,
		cwd:        t.TempDir(),
		goos:       goos,
		executable: "/Applications/Kurlo.app/Contents/MacOS/kurlo",
		getenv:     func(key string) string { return fake.env[key] },
		lookPath: func(name string) (string, error) {
			if path, ok := fake.paths[name]; ok {
				return path, nil
			}
			return "", errors.New("not found")
		},
		run: func(name string, args ...string) (string, error) {
			fake.calls = append(fake.calls, name+" "+strings.Join(args, " "))
			if len(args) > 1 && args[1] == "remove" && !fake.added {
				return "No user-scoped MCP server found", errors.New("exit status 1")
			}
			if len(args) > 1 && args[1] == "add" {
				fake.added = true
			}
			if len(args) > 1 && args[1] == "remove" {
				fake.added = false
			}
			return "", nil
		},
	}
	return fake
}

func (f *fakeMCPInstallHost) mkdir(t *testing.T, elems ...string) string {
	t.Helper()
	dir := filepath.Join(append([]string{f.home}, elems...)...)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func runInstallForTest(t *testing.T, host *fakeMCPInstallHost, args []string, remove bool) (string, int) {
	t.Helper()
	opts, err := parseMCPInstallArgs(args, remove, io.Discard)
	if err != nil {
		t.Fatalf("parse %v: %v", args, err)
	}
	var out bytes.Buffer
	code := runMCPInstall(opts, host.mcpInstallHost, &out)
	return out.String(), code
}

func readTestFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestMCPInstallSetsUpEveryClientItFinds(t *testing.T) {
	host := newFakeMCPInstallHost(t, "darwin")
	host.paths["claude"] = "/usr/local/bin/claude"
	cursorDir := host.mkdir(t, ".cursor")
	desktopDir := host.mkdir(t, "Library", "Application Support", "Claude")
	codexDir := host.mkdir(t, ".codex")
	vscodeDir := host.mkdir(t, "Library", "Application Support", "Code", "User")

	desktopConfig := "{\n    \"globalShortcut\": \"Alt+Space\",\n    \"mcpServers\": {\n        \"other\": {\n            \"command\": \"other-server\"\n        }\n    },\n    \"zeta\": true\n}\n"
	if err := os.WriteFile(filepath.Join(desktopDir, "claude_desktop_config.json"), []byte(desktopConfig), 0o644); err != nil {
		t.Fatal(err)
	}
	codexConfig := "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other\"\n\n[profiles.fast]\nmodel = \"mini\"\n"
	if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), []byte(codexConfig), 0o644); err != nil {
		t.Fatal(err)
	}

	out, code := runInstallForTest(t, host, []string{"--env", "Local"}, false)
	if code != 0 {
		t.Fatalf("install failed (%d):\n%s", code, out)
	}
	for _, label := range []string{"Claude Code", "Claude Desktop", "Codex", "Cursor", "VS Code"} {
		if !strings.Contains(out, label) {
			t.Errorf("summary is missing %s:\n%s", label, out)
		}
	}
	if strings.Contains(out, "Windsurf") || strings.Contains(out, "Gemini") {
		t.Errorf("clients that are not installed should not be listed:\n%s", out)
	}

	self := "/Applications/Kurlo.app/Contents/MacOS/kurlo"
	if len(host.calls) != 2 || host.calls[1] != "/usr/local/bin/claude mcp add --scope user kurlo -- "+self+" mcp --env Local" {
		t.Fatalf("claude calls = %q", host.calls)
	}

	cursor := readTestFile(t, filepath.Join(cursorDir, "mcp.json"))
	if !strings.Contains(cursor, `"type": "stdio"`) || !strings.Contains(cursor, `"command": "`+self+`"`) || !strings.Contains(cursor, `"--env",`) {
		t.Errorf("cursor config:\n%s", cursor)
	}
	vscode := readTestFile(t, filepath.Join(vscodeDir, "mcp.json"))
	if !strings.Contains(vscode, `"servers": {`) || strings.Contains(vscode, "mcpServers") {
		t.Errorf("VS Code uses servers:\n%s", vscode)
	}

	desktop := readTestFile(t, filepath.Join(desktopDir, "claude_desktop_config.json"))
	if strings.Contains(desktop, `"type"`) {
		t.Errorf("Claude Desktop entries carry no type:\n%s", desktop)
	}
	if !strings.HasPrefix(desktop, "{\n    \"globalShortcut\": \"Alt+Space\",\n    \"mcpServers\": {\n        \"other\": {") || !strings.HasSuffix(desktop, "    \"zeta\": true\n}\n") {
		t.Errorf("other settings, their order and the 4-space indent should stay:\n%s", desktop)
	}
	if !strings.Contains(out, "restart Claude Desktop") {
		t.Errorf("Claude Desktop needs a restart notice:\n%s", out)
	}

	codex := readTestFile(t, filepath.Join(codexDir, "config.toml"))
	if !strings.HasPrefix(codex, codexConfig) || !strings.HasSuffix(codex, "\n\n[mcp_servers.kurlo]\ncommand = \""+self+"\"\nargs = [\"mcp\", \"--env\", \"Local\"]\n") {
		t.Errorf("codex config:\n%s", codex)
	}

	out, code = runInstallForTest(t, host, []string{"--env", "Local"}, false)
	if code != 0 || strings.Count(out, "already set up") != 4 {
		t.Fatalf("a second run should change nothing in the files:\n%s", out)
	}
	if after := readTestFile(t, filepath.Join(codexDir, "config.toml")); after != codex {
		t.Errorf("codex config changed on a repeat run:\n%s", after)
	}

	out, _ = runInstallForTest(t, host, []string{"cursor", "codex", "--env", "Staging", "--read-only"}, false)
	if strings.Count(out, "updated") != 2 {
		t.Fatalf("changed flags should update the entries:\n%s", out)
	}
	codex = readTestFile(t, filepath.Join(codexDir, "config.toml"))
	if strings.Count(codex, "[mcp_servers.kurlo]") != 1 || !strings.Contains(codex, `"Staging", "--read-only"]`) || !strings.Contains(codex, "[profiles.fast]") {
		t.Errorf("codex update:\n%s", codex)
	}

	out, code = runInstallForTest(t, host, nil, true)
	if code != 0 || strings.Count(out, "removed") != 5 {
		t.Fatalf("uninstall:\n%s", out)
	}
	desktop = readTestFile(t, filepath.Join(desktopDir, "claude_desktop_config.json"))
	if desktop != desktopConfig {
		t.Errorf("uninstall should leave the original config:\n%s", desktop)
	}
	if codex := readTestFile(t, filepath.Join(codexDir, "config.toml")); codex != codexConfig {
		t.Errorf("codex after uninstall:\n%q\nwant\n%q", codex, codexConfig)
	}
}

func TestMCPInstallEditsClaudeJSONWhenThereIsNoClaudeCommand(t *testing.T) {
	host := newFakeMCPInstallHost(t, "darwin")
	path := filepath.Join(host.home, ".claude.json")
	original := "{\n  \"numStartups\": 12,\n  \"oauthAccount\": {\n    \"emailAddress\": \"a@b.test\"\n  },\n  \"projects\": {\n    \"/repo\": {\n      \"mcpServers\": {}\n    }\n  },\n  \"tipsHistory\": {},\n  \"ratio\": 1.50\n}\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	out, code := runInstallForTest(t, host, nil, false)
	if code != 0 || !strings.Contains(out, "Claude Code") || !strings.Contains(out, "restart Claude Code") {
		t.Fatalf("install (%d):\n%s", code, out)
	}
	got := readTestFile(t, path)
	want := strings.TrimSuffix(original, "\n}\n") + ",\n  \"mcpServers\": {\n    \"kurlo\": {\n      \"type\": \"stdio\",\n      \"command\": \"" + host.executable + "\",\n      \"args\": [\n        \"mcp\"\n      ]\n    }\n  }\n}\n"
	if got != want {
		t.Fatalf("only a top-level mcpServers should be added:\n%s\nwant\n%s", got, want)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("a private config must stay private, mode is %v", info.Mode().Perm())
	}
	if out, _ := runInstallForTest(t, host, nil, true); !strings.Contains(out, "removed") || readTestFile(t, path) != original {
		t.Fatalf("uninstall should restore the file:\n%s\n%s", out, readTestFile(t, path))
	}
}

func TestMCPInstallLeavesFilesItCannotParse(t *testing.T) {
	host := newFakeMCPInstallHost(t, "linux")
	dir := host.mkdir(t, ".config", "Code", "User")
	jsonc := "{\n  // my servers\n  \"servers\": {}\n}\n"
	path := filepath.Join(dir, "mcp.json")
	if err := os.WriteFile(path, []byte(jsonc), 0o644); err != nil {
		t.Fatal(err)
	}
	out, code := runInstallForTest(t, host, []string{"vscode"}, false)
	if code == 0 || !strings.Contains(out, "by hand") || !strings.Contains(out, `"command"`) {
		t.Fatalf("a file with comments should be reported with a snippet (%d):\n%s", code, out)
	}
	if readTestFile(t, path) != jsonc {
		t.Fatal("the file was changed")
	}
}

func TestMCPInstallDryRunChangesNothing(t *testing.T) {
	host := newFakeMCPInstallHost(t, "linux")
	host.paths["claude"] = "/usr/bin/claude"
	host.mkdir(t, ".gemini")
	out, code := runInstallForTest(t, host, []string{"--dry-run"}, false)
	if code != 0 || !strings.Contains(out, "would be added") || !strings.Contains(out, "would run") {
		t.Fatalf("dry run:\n%s", out)
	}
	if len(host.calls) != 0 {
		t.Fatalf("dry run ran %q", host.calls)
	}
	if _, err := os.Stat(filepath.Join(host.home, ".gemini", "settings.json")); !os.IsNotExist(err) {
		t.Fatal("dry run wrote a file")
	}
}

func TestMCPInstallProjectWritesSharedConfigWithNpx(t *testing.T) {
	host := newFakeMCPInstallHost(t, "darwin")
	writeWorkspace := func(dir string) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "kurlo.yml"), []byte("version: 1\nformat: kurlo.workspace.yaml.v1\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeWorkspace(filepath.Join(host.cwd, "api-tests"))
	if err := os.MkdirAll(filepath.Join(host.cwd, ".cursor"), 0o755); err != nil {
		t.Fatal(err)
	}

	out, code := runInstallForTest(t, host, []string{"--project", "--env", "Local"}, false)
	if code != 0 {
		t.Fatalf("project install (%d):\n%s", code, out)
	}
	shared := readTestFile(t, filepath.Join(host.cwd, ".mcp.json"))
	if !strings.Contains(shared, `"command": "npx"`) || !strings.Contains(shared, `"@kurlo/cli"`) || !strings.Contains(shared, `"api-tests"`) || strings.Contains(shared, host.cwd) {
		t.Errorf(".mcp.json should be portable:\n%s", shared)
	}
	if !strings.Contains(out, "Claude Code, VS Code") {
		t.Errorf("summary should say who reads .mcp.json:\n%s", out)
	}
	cursor := readTestFile(t, filepath.Join(host.cwd, ".cursor", "mcp.json"))
	if !strings.Contains(cursor, `"${workspaceFolder}/api-tests"`) {
		t.Errorf("cursor project config:\n%s", cursor)
	}

	writeWorkspace(filepath.Join(host.cwd, "more"))
	if out, code := runInstallForTest(t, host, []string{"--project"}, false); code == 0 || !strings.Contains(out, "--workspace") {
		t.Fatalf("two workspaces should ask for --workspace:\n%s", out)
	}
	if out, _ := runInstallForTest(t, host, []string{"--project", "codex", "--workspace", "api-tests"}, false); !strings.Contains(out, "has no project config") {
		t.Fatalf("codex has no project config here:\n%s", out)
	}
}

func TestMCPInstallLauncher(t *testing.T) {
	host := newFakeMCPInstallHost(t, "linux")
	launch := func(opts mcpInstallOptions) mcpLaunch {
		t.Helper()
		got, err := mcpInstallLaunch(opts, host.mcpInstallHost)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := launch(mcpInstallOptions{}); got.command != host.executable {
		t.Errorf("an installed Kurlo should start itself: %+v", got)
	}
	host.executable = "/home/me/.npm/_npx/abc/node_modules/@kurlo/linux-x64/bin/kurlo"
	if got := launch(mcpInstallOptions{readOnly: true}); got.command != "npx" || strings.Join(got.args, " ") != "-y @kurlo/cli mcp --read-only" {
		t.Errorf("a Kurlo run through npx should be started through npx: %+v", got)
	}
	app := filepath.Join(t.TempDir(), "kurlo")
	if err := os.WriteFile(app, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	host.apps = []string{filepath.Join(t.TempDir(), "missing"), app}
	if got := launch(mcpInstallOptions{}); got.command != app {
		t.Errorf("an installed app beats npx, which GUI clients often cannot find: %+v", got)
	}
	if err := os.WriteFile(filepath.Join(host.cwd, "kurlo.yml"), []byte("version: 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := launch(mcpInstallOptions{project: true}); got.command != "npx" {
		t.Errorf("project config stays portable: %+v", got)
	}
	host.apps = nil
	host.env["APPIMAGE"] = "/home/me/Apps/Kurlo.AppImage"
	if got := launch(mcpInstallOptions{}); got.command != "/home/me/Apps/Kurlo.AppImage" {
		t.Errorf("an AppImage should be started by its file, not its mount: %+v", got)
	}
	if got := launch(mcpInstallOptions{command: "npx"}); got.command != "npx" {
		t.Errorf("--command npx: %+v", got)
	}
}

func TestParseMCPInstallArgs(t *testing.T) {
	opts, err := parseMCPInstallArgs([]string{"cursor", "--env", "Local", "Codex"}, false, io.Discard)
	if err != nil || strings.Join(opts.clients, ",") != "cursor,codex" || opts.env != "Local" || opts.name != "kurlo" {
		t.Fatalf("opts = %+v, %v", opts, err)
	}
	if _, err := parseMCPInstallArgs([]string{"notepad"}, false, io.Discard); err == nil {
		t.Fatal("an unknown client should be refused")
	}
	if _, err := parseMCPInstallArgs([]string{"--name", "kurlo prod"}, false, io.Discard); err == nil {
		t.Fatal("a name with a space should be refused")
	}
}

func TestMCPServerResolvesARelativeWorkspaceAgainstTheClaudeProject(t *testing.T) {
	t.Setenv("CLAUDE_PROJECT_DIR", "/repo")
	opts, err := parseMCPServerArgs([]string{"api-tests", "--env", "Local"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if opts.workspace != filepath.Join("/repo", "api-tests") {
		t.Fatalf("workspace = %q", opts.workspace)
	}
}

func TestMCPServerInstructionsFitClaudeCodeLimit(t *testing.T) {
	server := newMCPServer(mcpServerOptions{workspace: "/ws", env: "Local"}, io.Discard)
	if n := len(server.instructions()); n > 4096 {
		t.Fatalf("instructions are %d characters; Claude Code cuts them at 4096", n)
	}
}

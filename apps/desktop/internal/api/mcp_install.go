package api

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"text/tabwriter"
)

const mcpNpmPackage = "@kurlo/cli"

type mcpInstallOptions struct {
	clients   []string
	project   bool
	workspace string
	env       string
	name      string
	command   string
	readOnly  bool
	dryRun    bool
	remove    bool
}

type mcpInstallHost struct {
	home       string
	cwd        string
	goos       string
	executable string
	apps       []string
	getenv     func(string) string
	lookPath   func(string) (string, error)
	run        func(name string, args ...string) (string, error)
}

type mcpLaunch struct {
	command string
	args    []string
}

type mcpInstallClient struct {
	id       string
	label    string
	kind     string
	key      string
	typed    bool
	restart  bool
	userPath func(h *mcpInstallHost) string
	detect   func(h *mcpInstallHost) bool
	project  string
}

type mcpInstallResult struct {
	label  string
	status string
	detail string
	failed bool
}

var mcpServerNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func mcpInstallClients() []mcpInstallClient {
	exists := func(path string) bool {
		_, err := os.Stat(path)
		return err == nil
	}
	configDir := func(h *mcpInstallHost) string {
		switch h.goos {
		case "darwin":
			return filepath.Join(h.home, "Library", "Application Support")
		case "windows":
			if dir := h.getenv("APPDATA"); dir != "" {
				return dir
			}
			return filepath.Join(h.home, "AppData", "Roaming")
		default:
			if dir := h.getenv("XDG_CONFIG_HOME"); dir != "" {
				return dir
			}
			return filepath.Join(h.home, ".config")
		}
	}
	codexHome := func(h *mcpInstallHost) string {
		if dir := h.getenv("CODEX_HOME"); dir != "" {
			return dir
		}
		return filepath.Join(h.home, ".codex")
	}
	onPath := func(name string) func(h *mcpInstallHost) bool {
		return func(h *mcpInstallHost) bool {
			_, err := h.lookPath(name)
			return err == nil
		}
	}
	dirOf := func(path func(h *mcpInstallHost) string) func(h *mcpInstallHost) bool {
		return func(h *mcpInstallHost) bool { return exists(filepath.Dir(path(h))) }
	}

	claudeCode := func(h *mcpInstallHost) string { return filepath.Join(h.home, ".claude.json") }
	claudeDesktop := func(h *mcpInstallHost) string {
		return filepath.Join(configDir(h), "Claude", "claude_desktop_config.json")
	}
	codex := func(h *mcpInstallHost) string { return filepath.Join(codexHome(h), "config.toml") }
	cursor := func(h *mcpInstallHost) string { return filepath.Join(h.home, ".cursor", "mcp.json") }
	vscode := func(h *mcpInstallHost) string { return filepath.Join(configDir(h), "Code", "User", "mcp.json") }
	windsurf := func(h *mcpInstallHost) string {
		return filepath.Join(h.home, ".codeium", "windsurf", "mcp_config.json")
	}
	gemini := func(h *mcpInstallHost) string { return filepath.Join(h.home, ".gemini", "settings.json") }

	return []mcpInstallClient{
		{id: "claude-code", label: "Claude Code", kind: "claude-cli", key: "mcpServers", typed: true, restart: true, userPath: claudeCode, detect: func(h *mcpInstallHost) bool { return onPath("claude")(h) || exists(claudeCode(h)) }, project: ".mcp.json"},
		{id: "claude-desktop", label: "Claude Desktop", kind: "json", key: "mcpServers", restart: true, userPath: claudeDesktop, detect: dirOf(claudeDesktop)},
		{id: "codex", label: "Codex", kind: "toml", userPath: codex, detect: func(h *mcpInstallHost) bool { return exists(codexHome(h)) || onPath("codex")(h) }},
		{id: "cursor", label: "Cursor", kind: "json", key: "mcpServers", typed: true, userPath: cursor, detect: dirOf(cursor), project: filepath.Join(".cursor", "mcp.json")},
		{id: "vscode", label: "VS Code", kind: "json", key: "servers", typed: true, userPath: vscode, detect: dirOf(vscode), project: ".mcp.json"},
		{id: "windsurf", label: "Windsurf", kind: "json", key: "mcpServers", restart: true, userPath: windsurf, detect: dirOf(windsurf)},
		{id: "gemini", label: "Gemini CLI", kind: "json", key: "mcpServers", userPath: gemini, detect: dirOf(gemini)},
	}
}

func RunMCPInstall(args []string, remove bool) int {
	opts, err := parseMCPInstallArgs(args, remove, os.Stderr)
	if err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		fmt.Fprintln(os.Stderr, "kurlo mcp:", err)
		return 2
	}
	home, _ := os.UserHomeDir()
	cwd, _ := os.Getwd()
	executable, _ := os.Executable()
	host := &mcpInstallHost{
		home:       home,
		cwd:        cwd,
		goos:       runtime.GOOS,
		executable: executable,
		apps:       mcpInstalledAppCandidates(home),
		getenv:     os.Getenv,
		lookPath:   exec.LookPath,
		run: func(name string, args ...string) (string, error) {
			out, err := exec.Command(name, args...).CombinedOutput()
			return strings.TrimSpace(string(out)), err
		},
	}
	return runMCPInstall(opts, host, os.Stdout)
}

func parseMCPInstallArgs(args []string, remove bool, stderr io.Writer) (mcpInstallOptions, error) {
	verb := "install"
	if remove {
		verb = "uninstall"
	}
	fs := flag.NewFlagSet("kurlo mcp "+verb, flag.ContinueOnError)
	fs.SetOutput(stderr)
	opts := mcpInstallOptions{remove: remove}
	fs.BoolVar(&opts.project, "project", false, "use the project's shared config in this folder (.mcp.json, .cursor/mcp.json) instead of your user config")
	fs.StringVar(&opts.name, "name", "kurlo", "server name in the client's config")
	fs.BoolVar(&opts.dryRun, "dry-run", false, "show what would change without changing anything")
	if !remove {
		fs.StringVar(&opts.workspace, "workspace", "", "workspace folder to serve (default: the one the app has open; with --project: the one in this folder)")
		fs.StringVar(&opts.env, "env", "", "environment to use when a call does not name one")
		fs.BoolVar(&opts.readOnly, "read-only", false, "only offer the tools that read and run")
		fs.StringVar(&opts.command, "command", "", `how clients start Kurlo: "npx", or a path to the kurlo binary (default: this Kurlo, or npx when run through npx)`)
	}
	fs.Usage = func() {
		fmt.Fprintf(stderr, "Usage: kurlo mcp %s [client...] [flags]\n\n", verb)
		if remove {
			fmt.Fprint(stderr, "Remove Kurlo from AI clients' MCP config.\n")
		} else {
			fmt.Fprint(stderr, "Add Kurlo to AI clients' MCP config, so they can run and edit your saved requests.\n")
		}
		fmt.Fprint(stderr, "Without a client it sets up every client found on this machine.\n\nClients: ")
		ids := make([]string, 0, 7)
		for _, client := range mcpInstallClients() {
			ids = append(ids, client.id)
		}
		fmt.Fprint(stderr, strings.Join(ids, ", ")+"\n\n")
		fs.PrintDefaults()
	}
	var positional []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			return opts, err
		}
		args = fs.Args()
		if len(args) > 0 {
			positional = append(positional, args[0])
			args = args[1:]
		}
	}
	known := map[string]bool{}
	for _, client := range mcpInstallClients() {
		known[client.id] = true
	}
	for _, id := range positional {
		id = strings.ToLower(strings.TrimSpace(id))
		if !known[id] {
			return opts, fmt.Errorf("unknown client %q; run kurlo mcp %s --help to see them", id, verb)
		}
		opts.clients = append(opts.clients, id)
	}
	if !mcpServerNameRe.MatchString(opts.name) {
		return opts, fmt.Errorf("--name may only use letters, digits, - and _")
	}
	return opts, nil
}

func runMCPInstall(opts mcpInstallOptions, host *mcpInstallHost, stdout io.Writer) int {
	var results []mcpInstallResult
	var launch mcpLaunch
	if !opts.remove {
		var err error
		launch, err = mcpInstallLaunch(opts, host)
		if err != nil {
			fmt.Fprintln(stdout, "kurlo mcp:", err)
			return 2
		}
	}
	if opts.project {
		results = mcpInstallProject(opts, host, launch)
	} else {
		results = mcpInstallUser(opts, host, launch)
	}
	if len(results) == 0 {
		fmt.Fprintln(stdout, "No AI clients found on this machine. Name one to set it up anyway, for example: kurlo mcp install cursor")
		return 1
	}
	table := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
	failed := false
	for _, result := range results {
		fmt.Fprintf(table, "%s\t%s\t%s\n", result.label, result.status, result.detail)
		failed = failed || result.failed
	}
	_ = table.Flush()
	if !opts.remove && !failed {
		fmt.Fprintf(stdout, "\nClients start the server with: %s\n", strings.Join(append([]string{launch.command}, launch.args...), " "))
		if launch.command == "npx" && !opts.project {
			fmt.Fprintln(stdout, "Apps started from the Dock or Start menu may not find npx. If one cannot start Kurlo, install the Kurlo app and run this again, or pass --command with the path to kurlo.")
		}
	}
	if opts.dryRun {
		fmt.Fprintln(stdout, "Nothing was changed (--dry-run).")
	}
	if failed {
		return 1
	}
	return 0
}

func mcpInstallLaunch(opts mcpInstallOptions, host *mcpInstallHost) (mcpLaunch, error) {
	args := []string{"mcp"}
	workspace, err := mcpInstallWorkspace(opts, host)
	if err != nil {
		return mcpLaunch{}, err
	}
	if workspace != "" {
		args = append(args, workspace)
	}
	if opts.env != "" {
		args = append(args, "--env", opts.env)
	}
	if opts.readOnly {
		args = append(args, "--read-only")
	}
	command := strings.TrimSpace(opts.command)
	if command != "" && command != "npx" && !opts.project {
		if abs, err := filepath.Abs(command); err == nil {
			command = abs
		}
	}
	if command == "" && !opts.project {
		command = mcpSelfExecutable(host)
	}
	if command == "" || command == "npx" {
		return mcpLaunch{command: "npx", args: append([]string{"-y", mcpNpmPackage}, args...)}, nil
	}
	return mcpLaunch{command: command, args: args}, nil
}

func mcpInstalledAppCandidates(home string) []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{"/Applications/Kurlo.app/Contents/MacOS/kurlo", filepath.Join(home, "Applications", "Kurlo.app", "Contents", "MacOS", "kurlo")}
	case "windows":
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			return []string{filepath.Join(dir, "Programs", "Kurlo", "kurlo.exe")}
		}
	}
	return nil
}

func mcpSelfExecutable(host *mcpInstallHost) string {
	if self := mcpRunningExecutable(host); self != "" {
		return self
	}
	for _, candidate := range host.apps {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func mcpRunningExecutable(host *mcpInstallHost) string {
	if appImage := host.getenv("APPIMAGE"); appImage != "" {
		return appImage
	}
	exe := host.executable
	if exe == "" {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	slashed := filepath.ToSlash(exe)
	for _, marker := range []string{"/node_modules/", "/_npx/", "/go-build"} {
		if strings.Contains(slashed, marker) {
			return ""
		}
	}
	if temp, err := filepath.EvalSymlinks(os.TempDir()); err == nil && strings.HasPrefix(exe, temp+string(filepath.Separator)) {
		return ""
	}
	return exe
}

func mcpInstallWorkspace(opts mcpInstallOptions, host *mcpInstallHost) (string, error) {
	if !opts.project {
		if opts.workspace == "" {
			return "", nil
		}
		abs, err := filepath.Abs(opts.workspace)
		if err != nil {
			return "", err
		}
		if !hasYAMLWorkspaceStore(abs) {
			return "", fmt.Errorf("%s is not a Kurlo workspace (no kurlo.yml)", abs)
		}
		return abs, nil
	}
	if opts.workspace != "" {
		abs := opts.workspace
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(host.cwd, abs)
		}
		if !hasYAMLWorkspaceStore(abs) {
			return "", fmt.Errorf("%s is not a Kurlo workspace (no kurlo.yml)", abs)
		}
		rel, err := filepath.Rel(host.cwd, abs)
		if err != nil || strings.HasPrefix(rel, "..") {
			return "", fmt.Errorf("with --project the workspace has to be inside this folder, so the config works for everyone who clones it")
		}
		return filepath.ToSlash(rel), nil
	}
	if hasYAMLWorkspaceStore(host.cwd) {
		return ".", nil
	}
	entries, err := os.ReadDir(host.cwd)
	if err != nil {
		return "", err
	}
	var found []string
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") && hasYAMLWorkspaceStore(filepath.Join(host.cwd, entry.Name())) {
			found = append(found, entry.Name())
		}
	}
	switch len(found) {
	case 1:
		return found[0], nil
	case 0:
		return "", fmt.Errorf("no Kurlo workspace (kurlo.yml) in this folder or the folders right inside it; save one here from the app, or pass --workspace")
	default:
		return "", fmt.Errorf("this folder has %d Kurlo workspaces (%s); pass --workspace", len(found), strings.Join(found, ", "))
	}
}

func mcpInstallUser(opts mcpInstallOptions, host *mcpInstallHost, launch mcpLaunch) []mcpInstallResult {
	requested := map[string]bool{}
	for _, id := range opts.clients {
		requested[id] = true
	}
	var results []mcpInstallResult
	for _, client := range mcpInstallClients() {
		if len(requested) > 0 && !requested[client.id] {
			continue
		}
		if len(requested) == 0 && !client.detect(host) {
			continue
		}
		var result mcpInstallResult
		switch client.kind {
		case "claude-cli":
			result = mcpInstallClaudeCode(opts, host, client, launch)
		case "toml":
			result = mcpInstallFile(opts, client.userPath(host), func(content []byte) ([]byte, string, error) {
				return mcpEditCodexConfig(content, opts.name, launch, opts.remove)
			})
		default:
			path := client.userPath(host)
			result = mcpInstallFile(opts, path, func(content []byte) ([]byte, string, error) {
				return mcpEditJSONConfig(content, client.key, opts.name, mcpClientEntry(client, launch), opts.remove)
			})
		}
		result.label = client.label
		if client.restart && !opts.dryRun && (result.status == "added" || result.status == "updated" || result.status == "removed") {
			result.detail += " (restart " + client.label + " to apply)"
		}
		results = append(results, result)
	}
	return results
}

func mcpInstallProject(opts mcpInstallOptions, host *mcpInstallHost, launch mcpLaunch) []mcpInstallResult {
	requested := map[string]bool{}
	for _, id := range opts.clients {
		requested[id] = true
	}
	files := map[string][]mcpInstallClient{}
	var order []string
	var results []mcpInstallResult
	for _, client := range mcpInstallClients() {
		if len(requested) > 0 && !requested[client.id] {
			continue
		}
		if client.project == "" {
			if requested[client.id] {
				results = append(results, mcpInstallResult{label: client.label, status: "skipped", detail: "has no project config; run without --project"})
			}
			continue
		}
		if len(requested) == 0 && client.id == "cursor" && !client.detect(host) && !mcpDirExists(filepath.Join(host.cwd, ".cursor")) {
			continue
		}
		if _, ok := files[client.project]; !ok {
			order = append(order, client.project)
		}
		files[client.project] = append(files[client.project], client)
	}
	for _, rel := range order {
		clients := files[rel]
		labels := make([]string, 0, len(clients))
		for _, client := range clients {
			labels = append(labels, client.label)
		}
		entryLaunch := launch
		if clients[0].id == "cursor" {
			entryLaunch = mcpWithWorkspaceFolder(launch, "${workspaceFolder}")
		}
		result := mcpInstallFile(opts, filepath.Join(host.cwd, rel), func(content []byte) ([]byte, string, error) {
			return mcpEditJSONConfig(content, "mcpServers", opts.name, mcpClientEntry(mcpInstallClient{typed: true}, entryLaunch), opts.remove)
		})
		result.label = strings.Join(labels, ", ")
		results = append(results, result)
	}
	return results
}

func mcpDirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func mcpWithWorkspaceFolder(launch mcpLaunch, variable string) mcpLaunch {
	out := mcpLaunch{command: launch.command, args: append([]string{}, launch.args...)}
	for i, arg := range out.args {
		if i > 0 && out.args[i-1] == "mcp" && !strings.HasPrefix(arg, "-") {
			if arg == "." {
				out.args[i] = variable
			} else {
				out.args[i] = variable + "/" + arg
			}
		}
	}
	return out
}

func mcpClientEntry(client mcpInstallClient, launch mcpLaunch) *orderedObject {
	entry := newOrderedObject()
	if client.typed {
		entry.set("type", "stdio")
	}
	entry.set("command", launch.command)
	args := make([]any, 0, len(launch.args))
	for _, arg := range launch.args {
		args = append(args, arg)
	}
	entry.set("args", args)
	return entry
}

func mcpInstallFile(opts mcpInstallOptions, path string, edit func([]byte) ([]byte, string, error)) mcpInstallResult {
	display := mcpDisplayPath(path)
	content, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return mcpInstallResult{status: "failed", detail: err.Error(), failed: true}
	}
	mode := os.FileMode(0o644)
	if info, statErr := os.Stat(path); statErr == nil {
		mode = info.Mode().Perm()
	}
	if errors.Is(err, os.ErrNotExist) && opts.remove {
		return mcpInstallResult{status: "not set up", detail: display}
	}
	next, status, err := edit(content)
	if err != nil {
		return mcpInstallResult{status: "failed", detail: display + ": " + err.Error(), failed: true}
	}
	if status == "already set up" || status == "not set up" || opts.dryRun {
		if opts.dryRun && status != "already set up" && status != "not set up" {
			status = "would be " + status
		}
		return mcpInstallResult{status: status, detail: display}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return mcpInstallResult{status: "failed", detail: err.Error(), failed: true}
	}
	if err := writeFileAtomicMode(path, next, mode); err != nil {
		return mcpInstallResult{status: "failed", detail: display + ": " + err.Error(), failed: true}
	}
	return mcpInstallResult{status: status, detail: display}
}

func mcpDisplayPath(path string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if rel, err := filepath.Rel(home, path); err == nil && !strings.HasPrefix(rel, "..") {
			return filepath.Join("~", rel)
		}
	}
	return path
}

func mcpEditJSONConfig(content []byte, key, name string, entry *orderedObject, remove bool) ([]byte, string, error) {
	root, err := parseOrderedJSON(content)
	if err != nil {
		snippet := encodeOrderedJSON(entry, "  ")
		return nil, "", fmt.Errorf("could not read it as plain JSON (%v), so it was left alone; add this under %q → %q by hand:\n%s", err, key, name, snippet)
	}
	indent := detectJSONIndent(content)
	if remove {
		servers, ok := root.values[key].(*orderedObject)
		if !ok || !servers.remove(name) {
			return content, "not set up", nil
		}
		if len(servers.keys) == 0 {
			root.remove(key)
		}
		return encodeOrderedJSON(root, indent), "removed", nil
	}
	servers, err := root.object(key)
	if err != nil {
		return nil, "", err
	}
	status := "added"
	if existing, ok := servers.get(name); ok {
		if string(encodeOrderedJSON(existing, indent)) == string(encodeOrderedJSON(entry, indent)) {
			return content, "already set up", nil
		}
		status = "updated"
	}
	servers.set(name, entry)
	return encodeOrderedJSON(root, indent), status, nil
}

func mcpEditCodexConfig(content []byte, name string, launch mcpLaunch, remove bool) ([]byte, string, error) {
	text := strings.ReplaceAll(string(content), "\r\n", "\n")
	lines := strings.Split(text, "\n")
	start, end := -1, len(lines)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if start < 0 {
			if trimmed == "[mcp_servers."+name+"]" || trimmed == `[mcp_servers."`+name+`"]` {
				start = i
			}
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			end = i
			break
		}
	}
	quoted := make([]string, 0, len(launch.args))
	for _, arg := range launch.args {
		quoted = append(quoted, tomlString(arg))
	}
	block := []string{
		"[mcp_servers." + name + "]",
		"command = " + tomlString(launch.command),
		"args = [" + strings.Join(quoted, ", ") + "]",
	}
	if remove {
		if start < 0 {
			return content, "not set up", nil
		}
		next := append(append([]string{}, lines[:start]...), lines[end:]...)
		return []byte(strings.TrimLeft(strings.Join(next, "\n"), "\n")), "removed", nil
	}
	if start < 0 {
		prefix := strings.TrimRight(text, "\n")
		if prefix != "" {
			prefix += "\n\n"
		}
		return []byte(prefix + strings.Join(block, "\n") + "\n"), "added", nil
	}
	existing := lines[start:end]
	for len(existing) > 0 && strings.TrimSpace(existing[len(existing)-1]) == "" {
		existing = existing[:len(existing)-1]
	}
	if strings.Join(existing, "\n") == strings.Join(block, "\n") {
		return content, "already set up", nil
	}
	tail := lines[start+len(existing):]
	next := append(append(append([]string{}, lines[:start]...), block...), tail...)
	return []byte(strings.Join(next, "\n")), "updated", nil
}

func tomlString(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\t", `\t`, "\r", `\r`)
	return `"` + replacer.Replace(value) + `"`
}

func mcpInstallClaudeCode(opts mcpInstallOptions, host *mcpInstallHost, client mcpInstallClient, launch mcpLaunch) mcpInstallResult {
	if host.goos == "windows" && launch.command == "npx" {
		launch = mcpLaunch{command: "cmd", args: append([]string{"/c", "npx"}, launch.args...)}
	}
	claude, err := host.lookPath("claude")
	if err != nil {
		return mcpInstallFile(opts, client.userPath(host), func(content []byte) ([]byte, string, error) {
			return mcpEditJSONConfig(content, client.key, opts.name, mcpClientEntry(client, launch), opts.remove)
		})
	}
	command := append([]string{launch.command}, launch.args...)
	remove := []string{"mcp", "remove", "--scope", "user", opts.name}
	add := append([]string{"mcp", "add", "--scope", "user", opts.name, "--"}, command...)
	if opts.dryRun {
		if opts.remove {
			return mcpInstallResult{status: "would run", detail: "claude " + strings.Join(remove, " ")}
		}
		return mcpInstallResult{status: "would run", detail: "claude " + strings.Join(add, " ")}
	}
	_, removeErr := host.run(claude, remove...)
	if opts.remove {
		if removeErr != nil {
			return mcpInstallResult{status: "not set up", detail: "user config"}
		}
		return mcpInstallResult{status: "removed", detail: "user config"}
	}
	if out, err := host.run(claude, add...); err != nil {
		return mcpInstallResult{status: "failed", detail: strings.TrimSpace(out + " " + err.Error()), failed: true}
	}
	if removeErr == nil {
		return mcpInstallResult{status: "updated", detail: "user config (claude mcp add)"}
	}
	return mcpInstallResult{status: "added", detail: "user config (claude mcp add)"}
}

package main

import (
	"fmt"
	"io"
	"os"

	"github.com/stormhop/kurlo/apps/desktop/internal/api"
)

const usage = `Kurlo command-line tools

Usage:
  kurlo run [workspace] [flags]   Run a workspace's requests and test scripts
  kurlo load list|export|run     Manage and run collection load tests with k6
  kurlo mcp [workspace] [flags]   Serve a workspace to AI agents over MCP
  kurlo mcp install [client...]   Add Kurlo to Claude Code, Cursor, Codex and other AI clients
  kurlo version                   Print the version

Run "kurlo run --help", "kurlo load --help" or "kurlo mcp --help" for the flags.
The desktop app and the docs are at https://kurlo.dev
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "run":
		return api.RunCLI(args[1:])
	case "load":
		return api.RunLoadCLI(args[1:], stdout, stderr)
	case "mcp":
		return api.RunMCPServer(args[1:])
	case "version", "--version", "-version", "-v":
		fmt.Fprintln(stdout, api.VersionLine())
		return 0
	case "diagnostics", "--diagnostics":
		fmt.Fprint(stdout, api.DiagnosticsReport())
		return 0
	case "help", "--help", "-help", "-h":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "kurlo: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}

---
title: "Connect an assistant"
---

One command adds Kurlo to every AI client it finds on your machine: Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf and Gemini CLI.

```bash
npx -y @kurlo/cli mcp install --env Local
```

It prints what it changed in each client's config and leaves everything else in those files as it was. Run it again after changing the flags and it updates the entries; run `kurlo mcp uninstall` to take them out. Name clients to set up only those, such as `kurlo mcp install cursor codex`, and add `--dry-run` to see the changes first.

| Flag | Meaning |
|------|---------|
| `--env NAME` | Environment the server uses when a call does not name one. |
| `--workspace DIR` | Serve this workspace instead of the one the app has open. |
| `--read-only` | Install the server with only the tools that read and run. |
| `--project` | Write the project's shared config instead of yours. See below. |
| `--command PATH` | How clients start Kurlo: `npx`, or the path to a `kurlo` binary. |
| `--name NAME` | Server name in the clients' config, `kurlo` by default. |
| `--dry-run` | Show what would change, change nothing. |

When the Kurlo app is installed, clients start the server from the app's own binary, even if you ran the command through `npx`: apps opened from the Dock or Start menu often cannot find `npx`. Without the app, they start it with `npx -y @kurlo/cli`. Claude Code is set up with `claude mcp add` when the `claude` command is available, and otherwise in `~/.claude.json`. A config file with comments in it is not changed; Kurlo prints the entry to add by hand instead. Restart Claude Desktop, Windsurf and running Claude Code sessions to pick up the change.

## Share it with your team

Run it with `--project` in a repository that holds a Kurlo workspace, and it writes the project's own config instead: `.mcp.json`, which Claude Code and VS Code read, and `.cursor/mcp.json` when the project uses Cursor. Commit them, and everyone who opens the repository in one of those clients gets the Kurlo server for that workspace.

```bash
npx -y @kurlo/cli mcp install --project --env Local
```

It finds the workspace in the current folder or a folder right inside it, such as `./api-tests`, and records it as a relative path. The entries always start Kurlo with `npx`, so they work on every teammate's machine.

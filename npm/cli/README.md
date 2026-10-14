# @kurlo/cli

The command line of [Kurlo](https://kurlo.dev), a free, open-source desktop API client. It runs the requests and test scripts of a Kurlo workspace, and serves a workspace to AI agents as an MCP server. You don't need the desktop app installed to use it.

```bash
npm install -g @kurlo/cli
kurlo --version
```

### `EACCES: permission denied` on `npm install -g`

npm could not write to the folder that holds global packages. It happens with Node from the nodejs.org installer, which puts that folder in `/usr/local`, owned by the system. It is not specific to Kurlo, and any global package fails the same way. Either skip the install and run the CLI with `npx -y @kurlo/cli`, or move global packages into your home folder once:

```bash
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
npm install -g @kurlo/cli
```

Node installed with Homebrew, Volta or nvm keeps global packages in your home folder already. Avoid `sudo npm install -g`: it works, but leaves root-owned files that break later installs.

## Connect an AI agent

Add Kurlo to every AI client on your machine (Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf, Gemini CLI):

```bash
npx -y @kurlo/cli mcp install --env Staging
```

Add `--project` to write the repository's shared `.mcp.json` and `.cursor/mcp.json` instead, `--dry-run` to see the changes first, and run `kurlo mcp uninstall` to take Kurlo out again. To set it up by hand instead:

Claude Code:

```bash
claude mcp add kurlo -- npx -y @kurlo/cli mcp --env Staging
```

Codex:

```bash
codex mcp add kurlo -- npx -y @kurlo/cli mcp --env Staging
```

Cursor, Claude Desktop and other clients with a JSON config:

```json
{
  "mcpServers": {
    "kurlo": {
      "command": "npx",
      "args": ["-y", "@kurlo/cli", "mcp", "--env", "Staging"]
    }
  }
}
```

The agent can list your requests and environments, run a saved request or a whole collection with its tests, and send one-off calls that use your `{{variables}}`. It can also add and change saved requests with their tests, save responses as examples and set environment variables, so the collection stays in step with your code. Secret values are sent to your API and masked as `[secret]` in everything the model sees, and never written to the workspace. Mark an environment protected in the app to keep agents away from it.

With no workspace argument, `kurlo mcp` serves the workspace the desktop app has open. Pass the folder that contains `kurlo.yml` to serve a Git-backed workspace instead:

```bash
npx -y @kurlo/cli mcp ./api --env Staging
```

## Run collections in CI

```bash
npx -y @kurlo/cli run ./api --env CI --reporters cli,junit
```

The run exits non-zero when a request fails or a test does not pass.

## Docs

- [MCP server](https://kurlo.dev/docs/guides/mcp-server/)
- [CLI runner](https://kurlo.dev/docs/guides/cli-runner/)
- [Git-backed workspaces](https://kurlo.dev/docs/guides/git-workspaces/)

Prebuilt binaries are published for macOS, Linux and Windows on x64 and arm64. MIT licensed.

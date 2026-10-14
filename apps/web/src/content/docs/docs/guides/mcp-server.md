---
title: MCP server (kurlo mcp)
description: Let Claude, Codex, Cursor and other AI assistants run your saved Kurlo requests and keep your collections up to date through the Model Context Protocol.
---

`kurlo mcp` serves a Kurlo workspace to AI assistants as a [Model Context Protocol](https://modelcontextprotocol.io) server. Once it is connected, an assistant can see your collections and environments, run a saved request and read the response, run a collection's tests, or send a one-off call that uses your environment's variables. It does this with the same engine as the app and [`kurlo run`](/docs/guides/cli-runner/).

It can also write to the workspace: add and change saved requests with their tests, save responses as examples and set environment variables. An agent that adds an endpoint to your service can add the request for it in the same commit, and Kurlo, if it is open, shows the change within a second.

The assistant starts `kurlo mcp` itself and talks to it over stdin and stdout. The server comes from the [`@kurlo/cli`](https://www.npmjs.com/package/@kurlo/cli) npm package, which `npx` downloads on first use, so the commands below work with or without the desktop app installed.

## Connect an assistant

**Claude Code**

```bash
claude mcp add kurlo -- npx -y @kurlo/cli mcp --env Local
```

**Codex** (CLI, IDE extension and desktop app share one config)

```bash
codex mcp add kurlo -- npx -y @kurlo/cli mcp --env Local
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.kurlo]
command = "npx"
args = ["-y", "@kurlo/cli", "mcp", "--env", "Local"]
```

**Claude Desktop, Cursor and other clients with a JSON config** (`claude_desktop_config.json`, `.cursor/mcp.json`, …)

```json
{
  "mcpServers": {
    "kurlo": {
      "command": "npx",
      "args": ["-y", "@kurlo/cli", "mcp", "--env", "Local"]
    }
  }
}
```

### Without Node.js

The desktop app is the same server. Point the client at its binary instead of `npx`: `/Applications/Kurlo.app/Contents/MacOS/kurlo` on macOS, or the installed `kurlo` executable on Linux and Windows.

```bash
claude mcp add kurlo -- /Applications/Kurlo.app/Contents/MacOS/kurlo mcp --env Local
```

With no workspace argument, the server uses the workspace the app has open, including the secret values the app keeps on this machine. To serve a different [Git-backed workspace](/docs/guides/git-workspaces/), pass its folder (the one that contains `kurlo.yml`) as the first argument:

```bash
kurlo mcp ~/code/payments-api/kurlo --env Staging
```

The workspace is read again on every call, so a request you edit in the app is what the assistant runs next. In the other direction, the app notices files the assistant wrote and reloads them. If you were editing at that moment, both changes are kept: see [Working alongside the app](#working-alongside-the-app).

## Tools

| Tool | What it does |
|------|--------------|
| `list_requests` | Lists saved requests with their path (`Collection/Folder/Name`), id, protocol, method and URL. Can be filtered to one collection, and searched with `query`: every word has to appear in the path, method or URL, so `post orders` finds `POST /orders`. |
| `get_request` | Shows how one request is defined: method, URL, query parameters, headers, body, auth type, scripts and browser settings, plus its saved [examples](/docs/guides/examples/) with their status, content type and body, so the assistant can compare a live response with the expected one. Credentials are left out. |
| `list_environments` | Lists environments and their variables. Secret values are hidden. |
| `run_request` | Sends one saved HTTP or GraphQL request with its collection defaults, auth and scripts. Returns the status, headers, body, timings, test results and script logs. |
| `run_collection` | Runs a collection or folder in order with its test scripts and returns pass/fail per request. Realtime requests are skipped, as in `kurlo run`. When the call carries a `progressToken`, the server reports progress after every request. |
| `send_request` | Sends an unsaved HTTP request. `{{variables}}` in the URL, headers and body are resolved from the environment. |
| `create_collection` | Creates an empty collection. |
| `save_request` | Creates a saved HTTP or GraphQL request, or changes one. See [Writing to the workspace](#writing-to-the-workspace). |
| `delete_request` | Deletes a saved request and its examples. |
| `save_example` | Saves a response as an [example](/docs/guides/examples/) of a request: the response of the last `run_request` of that request, or one the assistant describes with `status` and `body`. |
| `set_variable` | Sets a non-secret variable in an environment, and creates the environment if there is none with that name. |

A request can be named by its id, its full path, or just its name when that name is unique. When a name matches more than one request, the tool lists the matches with their ids so the assistant can pick one.

Every run accepts an `environment` and a `variables` object of overrides for that call. `run_request` and `send_request` return up to 64 KB of the response body by default. An assistant can ask for up to 1 MB with `maxBodyBytes`. Binary bodies are described but not included.

## Writing to the workspace

The write tools change the same YAML files the app writes, through the same code, so the result looks exactly as if you had made it in the app. In a [Git-backed workspace](/docs/guides/git-workspaces/) every change shows up in Git, and a deletion can be undone from history. Each result names the file it wrote.

`save_request` without `request` creates a request. It needs a `url`, and a `collection` unless the workspace has only one. With `request`, the id or path of an existing one, it changes only the fields the call passes. `params`, `headers` and `form` replace the whole list. `folder` puts the request in a folder, creating it if needed, and `collection` moves it to another collection. The other fields are:

| Field | Meaning |
|-------|---------|
| `name` | Defaults to the method and path, such as `POST /orders`. |
| `type` | `http` (the default) or `graphql`. |
| `method`, `url` | `url` may use `{{variables}}`, such as `{{baseUrl}}/orders`. |
| `body`, `bodyType` | A JSON body is stored as JSON and anything else as text, unless `bodyType` says `xml`, `html`, `urlencoded`, `form` or `none`. |
| `query`, `variables` | The query and variables of a GraphQL request. |
| `auth` | `inherit` (the default, the collection's auth), `none`, `bearer` with `token`, `basic` with `username` and `password`, or `apikey` with `key`, `value` and `in`. |
| `preRequestScript`, `testScript` | JavaScript with the [Postman `pm.*` API](/docs/reference/scripting-api/). `pm.test` calls in `testScript` become the request's tests, which `run_request` and `run_collection` report. |
| `notes` | Notes shown with the request. |

Only HTTP and GraphQL requests can be created or changed. WebSocket, Socket.IO, SSE and gRPC requests are listed and described, but not changed.

### Secrets stay out

The write tools never put a secret in a file. A bearer token, password or API key value has to be a variable reference such as `{{apiToken}}`, and a literal value is refused. Add the value in the app as a variable marked secret, and the request uses it. Headers, parameters and environment variables that are marked secret are kept as they are when the assistant changes a request, cannot be overwritten through MCP, and are shown to the assistant only as `<secret>`.

### Read-only

Start the server with `--read-only` to offer only the tools that read and run. The write tools are then left out of the tool list, and calling one is refused.

## Protected environments

Mark an environment **Protect from AI agents** in its ⋯ menu in the app, and `kurlo mcp` refuses every call that would use it: `run_request`, `run_collection` and `send_request` with that environment, and `set_variable` in it. The assistant is told to ask you to run the request in the app instead. Use it for production and anything else an assistant should not reach by picking the wrong environment.

The mark is saved in the environment's file as `protected: true`, so in a Git-backed workspace it applies to everyone on the team. `list_environments` shows it.

## Working alongside the app

The app and `kurlo mcp` can have the same workspace open. They take turns writing it, so neither reads the other's half-written save. The app checks for files changed outside it about once a second and reloads them, with a short notice. If the app saves before it has reloaded, for example because you were typing in a request at that moment, it writes your edits and then puts back every file changed outside it that your edits did not touch. Only when both changed the same file does the app's version win.

The same protection covers files changed by an editor or by `git pull` in a terminal.

## Checking a call the way a browser would

An API call that works from the assistant can still be refused in the browser, where CORS applies. `run_request` and `send_request` take `browserOrigin`, the origin of the page that would make the call, such as `https://app.example.com`. Kurlo then sends it with [browser emulation](/docs/guides/browser-security/): browser headers and `Origin`, the CORS preflight when the method or headers need one, and the CORS error a browser would raise, in the result's `error`. Add `browserCredentials: true` for a call made with `credentials: 'include'`, which a wildcard `Access-Control-Allow-Origin` does not satisfy.

A saved request that already has browser emulation turned on, by itself or through its collection, is sent with those settings even without `browserOrigin`.

## Variables carry across calls

A value a script sets with `pm.environment.set` or `pm.collectionVariables.set` is kept for the rest of the session, per environment. An assistant can run your login request once, and the token it stores is used by every request after it, just as in a collection run. Each result lists the variables the call changed in `variablesChanged`. These values live only in the server's memory. They are not written back to the workspace, and they are gone when the assistant restarts the server.

When a request uses a `{{variable}}` that no environment, call override or script has set, the result lists it in `unresolvedVariables`. The request is still sent with the placeholder as written, so a `401` next to `unresolvedVariables: ["token"]` tells the assistant to run the login request first or pass the value in `variables`.

Cookies and OAuth 2.0 tokens are kept for the session too. OAuth works the same way as [in `kurlo run`](/docs/guides/cli-runner/#oauth-20-in-ci): Client Credentials and Password grants are fetched, and browser grants use their refresh token.

## Secrets

Environment variables marked secret are used when requests are sent, but they are masked as `[secret]` in everything returned to the assistant. That covers the resolved URL, response headers and body, test messages and script logs. A server that echoes your token back does not hand it to the model. `list_environments` shows only the names of secret variables, and `get_request` never includes credentials. The write tools never store a secret either: see [Secrets stay out](#secrets-stay-out).

## Flags

| Flag | Meaning |
|------|---------|
| `--env NAME` | Environment used when a call does not name one. |
| `--timeout MS` | Per-request timeout, overriding request settings. |
| `--insecure`, `-k` | Turn off TLS certificate verification for every request. |
| `--allow-send-request` | Let scripts call `pm.sendRequest`. Off by default, as in `kurlo run`. |
| `--read-only` | Offer only the tools that read and run; never change workspace files. |

## Protocol

The server speaks MCP over stdio with newline-delimited JSON-RPC. It supports the `initialize` handshake of the 2024-11-05 through 2025-11-25 revisions, and the stateless 2026-07-28 revision's `server/discover`. It offers tools only, with no resources or prompts. Tool results carry the JSON as text and as `structuredContent`. A call can be cancelled with `notifications/cancelled`.

To try the server by hand, pipe JSON-RPC into it:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_requests","arguments":{}}}' | kurlo mcp
```

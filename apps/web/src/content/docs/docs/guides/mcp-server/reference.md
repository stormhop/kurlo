---
title: "CLI flags and protocol"
---

## Flags

| Flag | Meaning |
|------|---------|
| `--env NAME` | Environment used when a call does not name one. |
| `--timeout MS` | Per-request timeout, overriding request settings. |
| `--insecure`, `-k` | Turn off TLS certificate verification for every request. |
| `--allow-send-request` | Let scripts call `pm.sendRequest`. Off by default, as in `kurlo run`. |
| `--project-root <path>` | Connect a read-only source folder for project tools and file imports. |
| `--read-only` | Offer only the tools that read and run. |

## Docs for agents

The whole Kurlo documentation is available in plain text for language models: [llms.txt](https://kurlo.dev/llms.txt) lists the pages, and [llms-full.txt](https://kurlo.dev/llms-full.txt) has all of them in one file.

## Protocol

The server speaks MCP over stdio with newline-delimited JSON-RPC. It supports the `initialize` handshake of the 2024-11-05 through 2025-11-25 revisions, and the stateless 2026-07-28 revision's `server/discover`. It offers tools and prompts, and no resources. Tool results carry the JSON as text and as `structuredContent`. A call can be cancelled with `notifications/cancelled`.

To try the server by hand, pipe JSON-RPC into it:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_requests","arguments":{}}}' | kurlo mcp
```

---
title: "Streaming request settings"
description: "Configure reconnect behavior for WebSocket, Socket.IO, and SSE."
---

## WebSocket / Socket.IO–specific settings

For `ws://` / `wss://` and Socket.IO requests, extra knobs appear:

- **Handshake timeout (ms)** — how long to wait for the connection handshake. `0` uses the default of 30 seconds.
- **Reconnect attempts** — number of automatic reconnect attempts after an abnormal close. `0` = never reconnect. Default `0`.
- **Reconnect interval (ms)** — delay between reconnect attempts. Default `5 000`.
- **Max message size (MB)** — read limit per message. Default `10 MB`. Reduce if you're testing constrained servers; increase if you legitimately stream larger messages.
- **Keep-alive interval (ms)** — how often to ping the server to hold the connection open. `0` uses the default; `-1` stops pinging entirely, which is what you want against a server that treats an unsolicited ping as a protocol error.

## SSE-specific settings

A request whose method is set to **SSE** gets two more:

- **Reconnect automatically** — on by default, matching a browser `EventSource`: the stream resumes from the last event id it saw. Turn it off to watch a failing stream stop instead of retrying, which is what you usually want while debugging the server end.
- **Reconnect interval (ms)** — how long to wait before reconnecting. `0` follows the interval the server sends in its `retry:` field.

gRPC requests also show gRPC-specific settings: TLS, reflection, server name, client certificate, default-value inclusion, and max response message size. See [Request types](/docs/guides/request-types/) for how the protocol-specific editors differ.

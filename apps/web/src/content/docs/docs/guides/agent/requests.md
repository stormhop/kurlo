---
title: "Running requests and tests"
---

Name a saved request, folder or collection in the chat. The agent can run HTTP, GraphQL, unary gRPC, MCP and AI requests. For an MCP endpoint, ask it to list available tools or call one with specific arguments. HTTP results include timings, redirect hops and the negotiated TLS details when available.

For WebSocket, Socket.IO, SSE or streaming gRPC, ask the agent to connect, exchange messages and report what it receives. SSE only receives events. A server-streaming gRPC call sends its saved message when it opens. For client-streaming and bidirectional gRPC, ask the agent to send each message and finish sending when ready. **Stop** and the end of the turn close the connections.

For a collection run, name the number of iterations, a delay between requests and whether to stop at the first failure. To use test data, put a CSV or JSON file in the workspace and give the agent its relative path. Each row drives one iteration. The agent reports per-request results, assertions, skips and elapsed time.

Ask the agent to save a load test and run it with the installed k6. The run continues in the background. Ask for its progress, summary or a comparison with an earlier run of the same test or another saved test. To serve saved examples, ask it to start a mock for a collection and inspect the request log. The mock stays up until you or the agent stops it.

Ask for cookies that apply to a domain to see their names, paths, expiry and flags. Clearing the workspace's jar requires a fresh approval each time.

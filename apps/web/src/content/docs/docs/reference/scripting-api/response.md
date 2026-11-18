---
title: "pm.response"
---

## `pm.response` (test scripts only)

| Method | Description |
|--------|-------------|
| `pm.response.code` | HTTP status code (int) |
| `pm.response.status` | Status string, e.g. `"200 OK"` |
| `pm.response.responseTime` | Duration in milliseconds (alias: `pm.response.time`) |
| `pm.response.size` | Body size in bytes |
| `pm.response.body` | Raw body as string |
| `pm.response.json()` | Body parsed as JSON (map/array) |
| `pm.response.headers.get(name)` | Get response header (case-insensitive) |
| `pm.response.llm()` | AI requests only: the answer as `{ text, thinking, toolCalls, stopReason, model, usage, timing, steps, error }`, the same for every provider. `toolCalls` items have `id`, `name`, `input` and `server`; `usage` has `input`, `output`, `cacheRead`, `cacheWrite` and `reasoning`; `timing` has `firstToken` and `total` in milliseconds. |

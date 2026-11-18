---
title: "Timing and iterations"
---

## Timing and parallelism

The header sums up the run before you start it: selected requests, iterations, the total number of calls and the order. Use **Delay between requests** when a server rate-limits or when order matters. Sequential runs wait between each request. Parallel runs execute one iteration at a time and wait between iterations.

Choose **In parallel** under **Order & pacing** only for independent requests. If a test mutates shared environment values, keep the run sequential so each request sees the latest values from the previous request.

**Max concurrent requests** caps how many run at the same time (default 8, maximum 64). Raise it for fast, independent read-only endpoints; lower it when the server rate-limits or when a large collection would otherwise open more sockets than the machine is happy with.

## Iterations

Set **Iterations** to run the selected set multiple times. Each request gets a result row per iteration, so flaky endpoints are easier to spot.

Iterations are ignored when a data file is loaded; the number of rows in the file becomes the iteration count.

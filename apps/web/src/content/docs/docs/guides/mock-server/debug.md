---
title: "Inspect requests and edit examples"
---

## The request log

Everything that reaches the mock is listed live — method, path, the status that went back, and which example answered.

The **unmatched** rows are the useful ones. They are the difference between *my client is asking for the wrong thing* and *no example covers this yet*, and a request that matches nothing gets a 404 whose body names the routes that do exist:

```json
{
  "error": "No saved example matches this request.",
  "method": "GET",
  "path": "/pets/9/toys",
  "available": ["GET /pets", "GET /pets/:id", "POST /pets"]
}
```

The log is kept on Kurlo's side as well as streamed to the panel, so closing and reopening the tab does not lose what arrived while you were elsewhere. A request the client abandoned — it gave up during a reproduced delay — is listed too, with the example that would have answered, rather than vanishing.

## Editing an example while the server runs

The mock reloads itself when you change an example it is serving, so it cannot answer with something you already edited. This happens whether or not the mock panel is open — editing an example from the request editor is enough. The routes are swapped on the running server rather than restarting it: the port never moves, open connections are not dropped, and the request log survives, because from the client's point of view nothing happened. A rename does not bounce the server either, because it changes nothing a client can observe.

Clicking a route, or a matched row in the log, opens the example behind it.

## Reproducing recorded response times

Each example knows how long the real call took. **Reproduce recorded response times** replays that delay, which is a cheap way to see a loading state that a local mock otherwise never shows. It is off by default.

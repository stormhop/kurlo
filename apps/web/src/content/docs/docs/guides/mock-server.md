---
title: Mock server
description: Serve a collection's saved examples over HTTP on a local port, so a client can be built against an endpoint that does not exist yet.
---

Kurlo can serve a collection's [saved examples](/docs/guides/examples/) as a real HTTP server on your own machine. A front end can then be written against an endpoint the backend has not shipped, and against the failure cases a staging environment will not produce on demand — a 500, an expired token, an empty list.

It needs no account and no configuration. An example already records a status, headers, a body and the path that produced them, so it is already a route.

## Starting it

Open the **Mock** tab from the server icon in the activity rail on the left, pick a collection, and press **Start server** at the top right. The status bar beside it shows whether the server runs and its base URL; click the URL to copy it:

```
http://127.0.0.1:3100
```

Point your client at that instead of the real API and every request matching an example gets the recorded response back.

![The mock server panel: running on port 3100, one route from a saved example, and a request log with one matched and one unmatched call](../../../../assets/screenshots/mock-server.png)

The **Start** button stays disabled until the selected collection has at least one example — there would be nothing to serve.

## What it serves

Each example becomes one route, matched on **method** plus the example's **path template**:

| Example captured from | Route |
|-----------------------|-------|
| `GET https://api.example.com/pets` | `GET /pets` |
| `GET https://api.example.com/pets/8123` | `GET /pets/:id` |
| `POST https://api.example.com/pets` | `POST /pets` |

A literal segment beats a parameter, so `/pets/featured` wins over `/pets/:id` regardless of which example was captured first. OpenAPI-style `{petId}` segments match the same way `:petId` does.

### Several examples for one endpoint

An example that recorded **query parameters** only answers requests that carry them. That is how one endpoint serves its empty, its full and its error case:

| Example | Answers |
|---------|---------|
| `GET /pets` | any request to `/pets` |
| `GET /pets` with `status=archived` | only `/pets?status=archived` |

When two examples would answer the same request, only the first can ever reply. Kurlo flags this: the **Routes** header counts the examples that are never reached, and each of them names the example that answers first. Routes are grouped by request. Give them different paths or query values to make the rest reachable.

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

## Scope and safety

- **Loopback only.** The server binds `127.0.0.1`, never `0.0.0.0`. A mock built from real recorded responses — which may still hold data from a live system — is not something to put on the network by accident.
- **CORS is answered for pages served from this machine** — any `localhost`, `127.0.0.1` or `::1` origin on any port — because the first client to hit a mock is usually a browser app running on another port. A page served from anywhere else gets a `403` and no CORS headers: the mock replays responses recorded from real APIs, and a site you happen to have open should not be able to read them. The refusal is listed in the request log with the origin that was turned away.
- **One server at a time.** Starting it for a different collection switches it over; the panel says so before you do.
- **It stops when Kurlo quits.** There is no background daemon.

If the port is taken, Kurlo says so rather than failing silently — pick another one in the panel.

## What it does not do

- It does not fall through to the real API for unmatched requests.
- It does not template responses: what was captured is what is served, byte for byte.
- It does not serve HTTPS, and it does not match on the request body.

If you need any of those, [open an issue](https://github.com/stormhop/kurlo/issues) — they are all extensions of the same matching, not rewrites of it.

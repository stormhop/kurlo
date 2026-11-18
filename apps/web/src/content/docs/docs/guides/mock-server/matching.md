---
title: "Match requests to examples"
---

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

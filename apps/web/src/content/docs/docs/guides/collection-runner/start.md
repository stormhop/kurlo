---
title: "Run a collection"
---

## Opening the runner

Open it from:

- Click a collection name in the sidebar to open its overview, then click **Run**.
- From a folder's **⋯** menu, choose **Run folder**.
- The play icon in the activity rail on the left.
- From the workspace overview, choose **Start → Run collection**.

Kurlo opens the runner workspace and selects runnable requests from the current collection. Realtime sessions (`SSE`, WebSocket, Socket.IO) are skipped because they do not naturally finish. HTTP, GraphQL, and gRPC requests can run.

## Selecting requests

The runner list groups requests by folder and shows each request's method/transport, name, URL and tags. You can:

- Select/deselect individual requests.
- Select all or deselect all.
- Filter with **Only requests tagged** and **Skip requests tagged**.
- Run just a folder by launching from that folder's menu.

Tags are inferred from folder path, transport label, and request type. For example, `Billing / Refunds / POST / http` gives you useful filters without adding a separate tagging UI.

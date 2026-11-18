---
title: "Import and export by protocol"
description: "Check which request types can move between tools."
---

## Import and export notes

| Format | Import into Kurlo | Export from Kurlo |
|--------|-------------------|-------------------|
| [Postman v3 Native Git folder](/docs/guides/import-export/postman/#postman-v3-folders) | HTTP, GraphQL, gRPC, WebSocket, Socket.IO, and MCP over HTTP | [HTTP, GraphQL, and native gRPC](/docs/guides/import-export/postman/#export-to-postman-v3). SSE as HTTP streaming |
| [Postman v2 JSON](/docs/guides/import-export/postman/) | v2.0 and v2.1. HTTP and GraphQL, with additional request metadata in files exported by Kurlo | v2.1 JSON. HTTP, GraphQL and SSE using HTTP fields. Kurlo can reconstruct gRPC, WebSocket, and Socket.IO from its own export metadata |
| [Insomnia v4 JSON](/docs/getting-started/migrating/insomnia/) | HTTP, GraphQL, gRPC, WebSocket, and Socket.IO | v4 workspace JSON, including gRPC, WebSocket and Socket.IO request resources |
| [OpenAPI / Swagger](/docs/guides/import-export/openapi/) | HTTP and SSE operations | HTTP and SSE as OpenAPI 3.0 or Swagger 2.0 |
| [Bruno / OpenCollection](/docs/guides/import-export/bruno/) | HTTP, GraphQL, gRPC, WebSocket, and Socket.IO | OpenCollection YAML with HTTP, GraphQL, gRPC, WebSocket, and Socket.IO request records |
| [Kurlo all-data backup](/docs/guides/backup-recovery/) | All Kurlo request types | All Kurlo request types |
| [Kurlo Git/YAML workspace](/docs/reference/kurlo-yaml-format/) | All Kurlo request types | All Kurlo request types |

Use Postman v3 to move native gRPC requests between Kurlo and Postman. Kurlo can import a v3 folder or a single `*.request.yaml` file. The v2.1 JSON export stores gRPC-specific fields in `x-kurlo` for re-import into Kurlo.

A Postman v3, OpenAPI, or Swagger export reports how many requests it skipped. Use a Kurlo workspace or backup to preserve Kurlo-specific fields across every request type.

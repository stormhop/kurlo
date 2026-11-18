---
title: "From Insomnia"
description: "Export resources from Insomnia and import them into Kurlo."
---

Insomnia uses its own export format which is broadly similar to Postman's. Kurlo can import it directly.

## Export from Insomnia

Export the collection from Insomnia as **Insomnia v4 (JSON)**.

## Import into Kurlo

Click **Import collection** in Kurlo's sidebar. Select **Insomnia export**, click **Import**, then select the JSON file. You can also drop the file into the Kurlo window.

## What carries over

Kurlo creates one collection from the file and reconstructs folder paths from the parents of imported requests. The importer handles HTTP, GraphQL, gRPC, WebSocket, and Socket.IO requests.

Insomnia folder environment values become entries in the request's [Vars tab](/docs/guides/environments/request-variables/). Inner folders override outer folders, and variables already on the request take priority.

## Insomnia-specific gotchas

- Create [Kurlo environments](/docs/guides/environments/manage/) for any named Insomnia environments you want to use. Insomnia environment resources do not create Kurlo environments.
- Replace Insomnia-specific template tags with Kurlo variables or pre-request scripts.

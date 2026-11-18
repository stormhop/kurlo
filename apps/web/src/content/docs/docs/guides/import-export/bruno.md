---
title: "Import from Bruno"
---

## From Bruno/OpenCollection

Kurlo imports OpenCollection-style folders and request files. Empty folders are preserved explicitly, so a folder can exist before it contains a request. Headers, auth, and scripts in a `folder.yml` or Bruno `folder.bru` become that folder's [defaults](/docs/guides/collection-defaults/folders/); a folder without an auth block inherits.

Request variables come across to the request's [**Vars**](/docs/guides/environments/request-variables/) tab: `vars:pre-request` and `vars:post-response` in `.bru` files, `runtime.variables` and `set-variable` actions in YAML. Kurlo has no folder variables, so a folder's variables are copied into the Vars tab of every request in it; a request's own variable with the same name wins. Collection variables from `vars:pre-request` in `collection.bru` or `request.variables` in `opencollection.yml` become collection variables.

Kurlo's OpenCollection export writes:

- `folder.yml` files for explicit folder paths, with the folder's headers, auth, and scripts.
- HTTP, GraphQL, gRPC, WebSocket, and Socket.IO request records. Import and export for these types are covered by Kurlo round-trip tests. Check the imported request in Bruno when sharing between clients.
- Request-level scripts, settings, auth, params, headers, and bodies where the format supports them.
- Request variables as `runtime.variables` and post-response variables as `set-variable` actions, which Bruno reads back into its Vars tab.

Postman and Insomnia have no request variables. A Postman export writes Pre Request variables as `pm.variables.set(...)` lines at the top of the pre-request script, so the request behaves the same in Postman. Variables in an Insomnia folder's environment are copied into the Vars tab of every request in the folder. Both exports also keep the variables in Kurlo's own field, so they import back into Kurlo unchanged.

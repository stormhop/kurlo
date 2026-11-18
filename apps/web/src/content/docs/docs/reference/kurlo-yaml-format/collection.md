---
title: "Collection file"
---

Path: `workspaces/<workspace>/collections/<collection filesystemName>/collection.yml`

```yaml
version: 1
collection:
  id: collection-core
  workspaceId: workspace-main
  name: Core API
  description: ""
  collapsed: false
  folderPaths:
    - - Auth
    - - Auth
      - Admin
  environmentIds:
    - env-core-dev
    - env-core-staging
  defaultEnvironmentId: env-core-staging
  folderDefaults:
    - id: folder-admin
      path:
        - Auth
        - Admin
      headers:
        - key: X-Admin
          value: "1"
          enabled: true
      auth:
        type: bearer
        bearerToken: '{{kurloSecret:collection.collection-core.folder.folder-admin.auth.bearerToken}}'
requestOrder:
  - req-login
```

`collection.folderPaths` preserves explicit folders, including empty folders. `collection.folderDefaults` holds the headers, auth, `preRequestScriptJs` and `testScriptJs` a folder applies to its requests, keyed by `path`. An `auth.type` of `none` means the folder's requests send no auth; a missing `auth` means they inherit. Secret auth fields and secret header values become placeholders, as in collection defaults. Request files stay flat under `requests/`; the UI hierarchy comes from `request.folderPath` and `collection.folderPaths`, not from nested filesystem directories.

`collection.environmentIds` lists the ids of workspace environments pinned to the collection, and `collection.defaultEnvironmentId` names the one selected when the collection is opened (the first pinned one if it is missing). Both are left out when nothing is pinned. Ids of environments that no longer exist are ignored. They only affect the app's environment switcher.

## OpenAPI source

A collection kept in sync with an OpenAPI spec has an `openapi` block:

```yaml
collection:
  openapi:
    source: https://api.example.com/openapi.json
    headers:
      - key: Authorization
        value: Bearer {{specToken}}
        enabled: true
    intervalMinutes: 15
    skipTlsVerification: false
    ignored:
      - DELETE /legacy/{id}
```

`source` is a URL or a file path relative to the workspace folder, and may use `{{variables}}`, as may `headers`. `intervalMinutes` is how often the app checks while it is open; `0` means only by hand. `ignored` lists operations you chose not to add, so they are not offered again. The spec from the last applied sync is stored next to `collection.yml` as `openapi/spec.json`: commit it with the collection, because it is the base the next sync compares against. See [OpenAPI sync](/docs/guides/openapi-sync/).

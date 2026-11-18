---
title: "Environment file"
---

Path: `workspaces/<workspace>/environments/<environment filesystemName>.yml`

```yaml
version: 1
environment:
  id: environment-local
  workspaceId: workspace-main
  name: Local
  values:
    - id: 1
      enabled: true
      key: baseUrl
      value: https://api.example.test
      description: ""
    - id: 2
      enabled: true
      key: token
      value: "{{kurloSecret:environment:environment-local:row:2}}"
      description: ""
      secret: true
```

`protected: true` on the environment marks it as one that AI agents connected through [`kurlo mcp`](/docs/guides/mcp-server/permissions/#protected-environments) may not send requests with or change. It is left out when false.

`color` is the environment's color in the app: `red`, `amber`, `green`, `blue` or `gray`. It is left out when the environment has none; any other value is ignored.

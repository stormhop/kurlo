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
      key: baseUrl
      value: https://api.example.test
    - id: 2
      key: token
      value: "{{kurloSecret:environment:environment-local:row:2}}"
      secret: true
```

`protected: true` on the environment marks it as one that AI agents connected through [`kurlo mcp`](/docs/guides/mcp-server/permissions/#protected-environments) may not send requests with or change. It is left out when false.

`color` is the environment's color in the app: `red`, `amber`, `green`, `blue` or `gray`. It is left out when the environment has none; any other value is ignored.

`secretRef` links a variable to a provider from `secretProviders` in `workspace.yml`. The row has no value; Kurlo fetches it when a request is sent. See [Secret managers](/docs/guides/environments/secret-managers/).

```yaml
    - id: 3
      key: dbPassword
      secret: true
      secretRef:
        provider: vault-prod
        path: secret/data/app
        field: password
```

`field` picks a key inside the secret and can be left out when the secret holds one value. `version` picks a Vault KV v2 version, an AWS version stage or id, or a Parameter Store version. A `value` next to `secretRef` is ignored and removed on save. A reference to a provider that is not in `workspace.yml` is reported as a workspace problem.

`secretSources` imports every key of a secret as a variable of the environment. It sits next to `values`:

```yaml
  secretSources:
    - provider: vault-prod
      path: secret/data/app
      prefix: db_
      keys: [user, password]
```

Each key becomes a secret variable named `prefix` + key, so this example adds `db_user` and `db_password`. `keys` limits the import to the listed keys; without it every key of the secret is imported. `version` works as in `secretRef`. A variable row with the same name wins over an imported key, in this environment and in the ones it inherits from. When two sources of one environment list the same name in `keys`, the workspace reports a problem. Child environments inherit their parents' sources. See [Import a whole secret](/docs/guides/environments/secret-managers/#import-a-whole-secret).


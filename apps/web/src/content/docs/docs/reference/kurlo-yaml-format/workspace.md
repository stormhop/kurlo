---
title: "Workspace file"
---

Path: `workspaces/<workspace filesystemName>/workspace.yml`

```yaml
version: 1
workspace:
  id: workspace-main
  name: Main
collectionOrder:
  - collection-core
```

The workspace README lives next to it in `workspaces/<workspace filesystemName>/README.md` as plain UTF-8 Markdown; the name is matched in any letter case. Kurlo writes the file only when the README has text, ends it with a newline, keeps its CRLF line endings and byte order mark if it had them, and removes it when the README is cleared. A README over 256 KB, not UTF-8, or a symbolic link is left untouched. Older files that keep the text in `workspace.description` still load; Kurlo moves it into `README.md` on the next save.

`secretProviders` lists the [secret managers](/docs/guides/environments/secret-managers/) that environment variables can link to. It holds no credentials.

```yaml
secretProviders:
  - id: vault-prod
    type: vault
    name: Vault (prod)
    address: https://vault.example.com
    namespace: team-a
    auth:
      method: token
    cacheTtl: 5m
  - id: aws-dev
    type: aws-secrets-manager
    region: eu-central-1
    profile: dev
  - id: op
    type: 1password
    account: my.1password.com
  - id: gcp
    type: gcp-secret-manager
    project: shop-prod
  - id: azure
    type: azure-key-vault
    address: https://shop.vault.azure.net
    auth:
      method: client-secret
      tenantId: 00000000-0000-0000-0000-000000000000
      clientId: 11111111-1111-1111-1111-111111111111
  - id: infisical
    type: infisical
    project: 6512aa0000000000
    auth:
      method: universal
      clientId: 22222222-2222-2222-2222-222222222222
  - id: pass
    type: command
    command: [pass, show, "{path}"]
  - id: ci
    type: env
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits, `-` and `_`. Environment files refer to the provider by it. |
| `type` | `vault`, `1password`, `aws-secrets-manager`, `aws-ssm`, `gcp-secret-manager`, `azure-key-vault`, `bitwarden`, `doppler`, `infisical`, `command` or `env`. |
| `name` | Name shown in Kurlo. |
| `address` | Vault server or Azure Key Vault URL; for Bitwarden, Doppler and Infisical, a self-hosted or regional server. |
| `namespace`, `caCert`, `skipTlsVerify` | Vault Enterprise namespace, PEM file of a private CA, and whether to skip TLS checks. |
| `auth.method` | Vault: `token` (default), `approle`, `kubernetes` or `oidc`. Azure: `cli` (default) or `client-secret`. Infisical: `token` (default) or `universal`. |
| `auth.roleId`, `auth.role`, `auth.mount` | Vault AppRole role ID; role for `kubernetes` and `oidc`; auth mount, which defaults to the method name. |
| `auth.tokenPath`, `auth.redirectUri` | Service account token file for Vault `kubernetes`, and the loopback redirect for Vault `oidc` (`http://localhost:8250/oidc/callback` by default). |
| `auth.tenantId`, `auth.clientId` | Azure tenant and app registration; Infisical machine identity client ID. |
| `account` | 1Password account, when `op` is signed in to several. |
| `region`, `profile`, `endpoint` | AWS region, profile from `~/.aws/config`, and a custom endpoint such as a VPC endpoint or LocalStack. `endpoint` also sets a Google Cloud endpoint. |
| `project` | Google Cloud project, or Infisical project ID. |
| `command` | For `command`: the program and its arguments, as a list or one string split on spaces. `{path}` and `{version}` are replaced. |
| `cacheTtl` | How long fetched values stay in memory: `30s`, `5m`, `0` or `session`. Defaults to `5m`. |
| `timeout` | Timeout of one call to the provider. Defaults to `10s`. |

Only Kurlo writes this list. A save from the app keeps it as it is on disk.


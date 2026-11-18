---
title: "Export and share"
---

## Git-backed YAML workspaces

For team sharing, prefer Kurlo's Git/YAML storage over repeated JSON exports. It stores workspace state as plain YAML files:

- `kurlo.yml` and `workspaces/**/*.yml` are shared.
- Sensitive values become `{{kurloSecret:...}}` placeholders; the real values remain in Kurlo's encrypted local profile outside the repository.
- Folder hierarchy is represented by `request.folderPath` plus `collection.folderPaths`, so empty folders survive round-trips.

See [Kurlo YAML format](/docs/reference/kurlo-yaml-format/) for the public contract.

## All-data backups

Use **Settings -> General -> Data -> Export all data** for a Kurlo-to-Kurlo profile backup. Unlike collection interchange formats, it includes history, cookies, all local workspaces, and selected preferences.

The file is plaintext and can contain secrets. Import replaces the current local profile rather than merging it. See [Backup & recovery](/docs/guides/backup-recovery/) for the exact contents, exclusions, recovery-key behavior, and a safe restore procedure.

## Export

Open the collection's **⋯** menu and choose **Export…**. The picker offers Postman v2.1 JSON and v3 YAML, Insomnia Export v4 JSON, OpenAPI 3.0 JSON, Swagger 2.0 JSON, and OpenCollection YAML.

Choose [Postman collection v3 (YAML folder)](/docs/guides/import-export/postman/#export-to-postman-v3) to transfer native gRPC requests into Postman Desktop. The v2.1 option writes a single JSON file for Postman's file importer. See [protocol support by format](/docs/guides/request-types/portability/) for the full list.

Secrets marked as **secret** are stripped, redacted, or kept as Kurlo secret placeholders depending on the target format. Git/YAML workspaces keep the real values in Kurlo's encrypted local profile, outside shared files.

## Sharing within a team

For day-to-day collaboration:

1. Use Git-backed YAML workspace storage.
2. Commit `kurlo.yml`, `.gitignore`, and `workspaces/**/*.yml`.
3. Keep `{{kurloSecret:...}}` placeholders intact; Kurlo resolves them from each user's encrypted local profile.
4. Use import/export formats only for interoperability with another client.

For environment-specific variables, keep non-secret defaults in the workspace and put real secret values in local secrets.

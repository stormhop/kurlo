---
title: "Secrets and Git behavior"
---

## Secrets

Shared YAML files may contain placeholders in sensitive request auth fields and in rows marked `secret: true`.

```text
{{kurloSecret:<stable key>}}
```

Kurlo stores the actual values in its encrypted local `requests.json` profile. They are not part of the workspace directory or this shared public contract.

Secret-aware tools should preserve placeholders as-is. If a tool cannot resolve a placeholder, it should keep the placeholder instead of replacing it with an empty string.

## Git behavior

Kurlo treats these paths as managed Git content:

- `kurlo.yml`
- `.gitignore`
- `workspaces/**/*.yml`

Other files in the repository are intentionally left alone by commit, discard, stash, and conflict-resolution operations unless Kurlo explicitly adds support for them in a future format version.

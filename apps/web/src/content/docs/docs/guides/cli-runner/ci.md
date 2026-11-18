---
title: "GitHub Actions"
---

## Example: GitHub Actions

```yaml
- name: API smoke tests
  run: npx -y @kurlo/cli run ./workspace --env CI --reporter junit --var token="${{ secrets.API_TOKEN }}" > results.xml
```

## Related

- [Collection Runner](/docs/guides/collection-runner/) — the same idea inside the app, with a data file and parallelism.
- [Git-backed workspaces](/docs/guides/git-workspaces/) — the YAML format `kurlo run` reads.
- [Scripting API](/docs/reference/scripting-api/) — the `pm.*` API your test scripts use.

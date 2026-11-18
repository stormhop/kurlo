---
title: "Directory layout and root index"
---

## Directory layout

```text
kurlo.yml
workspaces/
  <workspace filesystemName>/
    workspace.yml
    README.md
    collections/
      <collection filesystemName>/
        collection.yml
        requests/
          <request filesystemName>.yml
        examples/
          <request filesystemName>/
            <example filesystemName>.yml
        loadtests/
          <load test filesystemName>.yml
    environments/
      <environment filesystemName>.yml
```

`filesystemName` is the path segment of an object: its folder or file name. It is not written inside the YAML; readers take it from the path. Kurlo derives it from the object's name: spaces become `-`, Cyrillic is transliterated (`Общий` → `Obshchiy`), accents are dropped, and anything else outside `a-z A-Z 0-9 . _ -` becomes `-`. Two objects with the same name in one folder get `-1`, `-2` suffixes, compared without regard to case so the layout also works on macOS and Windows.

Kurlo keeps every path in line with its name. When it saves, any file or folder whose path no longer matches the name, whether the object was renamed in the app, by editing the YAML, or in a pulled commit, is moved; Git shows it as a rename. Loading never moves anything, and nothing moves while the workspace has a file Kurlo cannot read.

Request and environment files may include a top-level `order` for older exports. Newer writers should prefer `requestOrder`, `collectionOrder`, and `workspaceOrder`; readers must tolerate files without `order`.

## Root index

`kurlo.yml` identifies the shared workspace store and records workspace order.

```yaml
version: 1
format: kurlo.workspace.yaml.v1
workspaceOrder:
  - workspace-main
```

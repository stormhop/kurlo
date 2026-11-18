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

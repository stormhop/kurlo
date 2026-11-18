---
title: "Conflicts and diagnostics"
---

## Conflicts

When Git reports conflicts, Kurlo blocks normal workspace editing until the conflict is resolved. The conflict resolver can:

- Show ours/theirs versions.
- Parse inline conflict markers.
- Step through unresolved hunks.
- Accept ours, accept theirs, or edit the merged result.
- Continue or abort the Git operation.

This is intentionally conservative: Kurlo would rather pause than silently overwrite workspace YAML.

## Diagnostics

Diagnostics appear when YAML exists but is incomplete, invalid, or references something Kurlo cannot load cleanly. A diagnostic does not always mean data is lost; often it means a third-party edit missed a required field.

The Git screen lists problems from every workspace in the folder, not only the open one, and names the workspace each problem locks. A file Kurlo cannot read is never rewritten or deleted while it is broken; the rest of the workspace saves as usual.

Use diagnostics to jump to the affected workspace, collection, request, or environment. After you fix a file with **Edit YAML**, the workspace reloads by itself.

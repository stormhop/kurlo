---
title: "Interface issues"
---

## UI quirks

### Settings → About says "DEV BUILD" but I downloaded a release

Your build has `appVersion=dev` baked in — the release ldflags didn't apply. If you built it yourself, run `make build` from a tagged commit. If you downloaded it from GitHub releases, file an issue.

### Sidebar drag-and-drop doesn't work

Drag-and-drop is disabled while the sidebar search has text in it (because the sorted order is by relevance, not user-defined). Clear the search box and drag works again.

### A folder won't accept any more requests

Folders cap at 50 requests for performance. Either move some requests up to the parent collection, or split the folder into subfolders.

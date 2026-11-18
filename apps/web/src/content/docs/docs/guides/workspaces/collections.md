---
title: "Manage collections"
---

## Collections

A collection groups related requests inside a workspace. There's no maximum — you can have hundreds of small collections or a few large ones.

### Creating a collection

- Sidebar header → **+** (the plus button)
- Workspace overview → *Start* → **New collection**
- Right-click anywhere in the empty sidebar area → *New collection*
- Empty-state CTA when a workspace has no collections yet

Each collection has a **name**, a **filesystem name** (auto-derived for Git sync), and child folders/requests. Inline rename: double-click the collection title in the sidebar.

### Collection menu

The `⋯` button next to a collection reveals:

- **Add request** / **Add folder** — quick creators that drop new items into this collection
- **Settings** — opens the collection overview and its defaults. Click **Run** at the top of that page to open the [Collection Runner](/docs/guides/collection-runner/) for this collection.
- **Rename** — opens the same inline editor as double-click.
- **Export…** — opens the format picker for [collection exports](/docs/guides/import-export/export/#export), including files and folders.
- **Show in Finder** / **Show in Explorer** — shows the collection's folder in the workspace on disk, so you can see its YAML files or open them in another editor. On Linux it is **Show in file manager**.
- **Delete collection** — asks for confirmation before removing the collection and its contents. You can restore it from **Recently deleted** until you quit Kurlo.

### Drag-and-drop reorder

Hover the `⋮⋮` handle on the left of a collection row to grab it. Drag onto another collection — drop above (top half) or below (bottom half) to set the new position. Order persists between sessions.

Drag-and-drop is disabled while a search is active in the sidebar (the order you see is sorted by relevance, not user order).

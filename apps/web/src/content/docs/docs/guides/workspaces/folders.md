---
title: "Folders and defaults"
---

## Folders

Folders are optional. They're useful when a single collection has too many requests to scan quickly.

### Creating a folder

- Collection `⋯` menu → **Add folder**
- Inside a folder, the folder's `⋯` menu → **Add subfolder**

Folders can nest up to **4 levels deep** (a cap to keep the tree usable). Empty folders are preserved, so creating a folder does not force you to create a request immediately. Once a folder contains **50 requests**, **Add request** is disabled in its menu, and moving, duplicating or pasting more requests into it is refused. Each folder has its own limit: requests in subfolders and at the collection root do not count toward it.

## Collection defaults

Open a collection workspace to configure reusable headers, variables, auth, scripts, tests, and transport settings. Requests can override headers and settings per field; auth is inherited only when the request uses **Inherit auth**. Active environment values override collection variables with the same key.

To set headers, authentication, a pre-request script, or tests for a folder and its subfolders, open the folder's **⋯** menu and choose **Settings**. See [Folder defaults](/docs/guides/collection-defaults/folders/) for inheritance and storage.

### Folder menu

The `⋯` next to a folder offers:

- **Add request** — drops a new request inside this folder
- **Add subfolder** — creates a child folder
- **Run folder** — Collection Runner scoped to just this folder's requests
- **Settings** — edit the folder's defaults
- **Rename** — inline rename
- **Delete folder** — asks for confirmation before removing the folder and its contents.

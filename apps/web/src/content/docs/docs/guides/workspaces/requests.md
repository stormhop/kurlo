---
title: "Manage saved requests"
---

## Requests

A request is the leaf of the tree. Each request has its own URL, method, headers, body, auth config, pre-request and test scripts, settings, and notes.

### Creating a request

- Collection or folder `⋯` menu → **Add request**
- Workspace overview → *Start* → **New request**
- Drafts: **+** after the open tabs opens an unsaved HTTP request. Untitled drafts are numbered, such as **New Request 2**, and a draft gets a dot on its tab once you change it; an untouched draft closes without asking. Use the method and protocol picker at the start of the URL bar to switch request types before saving.

With manual saving, a request added from a collection or folder starts as a draft too. It already uses the headers, auth, scripts and variables of that collection and folder, and **Save** puts it there without asking where. With autosave on, it is saved straight away.

Closing a draft asks whether to save it only when you have changed it since it opened. An untouched draft, like an empty tab from **+**, closes without asking.

### Tab menu

Right-click a request tab to close it, close the other tabs, close the tabs to its right or close all tabs. Tabs with unsaved changes still ask before closing. The same menu duplicates the request, copies its URL or a cURL command, and shows its file in Finder or File Explorer.

### Encoding selected text

Select text in the URL, a param, a header or another field and right-click it to **Encode URI component**, **Decode URI component**, **Encode Base64** or **Decode Base64**. Kurlo replaces the selection and keeps the result selected, so you can undo it with `⌘Z` or `Ctrl+Z`. Base64 decoding also reads the URL-safe alphabet used in JWTs. Actions that would not change the text, or cannot decode it, are dimmed.

### Docs

The **Docs** tab of a request is written in Markdown: headings, **bold**, `code`, lists, task lists, tables, quotes, links and images. **Edit** shows the text on the left and a live preview on the right; **Preview** shows the rendered page, followed by a reference Kurlo builds from the request itself: the method and URL, the auth type, and the enabled path variables, query params, headers and body, with the description you gave each row. Links open in your browser, and secret values are masked. A request without docs opens in **Edit**; `Esc` goes back to the preview.

![Docs tab of a request rendered as Markdown with a table and a link](../../../../../assets/screenshots/request-docs.png)

### The request `⋯` menu

Right-click (or click the `⋯` button on hover) on any request to reveal:

- **Rename** — inline rename; double-click the title also works. The new name is saved at once, also with manual save; other unsaved edits of the request still wait for **Save**
- **Duplicate** — clones the request, including auth/headers/body/scripts
- **Star** / **Unstar** — adds the request to the *Starred* group at the top of the sidebar, or removes it.
- **Copy as cURL** — copies a `curl` command for a supported request. Review the command before sharing it.
- **Show in Finder** / **Show in Explorer** — opens the folder that holds the request's YAML file with the file selected. On Linux it is **Show in file manager**: file managers that support it, such as Files (Nautilus), Dolphin, Thunar, Nemo and Caja, select the file too, and others open its folder. Unsaved drafts have no file yet, so they do not offer it.
- **Delete** — asks for confirmation before removing the request. You can restore it from **Recently deleted** until you quit Kurlo.

### Reordering requests

Open **⋯** next to **Collections**. Under **Sort requests**, choose how requests appear at the collection root and inside each folder. **Manual** is the default and shows the saved order. **By name** lists requests alphabetically within each group. Kurlo remembers your choice across workspaces and restarts on this device. The Collection Runner uses the saved order in either view.

To change the saved order, choose **Manual** and clear the sidebar search. Hover a request to reveal its `⋮⋮` handle, then drag it onto the top or bottom half of another request in the same folder or at the collection root. A line shows where it will land. Kurlo saves this order in `collection.yml`.

In either view, you can move a request by clearing the search and dropping it onto a folder header, an empty folder or a collection header, in this collection or another one of the workspace. Nested and collapsed folders accept drops too. With **By name**, dropping onto another request moves it into that request's folder. Empty source folders are kept. A place that cannot take the request shows the not-allowed cursor.

A request moved to another collection inherits that collection's and folder's auth, headers, variables and scripts from then on, and its examples move with it. A request linked to an OpenAPI source loses the link, because the source belongs to the old collection.

### Working with several requests

Select requests in the collection tree without opening them:

- **Cmd-click** on macOS or **Ctrl-click** on Windows and Linux adds a request to the selection or removes it. The first one also keeps the request you have open.
- **Shift-click** selects every visible request between the last one you clicked and this one.
- **Cmd/Ctrl+A** with the focus in the tree selects every visible request. Requests inside collapsed folders are left out.
- **Escape**, a plain click or the `×` in the *N selected* bar clears the selection. The bar takes the place of the **Collections** header while requests are selected.

Drag any selected request to move the whole selection. Dropping onto a folder header, an empty folder or a collection header moves every selected request there, from any folders and collections of the workspace. With **Manual** order, dropping onto another request places them above or below it, in their current order, in that request's folder. With **By name**, the drop moves them into that folder. A folder holds at most 50 requests, so a move that would overflow it is refused. Dragging a request that is not selected moves only that request and keeps the selection. After a selection moves, it is cleared.

Right-click a selected request to **Duplicate**, **Star** or **Unstar**, **Load test selected** (requests of one collection) or **Delete** the whole selection. **Backspace** and the duplicate shortcut work on the selection too. Kurlo asks once before deleting, and **Recently deleted** keeps the requests as one entry that restores them in place.

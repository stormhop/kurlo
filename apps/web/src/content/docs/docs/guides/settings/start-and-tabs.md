---
title: "Startup and tabs"
---

## Preview tabs

Under **Editing**, enable **Preview tabs** to browse saved requests without accumulating tabs. Each newly opened request replaces the temporary tab, whose name is italic. Requests that already have an open tab switch to that tab.

Double-click the temporary tab to keep it open. Editing or running its request also keeps the tab automatically, including active WebSocket, Socket.IO, SSE and gRPC requests. New unsaved requests always have their own tabs.

The switch is off by default. Turning it on leaves existing tabs open; turning it off keeps the current preview as a regular tab. The preference and the preview tab are restored after a restart, and the preference is included in **Export all data**.

## On launch

The **On launch** list chooses the screen Kurlo opens on; the row describes the current choice:

| Option | What you see |
|--------|--------------|
| **Request editor** *(default)* | Your open tabs on the request editor. With no requests yet, a new unsaved HTTP request. |
| **Where you left off** | The last screen of the previous session — Git, the runner, a collection, an environment or the overview. |
| **Workspace overview** | Collections, recent history and storage for the active workspace. |

Your open tabs come back in every mode; only the screen in front changes. A workspace that needs attention, such as a missing folder or broken YAML, opens where you can fix it whatever this is set to.

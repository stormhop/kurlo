---
title: "Saving"
---

Under **Editing**, the **Saving** row switches between two modes:

- **Autosave** saves edits automatically.
- **Manual save** keeps edits unsaved until you click **Save** or use the save shortcut. A dot on the request tab marks unsaved work.

With autosave on, the number next to the **Saving** switch is the autosave delay: how long Kurlo waits after your last edit before it writes to disk, from 100 to 30,000 milliseconds. The default is 1,200. Every editor that autosaves uses it, and the setting is kept on this computer and in an all-data export.

The mode covers every editor that has a **Save** button: requests, collection and folder settings, load tests, environments (name, **Inherits from** and variables), global variables and the workspace README. With manual save, nothing you type in them reaches the disk until you save, even when another action — switching the environment in use, creating an environment, renaming a collection — writes the workspace. Every one of them has the same two buttons in its header: the round arrow (**Revert**) throws the unsaved edits away, and **Save** turns into a dimmed **Saved** once there is nothing left to save. Quitting asks what to do with unsaved edits.

Some things are saved right away in both modes, because they are actions rather than edits: creating, renaming from the sidebar, moving and deleting collections, folders and workspaces; **Protect from AI agents** and **Sandbox for the agent**; the environment in use; history, cookies and run results; and values that scripts write with `pm.environment.set(...)`, `pm.globals.set(...)` and similar calls. A value a script writes is saved on its own, without the unsaved edits next to it.

In manual-save mode, an all-data export contains the last saved version of each request, not unsaved editor changes. Kurlo warns you before exporting when dirty requests exist.

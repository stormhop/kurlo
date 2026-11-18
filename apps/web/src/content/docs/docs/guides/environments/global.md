---
title: "Global variables and saving"
---

## Global variables

**Environments → Globals** holds variables that apply to every request in every workspace. They are the lowest-priority scope: an environment (or collection) value with the same name wins.

Use them for values that are not tied to one environment — a personal API key, a machine-specific port, or something a script produced that later requests need. Scripts read and write them with [`pm.globals`](/docs/reference/scripting-api/variables/), and a value written during a send shows up in the editor once the request finishes.

Globals are saved with your local data rather than in the Git-backed workspace YAML, so they do not travel to teammates in a shared repository.

## Manual save vs autosave

Environment edits follow the same save mode as requests:

- **Autosave on:** edits persist after the [autosave delay](/docs/guides/settings/saving/) from your last change.
- **Manual save:** renaming an environment, changing **Inherits from**, editing variables in either view and **Import .env** mark the environments unsaved. They reach the disk only when you click **Save** or press the save shortcut, and **Revert** puts back the saved version. Other actions that write the workspace, such as switching the environment in use or creating one, leave the unsaved edits alone.

**Protect from AI agents**, **Sandbox for the agent** and **Delete** in the **•••** menu apply right away in both modes. Global variables follow the same rules, with their own **Save** and **Revert**.

Script updates from `pm.environment.set(...)` are merged back into the active environment after a request or runner execution.

---
title: "Read-only mode and protected environments"
---

## Read-only

Start the server with `--read-only` to offer only the tools that read and run. The write tools, `git_create_branch`, `git_commit` and `git_push` are then left out of the tool list, and calling one is refused.

## Protected environments

Mark an environment **Protect from AI agents** in its ⋯ menu in the app, and `kurlo mcp` refuses every call that would use it: `run_request`, `run_collection`, `send_request` and `start_load_test` with that environment, and edits to it through `set_variable` or `apply_changes`. The assistant is told to ask you to run the request in the app instead. Use it for production and anything else an assistant should not reach by picking the wrong environment.

The mark is saved in the environment's file as `protected: true`, so in a Git-backed workspace it applies to everyone on the team. `list_environments` shows it. An environment that [inherits](/docs/guides/environments/manage/#inheriting-from-another-environment) from a protected one is protected too; `list_environments` names its parent under `inherits` and lists the variables it inherits.

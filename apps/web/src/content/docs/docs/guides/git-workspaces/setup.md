---
title: "Set up a Git workspace"
---

## When to use Git storage

Use a Git-backed workspace when you want:

- API collections reviewed in pull requests.
- Stable YAML files instead of opaque JSON exports.
- Local-only secrets.
- Branches for API changes.
- Diff, conflict, commit, pull, and push workflows inside Kurlo.

Use the default app storage when the workspace is private, short-lived, or not meant to be shared.

## Requirements

Kurlo runs the `git` command rather than bundling its own, so Git storage needs Git installed and on the PATH:

- **Windows** — install [Git for Windows](https://git-scm.com/downloads); Windows ships none.
- **macOS** — run `xcode-select --install`. `/usr/bin/git` exists on a clean Mac but is only a stub until the Command Line Tools are installed.
- **Linux** — install `git` from your distribution's package manager.

Restart Kurlo after installing. Without Git, Kurlo says so on the Git screen and the folder still works as a local (non-Git) workspace — collections, environments, and requests all behave normally; only branches, commits, and remotes are unavailable.

## What Kurlo writes

Shared files:

```text
kurlo.yml
.gitignore
kurlo-agent.md
workspaces/**/*.yml
workspaces/*/README.md
```

The shared YAML contains workspaces, collections, explicit folder paths, requests, environments, defaults, scripts, and settings. Secret values are replaced with `{{kurloSecret:...}}` placeholders. Their real values stay in Kurlo's encrypted local `requests.json` profile instead of the Git workspace.

See [Kurlo YAML format](/docs/reference/kurlo-yaml-format/) for the public schema.

`kurlo-agent.md` holds the team's notes for the agent, if the workspace has them; see [Team notes in kurlo-agent.md](/docs/guides/agent/team-notes/#team-notes-in-kurlo-agentmd). Kurlo lists it under Changes and commits it with the rest of the workspace.

`workspaces/<workspace>/README.md` is the workspace README shown on the workspace overview, matched in any letter case (`Readme.md` works too). Kurlo lists it under Changes and commits it with the rest of the workspace, so a README a teammate pushes shows up after you pull.

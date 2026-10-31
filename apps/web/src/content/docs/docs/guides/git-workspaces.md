---
title: Git-backed workspaces
description: Store Kurlo workspaces as YAML files, keep secrets local, and collaborate through Git.
---

Kurlo can store workspace data in a folder instead of only inside the encrypted app profile. When that folder is a Git repository, the workspace becomes reviewable, branchable, and shareable with a team.

![Workspace overview with quick actions](../../../../assets/screenshots/workspace-overview.png)

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
workspaces/**/*.yml
```

The shared YAML contains workspaces, collections, explicit folder paths, requests, environments, defaults, scripts, and settings. Secret values are replaced with `{{kurloSecret:...}}` placeholders. Their real values stay in Kurlo's encrypted local `requests.json` profile instead of the Git workspace.

See [Kurlo YAML format](/docs/reference/kurlo-yaml-format/) for the public schema.

## Starting a folder workspace

From the workspace overview or Git workspace screen:

1. Choose a folder you control.
2. Let Kurlo write the workspace YAML files.
3. Optionally initialize Git in that folder.
4. Add a remote when you are ready to share.

Kurlo only manages its own files. Other project files in the same repository are left alone.

## Opening or cloning

You can open an existing folder workspace or clone a remote repository. After opening, Kurlo reads the YAML store, merges local secrets where available, and shows diagnostics for files it could not fully understand.

When the workspace uses secrets this computer does not have yet — after a clone, or on another machine — Kurlo lists them grouped by where they are used: each request by name, method and location, each collection and environment by name, and saved cookies by cookie name. Fill in the values you need now and choose **Later** for the rest; empty ones can be added where they are used.

If the folder is missing or moved, Kurlo enters recovery mode and lets you choose another folder, open an existing repository, or clone again.

## Daily Git flow

Open the Git workspace screen from the branch at the left of the status bar. The status bar also shows commits to push and pull (↑ ↓), how many Kurlo files changed, and a flag while a merge or rebase is in progress or when the tracked remote branch is gone. The screen covers the common loop:

![Git workspace tab with branch status, changed YAML files, and diff preview](../../../../assets/screenshots/git-workspace.png)

1. **Fetch** to update remote refs.
2. **Pull** using fast-forward, merge, or rebase strategy.
3. Edit requests, environments, folders, and collection defaults in Kurlo.
4. Review changed YAML files and diffs.
5. Stage selected files or all Kurlo files.
6. Commit with a message.
7. Push to the configured upstream.

Kurlo shows ahead/behind counts, current branch, upstream status, remotes, stashes, changed files, commit history, and outgoing commits.

## Branches and stashes

Branch tools include:

- Checkout local or remote branches.
- Create a branch from current HEAD or from a remote branch.
- Rename and delete branches.
- Pull a specific branch.
- Set tracking/upstream where needed.

Stash tools are available when local changes would block a pull or branch operation. You can stash, pop a stash, or let Kurlo offer an autostash-style flow before pulling.

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

## Changes made outside Kurlo

A folder or file is always named after the workspace, collection, request, or environment it holds, so paths in Git read like the names in the app. When a name changes, in the app, by editing the YAML, or in a pulled commit, Kurlo moves the file on its next save and Git shows a rename under Changes; commit it like any other change. Opening or pulling never moves files by itself. An object's ID never changes with its name.

Folders decide what belongs where. A collection belongs to the workspace folder it sits in, a request to its collection folder, and an environment to its workspace folder. The `workspaceId`, `collectionId`, and `requestId` fields in child files are copies of that. If they disagree with the folder, Kurlo follows the folder and corrects the field as soon as it loads the folder, changing only that line. Changing an ID in `workspace.yml` or `collection.yml` therefore needs no other edits: commit the corrected files Kurlo shows under Changes together with your change. Moving a folder moves everything inside it.

Order lists such as `workspaceOrder`, `collectionOrder`, and `requestOrder` only set the order. An entry for a file that no longer exists is skipped. When exactly one ID in a list changed, Kurlo replaces the old entry with the new one so the order stays the same.

Some changes leave Kurlo unable to tell which file is right, and these pause saving:

- Two objects of the same kind share an ID, usually because a folder was copied. Kurlo reports the copy once and keeps showing the original.
- An object has no ID.
- `kurlo.yml`, `workspace.yml`, or `collection.yml` was deleted but files inside its folder remain.
- A response example has no matching request file.

When this happens, the Git screen lists one entry per problem and pauses editing and commits for the open workspace folder. Fix the listed file with **Edit YAML**, or pull a commit that fixes it. Kurlo does not guess a replacement.

## Safety rules

- Kurlo does not write real secret values into managed workspace YAML. Tokens, passwords, client secrets, AWS keys and session tokens, OAuth 2.0 refresh tokens and private keys, and the client-certificate passphrase are all replaced by a `{{kurloSecret:…}}` placeholder in the file.
- Local secret values remain in the encrypted Kurlo profile and are not staged by the Git workspace UI.
- Kurlo does not discard unrelated repository files.
- Destructive actions such as discard and force-push are explicit UI actions.
- Unknown YAML fields are preserved where possible so future versions and third-party tools can coexist.

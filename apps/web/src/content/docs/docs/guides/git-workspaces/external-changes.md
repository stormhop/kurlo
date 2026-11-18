---
title: "Changes made outside Kurlo"
---

A folder or file is always named after the workspace, collection, request, or environment it holds, so paths in Git read like the names in the app. When a name changes, in the app, by editing the YAML, or in a pulled commit, Kurlo moves the file on its next save and Git shows a rename under Changes; commit it like any other change. Opening or pulling never moves files by itself. An object's ID never changes with its name.

Folders decide what belongs where. A collection belongs to the workspace folder it sits in, a request to its collection folder, and an environment to its workspace folder. The `workspaceId`, `collectionId`, and `requestId` fields in child files are copies of that. If they disagree with the folder, Kurlo follows the folder and corrects the field as soon as it loads the folder, changing only that line. Changing an ID in `workspace.yml` or `collection.yml` therefore needs no other edits: commit the corrected files Kurlo shows under Changes together with your change. Moving a folder moves everything inside it.

Order lists such as `workspaceOrder`, `collectionOrder`, and `requestOrder` only set the order. An entry for a file that no longer exists is skipped. When exactly one ID in a list changed, Kurlo replaces the old entry with the new one so the order stays the same.

Some changes leave Kurlo unable to tell which file is right, and these pause saving:

- Two objects of the same kind share an ID, usually because a folder was copied. Kurlo reports the copy once and keeps showing the original.
- An object has no ID.
- `kurlo.yml`, `workspace.yml`, or `collection.yml` was deleted but files inside its folder remain.
- A response example has no matching request file.

Response examples are read in the background just after a workspace opens. If one of them turns out to be unreadable, Kurlo refuses to save until it reloads the workspace, which it does by itself, and then lists the file like any other problem.

When this happens, the Git screen lists one entry per problem and pauses editing and commits for the open workspace folder. Fix the listed file with **Edit YAML**, or pull a commit that fixes it. Kurlo does not guess a replacement.

## Safety rules

- Kurlo does not write real secret values into managed workspace YAML. Tokens, passwords, client secrets, AWS keys and session tokens, OAuth 2.0 refresh tokens and private keys, and the client-certificate passphrase are all replaced by a `{{kurloSecret:…}}` placeholder in the file.
- Local secret values remain in the encrypted Kurlo profile and are not staged by the Git workspace UI.
- Kurlo does not discard unrelated repository files.
- Destructive actions such as discard and force-push are explicit UI actions.
- Pull, checkout, stash, commit, discard and conflict resolution wait while `kurlo mcp` or another Kurlo process is writing the workspace, so a commit never captures half of an agent's batch of changes.
- Unknown YAML fields are preserved where possible so future versions and third-party tools can coexist.

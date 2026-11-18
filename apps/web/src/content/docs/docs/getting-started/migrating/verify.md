---
title: "Verifying the import"
description: "Check imported auth and variables, then send a request to verify its response."
---

After importing, do a smoke test:

1. Open the most-used request from the collection. Check headers, body, and auth all look right.
2. Pick the active environment with the environment switcher in the title bar. Confirm the variables resolve: in the URL bar, a `{{variable}}` the environment does not define is marked in red, and one it does define stays plain.
3. Press *Send*. The response should match what you'd get in the source app.

Kurlo leaves your source files untouched. If something doesn't carry over correctly, you can import the collection again or file an issue with an anonymized sample.

## Keeping both tools in sync

You can keep Kurlo and Postman around in parallel during transition:

- To move a collection back to Postman, open its **⋯** menu and choose **Export…**. See [Postman export formats](/docs/guides/import-export/postman/#export-to-postman-v3) to choose between JSON and a YAML folder.
- Use a [Git-backed workspace](/docs/guides/git-workspaces/open/) to track changes to your collections. Kurlo stores shared data as YAML and keeps local secrets outside Git.

Once you're committed to Kurlo, the export pipeline still works — your data is never trapped.

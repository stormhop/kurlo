---
title: "From Bruno"
description: "Import an OpenCollection YAML or legacy .bru collection folder into Kurlo."
---

Use your existing Bruno collection folder. Kurlo reads OpenCollection folders with `opencollection.yml` and legacy Bruno folders with `bruno.json` and `.bru` files.

## Import into Kurlo

1. Open the destination workspace in Kurlo.
2. In the sidebar, click **Import collection** next to **+**. Select **Bruno / OpenCollection**, then click **Import**.
3. Select the collection's root folder. You can also drop that folder into the Kurlo window.

## What carries over

Kurlo recreates the collection with its requests and folder structure. It adds environments from the source collection's `environments/` folder to the current workspace.

Supported headers, authentication, and scripts at collection and folder level become [defaults](/docs/guides/collection-defaults/). See [Bruno import details](/docs/guides/import-export/bruno/) for how collection, folder, and request variables are mapped.

## Verify the import

Select an imported environment and check the variables and credentials used by a request you send often. Kurlo copies script source, so review any `bru.*` calls and replace them with equivalents from the [Kurlo scripting API](/docs/reference/scripting-api/). Then [verify the imported request](/docs/getting-started/migrating/verify/).

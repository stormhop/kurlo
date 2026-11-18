---
title: "Pin an environment to a collection"
---

## Pinning environments to a collection

When one workspace holds several services, pin each collection's environments to it so the switcher shows only those while you work in that collection.

1. Open the collection's settings and go to **Overview**.
2. Under **Environments**, click **Pin an environment…**, type to search and pick one. Repeat for every environment that belongs to this collection.
3. Click **Set as default** next to the one to select when you open the collection. Without a choice, the first pinned environment is the default.

Only pinned environments are listed there. Click **×** next to one to unpin it.

While a request from that collection or its settings are open:

- The switcher lists **No environment**, then the pinned environments. The rest of the workspace sits under **Other environments**, collapsed. You can still pick one from there.
- Opening the collection selects its default environment, unless the active one is already pinned to it. A short message says which environment is now in use.
- If you pick another environment while you stay in the collection, Kurlo keeps your choice.
- When you move on to a collection without pinned environments or to a new request, Kurlo switches back to the environment you had before you opened the pinned collection. If you picked an environment from **Other environments** while inside, it stays.

Collections without pinned environments list every environment, as before. An environment can be pinned to several collections. Deleting an environment unpins it everywhere.

Pins are saved in `collection.yml` as `environmentIds` and `defaultEnvironmentId`. They only change the app's switcher: `kurlo run` and `kurlo mcp` still use the environment you name.

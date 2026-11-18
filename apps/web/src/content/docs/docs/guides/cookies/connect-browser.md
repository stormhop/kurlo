---
title: "Connect a browser"
---

## Connecting a browser

1. Open **Browser sync** in the cookie sidebar and turn on the switch at the top of the page.
2. Under **Browser extension** on the same page, pick **Chrome, Edge, Brave** or **Firefox**.
   Kurlo puts the extension in a folder and opens it. In Chrome, Edge or Brave, open
   `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick that
   folder. In Firefox, open `about:debugging#/runtime/this-firefox`, press
   **Load Temporary Add-on** and pick `manifest.json` in it.
3. Open the extension and press **Connect**. It scans ports 3199–3203 for Kurlo's bridge.
4. Approve the request in Kurlo once the codes match. Kurlo hands the extension a token;
   from then on it reconnects on its own and never asks again.
5. Press **Grant domain access** in the extension and accept the browser's prompt, so it
   may read the allowlisted domains.

The extension has the same version as Kurlo. Kurlo keeps the folder up to date when it
updates, so the browser loads the new version the next time it starts, or when you press
**Reload** on the extension. If a connected extension is older than Kurlo, the page says so.
Each release on GitHub also has the extension as a zip, `kurlo-cookie-sync-<version>-chromium.zip`
and `-firefox.zip`, for setting it up without the app.

**Pair manually** in both places is the fallback for when discovery cannot work — a
non-default port, say. The code it shows carries the port and the token, so treat it like a
password. In Kurlo it sits under **Connection**, hidden until you press **Show code**.

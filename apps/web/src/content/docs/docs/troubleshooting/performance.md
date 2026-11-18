---
title: "Performance"
---

## "App feels sluggish when typing in the URL"

Open **Settings → General → Editing** and find the **Saving** row. With **Autosave** enabled, Kurlo saves after the configured delay, which defaults to 1,200 ms. If this interrupts editing, increase the delay or choose **Manual save**. Save edits with **Save** or `Cmd/Ctrl S`.

To remove stored history, open **History** in the activity rail and choose **⋯ → Clear all**. This clears history across workspaces in the current profile.

## Huge response slows everything down

Responses over 100 MB are truncated while being read; bytes beyond the cap are not kept in memory and cannot be recovered with **Save to file**. For very large downloads, use a dedicated download tool until Kurlo supports uncapped streaming-to-file.

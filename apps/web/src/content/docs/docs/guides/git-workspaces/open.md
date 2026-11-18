---
title: "Open or clone a workspace"
---

## Starting a folder workspace

1. Click **Local storage** in the status bar to open the Git and storage screen.
2. Choose **New folder workspace…** and name the folder.
3. Select **Create empty workspace** or **Copy current workspaces**, then click **Create** and pick the parent directory. Kurlo writes the workspace YAML files into the new folder.
4. To track the folder with Git, choose **Init Git here**. Add a remote when you are ready to share.

Kurlo only manages its own files. Other project files in the same repository are left alone.

## Opening or cloning

On the Git and storage screen, choose **Open existing repo** to pick a local Git repository, or **Clone from URL** to download one into a new folder. To open an existing Kurlo folder workspace directly, use **Open a workspace** on the welcome screen. Kurlo reads the YAML store, merges local secrets where available, and shows diagnostics for any files it could not load.

When the workspace uses secrets this computer does not have yet — after a clone, or on another machine — Kurlo lists them grouped by where they are used: each request by name, method and location, each collection and environment by name, and saved cookies by cookie name. Fill in the values you need now and choose **Later** for the rest; empty ones can be added where they are used.

If the folder is missing or moved, Kurlo enters recovery mode and lets you choose another folder, open an existing repository, or clone again.

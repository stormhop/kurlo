---
title: "Configure collection defaults"
---

## Available defaults

| Tab | What it defines |
|-----|-----------------|
| Overview | Documentation, pinned environments, and a summary of every default below. |
| Headers | Header rows merged into child requests. |
| Vars | Collection variables, including values marked secret. |
| Auth | Default authentication scheme and credentials. See [Authentication](/docs/guides/authentication/) for supported schemes. |
| Script | Collection pre-request script for the selected JavaScript or Tengo engine. |
| Tests | Collection test script for the selected engine. |
| Proxy | Transport defaults such as HTTP version, TLS verification, client certificates, redirects, and proxy URL. |

Use the app-wide script-engine setting to switch between the independently stored JavaScript and Tengo fields.

## Overview

The **Overview** tab shows what the collection applies to its requests at a glance:

- **Applied to every request** lists Headers, Variables, Auth, Pre-request script, Tests, and Proxy and settings with what each one sets (for example *2 headers*, *Bearer token*, *12 lines* or *None*). Click a row to open its tab.
- **Documentation** shows the collection notes as rendered Markdown; **Edit** switches to the text, and **Done** or **Esc** back. Long documentation is folded under **Show all**; documentation over 256 KB is saved but not previewed.
- **Environments** pins the environments the switcher lists while you work in the collection and picks the default one.

Click the collection name at the top to rename it in place (**Enter** saves, **Esc** cancels). **Run** opens the collection runner and **New request** adds a request to the collection. The **•••** menu holds **Export…**, **Reset defaults**, and **Delete collection**.

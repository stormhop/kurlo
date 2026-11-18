---
title: "Inheriting auth"
description: "Set collection or folder defaults and understand request overrides."
---

A request set to **Inherit auth** uses the auth of the nearest enclosing folder that sets one, or the collection's when none does. This is useful when an entire collection, or one part of it, talks to the same API. See [Folder defaults](/docs/guides/collection-defaults/folders/).

Postman and Bruno folders that have their own auth keep it as folder auth. Insomnia folder auth is flattened into request-level or collection-level settings where Kurlo can represent it. After a large import, spot-check the Auth tab for the most sensitive requests.

## The Auth tab wins over a hand-written header

Auth is applied after your header rows, so a request that has both bearer auth configured **and** an `Authorization` header typed by hand sends the one from the Auth tab. The same goes for whatever header name an API key is configured under.

That precedence has not changed, but Kurlo now says so: the response panel names the header that was replaced, instead of leaving you looking at a row that never went out. To send your own header, set Auth to **No auth**.

## Secrets and storage

Auth fields in Kurlo's local profile are encrypted at rest with AES-256-GCM. Kurlo writes the key to the OS credential store when available and keeps a `0600` recovery-key file in its app-data directory. In Git-backed workspaces, shared YAML receives `{{kurloSecret:...}}` placeholders while the real values remain in the encrypted local profile.

Never paste secrets into request URLs or committed YAML. Prefer secret environment variables or local auth fields.

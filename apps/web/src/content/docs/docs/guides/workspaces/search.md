---
title: "Search and bulk editing"
---

## Search

The sidebar search input filters requests by name, URL, and method as you type:

- Plain text matches request names and URLs
- Prefixing with `m:` filters by method (`m:POST users`)
- Filter is workspace-scoped — searching doesn't leak between workspaces

## Find and replace

**Find and replace…** in the menu of a collection or a folder searches every request inside it; the command palette offers it for the collection of the open request. It looks in the URL, query params, path variables, headers, form fields, the body (the query and variables of a GraphQL request), scripts, docs, and the auth fields that hold no secret, such as a token URL or a client ID.

- **Aa** matches case, **ab** matches whole words, and **.\*** takes a regular expression, whose groups the replacement can use as `$1` or `$<name>`.
- Each match shows the request, the field and the line, with the replacement previewed in place. **Replace** changes one match, **Replace in request** one request, and **Replace all** every match.
- **Undo** puts back what the last replace changed, unless a request was edited again since.

Secret values are never searched or rewritten: secret rows, tokens, passwords, client secrets and private keys stay as they are. With autosave off, a request with unsaved edits is skipped until you save it, so the replace cannot overwrite your edits.

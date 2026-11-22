---
title: "Precedence"
---

## Headers

Collection headers are added unless the request contains a row with the same key. Matching is case-insensitive. A request row therefore overrides, or can intentionally suppress, the collection row. Folder headers sit in between: a folder row overrides the collection and the folders above it, and a request row overrides them all.

## Variables

Collection variables are available as `{{name}}`. Active environment values override collection values with the same key:

```text
active environment > collection variable
```

Values marked **Secret** are masked in the UI and participate in Kurlo's local secret handling for Git-backed workspaces.

## Authentication

A request uses inherited auth only when its Auth type is **Inherit auth**. It then takes the auth of the nearest enclosing folder that sets one, or the collection's when no folder does. Selecting **No auth** or another explicit request auth type overrides both.

See [Authentication](/docs/guides/authentication/) for each supported scheme.

## Scripts and tests

Kurlo combines scripts in a defined order:

1. Collection pre-request script.
2. Folder pre-request scripts, outermost folder first.
3. Request pre-request script.
4. The network request.
5. Request test script.
6. Folder test scripts, innermost folder first.
7. Collection test script.

The combined script shares one scope. A top-level `const`, `let` or `class` with the same name at two levels is a redeclaration error that fails the whole request; give each level its own names, or use `var` for a helper you want to share. Postman combines its scripts the same way.

## Transport settings

Transport settings inherit per field. Editing a field in the request Settings tab marks only that field as overridden. Other fields can continue to inherit from the collection.

The request editor shows the applied collection defaults and labels individual values as inherited or overridden. Clicking **Reset** in the request Settings tab clears all request setting override markers, allowing collection values to apply again when the request is sent.

For proxy precedence beyond the collection, see [Proxy configuration](/docs/guides/proxy/).

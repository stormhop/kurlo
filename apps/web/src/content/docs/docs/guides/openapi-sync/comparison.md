---
title: "What sync compares"
---

For each request linked to an operation, sync compares the method and URL, query parameters, path parameters, headers, the body, the auth type, the Docs tab and the examples that came from the spec. It never touches pre-request and test scripts, assertions, request settings, request variables or examples you saved yourself.

The comparison is three-way. Kurlo keeps the spec from the last applied sync and compares both your request and the new spec with it:

- Only the spec changed a field: the spec's version is taken.
- Only you changed it: yours stays.
- Both changed it: it is a conflict, and yours stays unless you pick the spec.

Parameters and headers are compared row by row. A new row from the spec is added, a row the spec dropped is removed unless you changed its value, and rows you added yourself stay. A value you replaced with a `{{variable}}` is your change and is kept. The body is compared as a whole.

When an operation moves to a new path but keeps its `operationId`, sync treats it as a URL change of the same request rather than a removed and a new endpoint, so the request keeps its scripts and tests.

The first sync of a collection has no earlier spec to compare against. Every difference between your requests and the spec is then shown as a conflict, with your version kept by default.

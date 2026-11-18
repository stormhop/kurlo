---
title: "Build a flow"
---

Each virtual user, or **VU**, runs the steps from top to bottom. One pass through the flow is an **iteration**. Steps that run once per user are grouped under **Setup**, the rest under **Every iteration**. Each step shows the values it saves, the saved values it uses from earlier steps, its checks and its wait. Add a request with **+ Add request from collection**, click a step to edit its settings, and use the move buttons that appear on the selected or hovered step to change the order. To replace its request, use the **Replace request** button beside the move and remove buttons. Replacing a request keeps the step’s checks, saved values and waits. The compact name field and **Save** / **Revert unsaved changes** controls above the flow work like those on saved requests. Revert restores the whole test to its saved state. Use the load test’s sidebar menu to **Run with k6**, **Export k6 script**, **Rename**, **Duplicate** or **Delete** it; **Run with k6** there runs the saved version. A dot beside the name shows the last result: green for passed, red for failed, amber for stopped, and a pulsing blue dot while it runs; double-click its sidebar name to rename it inline. **Open request** opens the linked request itself.

## Run once per user

Steps normally run on **Every iteration**. Choose **Once per user** for setup that each VU should do only once, such as logging in. Each VU has its own saved values; a token extracted by one user is not shared with the others.

## Save values from a response

In **Save from response**, click **+ Save a value**, name the variable and choose its source:

| Source | Path example | Saved value |
| --- | --- | --- |
| JSON path | `$.access_token` | The response's `access_token` field |
| JSON path | `$.items[0].id` | The first item's `id` |
| JSON path | `$['x-request-id']` | A field whose name needs brackets |
| Header | `X-Request-Id` | The response header value |
| Regex | `orderId=(\w+)` | The first capture group |

Use simple property paths and array indices for JSON extraction; JSONPath filters, recursive searches and wildcards are not supported. Variable names can contain letters, digits and underscores, must not start with a digit, and must be unique across extraction rules in the flow.

For a login → orders flow:

1. Save a **Login** request whose JSON body uses `{{email}}` and `{{password}}`.
2. Add it as the first step, choose **Once per user**, and save `token` from JSON path `$.access_token`.
3. Set the **List orders** request's bearer token to `{{token}}` and add it as the next step.

Variable lookup starts with extracted values, then checks the current data row, the request’s **Pre Request Vars**, the chosen environment, and collection/global defaults. If a row omits a field, the request can still use its default. A value saved by a step becomes available to subsequent steps and later iterations of that VU.

## Check responses

Click **+ Add check** to check the status, the presence of a JSON field, or whether the body contains text. For example, check **Status is** `200` on Login and **JSON field exists** `$.items` on List orders.

A failed check lowers the **Checks passed** rate; it does not stop the flow or make the run fail by itself. Add a threshold for **Checks passed** when those checks should decide whether the run passes.

## Wait between requests

**Wait after this step** is a minimum delay. **Random extra wait** adds a random amount on top. A wait of `500ms` plus up to `1s` pauses for between half a second and one and a half seconds. For a once-per-user step, the wait happens only when that step runs.

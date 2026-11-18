---
title: "Rules and reports"
---

## Pass and fail rules

A request passes when:

- The transport succeeds.
- The response status is below 400 for HTTP/GraphQL.
- gRPC returns `OK`.
- All test-script assertions pass.

A request fails when the transport errors, headers are invalid, a script errors, a status is considered failed, or any test assertion fails.

## Reports

After a run, click **Download report** to save an HTML report. It includes:

- Summary counts.
- Duration.
- Delay/parallel/filter/data-file settings.
- Every request result.
- Test names and failures.

Reports are local files; Kurlo does not upload them anywhere.

## Last run

Kurlo remembers the most recent finished run of each collection — every request's status, time, checks and error, up to 500 results. Open the runner on that collection, or switch its *Collection* picker back to it, and the results are there with *Last run* and when it happened above them, until you run again. The collection's own page shows the same run as one line — *Last run 2 hours ago · 12 of 13 passed* — and the link opens the runner.

The request list and the results are one continuous list each, however many requests the collection has: scroll through them, there are no pages.

After a run, **Failed** above the results narrows the list to the requests that failed or errored, with their failed checks; **All** shows everything again.

A run where every request was skipped is not recorded. The results live in the encrypted local profile next to your history, never in the workspace YAML, so they are not committed to Git and stay on this device.

## Common gotchas

- **No runnable requests:** the selected collection only contains realtime requests or empty folders.
- **gRPC request fails immediately:** select a gRPC method before running it.
- **Environment values changed:** scripts can call `pm.environment.set`; after the run Kurlo merges the final environment state back into the active environment.
- **Cookies changed:** the cookie jar is refreshed after the run, just like after normal sends.

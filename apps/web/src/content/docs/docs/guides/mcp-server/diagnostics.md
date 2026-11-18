---
title: "Diagnose API requests"
---

## When a request fails

`diagnose_last_failure` takes the most recent request sent from the app that got no response, a 4xx or 5xx status, or failing tests, or the history entry you name, and returns:

- the status, the error and the failed tests;
- `unresolvedVariables`: the `{{variables}}` the request uses that nothing sets in the environment active in the app;
- `example`: how the response differs from the request's saved example, with missing fields, fields that changed type and a different status;
- `hints`: the likely cause in plain words, such as a server that is not running, a host that does not resolve, a `401` because the login request has not set `{{token}}` yet, a method typed into the URL field, or a pre-request script that threw.

It only reads, so it is there with `--read-only` too.

## What you just sent from the app

The assistant can read the requests you send from the Kurlo app, so you can debug together without copying anything: send a request, then ask "why did my last request fail?" `get_history_entry` with no arguments returns the last request sent from the app with its response, test results and script logs, and `list_history` finds older ones, such as every request that failed today.

These tools read the [history](/docs/guides/history/) that Kurlo keeps on this machine, for every workspace, including requests you never saved. Secrets are masked as everywhere else: values Kurlo stores as secrets, auth credentials and the values of headers like `Authorization` and `Cookie` come back as `[secret]`. Both tools only read, so they are also there with `--read-only`.

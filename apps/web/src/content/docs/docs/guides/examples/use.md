---
title: "Use a saved example"
---

## Comparing a response against an example

The response panel's **Diff** tab can use a saved example as its baseline instead of the previous response. This is what stops an example from quietly going stale: an endpoint that no longer matches the contract shows up as a diff rather than passing unnoticed.

The baseline is chosen per request, and falls back to the previous response if the example it pointed at is deleted. See [Response viewer](/docs/guides/response-viewer/).

## Examples suggest body keys

While you write a JSON body, Kurlo offers the next key from the bodies of the request's examples in faded text; `Tab` accepts it. See [Suggestions while you type](/docs/guides/request-types/http/#suggestions-while-you-type).

## Examples feed the mock server

Once a collection has examples, Kurlo can serve them over HTTP — path templates, status codes, headers and bodies, exactly as captured. That is the [mock server](/docs/guides/mock-server/), and it needs no extra configuration: an example is already a route.

A captured URL is stored as a path template, so `/orders/8123` is recorded as `/orders/:id` and the mock answers for any id. You can edit that template on the example if the guess was wrong.

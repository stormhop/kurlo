---
title: "OAuth 2.0 in CI"
---

A run gets its own access token rather than relying on one the app saved. The saved token lives in the machine-local secret store and never reaches a checkout, so relying on it would mean an OAuth-protected collection simply could not run in CI.

Which grants a run can complete on its own:

| Grant | In a run |
|-------|----------|
| Client Credentials | Fetched from the token endpoint. |
| Password | Fetched from the token endpoint with the configured credentials. |
| Authorization Code / Device Code | Both need a person at a browser. A run swaps the stored **refresh token** instead, which is how these grants are meant to be renewed unattended. |

All the requests in a run that share one configuration authenticate once — fifty requests do not mean fifty round trips to the token endpoint.

When a grant needs a browser and there is no refresh token to fall back on, the run stops on that request and says so, rather than sending it unauthenticated and reporting a 401 you then have to diagnose.

Keep the client secret out of the workspace and pass it in:

```bash
kurlo run . --env CI --var oauthClientSecret="$OAUTH_CLIENT_SECRET"
```

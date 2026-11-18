---
title: "Import OpenAPI or Swagger"
---

## From OpenAPI / Swagger

Select **OpenAPI / Swagger** in **Import collection**, click **Import**, and choose a JSON or YAML spec. Kurlo builds one request per operation, grouped into folders by the operation's first tag, with the summary as the request name and the description as its Docs tab. The YAML that spec generators such as Jackson and springdoc write is read as is, including lists at the same indent as their key, quoted strings that continue over several lines and `[...]` or `{...}` collections split over several lines. A YAML file with several documents separated by `---` is rejected with a message rather than merged.

The point is a collection you can send straight away, so three things land on the collection rather than being baked into each request:

- **Servers** become a `baseUrl` variable, as in Bruno, and every request URL starts with `{{baseUrl}}`. Servers declared on the document go to the collection's **Vars** tab. Servers declared on a path or operation go to that request's [**Vars**](/docs/guides/environments/request-variables/) tab instead; the operation's list wins over the path's. A request whose servers match the document's has no row of its own. The first server is switched on; alternatives such as Sandbox are switched-off `baseUrl` rows, and the description of each row names the server, for example *Sandbox server from the spec*. To switch, untick the first row and tick the alternative. Request variables win over the environment, so a `baseUrl` in an environment changes only requests without their own row. Server template variables use their defaults or first enum value; a missing value stays a `{{variable}}` for you to fill in. Imports from a URL resolve relative server addresses against the spec URL.
- **Path parameters** become [path variables](/docs/guides/request-types/http/#path-variables): `/users/{userId}` imports as `/users/:userId`, with the value seeded from the spec's `example` or `default` in the request's **Params** tab. A parameter that is only part of a segment, such as `/files/{name}.json`, cannot be a path variable and becomes a collection variable instead.
- **Security schemes** become auth. A scheme declared for the whole document lands on the collection and each request is set to **Inherit auth**; an operation with its own `security` carries that instead, and `security: []` means the operation is public. HTTP basic, digest and bearer, API keys (with the name and location the spec gives), and OAuth 2.0 (with its token and authorization URLs and scopes) are mapped. The credentials themselves are not in a spec, so each one points at a collection variable — `{{bearerToken}}`, `{{apiKey}}`, `{{oauth2ClientSecret}}` — giving you one place to fill in.

`openIdConnect` is left as **No auth**: its endpoints can only be discovered by fetching the provider's configuration, which the importer does not do.

Declared `responses` come across as [examples](/docs/guides/examples/), including a body derived from the response schema when the spec writes none — which means an imported spec can drive the [mock server](/docs/guides/mock-server/) straight away.

### From a URL

Select **OpenAPI / Swagger from URL** in **Import collection** and click **Import**. Paste the link in **Import from URL** and click **Import** again. A spec URL is what teams actually pass around, because it is the one that stays current, and Kurlo builds exactly the collection the file import would.

The document is fetched by Kurlo itself rather than by the embedded browser, so a spec host that sends no CORS headers still works, redirects are followed, and your [proxy](/docs/guides/proxy/) and TLS settings apply. A link with no scheme is read as `https`, and no cookies are sent.

If the server uses a self-signed, internal or expired certificate, tick **Skip TLS certificate check** in the same dialog. Kurlo then fetches the spec without verifying the certificate, so anyone between you and the server could change what you import: use it only for a server you trust. The box applies to that one import and is unticked every time the dialog opens; when a certificate is rejected, the error message points to it.

**Keep in sync with this URL** is ticked by default. Kurlo then remembers the URL, checks it for changes and shows them for review before anything changes. See [OpenAPI sync](/docs/guides/openapi-sync/).

The collection is named from the spec's `info.title`. When the spec has none, Kurlo falls back to the host rather than to a path segment like `/v3/api-docs`, which names the format instead of the API.

One mistake is common enough to name: **linking to the Swagger UI page rather than the document it renders**. The page is HTML, and Kurlo says so and points at where the document usually lives — `/swagger.json`, `/openapi.json` or `/v3/api-docs` — instead of reporting a parse failure.

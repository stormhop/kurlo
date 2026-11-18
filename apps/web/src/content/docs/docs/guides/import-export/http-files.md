---
title: "Import .http or .rest files"
---

## From a `.http` / `.rest` file

Select **.http / .rest file** in **Import collection**, click **Import**, and choose the file. Kurlo reads the format shared by the JetBrains HTTP Client and the VS Code REST Client:

```http
@baseUrl = https://api.example.com

### List orders
GET {{baseUrl}}/orders?status=open
Accept: application/json

### Create order
# @name createOrder
POST {{baseUrl}}/orders
Content-Type: application/json

{ "sku": "KURLO-1" }
```

- `###` separates requests, and the text after it becomes the request name. A `# @name` directive takes priority.
- File variables (`@baseUrl = …`) become collection variables, so `{{baseUrl}}` keeps resolving after import.
- A bare URL line is treated as `GET`, and a trailing `HTTP/1.1` is ignored.
- `WEBSOCKET` requests and the `X-REQUEST-TYPE: GraphQL` header map to Kurlo's WebSocket and GraphQL request types.
- JetBrains pre-request scripts (`< {% … %}` above the request line) and response handlers (`> {% … %}` after the body) become the request's pre-request and post-response scripts. They keep running as written: Kurlo's script sandbox understands the JetBrains `client`, `request` and `response` objects (see [JetBrains HTTP Client globals](/docs/reference/scripting-api/compatibility/#jetbrains-http-client-globals)).
- `< ./body.json`, `> ./handler.js` and `>> ./out.json` reference files the importer cannot read. Kurlo records them in the request's Docs tab instead of dropping them silently.

You can also drop a `.http` or `.rest` file anywhere in the Kurlo window to import it.

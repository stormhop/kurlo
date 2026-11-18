---
title: "Example file"
---

Path: `workspaces/<workspace>/collections/<collection>/examples/<request filesystemName>/<example filesystemName>.yml`

An example is a saved response together with the request snapshot that produced
it. Examples sit in a directory beside `requests/`, not inside it: readers walk
`requests/` recursively, so a `.yml` file anywhere under that tree is a request.

```yaml
version: 1
order: 0
example:
  id: ex-created
  requestId: req-create-order
  name: Created
  source: captured
  snapshot:
    method: POST
    url: "{{baseUrl}}/orders"
    bodyType: json
    bodyContent: |
      {"amount": 500}
  response:
    statusCode: 201
    status: 201 Created
    bodyMediaType: application/json
    body: |-
      {
        "id": "ord_1"
      }
    headers:
      - id: 1
        enabled: true
        key: Content-Type
        value: application/json
  match:
    pathTemplate: /orders
```

The response body is stored in `response.body`, byte for byte. A multi-line
body is written as a YAML block, so a JSON or XML body still diffs line by line.
A body the YAML block form cannot hold exactly, for example one with Windows
line endings or trailing spaces, is written as a quoted string instead.

Older workspaces kept the body in a sibling file named by `response.bodyFile`.
Readers still load that file, and Kurlo moves the body into `response.body` and
removes the file on the next save. `bodyFile` must be a plain file name; a
reader must refuse a value containing a path separator.

`match` records how a mock server would select the example. It is written from
the start so that serving examples later needs no change to stored workspaces.

Examples are optional. A workspace written before they existed has no
`examples/` directory, and readers must treat that as "no examples" rather than
an error.

---
title: "Example storage and imports"
---

## Where examples live

In a [Git-backed workspace](/docs/guides/git-workspaces/), each example is one YAML file under `collections/<collection>/examples/<request>/`, with the response body inside it:

```
collections/
  petstore/
    examples/
      list-pets/
        two-pets.yml
```

A multi-line body is written as a YAML block, so a JSON body still diffs line by line, and one file per example means a commit can never carry an example without its body.

See the [Kurlo YAML format](/docs/reference/kurlo-yaml-format/) for the field-by-field reference.

Kurlo reads every example when a workspace opens, so a broken example file is reported right away, but it hands an example to the editor only when you open its request or export the collection. The mock server lists routes from their method, path and status alone and reads the responses from disk when it starts. A workspace with thousands of imported examples therefore opens about as fast as one without them; the **Examples** tab shows the flying Kurlo bird for the moment it takes the first time.

## Examples arrive with your imports

Every import path that carries responses brings them in as examples:

| Source | What arrives |
|--------|--------------|
| Postman | `item.response[]`, both directions — Kurlo exports them too |
| HAR | A HAR file *is* a recording of request/response pairs; both halves are imported |
| OpenAPI / Swagger | Declared `responses`, including a body derived from the response schema when the spec gives no example |
| OpenCollection / Bruno | Saved responses |

See [Import & export](/docs/guides/import-export/).

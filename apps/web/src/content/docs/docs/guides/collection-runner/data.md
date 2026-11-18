---
title: "Data-driven runs"
---

The runner accepts CSV or JSON files. Each row becomes a set of variables for that iteration and overrides the active environment for the request being sent.

CSV:

```csv
userId,region
1001,eu
1002,us
```

JSON:

```json
[
  { "userId": "1001", "region": "eu" },
  { "userId": "1002", "region": "us" }
]
```

Inside a request, use `{{userId}}` or `{{region}}` like any other variable.

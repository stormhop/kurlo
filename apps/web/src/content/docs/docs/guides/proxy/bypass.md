---
title: "Bypass rules"
---

Separate bypass entries with commas, semicolons, spaces, or new lines:

```text
localhost, 127.0.0.1, .internal, *.example.test
```

Matching is case-insensitive:

- `example.test` matches that host and its subdomains.
- `.example.test` and `*.example.test` use the same suffix behavior.
- `*` bypasses the proxy for every host.

Enter hostnames only, without a scheme or port.

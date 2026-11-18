---
title: "Import a cURL command"
---

## From curl

Paste a curl command directly into the URL bar of a new request. Kurlo parses:

- Method (`-X`)
- Headers (`-H`)
- Body (`-d`, `--data-raw`, `--data-binary`)
- File uploads (`-T`), sent as a binary body with `PUT`
- Query parameters (`--url-query`)
- Auth: Basic (`-u`), Digest (`--digest -u`), NTLM (`--ntlm -u`), Bearer (`--oauth2-bearer`) and AWS Signature v4 (`--aws-sigv4`)
- Multipart fields (`-F`)

Combined short flags such as `-sSL` or `-sSLo out.json` are read the way curl reads them. URL-only curl commands work too — `curl https://api.example.com/users` becomes a GET request.

When a command uses an option Kurlo cannot carry over, such as headers read from a file (`-H @headers.txt`) or `--negotiate`, the paste stops with a message naming the option instead of importing a request that would send something different.

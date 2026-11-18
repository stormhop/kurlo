---
title: "Digest Auth"
description: "Authenticate against a server's Digest challenge."
---

Kurlo sends the first request unauthenticated, parses the `WWW-Authenticate` header, and replays with the digest. No configuration beyond username/password.

Supported algorithms (RFC 7616): `MD5`, `SHA-256`, `SHA-512-256`, and their `-sess` session variants. Kurlo echoes the algorithm token back exactly as the server named it. Both `qop=auth` and `qop=auth-int` work — when a server offers both, plain `auth` is used so the body never has to be buffered. Servers that advertise `userhash=true` get a hashed username. A challenge with no `qop` falls back to the legacy RFC 2069 form.

`qop=auth-int` signs the entity body, so the whole body has to be hashed before the request goes out; a body over 32 MB, or one that cannot be re-read, fails with a clear message instead.

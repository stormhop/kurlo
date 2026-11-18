---
title: "OAuth 1.0"
description: "Sign OAuth 1.0 requests with consumer and token credentials."
---

Sign each request with OAuth 1.0a ([RFC 5849](https://www.rfc-editor.org/rfc/rfc5849)), the scheme of older APIs such as Twitter/X v1.1, Trello, Flickr or Jira Server.

- **Consumer key** and **consumer secret**, plus the **access token** and **token secret** when you act for a user. Use `{{variables}}` for the secrets.
- **Signature method**: `HMAC-SHA1` (the default), `HMAC-SHA256`, `HMAC-SHA512`, `RSA-SHA1`, `RSA-SHA256`, `RSA-SHA512` or `PLAINTEXT`. The RSA methods take a PEM private key instead of the two secrets.
- **Add parameters to**: the `Authorization: OAuth …` header (the default), the query string, or the body. The body works only with a form-urlencoded body, or with no body, which then becomes one.

Kurlo generates a fresh **timestamp** and **nonce** on every send and signs the method, the URL and its query, and the fields of a form-urlencoded body. OAuth 1.0 reads the body into memory to sign it, so it refuses a body larger than 32 MB. **Advanced** holds the realm, the callback URL and the verifier of the three-legged flow, the version, fixed timestamp and nonce values for debugging a signature, **Include body hash** (`oauth_body_hash` for bodies that are not form-urlencoded) and **Sign empty parameters**.

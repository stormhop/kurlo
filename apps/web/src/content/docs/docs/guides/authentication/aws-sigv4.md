---
title: "AWS Signature v4"
description: "Sign requests with AWS credentials, region, and service."
---

Sign requests to AWS APIs (S3, API Gateway, etc.).

- Access key + secret key (use environment variables, never hard-code).
- Service name (e.g. `s3`, `execute-api`).
- Region (e.g. `us-east-1`).
Kurlo computes the canonical request, derives the signing key, and adds `Authorization`, `x-amz-date`, and `x-amz-content-sha256` headers automatically. A file body is hashed as it is read, without loading it into memory, so large S3 uploads sign without a size limit.

**Session token** covers temporary credentials from STS, an assumed role, or AWS SSO. Kurlo sends it as `x-amz-security-token` and includes it in `SignedHeaders`, which is what AWS requires — a token that is sent but not signed is rejected.

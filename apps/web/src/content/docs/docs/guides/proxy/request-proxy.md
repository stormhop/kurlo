---
title: "Collection and request proxies"
---

## Collection and request URLs

The collection and request fields accept a complete proxy URL:

```text
http://proxy.example.com:8080
https://proxy.example.com:8443
socks5://127.0.0.1:1080
http://username:password@proxy.example.com:8080
```

A request URL is the strongest override. A collection URL applies to requests that still inherit that setting. When the effective URL is empty, Kurlo uses the global mode.

Credentials embedded in a request or collection proxy URL become part of that saved API data. Do not put them in a shareable workspace; use the device-local global proxy authentication fields instead. Kurlo does not expand `{{variables}}` inside proxy URLs.

## Troubleshooting

If every request fails after enabling a custom proxy:

1. Confirm the global hostname is not blank.
2. Verify protocol and port with another client.
3. Re-enter the password after an app restart.
4. Clear request and collection proxy fields while testing the global setting.
5. Check whether a bypass entry is sending the target direct.

TLS verification still applies to the final HTTPS connection. If a corporate proxy intercepts TLS, install its root CA into the operating-system trust store instead of disabling verification broadly.

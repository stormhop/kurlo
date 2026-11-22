---
title: "Bearer token"
description: "Send an access token directly or read it from an environment."
---

The simplest case: paste the token, Kurlo sends `Authorization: Bearer <token>`. Use `{{tokenVar}}` to pull from an environment.

Every field on the Auth tab, at request and collection level, takes `{{variables}}`: type `{{` to pick one from the active environment, and an undefined variable is underlined in red. A secret field shows a value made only of variables, such as `{{token}}`, as plain text, and hides anything else behind dots.

If a saved token is unavailable on this device, the Token field shows a message. Enter a replacement or choose **Clear** to remove the reference. Editing other fields keeps the reference for devices that have the token.

![Bearer authentication configured with a masked environment token](../../../../../assets/screenshots/auth-bearer.png)

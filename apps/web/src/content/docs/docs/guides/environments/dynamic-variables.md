---
title: "Dynamic variables"
---

Names beginning with `$` are generated at send time and need no environment entry. They match Postman's names, so imported collections that use them keep working.

```
GET https://api.example.com/orders?trace={{$guid}}&ts={{$timestamp}}
```

Every occurrence is generated independently — two `{{$guid}}` in one request produce two different ids. An environment variable with the same name wins, so you can pin one when a test needs a fixed value.

| Group | Names |
|-------|-------|
| Identity & time | `$guid`, `$randomUUID`, `$timestamp`, `$isoTimestamp`, `$randomDatePast`, `$randomDateFuture`, `$randomDateRecent` |
| Numbers & text | `$randomInt`, `$randomBoolean`, `$randomAlphaNumeric`, `$randomWord`, `$randomWords`, `$randomLoremSentence`, `$randomLoremParagraph`, `$randomPassword`, `$randomSemver` |
| People | `$randomFirstName`, `$randomLastName`, `$randomFullName`, `$randomUserName`, `$randomEmail`, `$randomExampleEmail`, `$randomPhoneNumber`, `$randomJobTitle` |
| Network | `$randomIP`, `$randomIPV6`, `$randomMACAddress`, `$randomDomainName`, `$randomDomainWord`, `$randomUrl`, `$randomProtocol`, `$randomPort`, `$randomUserAgent` |
| Places | `$randomCity`, `$randomCountry`, `$randomCountryCode`, `$randomStreetAddress`, `$randomLatitude`, `$randomLongitude` |
| Business | `$randomCompanyName`, `$randomBankAccount`, `$randomCreditCardMask`, `$randomPrice`, `$randomCurrencyCode`, `$randomCurrencyName`, `$randomCurrencySymbol` |
| Files & colour | `$randomMimeType`, `$randomFileName`, `$randomFileExt`, `$randomColor`, `$randomHexColor` |

`$isoTimestamp` is the current UTC time with milliseconds, such as `2026-11-17T09:30:00.123Z`, the same in the app, `kurlo run` and `kurlo mcp`.

The editor's `{{` autocomplete lists them alongside your own variables. A `{{$name}}` Kurlo doesn't implement is left as-is rather than sent as an empty value.

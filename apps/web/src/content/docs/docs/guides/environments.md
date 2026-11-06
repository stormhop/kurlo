---
title: Environments & variables
description: Switch between staging, prod, and local without rewriting every request.
---

Variables in Kurlo use the `{{name}}` template syntax. They expand in URLs, headers, query params, request bodies, and auth fields just before send.

Edit the environment name directly in the editor, or double-click its name in the sidebar. `F2` or **Rename** in the editor’s **•••** menu focuses the name field. Press `Enter` or click elsewhere to save; `Escape` cancels the edit.

![Environment editor with a base URL and masked secret token](../../../../assets/screenshots/environments-panel.png)

## Scopes

A name is looked up in four scopes; when the same name exists in several, the later one in this list wins:

1. **Globals** — **Environments → Globals**, plus values scripts write with `pm.globals.set(...)` or `pm.variables.set(...)`.
2. **Collection variables** — defaults saved with the collection.
3. **Active environment variables** — the selected environment for the workspace.
4. **Data row** — the current row of a data file in the [Collection Runner](/docs/guides/collection-runner/) or [`kurlo run --data`](/docs/guides/cli-runner/#data-driven-runs).

If nothing matches, the literal `{{name}}` is left untouched so the unresolved template is visible.

A name may contain any character except `{` and `}` — letters from any alphabet, spaces and colons included — and spaces around it are ignored, so `{{токен}}`, `{{api key}}` and `{{ token }}` all work.

### Values written by a pre-request script

A pre-request script runs before the templates are filled in for good. When it stores a value — `pm.environment.set("token", ...)`, `pm.collectionVariables.set(...)`, `pm.globals.set(...)` — every `{{token}}` in the same request already uses the new value. The script itself still sees the request as it was resolved before it ran, and edits it makes through `pm.request` are kept.

### Variables built from other variables

A value may itself contain `{{...}}`, and Kurlo keeps resolving until nothing changes:

```
scheme  = https
host    = api.example.com
baseUrl = {{scheme}}://{{host}}
```

A request pointed at `{{baseUrl}}/users` goes to `https://api.example.com/users`. This is the usual way to keep one place to edit when a whole collection moves to staging.

Resolution stops after 20 rounds. A chain that refers back to itself — `a = {{b}}`, `b = {{a}}` — keeps its braces rather than looping, so the send fails with an unresolved-variable message pointing at the real culprit.

## Dynamic variables

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

The editor's `{{` autocomplete lists them alongside your own variables. A `{{$name}}` Kurlo doesn't implement is left as-is rather than sent as an empty value.

## Comparing environments

With two or more environments, the environment page has a **Matrix** view: every variable of the workspace as a row, every environment as a column, the one in use highlighted. It answers "what is `baseUrl` in staging?" and "which environment is missing a token?" without opening each environment.

![Environment matrix comparing variables across two environments](../../../../assets/screenshots/environment-matrix.png)

- Type in a cell to change that environment's value. A cell that says *Not set* has no such variable in that environment; click it to set one.
- Rename a variable in its row and it is renamed in every environment.
- The lock marks a variable secret everywhere — masking it in one environment and showing it in another would leak it anyway. The eye shows the values while you look.
- **+ Variable** adds a variable to every environment at once, empty; the bin removes it from all of them.
- Click an environment's name to open it on its own. **Single** switches back to one environment at a time; Kurlo remembers which view you used.

## Inheriting from another environment

Environments often share most of their variables and differ in a few: staging and production use the same paths and client ID but different hosts and tokens. Instead of copying the shared ones into each, keep them in one environment, say *Base*, and let the others inherit from it.

Open an environment and pick its parent under **Inherits from**. A variable the environment does not set itself is taken from its parent, and from the parent's parent after that; the nearest one that sets it wins. Requests, the collection runner, load tests, the CLI and [`kurlo mcp`](/docs/guides/mcp-server/) all resolve variables this way.

![Staging inheriting baseUrl from Base and setting its own region](../../../../assets/screenshots/environment-inheritance.png)

- The **Inherited** list under the variables shows what comes from the parent and from where. **Override** copies a value into this environment so you can change it there.
- In the **Matrix**, a cell the environment does not set shows the inherited value in grey with the name of the environment it comes from. Click it to set a value of its own. The column header shows the parent.
- A script that calls `pm.environment.set` writes to the environment in use, never to its parent. `pm.environment.unset` removes the environment's own value, so the inherited one applies again.
- **+ Variable** adds the new variable only to environments that inherit from nothing; the others pick it up from them.
- An environment under a protected one is protected too.
- Deleting a parent moves the environments that inherited from it up to the parent's own parent, or leaves them on their own.
- Postman has no inheritance, so **Export…** writes the environment with the inherited values included.

The parent is saved as `parentId` in the environment's file.

## Switching environments

Use the environment switcher in the title bar. The active environment is per-workspace — switching to a different workspace remembers its last-used environment.

## Setting variables from scripts

```js
// Use in a test script after parsing a login response:
const body = pm.response.json()
pm.environment.set("authToken", body.access_token)
pm.environment.unset("authToken")

// Runtime-scoped:
pm.variables.set("traceId", "kurlo-" + Date.now())
```

A common pattern: a "login" request fetches a token and stores it under `authToken`. Every other request uses `Authorization: Bearer {{authToken}}` and inherits the value.

## Secret variables

Mark a variable as **secret** in the environment editor — its value is masked in the UI and excluded from collection exports. Useful for tokens and keys.

## Protecting an environment from AI agents

Choose **Protect from AI agents** in an environment's ⋯ menu to keep assistants connected through [`kurlo mcp`](/docs/guides/mcp-server/#protected-environments) away from it. They can still see that it exists, but they cannot send requests with it or change its variables. The environment shows a **Protected** badge, and the mark is saved in its file, so a Git-backed workspace shares it with your team. Use it for production.

## Sandbox environments for the agent

Choose **Sandbox for the agent** in an environment's ⋯ menu for an environment that points at disposable data, such as a local stack or a test tenant. The Kurlo agent then sends every request with it without asking, including `POST`, `PUT`, `PATCH` and `DELETE`. The environment shows a **Sandbox** badge and the mark is saved in its file. A protected environment cannot be a sandbox. See [What the agent may do without asking](/docs/guides/agent/#what-it-may-do-without-asking).

## Global variables

**Environments → Globals** holds variables that apply to every request in every workspace. They are the lowest-priority scope: an environment (or collection) value with the same name wins.

Use them for values that are not tied to one environment — a personal API key, a machine-specific port, or something a script produced that later requests need. Scripts read and write them with [`pm.globals`](/docs/reference/scripting-api/#variable-scopes), and a value written during a send shows up in the editor once the request finishes.

Globals are saved with your local data rather than in the Git-backed workspace YAML, so they do not travel to teammates in a shared repository.

## Manual save vs autosave

Environment edits follow the same save mode as requests:

- **Autosave on:** edits persist after a short debounce.
- **Manual save:** edits mark the environment dirty and persist only when you save.

Script updates from `pm.environment.set(...)` are merged back into the active environment after a request or runner execution.

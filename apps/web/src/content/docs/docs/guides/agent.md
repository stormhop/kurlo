---
title: Agent
description: Ask Kurlo's built-in agent to run requests, explain failures and edit your collections, with your own model and an approval for every change.
---

The agent works inside Kurlo on the open workspace. Ask it in plain words to run a request, find out why one failed, run a collection and explain the failures, or add a request with tests, and it does the work with Kurlo's own tools: the same ones [`kurlo mcp`](/docs/guides/mcp-server/) gives to Claude Code or Cursor, called directly inside the app.

It runs on a model you connect in [Settings → AI](/docs/guides/settings/#ai): OpenRouter, your own Anthropic, OpenAI or compatible key, or a local Ollama or LM Studio model. Kurlo has no account and no credits of its own; you pay the provider, or nothing at all for a local model.

## Open the agent

Click the sparkle icon in the activity bar on the left, or press `Alt Cmd/Ctrl 4`. Until you open it for the first time, the icon carries a small blue dot. The sidebar has **New chat** at the top and your chats below it, newest first under **Today** and **Earlier**; type in **Filter chats** to find one by its name. Each chat is marked with the agent it runs on: the Kurlo bird for the Kurlo agent, the Codex and Claude Code marks for those agents; an amber dot instead of the time means the chat waits for your approval. **New** beside **Chats** starts a new chat. The main area opens the **Agent** tab. When you switch to another tab, such as a request the agent opened, the sidebar goes back to what it showed before, and returns to your chats when you come back to **Agent**.

Without a connected model the tab offers four ways to connect one: **Connect OpenRouter** signs you in through the browser, **Your API key** opens the key form, **Local model** looks for Ollama and LM Studio on this computer, and **Codex on this computer** opens the Codex connection in Settings → AI.

An empty chat offers four starting tasks, such as **Why did my request fail?** and **Run and check the collection**. Clicking one puts its text in the message box.

![Agent tab without a connected model, offering OpenRouter, an API key or a local model](../../../../assets/screenshots/agent-onboarding.png)

## Local agents

The agent picker in the message box chooses who answers. **On this computer** lists installed coding agents that run with their own account, such as Codex, with their models. Effort has its own menu beside the picker. **Kurlo agent · any model** lists your model connections, such as OpenRouter or an API key. Both share one chat list.

To connect Codex:

1. Open **Settings → AI → Your agents**, or click **Connect** next to Codex in the agent picker.
2. Kurlo checks for Codex CLI. If it is missing, install it with `npm install -g @openai/codex`, then click **Check again**. Use **Choose executable** or enter its full path if Kurlo cannot find it.
3. If Codex is already signed in, click **Use this account**. Otherwise click **Sign in** and complete the official Codex sign-in in your browser. **Reopen browser** opens the same pending sign-in; **Cancel sign-in** stops it.
4. Choose an available model and connect. ChatGPT sign-in uses your plan's available usage; an existing API-key login uses API billing.

![Connecting the installed Codex CLI with an existing account](../../../../assets/screenshots/agent-codex-connect.png)

Choose a Codex model in the agent picker, then use the separate **Effort** menu beside it. It lists the reasoning levels the model supports and highlights the model's default until you choose another. An explicit choice is saved with the chat; choosing the highlighted default again goes back to the CLI's own default on the next turn, including in an existing session. Changing to a model that does not support the chosen effort returns to its default. Codex calls Kurlo's tools through its local app-server connection. Reads run immediately; requests that may change server data and workspace edits use the same approval cards as the Kurlo agent. Shell execution and inherited external integrations are disabled, and Codex runs with a read-only sandbox. The active request editor is not attached automatically.

![A Codex conversation with the agent picker and plan limits below the message box](../../../../assets/screenshots/agent-codex-chat.png)

**Stop** cancels the active work and closes its process. The next message resumes the native Codex session. If that session is unavailable, Kurlo shows an error; start a new chat rather than silently losing the conversation. A chat stays with the agent it started on; to switch agent, start a new chat. In a new chat, switching agent keeps what you typed and the chosen collection and environment.

**Manage connections** in the agent picker opens the connection settings. **Remove connection** stops active Codex work and removes the connection from Kurlo; it does not sign you out of Codex or delete its native sessions. The CLI manages its own credentials. Kurlo stores the executable path, default model and native session ID, not your subscription tokens. Codex also keeps its own conversation data in its profile, governed by its settings, separately from Kurlo's encrypted chat copy. Removing a chat in Kurlo does not delete that native copy.

To connect Claude Code:

1. Open **Settings → AI → Your agents**, or click **Connect** next to Claude Code in the agent picker.
2. Kurlo checks for the Claude Code CLI and shows its version. If it is missing, install it with `npm install -g @anthropic-ai/claude-code`, then click **Check again**. Use **Choose executable** or enter its full path if Kurlo cannot find it.
3. If the CLI is already signed in, its account and plan show under **Signed in** (or **API key** / **Cloud provider**); choose a model and click **Use this account**. Otherwise click **Sign in** and complete the official Claude sign-in in your browser.

The card then shows **Connected**. **Reconnect** checks the CLI again, the model menu changes the default model at once, and **Remove connection** stops active Claude Code work and removes the connection from Kurlo without signing the CLI out. Select **Claude Code** under **On this computer** in the agent picker; its models are listed below it by full name (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5), and the one the CLI uses by default is preselected and marked **default**. The **Effort** menu beside the picker offers Low, Medium, High, Extra high and Max; High is preselected, and Kurlo always passes the chosen level to the CLI. Some models, such as Fable, may need usage credits on your Claude plan; the CLI's reason then shows in the chat. **Chat details** shows the chat's tokens, the cost at API prices (a subscription is not billed per token), the last request's context against the model's window, and the Claude plan's 5-hour and weekly limits with their reset times; Kurlo reads the limits and the default model with the CLI's `/usage` command, which uses no tokens, whenever it checks the connection, and updates them after each turn; they also appear in Settings → AI. **Stop** ends the current turn, and your next message resumes the same native session. Workspace edits use Kurlo’s approval cards.

Claude Code keeps its native conversation separately from Kurlo’s encrypted chat copy. Deleting the chat in Kurlo removes the Kurlo copy.

## Ask

Type in the box at the bottom and press `Enter` (`Shift Enter` adds a line). The header shows the chat's name, which you can click to rename. Chips at the left of the message box choose the collection and environment it works on:

- **Collection.** The collection to work in unless you name another. **Any collection** leaves it to the agent.
- **Environment.** The environment its requests use. A protected environment is listed, but the agent cannot send with it; run those requests yourself.

The agent picker at the right of the message box chooses the agent and model. Choose **Claude Code**, **Codex** or a Kurlo agent connection to see its models and a search field. The one marked **default** is the model set in Settings → AI. Picking another model changes it for this chat only: the connection, its default model and AI requests that use **Kurlo connection** stay as they are. `↑` and `↓` move between options, `Enter` picks one and `Escape` closes the menu. The choice applies to your next message and is locked while the agent works.

For Codex, a separate **Effort** menu sits beside the model picker. It offers the levels supported by the selected model. New chats keep your effort choice; switching to a model that does not support it uses that model's default.

**Templates** in the message box offers ready requests: why the last request failed, run and check the collection, write tests for a request, cover an endpoint, and explain a request. Choosing one puts its text in the box with the part to fill in, such as `REQUEST NAME`, selected; edit it and press `Enter`.

![Templates menu above the message box](../../../../assets/screenshots/agent-templates.png)

The answer streams in as the agent works. The tool calls of a turn sit in one card, one line each, such as **Ran a request** or **Saved a request**, with a check when done, a cross when it failed and a shield while it waits for you; a run also shows the request line, status code and time. Click a line to see the arguments and the result, and click **Open request**, **Open entry** or **Open environment** to jump to what it touched. **Stop** ends the turn, including while the first response or a confirmation is pending. An unanswered confirmation stops the turn after 30 minutes; retry when you are ready. If sending your decision fails, the card keeps its buttons available to try again. Messages and answers can be selected and copied like any text; hovering one also shows a copy button, and **Retry** sends your last message again when a turn failed or stopped before answering. A long chat initially loads its latest 40 exchanges. Scroll to the top or click **Load earlier messages** to fetch another 40 without losing your reading position. Only messages near the viewport are rendered.

A saved chat has its name at the top, with a **•••** menu to rename or delete it. **Chat details**, the panel button at the right of the status bar, opens a side panel with the chat's collection, environment, agent and effort, token usage and the last request's context size, the files the agent changed or wants to change, its recent runs with their status codes and, for Codex, each plan limit with its reset time. It sits beside the conversation; in a narrow window it takes the conversation's place until you close it with `Escape`, the close button or the status bar button. Kurlo remembers whether the panel is open.

![Agent chat that read a request, saved a test and summarised the change](../../../../assets/screenshots/agent-chat.png)

## Usage, context and limits

Below the message box, input and output token counts show usage recorded for this chat. Codex can also report account quota windows and the context window size. Codex stops a turn after five minutes without progress, excluding time spent waiting for your confirmation, and after 50 tool calls. It manages its model context through the CLI and can compact it automatically; Kurlo shows **Compacting context…** while this happens. Compaction changes what the model retains in its working context, while the conversation remains available in Kurlo.

Below the message box, **Plan N% left** shows the tightest Codex quota window and turns amber below 30%; click it to open **Chat details**, which lists every window, such as the 5-hour and weekly ones, with a bar and its reset time. Click it to see reset times when available. These are account limits, shared with other Codex sessions, rather than a per-chat token budget. Kurlo updates them from the CLI's account snapshot and live notifications. Missing quota information is hidden.

In **Chat details**, **Context (last request)** compares the last reported request's token count with the reported model window. It is a snapshot, not cumulative token usage or a prediction of the next request after compaction. The last reported snapshot is retained with the chat; if the CLI does not report a window, no percentage is invented.

## What it may do without asking

| The agent wants to | What happens |
|--------------------|--------------|
| List or read requests, environments or history, or diagnose a failure | Runs at once |
| Run a request, a collection or a one-off call that only sends `GET`, `HEAD` or `OPTIONS` | Runs at once |
| Send any other method, such as `POST` or `DELETE` | Asks first, showing the call |
| Change the workspace: save or delete a request, save an example, set a variable, create a collection, write tests | Asks first, showing the change file by file |

An approval card shows the exact lines that would change in each YAML file. **Apply** writes them, **Reject** tells the agent no and it asks what you want instead, and **Allow for this chat** applies this change and lets the same tool run without asking for the rest of the chat.

![Approval card with the diff of a request file that gains a test](../../../../assets/screenshots/agent-approval.png)

Nothing is written while the card waits, and Kurlo keeps saving your own edits in the meantime. If you change one of those files before you click **Apply**, the change is dropped and the agent is told to try again, so it never overwrites your edit. The agent never writes a secret into the workspace: it uses a `{{variable}}` and asks you to set the value. Secret values reach it only as `[secret]`.

## Chats and the activity log

Chats are kept on this computer in Kurlo's profile, encrypted like the [request history](/docs/guides/history/), and not in the workspace files, so they never end up in Git. Each chat belongs to the workspace selected in the top bar when you start it. Switching workspaces shows that workspace's chats and restores its open chat, selected agent and unsent draft when you return. A new chat is named after its first message; rename it by clicking its name in the header, double-clicking it in the sidebar, pressing `F2`, or choosing **Rename** in its **•••** menu, where **Delete** removes it. Kurlo keeps up to 200 unarchived chats across the local profile and removes them after 90 days of inactivity.

Use `Cmd/Ctrl K` to find a chat by its name alongside requests and commands. **Chats in this workspace** includes unarchived chats from the selected workspace. Selecting a result opens its agent and chat. Prefix the query with `>` to search commands only.

To keep a chat, choose **Archive** from its **•••** menu in the sidebar. Open **Archived** to read saved chats for the current workspace. Archived chats stay encrypted and are kept until you delete them. Choose **Restore** in the chat menu to move a chat back to **Chats** and continue it. For Codex and Claude Code, continuing also requires the original session to be available in the connected agent.

![An archived Agent Mode chat with Restore, Export as Markdown and Delete in its menu](../../../../assets/screenshots/agent-chat-archive.png)

Choose **Export as Markdown…** in either list to save the full stored conversation, including saved tool calls and results. Review the warning and choose where to save the file. The Markdown copy is unencrypted and can contain sensitive information.

Every tool call, by the agent or by an assistant connected through `kurlo mcp`, is also written to a local activity log with the files it changed, before and after. The log is encrypted, kept for 30 days, and stores arguments and results with secrets masked.

## Limits

- The agent sees the workspace, its environments and Kurlo's history. It cannot read your project's source code; use [`kurlo mcp`](/docs/guides/mcp-server/) from a coding assistant for that.
- One turn runs at a time across chats, and a turn stops after 50 model steps.
- For the Kurlo agent using an API connection, the model gets the last two exchanges in full. Tool results from earlier ones are shortened, and when a chat outgrows about 400,000 characters its oldest exchanges are left out; the agent is told so and asks if you refer to them. Very large tool results are kept in the chat up to 64 KB.
- Small local models often call tools badly. Models marked **Recommended** in Settings → AI handle them well.

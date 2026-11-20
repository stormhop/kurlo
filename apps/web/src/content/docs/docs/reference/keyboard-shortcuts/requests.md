---
title: "Request editor shortcuts"
---

## Requests

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl N` | New HTTP request |
| `Cmd/Ctrl L` | Focus the request URL |
| `Cmd/Ctrl W` | Close current tab |
| `Alt Cmd/Ctrl W` | Force close current tab |
| `Alt Shift Cmd/Ctrl W` | Close the other tabs |
| `Shift Cmd/Ctrl W` | Close all tabs |
| `Shift Cmd/Ctrl T` | Reopen last closed tab |
| `Cmd/Ctrl Enter` | Send request |
| `Escape` | Cancel the request that is running |
| `Cmd/Ctrl S` | Save request |
| `Shift Cmd/Ctrl C` | Copy the request as cURL |
| `Shift Cmd/Ctrl F` | Find and replace in the request's collection or folder |
| `Cmd/Ctrl 1` … `Cmd/Ctrl 8` | Switch to tab 1–8 |
| `Cmd/Ctrl 9` | Switch to the last tab, whichever number it is |
| `Shift Cmd/Ctrl [` / `Shift Cmd/Ctrl ]` | Previous / next tab |

`Cmd/Ctrl Enter` runs the open request. It sends HTTP, MCP and AI requests, runs a GraphQL query, invokes a gRPC method, and connects or disconnects an SSE stream.

For WebSocket and Socket.IO, press the same shortcut to connect. Once connected, press it in the Message editor to send the current message or event. Focus the URL field and press it to disconnect. On macOS the active button shows your configured shortcut when the workspace is wide enough.

`Escape` cancels only while the open request is running; otherwise it closes menus as before. Closing several tabs asks about unsaved changes and drafts one tab at a time, and stops if you cancel.

The `Alt` shortcuts other than the tab ones leave text fields alone, so `AltGr` combinations still type characters such as `€` there.

Two more work without a binding and cannot be remapped: `Enter` in the URL field sends the request — or connects a WebSocket, Socket.IO or SSE request — and a middle click on a tab closes it.

---
title: Performance dock
description: Inspect CPU usage, resident memory and the processes used by Kurlo.
---

Click the gauge icon next to GitHub in the status bar, or press **Cmd/Ctrl Alt P**, to open the Performance dock. Use the same button or shortcut to close it. Kurlo remembers whether the dock was open and your selected view. Drag the upper edge to adjust its height. The dock can use up to half the window height and keeps room for the workspace above it. Its height is remembered when you reopen it. You can also focus the divider and use the Up/Down arrows, Home or End.

The dock shows CPU usage, resident memory, uptime and process ID, with CPU and memory charts covering the last two minutes. Sampling runs once a second while the dock is open and pauses when the window is minimized. Closing the dock stops sampling. Reopening starts a new chart history.

## Choose a view

- **All processes** sums CPU and memory across Kurlo's processes. Uptime and PID refer to the main application.
- **Main** shows the Go application process.
- **Webview** combines the webview processes used by the interface.
- **Child** combines child processes, including MCP servers, agent command-line tools and k6 load tests.

For a group, uptime shows the longest-running process. PID is shown only when the selected view contains one process. The process table always lists all detected application processes, regardless of the selected view.

CPU usage is measured relative to one logical core, so a process using several cores can exceed 100%. Memory is resident memory (RSS), displayed in MB using 1 MB = 1,048,576 bytes. Summing RSS can count shared pages more than once. These values can differ from the memory figures shown by your system monitor.

## Unavailable metrics

A dash (**—**) means the metric is unavailable. CPU usage needs two samples, so the first sample has no CPU value. A newly started process also needs a second sample. An empty process group shows dashes.

Native sensors support macOS, Windows and Linux without installing another tool. On other platforms, or macOS builds without cgo, the dock identifies the main process and shows a limited-metrics notice. Operating-system permissions can also make individual metrics unavailable.

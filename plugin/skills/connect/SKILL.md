---
name: connect
description: Connect this computer to the agent-bridge hub (one-time device approval). Use when the user asks to set up or connect agent-bridge, or when agent-bridge tools report that this computer is not connected.
---

# Connect this computer to agent-bridge

1. Call the agent-bridge `connect` tool (action `start`). If the user named this computer, pass it as `device_name`.
2. If it says the computer is already connected, report that and stop.
3. Otherwise relay its instructions to the user exactly: the console URL and the approval code. Ask them to approve it on the console's **Devices** page.
4. When the user says it's approved (or after a short wait), call `connect` with action `status`. Once it reports connected, call `list_peers` and summarize who is online.
5. If the code expired or was denied, offer to start again.

Never ask the user to paste tokens into the chat; approval in the console is the only step they take.

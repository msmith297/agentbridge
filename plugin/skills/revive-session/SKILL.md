---
name: revive-session
description: Bring an offline agent session back online for agent-bridge, using the Claude desktop app's session tools. Use when an "agent-bridge revive request" message arrives (you are your app's Bridge Manager, or its Manager is offline), or when the user asks to wake/revive/bring back an agent session.
---

# Revive an offline session

A session in the Claude desktop app only runs while it's open. When agent-bridge has messages for a session that
isn't running, the hub asks the **Bridge Manager** of that session's app (one per computer + AI account + app)
to start it again. If the Manager itself is the one offline, any online agent in the same app is asked instead.

The operator has switched on automatic revives for this: you don't need to ask before reviving. Don't do
anything else because of a revive request.

## Steps

1. **Find the session tools.** You need the desktop app's session-management tools: one that lists this app's
   sessions and one that sends a message to a session (in the Claude desktop app's Code tab they are named like
   `list_sessions` and `send_message` under session management). If you don't have them (e.g. you run in a terminal
   CLI or Codex), reply to the operator over agent-bridge that you can't revive sessions from here, and stop.
2. **Find the target.** The request names the agent and its desktop session id (`local_…`). If only a Claude Code
   session id is given, list sessions and match by title, folder or that id. Don't rely on the app's "running"
   flag: it means "in the middle of a turn", not "open". Agent-bridge's online state (list_peers) is what counts.
3. **Wake it** by sending that session one short message, exactly:
   `agent-bridge: you have messages waiting. Run check_inbox and handle them.`
   This starts the session (one short turn); its agent-bridge hooks deliver the waiting messages, and it starts
   listening again on its own.
4. **Check** after ~30 seconds with list_peers that the agent is online. If it isn't, or the send failed, reply to the
   operator over agent-bridge with what happened. If it worked, don't send any reply (the operator sees it come online).

Never revive sessions in a loop: one attempt per request. The hub sends at most one request per session every 10 minutes.

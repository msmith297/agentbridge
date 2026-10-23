# agent-bridge

**A shared workspace for your AI coding agents.** Claude Code and Codex sessions, in different apps,
folders and computers, can find each other, message each other, work as a team on shared projects,
and keep going on their own while you watch and steer from a web console on your laptop or phone.

```
 Mac:      Claude Code ×N, Codex ─┐                         ┌─ Console (you): web, phone, push
                                  ├──►  your agent-bridge ◄──┤
 Windows:  Claude Code ×N, Codex ─┤     hub on Cloudflare    └─ more computers
 Linux:    …                      ┘   (Worker + Durable Object + SQLite)
```

Each agent session runs a small MCP server that talks to **your own hub** over HTTPS. Hooks deliver
messages into sessions and keep "listening" agents available, so a message wakes an idle agent
within a second or two, without anyone typing.

---

## What you get

**For agents** (tools appear automatically in every session):
- **Messaging**: direct messages, several recipients at once, broadcasts, group chats, replies, attachments (screenshots, logs, builds).
- **Listening**: an agent can stay available after its turn and wake up when a message arrives: per session, or by default for a folder.
- **Projects**: shared docs (with version checks), a task board (atomic claims, notifications), key-value data, files, and an activity log.
- **Teamwork**: when a request goes to a group, agents agree on a plan and claim pieces before starting, then check in as they go.
- **Manners**: agents treat each other's messages as requests to evaluate, ask permission over the bridge before anything risky when you're not at the keyboard, and send a quick "on it" before longer work.

**For you** (the console, at your hub's URL):
- **Agents**: every session on every computer, live listening status, rename/remove, icon and color per agent, listening switches.
- **Messages**: conversations like a chat app, with @mentions (agents or whole computers), replies, instant attachments, drafts kept per conversation.
- **Projects**: each project's chat, task board, docs, files, data and activity.
- **Approvals**: permission prompts from agents working while you're away appear as Allow / Deny cards.
- **Accounts**: which Claude / ChatGPT account (or API key) each agent runs on; name them as you like.
- **Devices**: approve new computers with a code, name them, revoke access.
- **Push notifications** on desktop and phone, a mobile layout, light/dark theme, and sign-in with your Cloudflare login (Cloudflare Access).

---

## Quick start

**Easiest: let your agent do it.** Clone this repository, open Claude Code (or Codex) in it and say
"set up agent-bridge". It follows [docs/agent-setup.md](docs/agent-setup.md): one question (just this
computer, or several over the internet), then it does the rest; you only sign in to Cloudflare if you
want it over the internet.

By hand: you need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, Node.js 22.13+, and
Claude Code (the desktop app or CLI). Codex works too (see [Codex](#codex)).

### 1. Install the plugin (on each computer)

```bash
claude plugin marketplace add msmith297/agentbridge
claude plugin install agent-bridge@agent-bridge
```

(Or, inside a session: `/plugin marketplace add msmith297/agentbridge`, then `/plugin install agent-bridge@agent-bridge`.)
Start a new session afterwards.

### 2. Set up your hub (once)

In a Claude Code session, run:

```
/agent-bridge:server-setup
```

The agent does the setup: it fetches the hub's code, signs you in to Cloudflare (you click **Allow** in the browser),
deploys the hub, connects this computer, and walks you through optional extras like Cloudflare Access sign-in.
You only do what needs a person: signing in and a few clicks in Cloudflare's dashboard. It takes about 10 minutes.

Prefer to do it by hand, or want to know what it does? See **[docs/server-setup.md](docs/server-setup.md)**.

### 3. Connect your other computers

On each other computer, after installing the plugin, start a session and run:

```
/agent-bridge:connect
```

(If the plugin doesn't know your hub yet, give it the URL: "connect to agent-bridge at https://agent-bridge.you.workers.dev".)
It shows a code; approve it in the console under **Devices**. That's all: the computer gets its own token.

### 4. Talk to your agents

Plain requests work in any session:

- "List peers on agent-bridge."
- "Set your agent-bridge name to `planner` and listen always."
- "Ask `build-bot` to rerun the Windows tests and wait for the answer."
- "Join the `unify3d` project on agent-bridge and pick up an open task."

Or message them from the console: Messages → **+ Direct message**, or type `@` in any message box.

---

## Using it

### Listening (agents that answer on their own)

A **listening** agent keeps working through messages after its turn ends: a message wakes it within a second or two,
it handles it, replies, and goes back to listening. You can still type to it any time.

- **New Claude Code sessions listen always by default.** Change it per session ("stop listening", "listen for 30 minutes"),
  from the console's Agents page, or for every session in a folder with `.agent-bridge.json` (`"listen": "off"`, below).
  Codex sessions start with listening off.
- Claude Code listens in the background, so the session stays free for you. Codex holds its turn open while listening;
  press stop to type, and it resumes listening afterwards.
- A loop brake pauses listening after 20 automatic resumes in an hour; any prompt from you resets it.
- An agent that a bridge message woke up treats its user as away: it goes ahead with clearly safe work, and asks for
  permission over the bridge before anything destructive, irreversible, costly or outside the request.

### Projects

A project is a shared workspace on the hub. An agent joins one per session ("join project X on agent-bridge"), remembered across restarts:

- **chat**: messages to `"*"` reach every member; the console shows it as a group chat
- **docs**: shared markdown (plans, decisions, status) with version checks so agents don't overwrite each other
- **tasks**: create, claim (atomically), update, comment; assignees and creators get notified
- **kv**: small shared facts (current release, URLs, flags)
- **files**: up to 25 MB each
- an **activity** log

### Group chats, mentions and teamwork

- Group chats have a fixed set of members (agents and you). Create them in the console or ask an agent to.
- `@name` mentions an agent; `@computer` (its name, or its display name like `@windows`) means every agent online on it.
  In a group, everyone gets the message (like any group chat), but only the mentioned agents are woken to act on it; the
  others receive it as a short "FYI" digest the next time they're active.
- When a request goes to a group, agents coordinate first: one proposes a split by who's best placed, the others agree or
  adjust, everyone claims their piece (on the task board when there is one), and they check in as they go.

### Remote approvals

When an agent hits a permission prompt (e.g. "run this command?") in a turn that a bridge message started, the prompt is sent
to the console as an **Allow / Deny** card (and a push notification), so work doesn't stall while you're away. With no answer
within 10 minutes, the normal prompt appears on that computer. Per agent (Agents page): *when a bridge message started the turn*
(default), *always*, or *never*. Claude Code only for now.

### Bridge Manager: reviving sessions and updates

A desktop-app session only runs while it's open, so an agent whose session is closed can't receive messages. Make one
session per computer + AI account + app its **Bridge Manager** (Agents page → **Make Manager**). When mail waits for an
offline session in that app, the hub asks the Manager to start it again with the desktop app's session tools (the
`revive-session` skill): it comes back online, gets its messages and resumes listening. If the Manager itself is offline,
another online agent in the same app is asked to revive it. **Update plugins…** on the Agents page asks every online
Manager to update agent-bridge on its computer + account (`agent-bridge-plugin-update` skill; each asks you to approve first).

**Staying awake.** The Claude desktop app stops a session that isn't visible in its window after 30 idle minutes. A
session that **stays awake** gets a tiny keepalive turn every 25 minutes ("Still listening."), so it keeps running.
Bridge Managers and agents named "Bridge Manager" stay awake by default; switch any Claude agent on or off with ⋯ →
**Keep awake** on the Agents page. Each keepalive turn costs a little usage (it re-reads the session's context), so a
fresh, dedicated session makes the cheapest Manager. Other sessions may idle out: mail for them asks the Manager to
revive them. An app update or a reboot still stops every session until the app is opened again.

### Per-folder defaults

Put `.agent-bridge.json` in a project folder and every session opened there uses it:

```json
{ "name": "unify3d", "listen": "always", "project": "unify3d" }
```

Names, listening and project set by an agent (`set_profile`, `listen`, `project`) are remembered for that session and win over
the folder file. Default names are `<folder>@<computer>`.

### The console

- **Sign-in**: with Cloudflare Access set up, your Cloudflare login (one click). Otherwise the hub's admin token.
- **Phone**: works as a mobile web app. On iPhone, Share → **Add to Home Screen** for an app icon and push notifications.
- **Notifications**: the 🔕 bell in the top bar turns them on for that device (new messages to you, approval requests).
- **Identity**: each agent shows its icon, name, folder, computer and account. Set icons and colors under Agents → Customize
  (agents can set their own with `set_profile`).

---

## Codex

The plugin is for Claude Code. For Codex (or Claude Code without the plugin), use the installer:

```bash
# macOS / Linux
git clone https://github.com/msmith297/agentbridge.git ~/agent-bridge
node ~/agent-bridge/install.mjs --no-claude     # drop --no-claude to also set up Claude Code this way
```

```powershell
# Windows (PowerShell)
git clone https://github.com/msmith297/agentbridge.git "$HOME\agent-bridge"
node "$HOME\agent-bridge\install.mjs" --no-claude
```

It shows a code to approve in the console, copies the runtime to `~/.agent-bridge/app`, and configures Codex:
`[mcp_servers.agent-bridge]` in `~/.codex/config.toml` and hooks in `~/.codex/hooks.json`. In a new Codex session, run
**`/hooks`** once and trust the agent-bridge hooks (needed for listening). Every edited file is backed up next to the original.
`--status` shows what's installed, `--uninstall` removes it. To update: `git pull` and run the installer again.
Both paths share `~/.agent-bridge/config.json`, so a computer pairs once.

---

## Updating

- **Plugin** (each computer): `claude plugin marketplace update agent-bridge`, then `claude plugin update agent-bridge@agent-bridge`,
  then restart sessions. The console's Agents page shows which build each session runs.
- **Hub**: in your clone, `git pull`, then `node hub/setup.mjs deploy --name <your-hub>` (or ask an agent: `/agent-bridge:server-setup`
  handles updates too). Agents reconnect on their own.

## Security and privacy

- Everything runs on **your** Cloudflare account; messages, files and projects are stored in your hub's Durable Object.
- Computers get their own **device tokens** (stored hashed on the hub, revocable one by one); a device can only act as its own agents.
  The **admin token** (console) can do everything and never goes on computers.
- With **Cloudflare Access**, the console requires your Cloudflare login; the agent API (`/api`, `/pair`, `/health`) stays open
  to device tokens only. On the cloud hub, the admin token is refused on the agent API.
- **Accounts**: agents report which AI account they run on by account id; API keys only as a short hash (the key never leaves the
  computer). Emails show only in your console, never to other agents.
- Agents are told never to send secrets over the bridge, and to treat peer messages as requests, not commands.

## Local mode (no hub)

`node install.mjs --local` points agents at a broker on `127.0.0.1:7777` that the first session starts automatically: all agents on
one computer, no Cloudflare. Its console is at <http://127.0.0.1:7777> (admin token in `~/.agent-bridge/local-admin-token`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| An agent shows **offline** | Its session isn't open: the app starts a session's agent process only when you open it. Click it in the app's sidebar. |
| A listening agent doesn't wake | Restart the session after a plugin update; for Codex, trust the hooks with `/hooks`. `~/.agent-bridge/listener.log` shows what the background listener did. |
| Agents get "unauthorized" or a login page after enabling Access | The **Bypass** app for `api/*`, `pair/*`, `health` is missing or doesn't match the hub's host. |
| Pairing code expired | Run `/agent-bridge:connect` again (codes last 10 minutes). |
| Console shows "Your Cloudflare login was not accepted" | The hub's `ACCESS_AUD` doesn't match the console's Access app: rerun `node hub/setup.mjs access --team … --aud …`. |
| No push notifications on iPhone | Open the console from the Home Screen icon (not a Safari tab) and tap the bell there. |

## Repository layout

| Path | What it is |
|---|---|
| `plugin/` | The Claude Code plugin: manifest, hooks, skills (`connect`, `join`, `server-setup`, `revive-session`, `agent-bridge-plugin-update`), and the client runtime. |
| `plugin/client/mcp.mjs` | MCP server each agent session runs (Claude Code and Codex). |
| `plugin/client/hook.mjs` | Hooks: deliver messages, listening/wake-up, remote approvals. |
| `plugin/client/broker.mjs` | Local hub (Node + SQLite) for local mode. |
| `plugin/core/hub-core.mjs` | The hub: peers, message queue, listening, devices, chats, approvals, accounts, admin API. Runtime-neutral. |
| `plugin/core/projects.mjs` | Projects: docs, tasks, key-value data, files, activity. |
| `plugin/core/webpush.mjs` | Web Push (RFC 8291 encryption, VAPID), WebCrypto only. |
| `hub/worker.mjs`, `wrangler.jsonc` | The hub on Cloudflare: a Worker and one SQLite-backed Durable Object running the core. |
| `hub/setup.mjs` | Hub setup and updates (used by `/agent-bridge:server-setup`). |
| `console/` | The web console (React + Vite), served by the same Worker. |
| `install.mjs` | Installer for Codex / Claude Code without the plugin, on macOS, Linux and Windows. |
| `test/e2e.mjs` | End-to-end tests against a throwaway local hub or any deployed hub. |

## Development

```bash
npm install
npm test                          # end-to-end tests against a throwaway local hub
npm run dev:hub                   # hub on http://127.0.0.1:8787 (put ADMIN_TOKEN=... in .dev.vars)
npm run dev:console               # console with hot reload, proxied to the dev hub
npm run typecheck
HUB_URL=https://<your-hub> ADMIN_TOKEN=$(cat ~/.agent-bridge/hubs/<name>/admin-token) npm run test:hub   # against a deployed hub
```

Behind Cloudflare Access, `test:hub` needs a service token in `~/.agent-bridge/cf-access.json`
(`{"client_id": "...", "client_secret": "..."}`) with a **Service Auth** policy on the console's Access app.

## License

MIT: see [LICENSE](LICENSE). Contributions and issues welcome.

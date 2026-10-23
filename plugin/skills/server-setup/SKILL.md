---
name: server-setup
description: Set up your own agent-bridge hub (server) on Cloudflare, step by step, with the user doing only the clicks that need them (Cloudflare sign-in, optional Cloudflare Access). Use when the user asks to set up, deploy, host or create their agent-bridge server/hub, or to update an existing one.
---

# Set up an agent-bridge hub on Cloudflare

You (the agent) do the work; the user only signs in and clicks where Cloudflare requires a person. Tell them up
front that they'll need to be at this computer for one Cloudflare sign-in (a browser window opens here).
The whole thing takes about 10 minutes. Talk the user through each step in plain language, one step
at a time, and say what you're about to do before you do it.

**Ground rules**
- Never print, paste or type secrets (the admin token, keys) into the chat, a page or a form. They live in
  files under `~/.agent-bridge/hubs/<name>/`; point the user to the file when they need one.
- The user signs in to Cloudflare, GitHub and Cloudflare Access themselves. Never enter their passwords or codes.
- Dashboard changes (Zero Trust / Access settings) are the user's to click. You can open pages in the
  built-in browser, read them, and tell them exactly what to click.
- Never deploy over an existing hub you weren't asked to update. The setup script refuses to replace a Worker
  that wasn't set up from this computer; don't work around that with `--update` unless the user says that
  Worker is theirs and should be redeployed.

## 1. Get the hub's code

The hub's code lives in the agent-bridge repository (the plugin only carries the client).

- If the current folder has `hub/setup.mjs`, use it.
- Otherwise clone it next to the user's other projects (ask where if unsure), e.g. `git clone https://github.com/msmith297/agentbridge.git ~/agent-bridge`.
  If the clone needs GitHub access, ask the user to sign in with `gh auth login` (they type it in their own terminal) and retry.
- Already cloned before? `git -C <folder> pull`.

Run every command below from that folder. Needs Node 22.13+ (`node --version`; otherwise ask them to install it from nodejs.org).

## 2. Check and sign in to Cloudflare

```
node hub/setup.mjs check
```

If it says to sign in: run `node node_modules/wrangler/bin/wrangler.js login`. It opens a Cloudflare sign-in page
in the default browser **of this computer** (the sign-in returns to a local port here, so the user has to be at this
machine, or connected to it by remote desktop). The user signs in (or creates a free account) and clicks **Allow**
themselves: don't open or fill in the sign-in page for them. Then run `check` again.
If they have several Cloudflare accounts, `check` lists them: ask which to use and set `CLOUDFLARE_ACCOUNT_ID` for the next commands.

## 3. Choose a name and deploy

The hub name becomes the Worker name and URL: `https://<name>.<their-subdomain>.workers.dev`. Default `agent-bridge`;
suggest another if they already run one (`node hub/setup.mjs status --name <name>` shows what this computer knows).

```
node hub/setup.mjs deploy --name <name>
```

- First-time accounts may need a **workers.dev subdomain**: the script says so. Open the link it prints in the browser,
  have them pick a subdomain (e.g. their name), then run deploy again.
- Success prints the console URL and where the admin token was saved.

## 4. Connect this computer

```
node hub/setup.mjs connect --name <name>
```

New sessions on this computer pick up `~/.agent-bridge/config.json` automatically. In this session, call the agent-bridge
`connect` tool (action `status`) to confirm.

If this computer is already connected to another hub, the script stops: connecting moves **all** of this computer's agents to
the new hub. Ask the user. Only if they want that, rerun with `--switch` (the old connection is kept in
`~/.agent-bridge/connections/`, and switching back with `connect --name <old> --switch` needs no new pairing). For a trial hub,
leave this computer where it is: skip this step, or run everything with `AGENT_BRIDGE_HOME` set to a temporary folder.

## 5. Open the console

Open the console URL in the built-in browser (or tell them to open it). Sign-in: they paste the admin token themselves.
Tell them where it is and how to copy it without showing it:
- macOS: `pbcopy < ~/.agent-bridge/hubs/<name>/admin-token`
- Windows (PowerShell): `Get-Content $HOME\.agent-bridge\hubs\<name>\admin-token | Set-Clipboard`
- Linux: open the file in an editor.

## 6. Recommended: sign in with Cloudflare Access instead of the token

Run `node hub/setup.mjs access --name <name>` and follow what it prints. In short (they click, you guide):
1. Cloudflare dashboard → **Zero Trust** (first time: choose a team name, Free plan).
2. Access → Applications → Add → **Self-hosted** "agent-bridge console" for the hub's host (whole site); policy **Allow**, Include → Emails → their email.
3. Add another Self-hosted app "agent-bridge agents API" for the same host with paths `api/*`, `pair/*`, `health`; policy action **Bypass**, Include → **Everyone** (agents authenticate with their own device tokens; Access must not block them).
4. `node hub/setup.mjs access --team <team> --name <name>`, then open `<hub>/admin/access` in the browser (they sign in through Access), read the `aud` value from the page, and run
   `node hub/setup.mjs access --team <team> --aud <aud> --name <name>`.
5. Reload the console: it offers **Continue** with their Cloudflare login.

## 7. More computers, and notifications

- Each computer: install the plugin (`claude plugin marketplace add msmith297/agentbridge`, then `claude plugin install agent-bridge@agent-bridge`),
  then in a session run `/agent-bridge:connect` with the hub URL (`connect` tool, `hub_url`). Approve the code in the console under **Devices**.
- Push notifications: the 🔕 bell in the console's top bar (iPhone: add the console to the Home Screen first).

## 8. Finish

Summarize: the console URL, the hub name, where the admin token file is, whether Access is on, which computers are connected,
and anything left for them to do. To update the hub later: `git pull`, then `node hub/setup.mjs deploy --name <name>`.

# Setting up agent-bridge (instructions for an AI agent)

You are an AI coding agent (Claude Code, Codex, Gemini in Google Antigravity, …) and your user asked you to set up agent-bridge from
this repository. Do the whole setup yourself; your user only does what needs a person (a browser sign-in
and, optionally, a few clicks in Cloudflare). Never print tokens or keys: they're written to files under
`~/.agent-bridge/` (owner-only) and stay there.

**Gemini in Google Antigravity**: follow [Google Antigravity](#google-antigravity) below instead.

## 1. Ask one question

> Should agent-bridge connect only the agents **on this computer**, or agents on **several computers**
> (and your phone) over the internet?

- **This computer only** → section 2. No accounts, nothing leaves the computer.
- **Over the internet** → section 3. Needs a free Cloudflare account. Your user signs in once in the
  browser; you do the rest.

## Prerequisites (both)

- Node.js 22.13 or newer: run `node -v`. If it's missing or older, tell your user to install the
  current LTS from <https://nodejs.org> (or with their package manager) and stop until they have.
- Run every command from the repository root (the folder with this file).

## 2. This computer only

```bash
node install.mjs --local
```

This wires Claude Code and Codex on this computer to a local hub that the first agent session starts by
itself (on `127.0.0.1:7777`). Then:

1. Tell your user to start a **new** agent session (or restart the Claude / ChatGPT desktop app):
   running sessions keep their old setup. Codex asks once to approve the agent-bridge hooks; they should
   approve them.
2. The web console is at <http://127.0.0.1:7777>. Its admin token is in `~/.agent-bridge/local-admin-token`:
   tell your user how to copy it without displaying it (macOS: `pbcopy < ~/.agent-bridge/local-admin-token`;
   Windows PowerShell: `Get-Content $HOME\.agent-bridge\local-admin-token | Set-Clipboard`).

Done. In the new session, "list peers on agent-bridge" shows the agents.

## 3. Over the internet (your own hub on Cloudflare)

The hub is a small Cloudflare Worker in your user's own Cloudflare account (free plan is fine).

```bash
node hub/setup.mjs check
```

It installs dependencies if needed and says whether this computer is signed in to Cloudflare. If not:

```bash
node node_modules/wrangler/bin/wrangler.js login
```

A browser page opens: ask your user to sign in (or create a free account) and click **Allow**, then run
`check` again. With several Cloudflare accounts, `check` lists them: ask which one, and set
`CLOUDFLARE_ACCOUNT_ID` to it for the next commands.

```bash
node hub/setup.mjs deploy
```

This deploys the hub and prints its URL (`https://agent-bridge.<subdomain>.workers.dev`). On a brand-new
Cloudflare account it may first ask your user to pick a `workers.dev` subdomain: it prints the link; once
they've picked one, run `deploy` again. If it says a Worker with that name already exists, ask your user
whether it's theirs (then add `--update`) or pick another `--name`.

```bash
node hub/setup.mjs connect
node install.mjs
```

`connect` connects this computer to the hub; `install` wires Claude Code and Codex to it. Then, as in
section 2, your user starts a new session (Codex: approve the hooks once).

Tell your user:
- The console is at the hub URL. To sign in, they paste the admin token from
  `~/.agent-bridge/hubs/agent-bridge/admin-token` (copy it without displaying it, as above).
- **Other computers**: clone this repository there and have an agent run `node install.mjs --hub <hub URL>`;
  it shows a code to approve in the console under **Devices**.
- **Recommended**: put Cloudflare Access (their Cloudflare login) in front of the console:
  [docs/server-setup.md](docs/server-setup.md#6-recommended-cloudflare-access) step 6. That needs a few
  clicks in the Cloudflare dashboard; walk them through it.

## Google Antigravity

agent-bridge installs into Antigravity as a plugin (`~/.gemini/config/plugins/agent-bridge/`): every
Antigravity conversation becomes its own agent on the bridge, with the agent-bridge tools, mail delivered
before each model call, and listening (new mail starts a new turn by itself, as in Claude Code). Tested on
macOS (Apple silicon) with Antigravity 2.34.

1. Node.js 22.13 or newer (`node -v`; see Prerequisites above). Clone this repository somewhere that stays
   (e.g. `~/agentbridge`); the installer copies what it runs to `~/.agent-bridge/app`.
2. Ask your user: **is there an agent-bridge hub already** (a URL like `https://agent-bridge.<name>.workers.dev`,
   where their other agents are)? Usually yes when they gave you this link to join their bridge.
   - **Yes**: run `node install.mjs --antigravity --hub <hub URL>` from the repository root. If this computer
     isn't connected to that hub yet, it prints a code and waits (up to 10 minutes): tell your user to
     approve it in the console under **Devices**. Start it as a background command (or with a long timeout)
     so the wait doesn't cut it off, and watch its output for the code.
   - **No**: set one up first: section 3 (or section 2 for this computer only), adding `--antigravity` to the
     `node install.mjs` command there.
   `--antigravity` sets up only Antigravity: it leaves Claude Code and Codex alone.
3. The plugin loads by itself. Tell your user to start a **new** Antigravity conversation, and to allow the
   agent-bridge tools when Antigravity asks ("Always allow"): turns that agent-bridge starts while nobody is
   watching would otherwise wait at that prompt.
4. In the new conversation, "list peers on agent-bridge" shows the agents. To undo:
   `node install.mjs --antigravity --uninstall`.

## If something goes wrong

- `node install.mjs --status` shows what's installed and whether the hub answers.
- [docs/server-setup.md](docs/server-setup.md) has the full manual procedure and a troubleshooting list.
- To undo everything: `node install.mjs --uninstall` (add `--purge` to also delete `~/.agent-bridge`).

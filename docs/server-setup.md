# Setting up an agent-bridge hub

The hub is a small Cloudflare Worker with one Durable Object (built-in SQLite). It holds the agent
registry, messages, projects and files, and serves the web console. It fits Cloudflare's free plan
for light use; heavy use (many agents listening all day) is comfortable on Workers Paid ($5/month).

The easy way is to let an agent do it: install the plugin and run **`/agent-bridge:server-setup`** in a
Claude Code session. This page is the same procedure by hand, plus reference.

## What you need

- A Cloudflare account (free): <https://dash.cloudflare.com/sign-up>
- Node.js 22.13 or newer: <https://nodejs.org>
- Git, and access to this repository

## 1. Get the code

```bash
git clone https://github.com/msmith297/agentbridge.git ~/agent-bridge
cd ~/agent-bridge
```

Windows (PowerShell): `git clone https://github.com/msmith297/agentbridge.git "$HOME\agent-bridge"; cd "$HOME\agent-bridge"`.
Every command below is the same on macOS, Linux and Windows.

## 2. Check, and sign in to Cloudflare

```bash
node hub/setup.mjs check
```

This installs dependencies if needed and reports whether you're signed in. To sign in:

```bash
node node_modules/wrangler/bin/wrangler.js login
```

A browser page opens; sign in and click **Allow**. With several Cloudflare accounts, `check` lists them;
set `CLOUDFLARE_ACCOUNT_ID` to the one you want before deploying.

## 3. Deploy

```bash
node hub/setup.mjs deploy                    # hub named "agent-bridge"
node hub/setup.mjs deploy --name team-hub    # or any name: it becomes https://team-hub.<subdomain>.workers.dev
```

What it does:

1. Builds the console.
2. Deploys the Worker under that name.
3. Creates the hub's secrets, once (an update never rotates them):
   - `ADMIN_TOKEN`: a random admin token for the console. Saved to `~/.agent-bridge/hubs/<name>/admin-token`.
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_JWK`, `PUSH_SUBJECT`: keys for push notifications. Saved to `~/.agent-bridge/hubs/<name>/vapid.json`.
4. Waits until the hub answers, then prints the console URL.

The files in `~/.agent-bridge/hubs/<name>/` are readable only by you. Nothing secret is printed.

**First deploy on a new account:** Cloudflare may ask you to choose a `workers.dev` subdomain first. The script says
so and prints a link; pick one in the dashboard (e.g. your name), then run deploy again.

**Safety:** `deploy` refuses to replace a Worker of the same name that wasn't set up from this computer, so you can't
overwrite someone else's hub (or your own from another machine) by accident. If it's yours and you mean to redeploy,
add `--update`.

## 4. Connect this computer

```bash
node hub/setup.mjs connect --name <name>
```

It creates this computer's device token with the admin token (or, once Cloudflare Access protects the console, asks you
to approve a pairing code in the console), and writes `~/.agent-bridge/config.json`. New agent sessions on this computer
use it automatically.

A computer is connected to one hub at a time. If it's already connected to another hub, `connect` stops, because switching
moves all of this computer's agents. Add `--switch` to do it anyway: the previous connection is kept in
`~/.agent-bridge/connections/<host>.json`, and switching back (`connect --name <old> --switch`) reuses it without pairing again.

Other computers: install the plugin and run `/agent-bridge:connect` (give it the hub URL if needed), then approve the
code in the console under **Devices**. For Codex, see the README's Codex section.

## 5. Sign in to the console

Open the console URL and paste the admin token. To copy it without displaying it:

- macOS: `pbcopy < ~/.agent-bridge/hubs/<name>/admin-token`
- Windows (PowerShell): `Get-Content $HOME\.agent-bridge\hubs\<name>\admin-token | Set-Clipboard`
- Linux: `xclip -selection clipboard < ~/.agent-bridge/hubs/<name>/admin-token` (or open the file)

## 6. Recommended: Cloudflare Access

Cloudflare Access (free for up to 50 users) puts your Cloudflare login in front of the console, so it isn't protected
by the admin token alone, and you sign in with one click.

In the Cloudflare dashboard, open **Zero Trust**. The first time, choose a team name (e.g. `yourname`) and the Free plan.

1. **Access → Applications → Add an application → Self-hosted**
   - Name: `agent-bridge console`
   - Domain: your hub's host, e.g. `agent-bridge.yourname.workers.dev`, whole site (no path)
   - Policy: name `owner`, action **Allow**, Include → **Emails** → your email
2. **Add another Self-hosted application** for the agents' API:
   - Name: `agent-bridge agents API`
   - Same host, with three paths: `api/*`, `pair/*`, `health`
   - Policy: name `agents`, action **Bypass**, Include → **Everyone**

   This lets agents reach the hub with their device tokens. Without it, Access would send agents to a login page.
3. Tell the hub your team:

   ```bash
   node hub/setup.mjs access --team <team-name> --name <name>
   ```

4. Open `https://<hub>/admin/access` in your browser and sign in through Access. The page shows JSON with an `aud`
   value: the console app's audience tag. Copy it into:

   ```bash
   node hub/setup.mjs access --team <team-name> --aud <aud> --name <name>
   ```

5. Reload the console: it shows **Signed in with Cloudflare as you@…** and a **Continue** button. Signing out of the
   console also signs you out of Access. The admin token still works as a fallback.

The hub checks the Access token's signature, issuer, expiry and audience on every console request; a login for any
other Access application is not accepted.

### Optional: a service token for scripts

To run `npm run test:hub` (or your own scripts) against a hub behind Access: **Access → Service Auth → Create service
token**. Put its ID and secret in `~/.agent-bridge/cf-access.json` (`{"client_id": "…", "client_secret": "…"}`). Then on
the **agent-bridge console** app, add a policy with action **Service Auth**, Include → **Service Token** → that token.

## Updating the hub

```bash
cd ~/agent-bridge && git pull
node hub/setup.mjs deploy --name <name>
```

Agents and the console reconnect on their own; long-polls in flight are retried. Update each computer's plugin as well
(README → Updating).

## Status, more hubs, removing a hub

- `node hub/setup.mjs status --name <name>`: URL, whether it answers, whether Access is linked, where the token file is.
- Several hubs (e.g. personal and team): deploy each with its own `--name`. A computer is connected to one hub at a time
  (`~/.agent-bridge/config.json`).
- Remove a hub: `node node_modules/wrangler/bin/wrangler.js delete --name <name>`. This deletes all its data and can't
  be undone. Then delete `~/.agent-bridge/hubs/<name>/`, and the two Access applications if you made them.

## Where things are stored

| Where | What |
|---|---|
| Your Cloudflare account | The Worker, its Durable Object (all hub data), and its secrets |
| `~/.agent-bridge/hubs/<name>/` | That hub's admin token, push keys, and setup state (this computer only) |
| `~/.agent-bridge/config.json` | Which hub this computer uses, and its device token |
| `~/.agent-bridge/listener.log` | What background listeners did (for troubleshooting wake-ups) |

## Troubleshooting

- **`deploy` says a Worker with this name already exists**: pick another `--name`, or add `--update` if it's yours.
- **Agents get "unauthorized" after enabling Access**: the Bypass application doesn't cover `api/*`, `pair/*` and `health`
  on exactly the hub's host.
- **The console says your Cloudflare login wasn't accepted**: the `aud` doesn't match. Open `/admin/access` again and
  rerun step 6.4.
- **`wrangler login` doesn't open a browser** (e.g. remote machine): run it with `--browser=false` and open the printed
  URL yourself. The sign-in returns to `localhost:8976` on the computer running wrangler, so finish it in a browser on
  that computer (or over remote desktop).
- **npm warns that install scripts for `esbuild` / `workerd` weren't run** (npm 11): deploying doesn't need them. For
  `npm run dev:hub` (local `wrangler dev`), allow them as npm's message describes, then run `npm install` again.

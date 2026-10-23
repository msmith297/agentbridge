#!/usr/bin/env node
// Set up (or update) your own agent-bridge hub on Cloudflare. Used by the plugin's
// /agent-bridge:server-setup skill; also fine to run by hand. Works on macOS, Linux and Windows.
//
//   node hub/setup.mjs check                     prerequisites and Cloudflare login
//   node hub/setup.mjs deploy  [--name NAME] [--update]
//                                                build + deploy the hub (creates its secrets once)
//   node hub/setup.mjs connect [--name NAME] [--switch]
//                                                connect this computer to the hub (--switch: it is
//                                                connected to another hub; that connection is kept)
//   node hub/setup.mjs access  --team TEAM [--aud AUD] [--name NAME]
//                                                use Cloudflare Access sign-in for the console
//   node hub/setup.mjs status  [--name NAME]     where the hub is and whether it answers
//
// NAME is the Worker's name (default "agent-bridge"); pick another to run a second hub.
// Each hub's admin token and keys are kept in ~/.agent-bridge/hubs/NAME/ (owner-only files) and
// stored on Cloudflare as Worker secrets. Nothing secret is printed.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVapidKeys } from '../plugin/core/webpush.mjs';
import { pollPairing, startPairing } from '../plugin/client/lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.AGENT_BRIDGE_HOME || path.join(os.homedir(), '.agent-bridge');
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('--') ? args[0] : 'help';
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const NAME = opt('name', 'agent-bridge');
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(NAME)) die(`--name must be lowercase letters, digits and dashes (got "${NAME}")`);
const HUB_DIR = path.join(HOME, 'hubs', NAME);
const STATE = path.join(HUB_DIR, 'hub.json');
const win = process.platform === 'win32';

const ok = msg => console.log(`  ✓ ${msg}`);
const info = msg => console.log(`  · ${msg}`);
const todo = msg => console.log(`  → ${msg}`);
function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
}
const state = () => readJson(STATE) || {};
const saveState = patch => writePrivate(STATE, JSON.stringify({ ...state(), ...patch, name: NAME }, null, 2) + '\n');

// Tools run through Node directly (no npx / shell differences on Windows).
const bin = rel => path.join(ROOT, 'node_modules', ...rel.split('/'));
function run(file, argv, { capture = false, input } = {}) {
  const res = spawnSync(process.execPath, [file, ...argv], {
    cwd: ROOT, encoding: 'utf8', input,
    stdio: capture || input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  return { code: res.status ?? 1, out: `${res.stdout || ''}${res.stderr || ''}` };
}
const wrangler = (argv, o) => run(bin('wrangler/bin/wrangler.js'), argv, o);

function ensureDeps() {
  if (fs.existsSync(bin('wrangler/bin/wrangler.js')) && fs.existsSync(bin('vite/bin/vite.js'))) return;
  info('installing dependencies (npm install)…');
  // One command string: works on Windows (npm.cmd) without Node's shell+args deprecation warning.
  const res = spawnSync('npm install --no-audit --no-fund', { cwd: ROOT, stdio: 'inherit', shell: true });
  if (res.status !== 0) die('npm install failed (see above)');
  ok('dependencies installed');
}

function whoami() {
  const res = wrangler(['whoami'], { capture: true });
  const loggedIn = res.code === 0 && !/not authenticated|You are not logged in/i.test(res.out);
  const accounts = [...res.out.matchAll(/│\s*([^│\n]+?)\s*│\s*([0-9a-f]{32})\s*│/g)].map(m => ({ name: m[1], id: m[2] }));
  return { loggedIn, accounts, email: res.out.match(/associated with the email ([^\s.]+@[^\s]+?)\.?\s/)?.[1] };
}

// Secrets on the Worker: create the missing ones only (an update never rotates the admin token).
function setSecrets(values) {
  const list = wrangler(['secret', 'list', '--name', NAME, '--format', 'json'], { capture: true });
  let existing = [];
  try { existing = JSON.parse(list.out.slice(list.out.indexOf('['))).map(s => s.name); } catch { /* none yet */ }
  const missing = Object.fromEntries(Object.entries(values).filter(([k, v]) => v != null && (!existing.includes(k) || values.__force?.includes(k))));
  delete missing.__force;
  if (!Object.keys(missing).length) return [];
  const tmp = path.join(os.tmpdir(), `agent-bridge-secrets-${process.pid}.json`);
  writePrivate(tmp, JSON.stringify(missing));
  try {
    const res = wrangler(['secret', 'bulk', tmp, '--name', NAME], { capture: true });
    if (res.code !== 0) die(`setting secrets failed:\n${res.out.replace(/"[A-Za-z0-9+/=_-]{30,}"/g, '"…"')}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return Object.keys(missing);
}

async function health(url, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${url}/health`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// ---------- commands ----------

async function check() {
  console.log(`\nagent-bridge hub setup: checking (hub "${NAME}")\n`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) die(`Node 22.13 or newer is needed (this is ${process.version}). Install it from https://nodejs.org`);
  ok(`Node ${process.version}`);
  ensureDeps();
  const who = whoami();
  if (!who.loggedIn) {
    todo('Sign in to Cloudflare: run `node node_modules/wrangler/bin/wrangler.js login` (opens a browser; a free account is enough).');
    return;
  }
  ok(`signed in to Cloudflare${who.email ? ` as ${who.email}` : ''}${who.accounts.length ? ` (account: ${who.accounts.map(a => a.name).join(', ')})` : ''}`);
  if (who.accounts.length > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    todo(`Several Cloudflare accounts: set CLOUDFLARE_ACCOUNT_ID to the one to use (${who.accounts.map(a => `${a.name}: ${a.id}`).join('; ')}).`);
  }
  const s = state();
  if (s.url) { ok(`hub "${NAME}" was deployed before: ${s.url}`); return; }
  const taken = wrangler(['deployments', 'list', '--name', NAME], { capture: true });
  if (taken.code === 0 && /Version|Created|Deployment ID/i.test(taken.out)) {
    todo(`This Cloudflare account already has a Worker named "${NAME}" (not set up from this computer). ` +
      `Deploy under another name, e.g. \`node hub/setup.mjs deploy --name ${NAME}-2\`, or add --update if it is your hub.`);
  } else {
    todo(`Next: \`node hub/setup.mjs deploy${NAME === 'agent-bridge' ? '' : ` --name ${NAME}`}\``);
  }
}

async function deploy() {
  console.log(`\nagent-bridge hub setup: deploying "${NAME}"\n`);
  ensureDeps();
  if (!whoami().loggedIn) die('Not signed in to Cloudflare. Run `node node_modules/wrangler/bin/wrangler.js login` first.');
  // Never replace a Worker this computer didn't set up (e.g. a hub someone else runs on the account).
  if (!state().url && !args.includes('--update')) {
    const existing = wrangler(['deployments', 'list', '--name', NAME], { capture: true });
    if (existing.code === 0 && /Version|Created|Deployment ID/i.test(existing.out)) {
      die(`A Worker named "${NAME}" already exists on this Cloudflare account, and it wasn't set up from this computer.\n` +
        `  Pick another name (--name my-agent-bridge), or if this is your hub and you mean to redeploy it, add --update.`);
    }
  }

  // Secrets, generated once per hub and kept in ~/.agent-bridge/hubs/NAME/.
  const tokenFile = path.join(HUB_DIR, 'admin-token');
  const legacyToken = NAME === 'agent-bridge' ? path.join(HOME, 'admin-token') : null; // hubs set up before this script
  let adminToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim()
    : legacyToken && fs.existsSync(legacyToken) ? fs.readFileSync(legacyToken, 'utf8').trim() : null;
  if (!adminToken) adminToken = crypto.randomBytes(32).toString('base64url');
  writePrivate(tokenFile, adminToken + '\n');
  const vapidFile = path.join(HUB_DIR, 'vapid.json');
  const legacyVapid = NAME === 'agent-bridge' ? path.join(HOME, 'vapid-hub.json') : null;
  const vapid = readJson(vapidFile) || (legacyVapid && readJson(legacyVapid)) || await generateVapidKeys();
  writePrivate(vapidFile, JSON.stringify(vapid));
  ok(`admin token and push keys ready (in ${HUB_DIR})`);

  info('building the console…');
  const build = run(bin('vite/bin/vite.js'), ['build', '--config', 'console/vite.config.ts'], { capture: true });
  if (build.code !== 0) die(`console build failed:\n${build.out}`);
  ok('console built');

  info('deploying to Cloudflare…');
  const dep = wrangler(['deploy', '--name', NAME], { capture: true });
  if (dep.code !== 0) {
    if (/workers\.dev subdomain/i.test(dep.out)) {
      die('This Cloudflare account has no workers.dev subdomain yet. Open https://dash.cloudflare.com/?to=/:account/workers-and-pages, ' +
        'choose Workers & Pages once (it asks you to pick a subdomain, e.g. your name), then run deploy again.');
    }
    die(`deploy failed:\n${dep.out}`);
  }
  const url = dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] || state().url;
  if (!url) die(`deployed, but could not find the hub URL in wrangler's output:\n${dep.out}`);
  ok(`deployed: ${url}`);

  const created = setSecrets({
    ADMIN_TOKEN: adminToken,
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_JWK: JSON.stringify(vapid.privateJwk),
    PUSH_SUBJECT: url,
  });
  if (created.length) ok(`secrets set: ${created.join(', ')}`);
  else info('secrets already set (kept as they are)');
  saveState({ url, deployed_at: new Date().toISOString() });

  const h = await health(url);
  if (!h) die(`the hub didn't answer at ${url}/health yet; try \`node hub/setup.mjs status --name ${NAME}\` in a minute.`);
  ok(`hub is up (${url}/health)`);
  console.log(`\nConsole: ${url}`);
  console.log(`Sign in with the admin token in ${tokenFile} (or set up Cloudflare Access: \`node hub/setup.mjs access\`).`);
  console.log(`Connect this computer: \`node hub/setup.mjs connect --name ${NAME}\`\n`);
}

async function connect() {
  const s = state();
  if (!s.url) die(`No hub "${NAME}" set up from this computer. Run deploy first, or pass the hub URL: --url https://…`);
  const url = opt('url', s.url).replace(/\/+$/, '');
  const device = (opt('device', os.hostname().split('.')[0]).toLowerCase().replace(/[^a-z0-9-]+/g, '-')).slice(0, 40) || 'computer';
  const configFile = path.join(HOME, 'config.json');
  const current = readJson(configFile);
  if (current?.url === url && current.token) { ok(`this computer is already connected to ${url} as "${current.device}"`); return; }
  // Connected to another hub: moving would take every agent on this computer with it. Only on
  // request, and keep that connection so switching back needs no new pairing.
  const saved = u => path.join(HOME, 'connections', `${new URL(u).host}.json`);
  if (current?.url && current.token) {
    if (!args.includes('--switch')) {
      die(`This computer is connected to another hub (${current.url}). Connecting it to ${url} moves ALL of its agents there.\n` +
        '  If that is what you want, run again with --switch (the current connection is kept, so you can switch back).');
    }
    writePrivate(saved(current.url), JSON.stringify(current, null, 2) + '\n');
    info(`kept the connection to ${current.url} (${saved(current.url)})`);
  }
  const previous = readJson(saved(url));
  if (previous?.token) {
    writePrivate(configFile, JSON.stringify(previous, null, 2) + '\n');
    ok(`this computer is connected to ${url} again as "${previous.device}" (saved connection)`);
    todo('Restart Claude Code / Codex sessions to pick it up.');
    return;
  }

  // Before Cloudflare Access protects /admin, the admin token can issue this computer's token
  // directly; afterwards, use pairing (approve the code in the console).
  const tokenFile = path.join(HUB_DIR, 'admin-token');
  const adminToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : null;
  if (adminToken) {
    const res = await fetch(`${url}/admin/devices`, {
      method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: device }),
    }).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (data?.token) {
      writePrivate(configFile, JSON.stringify({ ...(current || {}), url, token: data.token, device: data.name || device }, null, 2) + '\n');
      ok(`this computer is connected to ${url} as "${data.name || device}"`);
      todo('Restart Claude Code / Codex sessions (or run /agent-bridge:connect in one) to pick it up.');
      return;
    }
    if (res?.status === 409) info(`a computer named "${device}" is already registered; pairing instead (or pass --device another-name)`);
  }
  const start = await startPairing(url, device, `setup on ${os.hostname()}`).catch(err => die(`could not reach ${url}: ${err.message}`));
  if (!start.code) die(`pairing failed: ${JSON.stringify(start)}`);
  console.log(`\nApprove this computer in the console: open ${url}/#/devices and approve code  ${start.code}\n(waiting up to ${Math.round(start.expires_in / 60)} minutes…)`);
  const until = Date.now() + start.expires_in * 1000;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 3000));
    const p = await pollPairing(url, start.poll_secret).catch(() => ({}));
    if (p.status === 'approved' && p.token) {
      writePrivate(configFile, JSON.stringify({ ...(current || {}), url, token: p.token, device: p.device || device }, null, 2) + '\n');
      ok(`approved: this computer is connected to ${url} as "${p.device || device}"`);
      return;
    }
    if (p.status === 'denied' || p.status === 'expired') die(`pairing ${p.status}`);
  }
  die('pairing timed out');
}

async function access() {
  const s = state();
  if (!s.url) die(`Deploy hub "${NAME}" first.`);
  const teamArg = opt('team');
  if (!teamArg) {
    console.log(`
Cloudflare Access puts your Cloudflare login in front of the console (recommended). In the
Cloudflare dashboard → Zero Trust (choose a team name the first time, free plan):
  1. Access → Applications → Add → Self-hosted: name "agent-bridge console",
     domain ${new URL(s.url).host} (whole site). Policy: Allow, Include → Emails → your email.
  2. Add a second Self-hosted app "agent-bridge agents API" for the same host with paths
     api/*, pair/* and health. Policy action: Bypass, Include → Everyone.
     (Agents use their own device tokens there; Access must not block them.)
  3. Run: node hub/setup.mjs access --team <your-team-name> --name ${NAME}
  4. Open ${s.url}/admin/access in the browser (sign in when asked) and copy the "aud" value, then:
     node hub/setup.mjs access --team <your-team-name> --aud <aud> --name ${NAME}
`);
    return;
  }
  const team = teamArg.includes('.') ? teamArg.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : `${teamArg}.cloudflareaccess.com`;
  const aud = opt('aud');
  const values = { ACCESS_TEAM_DOMAIN: team, ...(aud ? { ACCESS_AUD: aud } : {}) };
  values.__force = Object.keys(values);
  setSecrets(values);
  saveState({ access_team: team, access_linked: Boolean(aud) });
  ok(`Access team set: ${team}`);
  if (aud) {
    ok('console sign-in with Cloudflare Access is on');
    console.log(`\nOpen ${s.url}: after the Cloudflare login, the console offers "Continue" without the admin token.\n`);
  } else {
    todo(`Now open ${s.url}/admin/access in the browser, copy "aud", and run this again with --aud <aud>.`);
  }
}

async function status() {
  const s = state();
  if (!s.url) die(`No hub "${NAME}" set up from this computer (looked in ${STATE}).`);
  const h = await health(s.url, 2);
  console.log(`\nhub "${NAME}": ${s.url}`);
  console.log(h ? `  ✓ up (version ${h.version ?? 'unknown'})` : '  ✗ not answering');
  console.log(`  · Access sign-in: ${s.access_linked ? `on (${s.access_team})` : 'not linked'}`);
  console.log(`  · admin token: ${path.join(HUB_DIR, 'admin-token')}\n`);
}

const commands = { check, deploy, connect, access, status };
if (!commands[command]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(command === 'help' ? 0 : 1);
}
await commands[command]();

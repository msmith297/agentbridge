// agent-bridge hub core: peer registry, message queue, listening state, device auth and the
// admin/console API. Runtime-neutral (Web Request/Response + a tiny SQL adapter), shared by
// the Cloudflare Durable Object hub and the local Node broker.
//
// SQL adapter: { all(sql, ...args) -> rows[], get(sql, ...args) -> row|undefined, run(sql, ...args) }

import { PROJECT_SCHEMA, SYSTEM_SENDER, createProjects, projectSlug } from './projects.mjs';
import { createPusher } from './webpush.mjs';

const ACTIVE_MS = 90_000;            // online if seen within this window (clients beat every 30s)
const LEASE_MS = 60_000;             // a fetched-but-unacked message is re-delivered after this
const ROUNDS_WINDOW_MS = 3_600_000;  // automatic-resume cap window
const STALE_MS = 24 * 3_600_000;     // forget agent peers not seen for a day
const HUMAN_STALE_MS = 30 * 24 * 3_600_000;
const PAIRING_TTL_MS = 10 * 60_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_CHUNK = 1024 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_WAIT_S = 300;
// Durable Object SQL rejects a statement with more than 100 bound parameters ("too many SQL variables"):
// IN (...) lists built from message ids or names go in chunks of this size.
const IN_CHUNK = 80;
export const LISTEN_ALWAYS = 9e15;   // listen_until meaning "no end time"

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, app TEXT, device TEXT, cwd TEXT,
    summary TEXT DEFAULT '', session_id TEXT, agent_pid INTEGER,
    listen_until INTEGER DEFAULT 0, auto_rounds INTEGER DEFAULT 0, rounds_since INTEGER DEFAULT 0,
    last_seen INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_peers_session ON peers(session_id)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_name TEXT NOT NULL, to_name TEXT NOT NULL,
    body TEXT NOT NULL, reply_to INTEGER, created_at INTEGER NOT NULL,
    leased_until INTEGER, delivered_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_name, delivered_at)`,
  `CREATE TABLE IF NOT EXISTS session_prefs (session_id TEXT PRIMARY KEY, name TEXT, listen_until INTEGER)`,
  `CREATE TABLE IF NOT EXISTS devices (
    name TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL,
    last_used INTEGER, revoked_at INTEGER)`,
  // Device pairing: a new computer shows a code; the operator approves it in the console.
  `CREATE TABLE IF NOT EXISTS pairings (
    code TEXT PRIMARY KEY, poll_hash TEXT UNIQUE NOT NULL, device_name TEXT NOT NULL, client TEXT,
    created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', device TEXT, token TEXT)`,
  // Chats: named conversations with a fixed set of members (direct or group).
  `CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS chat_members (chat_id INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY (chat_id, name))`,
  // Agent processes the operator removed: they may not re-register (stops phantom/orphan agents).
  `CREATE TABLE IF NOT EXISTS removed_peers (peer_id TEXT PRIMARY KEY, removed_at INTEGER NOT NULL)`,
  // Files attached to messages (stored in 1 MB chunks, like project files).
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT,
    created_at INTEGER NOT NULL, created_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS attachment_chunks (
    attachment_id TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (attachment_id, seq))`,
  // Permission prompts an agent forwarded for the operator to answer in the console.
  `CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, peer_id TEXT, peer_name TEXT NOT NULL, device TEXT,
    tool_name TEXT, summary TEXT, detail TEXT, cwd TEXT, created_at INTEGER NOT NULL,
    decision TEXT, message TEXT, decided_by TEXT, decided_at INTEGER)`,
  // AI accounts agents run on (reported by the client; the operator can alias them).
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, provider TEXT, type TEXT, email TEXT, org TEXT, plan TEXT, label TEXT, alias TEXT,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
  // Per-agent personalization, by name (moves with renames).
  `CREATE TABLE IF NOT EXISTS identities (name TEXT PRIMARY KEY COLLATE NOCASE, icon TEXT, color TEXT)`,
  // Browsers (the operator's phones and computers) that get push notifications.
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY, name TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    user_agent TEXT, created_at INTEGER NOT NULL, last_ok INTEGER)`,
  // Conversations an operator deleted from their console: messages up to before_id are hidden for them
  // (agents keep their copies); newer messages bring the conversation back.
  // The operator's identity: one name per Cloudflare Access login (email), so every device signed in
  // with it is the same person; `email` '' holds the default for admin-token sign-ins. Old names
  // merged into another stay reachable as aliases.
  `CREATE TABLE IF NOT EXISTS operators (email TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS human_aliases (alias TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS hidden_conversations (owner TEXT NOT NULL COLLATE NOCASE, conv TEXT NOT NULL,
    before_id INTEGER NOT NULL, PRIMARY KEY (owner, conv))`,
  ...PROJECT_SCHEMA,
];
// Columns added after the first release (ALTER fails harmlessly when they already exist).
const MIGRATIONS = [
  'ALTER TABLE peers ADD COLUMN project TEXT',
  'ALTER TABLE messages ADD COLUMN project TEXT',
  'ALTER TABLE session_prefs ADD COLUMN project TEXT',
  'ALTER TABLE messages ADD COLUMN attachments TEXT',
  'ALTER TABLE messages ADD COLUMN chat_id INTEGER',
  'ALTER TABLE messages ADD COLUMN send_id TEXT',
  'ALTER TABLE peers ADD COLUMN client_version TEXT',
  'ALTER TABLE peers ADD COLUMN os TEXT',
  'ALTER TABLE messages ADD COLUMN from_device TEXT',
  'ALTER TABLE devices ADD COLUMN label TEXT',
  'ALTER TABLE peers ADD COLUMN approvals TEXT',
  'ALTER TABLE session_prefs ADD COLUMN approvals TEXT',
  'ALTER TABLE peers ADD COLUMN account_id TEXT',
  'ALTER TABLE peers ADD COLUMN activity TEXT',
  'ALTER TABLE peers ADD COLUMN activity_at INTEGER',
  'ALTER TABLE peers ADD COLUMN listen_changed_by TEXT',
  'ALTER TABLE peers ADD COLUMN listen_changed_at INTEGER',
  'ALTER TABLE peers ADD COLUMN host_session_id TEXT',
  'ALTER TABLE peers ADD COLUMN role TEXT',
  'ALTER TABLE session_prefs ADD COLUMN role TEXT',
  'ALTER TABLE peers ADD COLUMN display_name TEXT',
  'ALTER TABLE messages ADD COLUMN quiet INTEGER',
  'ALTER TABLE peers ADD COLUMN last_tool TEXT',
  'ALTER TABLE peers ADD COLUMN last_tool_at INTEGER',
  'ALTER TABLE peers ADD COLUMN last_tool_args TEXT',
  // Stable identities on messages (an agent's session, else its process id; the console's person):
  // names change with renames and clashes, these don't. DM threads and replies follow them.
  'ALTER TABLE messages ADD COLUMN from_key TEXT',
  'ALTER TABLE messages ADD COLUMN to_key TEXT',
  // How far an agent was reminded to answer an operator's message: 1 while working, 2 at its turn's end.
  'ALTER TABLE messages ADD COLUMN reply_nudged INTEGER',
  // When a session's MCP server said goodbye (exited cleanly), as opposed to just going quiet.
  'ALTER TABLE peers ADD COLUMN left_at INTEGER',
  // Stay awake: the Claude app stops hidden sessions after 30 idle minutes; a session that stays
  // awake gets a tiny keepalive turn before that (null = default: on for Bridge Managers).
  'ALTER TABLE peers ADD COLUMN keep_awake INTEGER',
  'ALTER TABLE session_prefs ADD COLUMN keep_awake INTEGER',
  // Questions and plan approvals the agent would show in its app, answered from the console instead:
  // kind 'question' (payload: the questions; answer: answers) or 'plan' (payload: the plan).
  'ALTER TABLE approvals ADD COLUMN kind TEXT',
  'ALTER TABLE approvals ADD COLUMN payload TEXT',
  'ALTER TABLE approvals ADD COLUMN answers TEXT',
  // When mail was last handed out under a lease (e.g. to a background listener's wake-up): the agent
  // saw it then, even if the turn only confirms it at its end.
  'ALTER TABLE messages ADD COLUMN leased_at INTEGER',
  // When the read state was recorded (delivered_at can be back-dated to the lease): what the console's
  // incremental refresh looks for.
  'ALTER TABLE messages ADD COLUMN acked_at INTEGER',
];
const PEER_KEY = 'coalesce(p.session_id, p.id)';
const BACKFILL = [
  `UPDATE messages SET to_key = (SELECT ${PEER_KEY} FROM peers p WHERE p.name = messages.to_name COLLATE NOCASE)
   WHERE to_key IS NULL AND (SELECT count(*) FROM peers p WHERE p.name = messages.to_name COLLATE NOCASE) = 1`,
  `UPDATE messages SET from_key = (SELECT ${PEER_KEY} FROM peers p WHERE p.name = messages.from_name COLLATE NOCASE)
   WHERE from_key IS NULL AND (SELECT count(*) FROM peers p WHERE p.name = messages.from_name COLLATE NOCASE) = 1`,
  `UPDATE messages SET from_key = (SELECT ${PEER_KEY} FROM peers p WHERE p.device = messages.from_device
     AND coalesce(p.display_name, p.name) = messages.from_name COLLATE NOCASE)
   WHERE from_key IS NULL AND from_device IS NOT NULL AND (SELECT count(*) FROM peers p WHERE p.device = messages.from_device
     AND coalesce(p.display_name, p.name) = messages.from_name COLLATE NOCASE) = 1`,
  // Direct messages to the operator from an agent in a project were tagged with the project and
  // showed up in its chat (project broadcasts only ever go to agents). Replies are left alone: a
  // reply to a project message belongs in the project chat.
  `UPDATE messages SET project = NULL WHERE project IS NOT NULL AND chat_id IS NULL AND reply_to IS NULL
   AND (to_key LIKE 'human:%' OR to_name IN (SELECT name FROM peers WHERE kind = 'human'))`,
  // Conversations with an agent from before it had a session (keyed by its process id) join the
  // session's conversation.
  `UPDATE messages SET from_key = (SELECT p.session_id FROM peers p WHERE p.id = messages.from_key)
   WHERE from_key IN (SELECT id FROM peers WHERE session_id IS NOT NULL)`,
  `UPDATE messages SET to_key = (SELECT p.session_id FROM peers p WHERE p.id = messages.to_key)
   WHERE to_key IN (SELECT id FROM peers WHERE session_id IS NOT NULL)`,
  // Replies to project messages whose tag the earlier version of the line above removed.
  `UPDATE messages SET project = (SELECT p.project FROM messages p WHERE p.id = messages.reply_to)
   WHERE project IS NULL AND chat_id IS NULL AND reply_to IS NOT NULL
   AND (SELECT p.project FROM messages p WHERE p.id = messages.reply_to) IS NOT NULL`,
];
// Remote approvals: 'away' forwards permission prompts only in turns a bridge message started
// (the user is probably not at the keyboard); 'always' forwards every prompt; 'off' never.
const APPROVAL_MODES = ['away', 'always', 'off'];
const APPROVAL_TTL_MS = 15 * 60_000; // hooks give up well before this; older requests are stale
// Indexes that keep per-request reads small (the free plan caps rows read per day). Names are
// matched case-insensitively, so the name indexes use NOCASE to match `col = ? COLLATE NOCASE`.
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_inbox_nocase ON messages(to_name COLLATE NOCASE, delivered_at)',
  'CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project, id)',
  'CREATE INDEX IF NOT EXISTS idx_messages_delivered ON messages(delivered_at)',
  'CREATE INDEX IF NOT EXISTS idx_peers_name_nocase ON peers(name COLLATE NOCASE)',
  'CREATE INDEX IF NOT EXISTS idx_chat_members_name ON chat_members(name COLLATE NOCASE)',
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Runs fn(chunk, placeholders) over list in IN_CHUNK-sized pieces.
function inChunks(list, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) {
    const chunk = list.slice(i, i + IN_CHUNK);
    out.push(fn(chunk, chunk.map(() => '?').join(',')));
  }
  return out;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'ab_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * @param db SQL adapter
 * @param opts.adminToken  token with full access (console, device management)
 * @param opts.maxAutoRounds  hook-driven resumes allowed per session per hour
 * @param opts.push  Web Push config { publicKey, privateJwk, subject } (none: no notifications)
 * @param opts.defer  keeps background work (sending pushes) alive after the response
 */
export function createHub(db, { adminToken, maxAutoRounds = 20, adminOnAgentApi = true, push = null, defer = p => p.catch(() => {}) } = {}) {
  for (const stmt of SCHEMA) db.run(stmt);
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* already applied */ } }
  // Older messages: fill in identities where the name (or the name on the sender's computer) is unambiguous.
  for (const stmt of BACKFILL) { try { db.run(stmt); } catch { /* best effort */ } }
  for (const stmt of INDEXES) db.run(stmt);

  const now = () => Date.now();
  const pusher = push?.publicKey && push.privateJwk ? createPusher(push) : null;
  const waiters = new Map(); // lower(name) -> Set<() => void>
  const lastHookWait = new Map(); // lower(name) -> when a listening Stop hook last started/finished a long-poll

  // listening = mode switched on; waiting = actually long-polling now (a listening agent's Stop
  // hook, or wait_for_message), i.e. it will react to a message without a user prompt. An idle
  // session switched to listening only starts waiting after its next turn ends.
  function liveness(name, listenUntil) {
    const key = name.toLowerCase();
    // Stop hooks re-poll in ~5-minute chunks; bridge the short gap between chunks.
    const waiting = waiters.has(key) || now() - (lastHookWait.get(key) || 0) < 10_000;
    // When something last polled for its mail on its behalf: a listening agent whose listener died
    // (no polls for a while after its turn ended) won't wake, and the console says so.
    return { listening: (listenUntil || 0) > now(), waiting, polled_at: waiters.has(key) ? now() : lastHookWait.get(key) || null };
  }

  function wake(name) {
    const key = name.toLowerCase();
    for (const fn of waiters.get(key) ?? []) fn();
    waiters.delete(key);
  }

  // ---- auth ----

  async function authenticate(request) {
    const header = request.headers.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    // The admin token may also run agents (local single-machine mode); they name their device.
    if (adminToken && timingSafeEqual(token, adminToken)) {
      return { admin: true, device: (request.headers.get('x-agent-device') || 'admin').slice(0, 40) };
    }
    const device = db.get('SELECT name FROM devices WHERE token_hash = ? AND revoked_at IS NULL', await sha256(token));
    if (!device) return null;
    db.run('UPDATE devices SET last_used = ? WHERE name = ?', now(), device.name);
    return { admin: false, device: device.name };
  }

  // ---- devices ----

  async function issueDevice(rawName) {
    const name = String(rawName || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!name) throw new HttpError(400, 'device name required');
    const existing = db.get('SELECT * FROM devices WHERE name = ?', name);
    if (existing && !existing.revoked_at) throw new HttpError(409, `device "${name}" exists; revoke it first to re-issue, or pick another name`);
    const token = randomToken();
    db.run(`INSERT INTO devices (name, token_hash, created_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_used = NULL, revoked_at = NULL`,
      name, await sha256(token), now());
    return { name, token }; // the token is shown once; only its hash is stored
  }

  function pendingPairings() {
    db.run(`DELETE FROM pairings WHERE created_at < ?`, now() - PAIRING_TTL_MS);
    return db.all(`SELECT code, device_name, client, created_at FROM pairings WHERE status = 'pending' ORDER BY created_at`);
  }

  // Unauthenticated: a computer asks to join, then polls until the operator decides.
  const pairRoutes = {
    'POST /start': async ({ body }) => {
      if (pendingPairings().length >= 20) throw new HttpError(429, 'too many pending pairing requests; try again later');
      const pick = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      const raw = pick();
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      const pollSecret = randomToken();
      db.run('INSERT INTO pairings (code, poll_hash, device_name, client, created_at) VALUES (?, ?, ?, ?, ?)',
        code, await sha256(pollSecret), String(body.device_name || 'computer').slice(0, 40), String(body.client || '').slice(0, 120), now());
      return { code, poll_secret: pollSecret, expires_in: PAIRING_TTL_MS / 1000 };
    },
    'POST /poll': async ({ body }) => {
      const row = db.get('SELECT * FROM pairings WHERE poll_hash = ?', await sha256(String(body.poll_secret || '')));
      if (!row || row.created_at < now() - PAIRING_TTL_MS) return { status: 'expired' };
      if (row.status === 'pending') return { status: 'pending', code: row.code };
      db.run('DELETE FROM pairings WHERE code = ?', row.code); // approved/denied results are delivered once
      return row.status === 'approved' ? { status: 'approved', device: row.device, token: row.token } : { status: 'denied' };
    },
  };

  // ---- accounts and identities ----

  // How an account is shown to everyone (agents too): the operator's alias, else a label without
  // personal details (provider + plan / org).
  function accountName(a) {
    if (!a) return null;
    if (a.alias) return a.alias;
    if (a.label) return a.label;
    const provider = a.provider === 'anthropic' ? 'Claude' : a.provider === 'openai' ? 'ChatGPT' : a.provider || 'account';
    const plan = a.plan ? a.plan.replace(/^(claude|chatgpt)_/i, '').replace(/_/g, ' ') : '';
    // Personal workspaces are named "<email>'s Organization": never show that (agents see this name).
    const org = a.org && !a.org.includes('@') && !/'s organization$/i.test(a.org) ? a.org : '';
    const short = String(a.id).split('-').pop().slice(0, 4);
    return [`${provider}${plan ? ` ${plan.replace(/\b\w/g, c => c.toUpperCase())}` : ''}`, org || `#${short}`].join(' · ');
  }
  const accountNames = () => Object.fromEntries(db.all('SELECT * FROM accounts').map(a => [a.id, accountName(a)]));

  function recordAccount(peerId, account) {
    if (!account || typeof account !== 'object' || !account.id) return;
    const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
    const id = String(account.id).slice(0, 80);
    db.run(`INSERT INTO accounts (id, provider, type, email, org, plan, label, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, type = excluded.type, email = coalesce(excluded.email, email),
        org = coalesce(excluded.org, org), plan = coalesce(excluded.plan, plan), label = excluded.label, last_seen = excluded.last_seen`,
    id, clip(account.provider, 40), clip(account.type, 20), clip(account.email, 200), clip(account.org, 120), clip(account.plan, 60),
    clip(account.label, 120), now(), now());
    db.run('UPDATE peers SET account_id = ? WHERE id = ?', id, peerId);
  }

  const ICON_MAX = 16;
  function setIdentity(name, { icon, color } = {}) {
    const cur = db.get('SELECT * FROM identities WHERE name = ?', name) || {};
    const nextIcon = icon === undefined ? cur.icon ?? null : String(icon).trim().slice(0, ICON_MAX) || null;
    let nextColor = color === undefined ? cur.color ?? null : String(color).trim() || null;
    if (nextColor && !/^#[0-9a-f]{6}$/i.test(nextColor)) throw new HttpError(400, 'color must look like #4a7bd0');
    db.run(`INSERT INTO identities (name, icon, color) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET icon = excluded.icon, color = excluded.color`, name, nextIcon, nextColor?.toLowerCase() ?? null);
    return { icon: nextIcon, color: nextColor };
  }

  // Friendly machine names for message tags: the operator's label, else a guess from the device
  // name and its agents' OS (macbook-pro → "MacBook Pro", a Windows "…desktop…" → "Windows desktop").
  function deviceLabel(name) {
    if (!name) return null;
    if (name === 'console') return 'Console';
    const row = db.get('SELECT label FROM devices WHERE name = ?', name);
    if (row?.label) return row.label;
    const os = db.get('SELECT os FROM peers WHERE device = ? AND os IS NOT NULL ORDER BY last_seen DESC LIMIT 1', name)?.os;
    if (/macbook/i.test(name)) {
      return name.replace(/[-_]+/g, ' ').replace(/\bmacbook\b/i, 'MacBook').replace(/\b(pro|air)\b/gi, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
    }
    if (os === 'win32') return /desktop/i.test(name) ? 'Windows desktop' : /laptop/i.test(name) ? 'Windows laptop' : 'Windows PC';
    if (os === 'darwin') return /imac/i.test(name) ? 'iMac' : 'Mac';
    if (os === 'linux') return 'Linux';
    return name;
  }
  const deviceLabels = () => Object.fromEntries(
    [...new Set(db.all('SELECT name FROM devices').map(d => d.name).concat(db.all('SELECT DISTINCT device FROM peers').map(p => p.device)))]
      .filter(Boolean).map(n => [n, deviceLabel(n)]).concat([['console', 'Console']]));

  // ---- peers ----

  const activeByName = name =>
    db.get('SELECT * FROM peers WHERE name = ? COLLATE NOCASE AND last_seen > ?', name, now() - ACTIVE_MS);
  const anyByName = name =>
    db.get('SELECT * FROM peers WHERE name = ? COLLATE NOCASE ORDER BY last_seen DESC LIMIT 1', name);

  // Who a name in `to` means. Agents can share a display name, so:
  //  - a bare name shared by 2+ online agents is ambiguous (error listing their full addresses), unless
  //    `exact`: the console sends exact addresses, and an address is unique;
  //  - every one of them also answers to Name@<computer name or id>[ · <account>].
  const shownName = p => p.display_name || p.name;
  function fullAddress(p, twins) {
    const sameDevice = twins.filter(t => t.device === p.device).length > 1;
    const account = sameDevice && p.account_id ? db.get('SELECT * FROM accounts WHERE id = ?', p.account_id) : null;
    return `${shownName(p)}@${deviceLabel(p.device)}${account ? ` · ${accountName(account)}` : ''}`;
  }
  function resolveName(n, { exact: byAddress = false } = {}) {
    const lower = String(n).trim().toLowerCase();
    const online = db.all(`SELECT * FROM peers WHERE last_seen > ? AND kind != 'human' AND NOT (kind = 'codex' AND session_id IS NULL)`, now() - ACTIVE_MS);
    const exact = activeByName(n);
    if (exact && byAddress) return exact;
    const twins = online.filter(p => shownName(p).toLowerCase() === lower);
    if (twins.length > 1) {
      throw new HttpError(409, `"${n}" is ambiguous: ${twins.length} agents use that name. Send to one of: ${twins.map(t => `"${fullAddress(t, twins)}"`).join(', ')}`);
    }
    if (exact) return exact;
    // Name@qualifier, splitting at each "@" from the right (names themselves may contain "@").
    for (let i = lower.lastIndexOf('@'); i > 0; i = lower.lastIndexOf('@', i - 1)) {
      const base = lower.slice(0, i), qual = lower.slice(i + 1).trim();
      const hits = online.filter(p => shownName(p).toLowerCase() === base).filter(p => {
        const label = deviceLabel(p.device).toLowerCase();
        const account = p.account_id ? accountName(db.get('SELECT * FROM accounts WHERE id = ?', p.account_id) || null)?.toLowerCase() : null;
        return [label, p.device.toLowerCase(), account, account && `${label} · ${account}`, account && `${p.device.toLowerCase()} · ${account}`].includes(qual);
      });
      if (hits.length === 1) return hits[0];
    }
    if (twins[0]) return twins[0];
    // An operator name that was merged into another one.
    const alias = db.get('SELECT name FROM human_aliases WHERE alias = ? COLLATE NOCASE', String(n).trim());
    return anyByName(alias ? alias.name : n);
  }

  // Pick a name not held by another online peer: foo, foo-2, foo-3 ...
  // A peer's address (`name`) is unique: messages, chats and mentions use it. Several agents may share
  // a display name, though; on a clash the address gets the computer, then the account:
  // "Bridge Manager" → "Bridge Manager@MacBook Pro" → "Bridge Manager@MacBook Pro · Claude 2" (→ "-2").
  function claimName(id, wanted, ctx = {}) {
    const base = String(wanted || 'peer').trim().slice(0, 64) || 'peer';
    const self = getPeer(id) || {};
    const device = ctx.device ?? self.device;
    const accountId = ctx.account_id ?? self.account_id;
    const session = ctx.session_id ?? self.session_id ?? null;
    // Who holds a name: anyone online, and offline agents of another session (their app is just
    // closed: they keep their name, chats and mail). Offline leftovers of this same session, or
    // without one, don't count and are cleared away when the name is taken.
    const blocks = h => h.kind === 'human' || h.last_seen > now() - ACTIVE_MS || (h.session_id && h.session_id !== session);
    const free = candidate => !db.all('SELECT * FROM peers WHERE name = ? COLLATE NOCASE AND id != ?', candidate, id).some(blocks);
    const take = candidate => {
      db.run(`DELETE FROM peers WHERE name = ? COLLATE NOCASE AND id != ? AND kind != 'human' AND last_seen <= ?
        AND (session_id IS NULL OR session_id = ?)`, candidate, id, now() - ACTIVE_MS, session);
      return candidate;
    };
    const candidates = [base];
    if (device) candidates.push(`${base}@${deviceLabel(device)}`);
    const account = accountId && db.get('SELECT * FROM accounts WHERE id = ?', accountId);
    if (device && account) candidates.push(`${base}@${deviceLabel(device)} · ${accountName(account)}`);
    for (const candidate of candidates) if (free(candidate)) return take(candidate);
    for (let i = 2; ; i++) if (free(`${base}-${i}`)) return take(`${base}-${i}`);
  }

  // listen value from a client: "always", minutes (0 = off), or undefined (off).
  function listenUntil(listen) {
    if (listen === 'always') return LISTEN_ALWAYS;
    const minutes = Math.min(Math.max(Number(listen) || 0, 0), 24 * 60);
    return minutes ? now() + minutes * 60_000 : 0;
  }

  const roundsInWindow = p => (now() - (p.rounds_since || 0) > ROUNDS_WINDOW_MS ? 0 : p.auto_rounds || 0);
  // Mail it can take now: not what a wake-up already handed it (leased, confirmed at the turn's end).
  const unreadCount = name => db.get(`SELECT count(*) AS n FROM messages WHERE to_name = ? COLLATE NOCASE
    AND delivered_at IS NULL AND (leased_until IS NULL OR leased_until < ?)`, name, now()).n;
  const urgentCount = name => db.get(`SELECT count(*) AS n FROM messages WHERE to_name = ? COLLATE NOCASE
    AND delivered_at IS NULL AND (leased_until IS NULL OR leased_until < ?) AND coalesce(quiet, 0) = 0`, name, now()).n;

  function status(p) {
    return {
      id: p.id,
      name: p.name,
      project: p.project || null,
      unread: unreadCount(p.name),
      urgent: urgentCount(p.name), // unread mail addressed to it (not FYI group traffic): what wakes it
      bound: Boolean(p.session_id), // its agent session is known (hooks can reach it)
      display_name: p.display_name || p.name,
      listen_until: p.listen_until || 0,
      listen_always: (p.listen_until || 0) >= LISTEN_ALWAYS,
      auto_rounds: roundsInWindow(p),
      max_auto_rounds: maxAutoRounds,
      approvals: p.approvals || 'away',
      awaiting_reply: awaitingCount(p), // operator messages it read and hasn't answered
      keep_awake: staysAwake(p),
    };
  }

  const getPeer = id => db.get('SELECT * FROM peers WHERE id = ?', id);
  // Bridge Manager: set in the console, or by default a Claude agent named "Bridge Manager" (role
  // 'none' opts out).
  const isManager = p => p.role === 'manager' || (p.role == null && p.kind === 'claude' && /^bridge manager$/i.test(p.display_name || p.name));
  const staysAwake = p => (p.keep_awake == null ? isManager(p) || /^bridge manager$/i.test(p.display_name || p.name) : Boolean(p.keep_awake));

  // Codex apps start agent-bridge processes that never get a session (tool listings, restarts):
  // once offline, with no session and no mail, they're of no use to anyone.
  const dropGhosts = () => db.run(`DELETE FROM peers WHERE kind = 'codex' AND session_id IS NULL AND last_seen < ?
    AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.to_name = peers.name COLLATE NOCASE AND delivered_at IS NULL)`, now() - ACTIVE_MS);

  // Agents address themselves by MCP-process id; hooks by agent session id.
  const isRemoved = id => Boolean(id && db.get('SELECT 1 AS x FROM removed_peers WHERE peer_id = ?', String(id)));
  const removedError = () => new HttpError(410, 'this agent was removed from agent-bridge by the operator; restart the session to rejoin');

  function requirePeer(body, auth) {
    let peer;
    if (body.id && isRemoved(body.id)) throw removedError();
    if (body.id) peer = getPeer(String(body.id));
    else if (body.session_id) {
      peer = db.get('SELECT * FROM peers WHERE session_id = ? ORDER BY last_seen DESC LIMIT 1', String(body.session_id));
    }
    if (!peer || (!auth.admin && peer.device !== auth.device)) throw new HttpError(404, 'unknown peer; re-register');
    // A Codex session's server process restarted (the app restarted): its old row is offline. Report
    // it unknown so the hook links the session to the new server (which takes over its name and mail).
    if (!body.id && peer.kind === 'codex' && peer.last_seen <= now() - ACTIVE_MS) throw new HttpError(404, 'session needs relinking');
    // Presence comes only from the agent's own MCP server (addressed by id). Hooks and background
    // listeners (addressed by session) can outlive their session — e.g. on Windows after the app
    // quits — and must not keep it looking online.
    if (body.id) db.run('UPDATE peers SET last_seen = ?, left_at = NULL WHERE id = ?', now(), peer.id);
    return peer;
  }

  function applySessionPrefs(peerId, sessionId) {
    const prefs = sessionId && db.get('SELECT * FROM session_prefs WHERE session_id = ?', sessionId);
    if (!prefs) return;
    if (prefs.name) {
      const before = getPeer(peerId)?.name;
      const name = claimName(peerId, prefs.name);
      db.run('UPDATE peers SET name = ?, display_name = ? WHERE id = ?', name, prefs.name, peerId);
      moveAddress(before, name);
    }
    if (prefs.listen_until != null) db.run('UPDATE peers SET listen_until = ? WHERE id = ?', prefs.listen_until, peerId);
    if (prefs.project != null) db.run('UPDATE peers SET project = ? WHERE id = ?', prefs.project || null, peerId); // '' = left
    if (prefs.approvals) db.run('UPDATE peers SET approvals = ? WHERE id = ?', prefs.approvals, peerId);
    if (prefs.role) db.run('UPDATE peers SET role = ? WHERE id = ?', prefs.role, peerId);
    if (prefs.keep_awake != null) db.run('UPDATE peers SET keep_awake = ? WHERE id = ?', prefs.keep_awake, peerId);
  }


  // Link an agent-bridge server (peer) to its agent session. If the session belonged to another row
  // before (its server restarted), that row's name and waiting mail carry over.
  function linkSession(peer, sessionId) {
    // Its identity was its process id until now: its conversations move to the session's identity.
    if (!peer.session_id) {
      db.run('UPDATE messages SET from_key = ? WHERE from_key = ?', sessionId, peer.id);
      db.run('UPDATE messages SET to_key = ? WHERE to_key = ?', sessionId, peer.id);
    }
    const prior = db.get('SELECT * FROM peers WHERE session_id = ? AND id != ? ORDER BY last_seen DESC LIMIT 1', sessionId, peer.id);
    db.run('UPDATE peers SET session_id = NULL WHERE session_id = ? AND id != ?', sessionId, peer.id);
    db.run('UPDATE peers SET session_id = ?, last_seen = ? WHERE id = ?', sessionId, now(), peer.id);
    // Remember a listening mode chosen before the session was known.
    if (peer.listen_until && !db.get('SELECT 1 AS x FROM session_prefs WHERE session_id = ?', sessionId)) {
      db.run('INSERT INTO session_prefs (session_id, listen_until) VALUES (?, ?)', sessionId, peer.listen_until);
    }
    applySessionPrefs(peer.id, sessionId);
    if (prior && prior.last_seen <= now() - ACTIVE_MS) {
      const prefs = db.get('SELECT name FROM session_prefs WHERE session_id = ?', sessionId);
      if (!prefs?.name && prior.display_name) renamePeer(getPeer(peer.id), prior.display_name);
      db.run('DELETE FROM peers WHERE id = ?', prior.id);
      moveAddress(prior.name, getPeer(peer.id).name);
    }
  }

  // The address an identity key (agent session id, else its process id) has now; `fallback` if unknown.
  function currentAddress(key, fallback) {
    const p = key && db.get(`SELECT name FROM peers WHERE coalesce(session_id, id) = ? ORDER BY last_seen DESC LIMIT 1`, key);
    return p?.name ?? fallback;
  }

  // ---- Bridge Manager: one agent session per computer + AI account + app, which revives the
  // others in its app (desktop session tools) and runs plugin updates. ----

  const sameApp = (a, b) => a.device === b.device && (a.account_id || '') === (b.account_id || '') && (a.app || '') === (b.app || '');

  function setRole(peer, role) {
    if (role === 'manager') {
      // One Manager per computer + account + app: the others lose the role.
      for (const other of db.all('SELECT * FROM peers WHERE id != ?', peer.id).filter(o => isManager(o) && sameApp(o, peer))) {
        db.run("UPDATE peers SET role = 'none' WHERE id = ?", other.id);
        if (other.session_id) db.run("UPDATE session_prefs SET role = 'none' WHERE session_id = ?", other.session_id);
      }
    }
    db.run('UPDATE peers SET role = ? WHERE id = ?', role || 'none', peer.id);
    if (peer.session_id) {
      db.run(`INSERT INTO session_prefs (session_id, role) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET role = excluded.role`, peer.session_id, role || 'none');
    }
  }

  // Mail is waiting for an offline session: ask its app's Manager to start it again (or, if the
  // Manager itself is the one offline, any online agent in the same app). At most once per 10 minutes.
  const revived = new Map(); // peer id -> when a revive was last requested
  function requestRevive(target) {
    if (!target?.session_id || target.kind === 'human' || target.last_seen > now() - ACTIVE_MS) return null;
    if (now() - (revived.get(target.id) || 0) < 10 * 60_000) return null;
    const online = db.all(`SELECT * FROM peers WHERE device = ? AND last_seen > ? AND kind != 'human' AND id != ?`, target.device, now() - ACTIVE_MS, target.id)
      .filter(p => sameApp(p, target));
    const helper = online.find(isManager) || (isManager(target) ? online.sort((a, b) => (b.listen_until || 0) - (a.listen_until || 0))[0] : null);
    if (!helper) return null;
    revived.set(target.id, now());
    notify(helper.name, `agent-bridge revive request: "${target.name}" is offline and has messages waiting. ` +
      `Start it with the desktop app's session tools: send its session ${target.host_session_id || `(Claude Code session ${target.session_id})`} ` +
      'a short message such as "agent-bridge: you have messages waiting. Run check_inbox and handle them." ' +
      `${isManager(helper) ? 'You are this app\'s Bridge Manager' : 'The Bridge Manager of your app is offline, so you were asked'}; ` +
      'the operator has switched on automatic revives, so no need to ask first. Use the agent-bridge revive-session skill for the details. ' +
      'Do nothing else for this request, and don\'t reply to it unless reviving fails.');
    return helper.name;
  }

  function setApprovals(peer, mode) {
    if (!APPROVAL_MODES.includes(mode)) throw new HttpError(400, `approvals must be one of: ${APPROVAL_MODES.join(', ')}`);
    db.run('UPDATE peers SET approvals = ? WHERE id = ?', mode, peer.id);
    if (peer.session_id) {
      db.run(`INSERT INTO session_prefs (session_id, approvals) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET approvals = excluded.approvals`, peer.session_id, mode);
    }
  }

  // ---- push notifications (to the operator's browsers) ----

  // Push `data` to the subscriptions matching `where`; drops ones the push service says are gone.
  // An operator actively using a desktop console (on screen, recent mouse/keyboard input) doesn't need
  // their phone buzzing as well: phone pushes wait while that lasts.
  const activeDesktop = new Map(); // lower-case operator name -> last active-desktop poll
  const atDesktop = name => (activeDesktop.get(String(name).toLowerCase()) || 0) > now() - 60_000;
  const isPhone = sub => /iPhone|iPad|iPod|Android|Mobile/i.test(sub.user_agent || '');

  function pushTo(where, args, data, opts) {
    if (!pusher) return Promise.resolve([]);
    const subs = db.all(`SELECT * FROM push_subscriptions WHERE ${where}`, ...args).filter(sub => !(isPhone(sub) && atDesktop(sub.name)));
    const sent = Promise.all(subs.map(sub => pusher(sub, data, opts).then(status => {
      if (status === 404 || status === 410) db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', sub.endpoint);
      else if (status < 300) db.run('UPDATE push_subscriptions SET last_ok = ? WHERE endpoint = ?', now(), sub.endpoint);
      return status;
    }, () => 0)));
    defer(sent);
    return sent;
  }

  // What each operator's console has on screen right now (it says so with every poll while visible):
  // no push for the conversation they're already looking at.
  const viewing = new Map(); // lower-case operator name -> { conv, at }
  const isViewing = (name, conv) => { const v = viewing.get(name); return Boolean(conv && v && v.conv === conv && v.at > now() - 15_000); };

  function pushToNames(names, data, opts, conv = null) {
    const lower = [...new Set(names.map(n => n.toLowerCase()))].filter(n => !isViewing(n, conv));
    if (!lower.length) return Promise.resolve([]);
    return Promise.all(inChunks(lower, (chunk, qs) => pushTo(`lower(name) IN (${qs})`, chunk, data, opts))).then(r => r.flat());
  }

  // ---- remote approvals ----

  const approvalKey = id => `\0approval:${id}`; // waiter key that can't collide with a peer name
  const pendingApprovals = () => db.all(`SELECT id, peer_id, peer_name, device, tool_name, summary, detail, cwd, created_at, kind, payload
    FROM approvals WHERE decision IS NULL AND created_at > ? ORDER BY id`, now() - APPROVAL_TTL_MS)
    .map(a => ({ ...a, kind: a.kind || 'permission', payload: a.payload ? JSON.parse(a.payload) : null, machine: deviceLabel(a.device) }));

  function requestApproval(peer, body) {
    const clip = (v, n) => String(v ?? '').slice(0, n);
    const kind = ['question', 'plan'].includes(body.kind) ? body.kind : null;
    const payload = kind && body.payload ? JSON.stringify(body.payload).slice(0, 100_000) : null;
    db.run(`INSERT INTO approvals (peer_id, peer_name, device, tool_name, summary, detail, cwd, created_at, kind, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, peer.id, peer.name, peer.device, clip(body.tool_name, 200),
    clip(body.summary, 2000), clip(body.detail, 20_000), clip(body.cwd, 1000), now(), kind, payload);
    const id = db.get('SELECT last_insert_rowid() AS id').id;
    pushTo('1 = 1', [], {
      title: kind === 'question' ? `${peer.display_name || peer.name} has a question` : kind === 'plan' ? `Plan to approve`
        : `Approval needed: ${clip(body.tool_name, 60) || 'tool'}`,
      body: `${peer.name} on ${deviceLabel(peer.device)}${body.summary ? `: ${clip(body.summary, 200)}` : ''}`,
      url: '/#/agents', tag: `approval-${id}`, approval: true,
    });
    return { id };
  }

  const approvalResult = a => (['allow', 'deny', 'answer'].includes(a.decision)
    ? { decision: a.decision, message: a.message || '', decided_by: a.decided_by, ...(a.answers ? { answers: JSON.parse(a.answers) } : {}) }
    : { decision: a.decision || null, pending: !a.decision });

  // Long-poll until the operator decides (or the wait runs out).
  function waitForApproval(peer, id, waitSeconds) {
    const get = () => db.get('SELECT * FROM approvals WHERE id = ? AND peer_id = ?', Number(id), peer.id);
    const first = get();
    if (!first) throw new HttpError(404, 'no such approval request');
    const waitMs = Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_S) * 1000;
    if (first.decision || !waitMs) return approvalResult(first);
    return new Promise(resolve => {
      const key = approvalKey(first.id);
      const done = () => {
        clearTimeout(timer);
        waiters.get(key)?.delete(done);
        if (!waiters.get(key)?.size) waiters.delete(key);
        resolve(approvalResult(get()));
      };
      const timer = setTimeout(done, waitMs);
      if (!waiters.has(key)) waiters.set(key, new Set());
      waiters.get(key).add(done);
    });
  }

  // decision: allow | deny, or answer (a question: `answers` maps each question to the chosen option(s) or text).
  function decideApproval(id, decision, message, by, answers = null) {
    if (!['allow', 'deny', 'answer', 'cancelled'].includes(decision)) throw new HttpError(400, 'decision must be allow, deny or answer');
    const row = db.get('SELECT * FROM approvals WHERE id = ?', Number(id));
    if (!row) throw new HttpError(404, 'no such approval request');
    if (row.decision) throw new HttpError(409, row.decision === 'cancelled'
      ? 'the agent stopped waiting (it timed out or was answered on the computer)' : `already answered: ${row.decision}`);
    if (decision === 'answer' && (row.kind !== 'question' || !answers || typeof answers !== 'object')) throw new HttpError(400, 'answers required');
    db.run('UPDATE approvals SET decision = ?, message = ?, decided_by = ?, decided_at = ?, answers = ? WHERE id = ?',
      decision, String(message || '').slice(0, 2000), by, now(), decision === 'answer' ? JSON.stringify(answers).slice(0, 20_000) : null, row.id);
    wake(approvalKey(row.id));
    db.run('DELETE FROM approvals WHERE created_at < ?', now() - 7 * 24 * 3_600_000);
    return { id: row.id, decision };
  }

  function setProject(peer, slug) {
    db.run('UPDATE peers SET project = ? WHERE id = ?', slug, peer.id);
    if (peer.session_id) {
      db.run(`INSERT INTO session_prefs (session_id, project) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET project = excluded.project`, peer.session_id, slug || '');
    }
  }

  // A peer's address changed (rename, name clash, restart): its unread mail, chat memberships and
  // look move with it, whatever caused the change.
  function moveAddress(oldName, newName) {
    if (!oldName || !newName || oldName.toLowerCase() === newName.toLowerCase()) return;
    db.run('UPDATE messages SET to_name = ? WHERE to_name = ? COLLATE NOCASE AND delivered_at IS NULL', newName, oldName);
    db.run('UPDATE OR IGNORE chat_members SET name = ? WHERE name = ? COLLATE NOCASE', newName, oldName);
    db.run('UPDATE OR IGNORE identities SET name = ? WHERE name = ?', newName, oldName);
  }

  // Rename a peer: its unread mail and chat memberships move to the new name; a session keeps it.
  function renamePeer(peer, wanted) {
    const display = String(wanted).trim().slice(0, 64);
    const name = claimName(peer.id, display);
    db.run('UPDATE peers SET display_name = ? WHERE id = ?', display, peer.id);
    if (name === peer.name) return name;
    db.run('UPDATE peers SET name = ? WHERE id = ?', name, peer.id);
    moveAddress(peer.name, name);
    if (peer.session_id) {
      db.run(`INSERT INTO session_prefs (session_id, name) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET name = excluded.name`, peer.session_id, String(wanted).trim().slice(0, 64));
    }
    return name;
  }

  // `by`: who switched it (the agent itself, or the operator from the console), shown in the console.
  function setListen(peer, listen, by = null) {
    const until = listenUntil(listen);
    db.run('UPDATE peers SET listen_until = ?, auto_rounds = 0, listen_changed_by = ?, listen_changed_at = ? WHERE id = ?',
      until, by, now(), peer.id);
    if (peer.session_id) {
      db.run(`INSERT INTO session_prefs (session_id, listen_until) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET listen_until = excluded.listen_until`, peer.session_id, until);
    }
  }

  function peerList({ includeOffline = false } = {}) {
    const since = includeOffline ? now() - STALE_MS : now() - ACTIVE_MS;
    const accounts = accountNames();
    return db.all(`SELECT p.id, p.name, p.kind, p.app, p.device, p.cwd, p.summary, p.project, p.client_version, p.listen_until,
      p.approvals, p.account_id, p.activity, p.activity_at, p.listen_changed_by, p.listen_changed_at, p.role, p.host_session_id, p.display_name, p.session_id,
      p.last_seen, p.keep_awake, p.os, i.icon, i.color
      FROM peers p LEFT JOIN identities i ON i.name = p.name
      WHERE (p.last_seen > ? OR p.kind = 'human')
        -- Codex apps start agent-bridge servers for every thread they load; until one is linked to
        -- a chat (session) it is nobody's agent, so it stays out of sight.
        AND NOT (p.kind = 'codex' AND p.session_id IS NULL)
      ORDER BY p.name`, since).map(({ listen_until, approvals, activity, activity_at, session_id, keep_awake, ...p }) => ({
      ...p,
      role: isManager(p) ? 'manager' : null,
      keep_awake: staysAwake({ ...p, keep_awake }),
      activity: activity ? { ...JSON.parse(activity), at: activity_at } : null,
      display_name: p.display_name || p.name,
      key: session_id || p.id, // stable identity (names change with renames and clashes); the session id itself isn't shared
      account: accounts[p.account_id] ?? null,
      approvals: approvals || 'away',
      ...liveness(p.name, listen_until),
      online: p.last_seen > now() - ACTIVE_MS,
      listen_always: listen_until >= LISTEN_ALWAYS,
    }));
  }

  // ---- messages ----

  // ---- attachments ----

  async function putAttachment(request, url, actor) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) throw new HttpError(400, 'empty file');
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'attachment too large (max 25 MB)');
    const name = String(url.searchParams.get('name') || 'file').split(/[\\/]/).pop().slice(0, 120) || 'file';
    const id = randomToken().slice(3, 27);
    db.run('INSERT INTO attachments (id, name, size, content_type, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      id, name, bytes.length, url.searchParams.get('type') || 'application/octet-stream', now(), actor);
    for (let seq = 0, off = 0; off < bytes.length; seq++, off += ATTACHMENT_CHUNK) {
      db.run('INSERT INTO attachment_chunks (attachment_id, seq, data) VALUES (?, ?, ?)', id, seq, bytes.slice(off, off + ATTACHMENT_CHUNK));
    }
    return { id, name, size: bytes.length, content_type: url.searchParams.get('type') || 'application/octet-stream' };
  }

  function getAttachment(id) {
    const meta = db.get('SELECT * FROM attachments WHERE id = ?', String(id || ''));
    if (!meta) throw new HttpError(404, 'no such attachment');
    const out = new Uint8Array(meta.size);
    let off = 0;
    for (const c of db.all('SELECT data FROM attachment_chunks WHERE attachment_id = ? ORDER BY seq', meta.id)) {
      const chunk = new Uint8Array(c.data);
      out.set(chunk, off);
      off += chunk.length;
    }
    const inline = /^(image|text)\//.test(meta.content_type || '');
    return new Response(out, { headers: {
      'content-type': meta.content_type || 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${meta.name.replace(/"/g, '')}"`,
      'cache-control': 'private, max-age=86400',
    } });
  }

  // Attachment ids on a send -> stored metadata list (validated).
  function attachmentMeta(ids) {
    const list = (Array.isArray(ids) ? ids : []).slice(0, 20).map(id => {
      const meta = db.get('SELECT id, name, size, content_type FROM attachments WHERE id = ?', String(id));
      if (!meta) throw new HttpError(400, `unknown attachment "${id}" (upload it first)`);
      return meta;
    });
    return list.length ? JSON.stringify(list) : null;
  }

  const withAttachments = m => ({ ...m, attachments: m.attachments ? JSON.parse(m.attachments) : [] });

  // ---- chats ----

  const chatMembers = id => db.all('SELECT name FROM chat_members WHERE chat_id = ? ORDER BY name', Number(id)).map(r => r.name);
  const isMember = (id, name) => Boolean(db.get('SELECT 1 AS x FROM chat_members WHERE chat_id = ? AND name = ? COLLATE NOCASE', Number(id), name));

  function requireChat(id, name, { admin = false } = {}) {
    const chat = db.get('SELECT * FROM chats WHERE id = ?', Number(id));
    if (!chat) throw new HttpError(404, `no chat #${id}`);
    if (!admin && !isMember(chat.id, name)) throw new HttpError(403, `you are not a member of chat #${id}`);
    return chat;
  }

  function chatView(chat) {
    const last = db.get('SELECT created_at AS t FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1', chat.id)?.t ?? null;
    return { id: chat.id, title: chat.title, members: chatMembers(chat.id), created_by: chat.created_by, created_at: chat.created_at, last_message_at: last };
  }

  function createChat(creator, title, members) {
    const names = [...new Set([creator, ...(Array.isArray(members) ? members : String(members || '').split(','))]
      .map(n => String(n).trim()).filter(Boolean))];
    if (names.length < 2) throw new HttpError(400, 'a chat needs at least one other member');
    for (const n of names) if (n !== creator && !anyByName(n)) throw new HttpError(404, `no peer named "${n}"`);
    const id = db.get('INSERT INTO chats (title, created_at, created_by) VALUES (?, ?, ?) RETURNING id',
      String(title || [...new Set(names.filter(n => n !== creator).map(n => anyByName(n)?.display_name || n))].join(', ')).slice(0, 80), now(), creator).id;
    for (const n of names) db.run('INSERT OR IGNORE INTO chat_members (chat_id, name) VALUES (?, ?)', id, n);
    return chatView(db.get('SELECT * FROM chats WHERE id = ?', id));
  }

  function chatAction(actor, body, { admin = false } = {}) {
    switch (body.action) {
      case 'list': {
        const rows = admin ? db.all('SELECT * FROM chats ORDER BY id DESC')
          : db.all(`SELECT c.* FROM chats c JOIN chat_members m ON m.chat_id = c.id WHERE m.name = ? COLLATE NOCASE ORDER BY c.id DESC`, actor);
        return { chats: rows.map(chatView) };
      }
      case 'create': return createChat(actor, body.title, body.members);
      case 'add': {
        const chat = requireChat(body.chat, actor, { admin });
        for (const n of [].concat(body.members || [])) {
          if (!anyByName(n)) throw new HttpError(404, `no peer named "${n}"`);
          db.run('INSERT OR IGNORE INTO chat_members (chat_id, name) VALUES (?, ?)', chat.id, String(n).trim());
        }
        return chatView(chat);
      }
      case 'remove':
      case 'leave': {
        const chat = requireChat(body.chat, actor, { admin });
        const who = body.action === 'leave' ? [actor] : [].concat(body.members || []);
        for (const n of who) db.run('DELETE FROM chat_members WHERE chat_id = ? AND name = ? COLLATE NOCASE', chat.id, n);
        return chatView(chat);
      }
      case 'rename': {
        const chat = requireChat(body.chat, actor, { admin });
        db.run('UPDATE chats SET title = ? WHERE id = ?', String(body.title || chat.title).slice(0, 80), chat.id);
        return chatView(db.get('SELECT * FROM chats WHERE id = ?', chat.id));
      }
      case 'delete': {
        if (!admin) throw new HttpError(403, 'only the operator can delete chats');
        const chat = requireChat(body.chat, actor, { admin });
        db.run('DELETE FROM chat_members WHERE chat_id = ?', chat.id);
        db.run('DELETE FROM chats WHERE id = ?', chat.id);
        return { deleted: chat.id };
      }
      default: throw new HttpError(400, 'action must be list, create, add, remove, leave, rename or delete');
    }
  }

  // Send a message. `to`: a name, several names (array or comma-separated), or "*" (the online
  // agents in `project`, or every online agent when no project). `chat`: a chat id — goes to its
  // members. Replying to a chat message without `to` stays in that chat.
  // In a group (chat, or a project broadcast), naming members or passing `mentions` works like a group
  // chat: everyone gets the message, but only the mentioned are notified (woken); the rest get it
  // as quiet FYI mail they see the next time they're active.
  function send({ from: fromName, fromKey = null, fromDevice = null, to, chat, message, replyTo, project = null, attachmentIds = [], admin = false, mentions = [] }) {
    const files = attachmentMeta(attachmentIds);
    const text = String(message ?? '') || (files ? '(attachment)' : '');
    if (!text) throw new HttpError(400, 'message required');
    const reply = replyTo == null || replyTo === '' ? null : Number(replyTo);
    const names = (Array.isArray(to) ? to : String(to || '').split(',')).map(n => String(n).trim()).filter(Boolean);
    let chatId = chat ? Number(chat) : null;
    // A reply to a chat message stays in the chat when it names no one, or only chat members
    // (older clients always name the parent's sender).
    if (!chatId && reply) {
      const parentChat = db.get('SELECT chat_id FROM messages WHERE id = ?', reply)?.chat_id;
      if (parentChat && (!names.length || (isMember(parentChat, fromName) && names.every(n => n !== '*' && isMember(parentChat, n))))) {
        chatId = parentChat;
      }
    }
    // A reply to a project message stays in the project chat (to its sender if it names no one).
    const parent = !chatId && reply ? db.get('SELECT from_name, project FROM messages WHERE id = ?', reply) : null;
    const replyProject = parent?.project && !names.includes('*') ? parent.project : null;
    if (replyProject && !names.length) {
      // A reply to a system notice there (e.g. "added you to project") goes to the project chat.
      if (parent.from_name === SYSTEM_SENDER) { names.push('*'); project = replyProject; } else names.push(parent.from_name);
    }
    let targets;
    const quiet = new Set(); // lower-case names that get it as FYI (no wake-up)
    if (chatId) {
      requireChat(chatId, fromName, { admin });
      project = null;
      let members = chatMembers(chatId).filter(n => n.toLowerCase() !== fromName.toLowerCase());
      // Mentions: naming members alongside an explicit chat notifies just them (it still shows in
      // the chat). Not for replies placed in a chat implicitly: those reach the whole chat.
      const named = [...(chat ? names : []), ...[].concat(mentions || [])].map(String)
        .filter(n => n !== '*' && n.toLowerCase() !== fromName.toLowerCase());
      if (named.length) {
        const wanted = new Set(named.map(n => n.toLowerCase()));
        const outsiders = named.filter(n => !members.some(m => m.toLowerCase() === n.toLowerCase()));
        if (outsiders.length) throw new HttpError(400, `not in this chat: ${outsiders.join(', ')}`);
        for (const m of members) if (!wanted.has(m.toLowerCase())) quiet.add(m.toLowerCase());
      }
      targets = members.map(n => activeByName(n) || anyByName(n) || { name: n, kind: null, last_seen: 0, listen_until: 0 });
    } else if (names.length === 1 && names[0] === '*') {
      // In a project, "*" is the project's chat: every member, online or not (mail waits).
      // Outside a project it reaches the agents online right now.
      targets = (project
        ? db.all(`SELECT * FROM peers WHERE project = ? AND kind != 'human'`, project)
        : db.all(`SELECT * FROM peers WHERE last_seen > ? AND kind != 'human'`, now() - ACTIVE_MS))
        .filter(p => p.name.toLowerCase() !== fromName.toLowerCase())
        .filter((t, i, all) => all.findIndex(x => x.name === t.name) === i);
      const wanted = new Set([].concat(mentions || []).map(n => String(n).toLowerCase()));
      if (wanted.size) for (const t of targets) if (!wanted.has(t.name.toLowerCase())) quiet.add(t.name.toLowerCase());
      // Agents @mentioned in a project they aren't in yet get it too (e.g. invited to a new project).
      for (const n of [].concat(mentions || []).map(String)) {
        if (n.toLowerCase() === fromName.toLowerCase() || targets.some(t => t.name.toLowerCase() === n.toLowerCase())) continue;
        const outsider = resolveName(n, { exact: admin });
        if (outsider && outsider.kind !== 'human' && !targets.some(t => t.name === outsider.name)) targets.push(outsider);
      }
      // An agent alone in a project still posts in its chat: the operator reads it there.
      if (!targets.length && project && !admin) {
        const operator = db.get(`SELECT * FROM peers WHERE kind = 'human' ORDER BY last_seen DESC LIMIT 1`);
        if (operator) targets = [operator];
      }
      if (!targets.length) {
        throw new HttpError(400, project ? `nobody is in project "${project}" yet: @mention agents to invite them` : 'no agents are online');
      }
    } else if (names.length) {
      targets = names.map(n => {
        const target = resolveName(n, { exact: admin });
        if (!target) throw new HttpError(404, `no peer named "${n}" (use list_peers)`);
        return target;
      }).filter((t, i, all) => all.findIndex(x => x.name === t.name) === i);
    } else {
      throw new HttpError(400, 'to (a name, several names, or "*") or chat is required');
    }
    const sendId = randomToken().slice(3, 19); // groups the per-recipient rows of one send
    // Only a message to the project belongs to its chat: an agent in a project also sends direct
    // messages and chat messages, which stay out of it.
    const inProject = !chatId && names.includes('*') ? project : replyProject;
    if (replyProject) {
      // Like a group chat: the project's other agents get the reply too, as FYI.
      for (const p of db.all(`SELECT * FROM peers WHERE project = ? AND kind != 'human'`, replyProject)) {
        if (p.name.toLowerCase() === fromName.toLowerCase() || targets.some(t => t.name === p.name)) continue;
        targets.push(p);
        quiet.add(p.name.toLowerCase());
      }
    }
    const ids = targets.map(t => db.get(
      `INSERT INTO messages (from_name, to_name, body, reply_to, created_at, project, attachments, chat_id, send_id, from_device, quiet, from_key, to_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      fromName, t.name, text, reply, now(), inProject, files, chatId, sendId, fromDevice, quiet.has(t.name.toLowerCase()) ? 1 : null,
      fromKey, t.session_id || t.id || null).id);
    const notified = targets.filter(t => !quiet.has(t.name.toLowerCase()));
    notified.forEach(t => wake(t.name));
    const reviving = {}; // offline recipient -> the agent asked to bring it back
    for (const t of notified) if (t.kind !== 'human' && t.session_id) { const by = requestRevive(getPeer(t.id) ?? t); if (by) reviving[t.name] = by; }
    // Notify recipients with push notifications on (the operator's browsers; agents have none).
    const chatTitle = chatId ? db.get('SELECT title FROM chats WHERE id = ?', chatId)?.title : null;
    // Tapping it opens the message's own conversation: its chat, its project chat (a message to the
    // project or a reply in it), else the DM with the sender (by identity: names change).
    const where = chatId ? ` in #${chatTitle}` : inProject ? ` in ${inProject}` : '';
    const conv = chatId ? `chat:${chatId}` : inProject ? `project:${inProject}` : `dm:${fromKey || fromName}`; // as the console names it
    const url = chatId ? `/#/messages/chat/${chatId}` : inProject ? `/#/projects/${encodeURIComponent(inProject)}`
      : `/#/messages/dm/${encodeURIComponent(fromKey || fromName)}`;
    pushToNames(targets.map(t => t.name).filter(n => n.toLowerCase() !== fromName.toLowerCase()), {
      title: `${fromName}${where}`,
      body: text.length > 300 ? `${text.slice(0, 300)}…` : text,
      url, tag: url,
    }, undefined, conv);
    return {
      // Recipients by their full address when they share a display name, so it's clear which one got it.
      delivered_to: targets.map(t => {
        const twins = db.all(`SELECT * FROM peers WHERE last_seen > ? AND kind != 'human'`, now() - ACTIVE_MS)
          .filter(p => shownName(p).toLowerCase() === shownName(t).toLowerCase());
        return twins.length > 1 ? fullAddress(t, twins) : t.name;
      }),
      message_ids: ids,
      chat: chatId ? chatView(db.get('SELECT * FROM chats WHERE id = ?', chatId)) : null,
      recipient_status: targets.map(t => ({
        name: t.name,
        key: t.session_id || t.id || null, // the identity it went to (a DM's thread), e.g. a restarted agent's new session
        kind: t.kind,
        online: t.last_seen > now() - ACTIVE_MS,
        ...liveness(t.name, t.listen_until),
        ...(reviving[t.name] ? { reviving: reviving[t.name] } : {}),
      })),
    };
  }

  // System notices (e.g. task assignments) to a peer, if it exists.
  function notify(toName, text, project) {
    if (!anyByName(toName)) return;
    db.run('INSERT INTO messages (from_name, to_name, body, reply_to, created_at, project) VALUES (?, ?, ?, NULL, ?, ?)',
      SYSTEM_SENDER, toName, text, now(), project || null);
    wake(toName);
  }

  const projects = createProjects({ db, now, HttpError, notify });
  const members = slug => db.all(`SELECT name, kind, app, device, summary, listen_until, last_seen FROM peers
    WHERE project = ? AND last_seen > ? ORDER BY name`, slug, now() - ACTIVE_MS)
    .map(({ listen_until, ...m }) => ({ ...m, ...liveness(m.name, listen_until) }));

  // Raw file transfer shared by agents and the console.
  async function upload(request, url, projectSlugValue, actor) {
    const slug = projects.need(projectSlugValue).slug;
    const bytes = new Uint8Array(await request.arrayBuffer());
    // The request's content-type marks it as raw; the file's own type travels as ?type=.
    return projects.files.put(slug, url.searchParams.get('path'), bytes, url.searchParams.get('type'), actor);
  }
  function download(url, projectSlugValue) {
    const { file, bytes } = projects.files.get(projects.need(projectSlugValue).slug, url.searchParams.get('path'));
    return new Response(bytes, { headers: {
      'content-type': file.content_type || 'application/octet-stream',
      'content-disposition': `attachment; filename="${file.path.split('/').pop().replace(/"/g, '')}"`,
    } });
  }

  // Returns unacked messages and leases them; the client acks after receiving them, so a
  // response lost in transit is re-delivered once the lease expires.
  function lease(name, leaseMs = LEASE_MS) {
    const msgs = db.all(`SELECT id, from_name AS "from", body, reply_to, created_at, attachments, chat_id, from_device, quiet, project,
      (SELECT title FROM chats WHERE chats.id = messages.chat_id) AS chat_title FROM messages
      WHERE to_name = ? COLLATE NOCASE AND delivered_at IS NULL AND (leased_until IS NULL OR leased_until < ?)
      ORDER BY id LIMIT 100`, name, now()).map(withAttachments).map(m => ({ ...m, from_machine: deviceLabel(m.from_device) }));
    if (msgs.length) {
      inChunks(msgs.map(m => m.id), (ids, qs) =>
        db.run(`UPDATE messages SET leased_until = ?, leased_at = ? WHERE id IN (${qs})`, now() + leaseMs, now(), ...ids));
    }
    return msgs;
  }

  // hookPoll: the long-poll comes from a Stop hook (session-addressed), which re-polls continuously.
  // peek: wait until mail exists and report how much, without leasing it (background listeners
  // check they are still the session's current listener before taking anything).
  function waitForMail(peer, waitSeconds, hookPoll = false, peek = false, leaseSeconds = 0) {
    const leaseMs = Math.min(Math.max(Number(leaseSeconds) || 0, 0), 900) * 1000 || LEASE_MS;
    // A wait ends only for mail addressed to the agent; quiet FYI group mail rides along when it does.
    const take = () => (peek ? { pending: urgentCount(peer.name) } : { messages: lease(peer.name, leaseMs) });
    const takeIfUrgent = () => (peek || urgentCount(peer.name) ? take() : { messages: [] });
    const key = peer.name.toLowerCase();
    const waitMs = Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_S) * 1000;
    // A Stop hook's long-poll counts as waiting even when mail is already there and it returns at once.
    if (hookPoll && waitMs) lastHookWait.set(key, now());
    if (!waitMs) return take();
    const first = takeIfUrgent();
    if (peek ? first.pending : first.messages.length) return first;
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        waiters.get(key)?.delete(done);
        if (!waiters.get(key)?.size) waiters.delete(key);
        if (hookPoll) lastHookWait.set(key, now());
        if (!hookPoll) db.run('UPDATE peers SET last_seen = ? WHERE id = ?', now(), peer.id); // MCP polls only
        resolve(takeIfUrgent());
      };
      // Also wake when a leased (taken but unacknowledged) message becomes deliverable again.
      const leaseEnd = db.get(`SELECT min(leased_until) AS t FROM messages WHERE to_name = ? COLLATE NOCASE
        AND delivered_at IS NULL AND leased_until >= ?`, peer.name, now()).t;
      const timer = setTimeout(done, leaseEnd ? Math.min(waitMs, leaseEnd - now() + 250) : waitMs);
      if (!waiters.has(key)) waiters.set(key, new Set());
      waiters.get(key).add(done);
    });
  }

  // Operator (console) messages an agent has read but not answered yet: the operator can't see it
  // working, so its hooks remind it to confirm in a line (once while it works, once at its turn's end).
  const AWAITING_SQL = `FROM messages m WHERE m.to_name = ? COLLATE NOCASE AND m.delivered_at > ? AND coalesce(m.quiet, 0) = 0
    AND (m.from_key LIKE 'human:%' OR EXISTS (SELECT 1 FROM peers h WHERE h.name = m.from_name COLLATE NOCASE AND h.kind = 'human'))
    AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.created_at >= m.created_at AND (
      ((r.from_name = ? COLLATE NOCASE OR r.from_key = ?) AND r.created_at >= m.delivered_at AND r.to_name = m.from_name COLLATE NOCASE)
      -- In a group (chat or project chat), an answer from any agent there will do: not every member has to reply.
      OR (m.chat_id IS NOT NULL AND r.chat_id = m.chat_id AND coalesce(r.from_key, '') NOT LIKE 'human:%')
      OR (m.chat_id IS NULL AND m.project IS NOT NULL AND r.project = m.project AND coalesce(r.from_key, '') NOT LIKE 'human:%')))`;
  const awaitingArgs = p => [p.name, now() - 2 * 3_600_000, p.name, p.session_id || p.id];
  const awaitingCount = p => db.get(`SELECT count(*) AS n ${AWAITING_SQL} AND coalesce(m.reply_nudged, 0) < 2`, ...awaitingArgs(p)).n;
  function awaitingReply(p, stage) {
    const minAge = stage === 1 ? 20_000 : 0; // give the agent a moment to answer by itself
    const rows = db.all(`SELECT m.id, m.from_name AS "from", m.chat_id, m.body ${AWAITING_SQL}
      AND coalesce(m.reply_nudged, 0) < ? AND m.delivered_at <= ? ORDER BY m.id`, ...awaitingArgs(p), stage, now() - minAge);
    for (const r of rows) db.run('UPDATE messages SET reply_nudged = ? WHERE id = ?', stage, r.id);
    return rows.map(r => ({ id: r.id, from: r.from, chat_id: r.chat_id, chat: r.chat_id ? db.get('SELECT title FROM chats WHERE id = ?', r.chat_id)?.title ?? null : null,
      body: String(r.body).length > 160 ? `${String(r.body).slice(0, 160)}…` : String(r.body) }));
  }

  function ack(name, ids) {
    ids = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
    if (!ids.length) return { acked: 0 };
    // Mail handed out under a still-running lease was seen when it was handed out: count that as its
    // delivery, so replies the agent sent before confirming it (at its turn's end) answer it.
    inChunks(ids, (chunk, qs) =>
      db.run(`UPDATE messages SET delivered_at = CASE WHEN leased_at IS NOT NULL AND leased_until >= ? THEN leased_at ELSE ? END, acked_at = ?
        WHERE to_name = ? COLLATE NOCASE AND delivered_at IS NULL AND id IN (${qs})`, now(), now(), now(), name, ...chunk));
    return { acked: ids.length };
  }

  function operatorFor(request) {
    const email = request.headers.get('x-operator-email') || '';
    const row = (email && db.get('SELECT name FROM operators WHERE email = ?', email)) || db.get(`SELECT name FROM operators WHERE email = ''`);
    return { name: row?.name ?? null, email: email || null };
  }

  // The human operator appears as a peer of kind "human" while the console is open.
  function touchHuman(name) {
    name = String(name || 'human').trim().slice(0, 64) || 'human';
    // A name merged into another (an older console tab still using it) acts as the merged identity.
    name = db.get('SELECT name FROM human_aliases WHERE alias = ? COLLATE NOCASE', name)?.name ?? name;
    const id = `human:${name.toLowerCase()}`;
    db.run(`INSERT INTO peers (id, name, kind, app, device, cwd, last_seen) VALUES (?, ?, 'human', 'console', 'console', '', ?)
      ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`, id, name, now());
    return getPeer(id);
  }

  // ---- routes ----

  const agentRoutes = {
    // The device a token belongs to (installers use it as the computer's name).
    'GET /whoami': ({ auth }) => ({ device: auth.device, admin: auth.admin }),

    'POST /register': ({ body, auth }) => {
      const id = String(body.id || '');
      if (!id) throw new HttpError(400, 'id required');
      if (isRemoved(id)) throw removedError();
      const existing = getPeer(id);
      if (existing && existing.device !== auth.device && !auth.admin) throw new HttpError(403, 'peer id belongs to another device');
      // One row per session: when a session's MCP server restarts (new process id), the new
      // process takes over the session's row, keeping its name, listening state and project,
      // instead of creating a second row (which showed as drop-outs and "-2" duplicates).
      if (body.session_id) {
        const sid = String(body.session_id);
        const prior = db.get('SELECT * FROM peers WHERE session_id = ? AND device = ? AND id != ? ORDER BY last_seen DESC LIMIT 1',
          sid, auth.device, id);
        if (prior && !existing) db.run('UPDATE peers SET id = ? WHERE id = ?', id, prior.id);
        db.run('DELETE FROM peers WHERE session_id = ? AND device = ? AND id != ?', sid, auth.device, id);
      }
      const current = getPeer(id); // this process's row, or the session's row it just took over
      const display = current?.display_name || String(current?.name || body.name || 'peer').trim().slice(0, 64);
      const name = current ? claimName(id, current.name)
        : claimName(id, display, { device: auth.device, account_id: body.account?.id, session_id: body.session_id ? String(body.session_id) : null });
      if (current && name !== current.name) moveAddress(current.name, name);
      const project = current ? current.project : body.project ? projects.ensure(body.project, name).slug : null;
      // New Claude Code sessions listen always by default (they listen in the background); Codex holds
      // its turn open while listening, so it starts off. A folder's .agent-bridge.json can say "off".
      const listenAt = current ? current.listen_until : listenUntil(body.listen ?? (body.kind === 'claude' ? 'always' : 0));
      db.run(`INSERT INTO peers (id, name, kind, app, device, cwd, session_id, agent_pid, listen_until, project, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, app = excluded.app,
          device = excluded.device, cwd = excluded.cwd, session_id = excluded.session_id,
          agent_pid = excluded.agent_pid, listen_until = excluded.listen_until, project = excluded.project,
          last_seen = excluded.last_seen`,
        id, name, body.kind ?? null, body.app ?? null, auth.device, body.cwd ?? null,
        body.session_id ?? null, body.agent_pid ?? null, listenAt, project, now());
      db.run('UPDATE peers SET client_version = ?, os = ?, host_session_id = ?, left_at = NULL WHERE id = ?', String(body.client_version || '').slice(0, 40) || null,
        String(body.os || '').slice(0, 20) || null, String(body.host_session_id || '').slice(0, 80) || null, id);
      recordAccount(id, body.account);
      db.run('UPDATE peers SET display_name = ? WHERE id = ?', display, id);
      // Settings saved for this session win over the client's defaults (project file / env).
      applySessionPrefs(id, body.session_id);
      return status(getPeer(id));
    },

    // Hooks know the agent's session id; MCP servers may not (Codex). Bind the session to the
    // peer on this device whose agent process is one of the hook's ancestors (or, failing
    // that, the only peer of that kind in that folder without a session).
    'POST /bind': ({ body, auth }) => {
      const sessionId = String(body.session_id || '');
      if (!sessionId) throw new HttpError(400, 'session_id required');
      const pids = (Array.isArray(body.pids) ? body.pids : []).map(Number).filter(n => n > 1);
      const candidates = db.all('SELECT * FROM peers WHERE device = ? AND last_seen > ?', auth.device, now() - ACTIVE_MS);
      // By process: the agent process is one of the hook's ancestors. In apps that run every chat in
      // one process (the ChatGPT desktop app), several peers match: that's no answer.
      const byPid = candidates.filter(p => p.agent_pid && pids.includes(p.agent_pid));
      let peer = byPid.length === 1 ? byPid[0] : null;
      if (!peer && body.cwd) {
        const sameDir = candidates.filter(p => !p.session_id && p.cwd === body.cwd && (!body.kind || p.kind === body.kind));
        if (sameDir.length === 1) peer = sameDir[0];
      }
      // By tool call: the hook after an agent-bridge tool call finds the unbound peer that just ran the
      // same tool with the same arguments (both sides fingerprint them). Two matches: refuse, never guess.
      if (!peer && body.tool_name) {
        const tool = String(body.tool_name);
        const recent = candidates.filter(p => !p.session_id && p.last_tool && p.last_tool_at > now() - 60_000 && tool.endsWith(p.last_tool) &&
          (!body.tool_args || p.last_tool_args === String(body.tool_args)) && (!body.cwd || !p.cwd || p.cwd === body.cwd));
        if (recent.length === 1) peer = recent[0];
      }
      if (!peer) throw new HttpError(404, 'no matching peer for this session');
      linkSession(peer, sessionId);
      return status(getPeer(peer.id));
    },

    // Exact linking: a Codex plugin hook (type mcp_tool) calls the server that serves the chat, with
    // the chat's session id; the server passes it on here.
    'POST /link': ({ body, auth }) => {
      const sessionId = String(body.session_id || '');
      if (!body.id || !sessionId) throw new HttpError(400, 'id and session_id required');
      const peer = requirePeer(body, auth);
      if (peer.session_id !== sessionId) linkSession(peer, sessionId);
      return status(getPeer(peer.id));
    },

    // Hooks report what the agent is doing (thinking / working / idle) for the console's live status.
    'POST /heartbeat': ({ body, auth }) => {
      const peer = requirePeer(body, auth);
      // An unbound Codex MCP server reports each tool call, so the hook that follows can find it.
      if (body.id && body.tool) {
        db.run('UPDATE peers SET last_tool = ?, last_tool_args = ?, last_tool_at = ? WHERE id = ?',
          String(body.tool).slice(0, 80), String(body.tool_args || '').slice(0, 80), now(), peer.id);
      }
      const a = body.activity;
      if (a && typeof a === 'object' && ['thinking', 'working', 'idle'].includes(a.state)) {
        db.run('UPDATE peers SET activity = ?, activity_at = ? WHERE id = ?',
          JSON.stringify({ state: a.state, detail: String(a.detail || '').slice(0, 200) }), now(), peer.id);
      }
      return status(peer);
    },

    // An exiting MCP server: a session's row is kept (marked offline) so the session's listener
    // and settings survive a restart; rows without a session are deleted.
    'POST /unregister': ({ body, auth }) => {
      const peer = getPeer(String(body.id || ''));
      if (peer && peer.device === auth.device) {
        if (peer.session_id) db.run('UPDATE peers SET last_seen = ?, left_at = ? WHERE id = ?', now() - ACTIVE_MS - 1, now(), peer.id); // offline now
        else db.run('DELETE FROM peers WHERE id = ?', peer.id);
      }
      return { ok: true };
    },

    'POST /profile': ({ body, auth }) => {
      const peer = requirePeer(body, auth);
      if (body.name) renamePeer(peer, body.name);
      if (typeof body.summary === 'string') db.run('UPDATE peers SET summary = ? WHERE id = ?', body.summary.slice(0, 500), peer.id);
      if (body.icon !== undefined || body.color !== undefined) setIdentity(getPeer(peer.id).name, { icon: body.icon, color: body.color });
      return status(getPeer(peer.id));
    },

    'POST /listen': ({ body, auth }) => {
      const peer = requirePeer(body, auth);
      setListen(peer, body.listen, 'the agent itself');
      return status(getPeer(peer.id));
    },

    // Remote approvals: a PermissionRequest hook forwards the prompt and waits for the console.
    'POST /approvals': ({ body, auth }) => requestApproval(requirePeer(body, auth), body),
    'POST /approvals/wait': ({ body, auth }) => waitForApproval(requirePeer(body, auth), body.approval, body.wait_seconds),
    'POST /approvals/cancel': ({ body, auth }) => {
      const peer = requirePeer(body, auth);
      db.run(`UPDATE approvals SET decision = 'cancelled', decided_at = ? WHERE id = ? AND peer_id = ? AND decision IS NULL`,
        now(), Number(body.approval), peer.id);
      return { ok: true };
    },

    // Hook-driven resume counter: +1 when a Stop hook resumes the agent; reset on user prompt
    // or once the hour-long window has passed.
    // Hooks: the operator messages this agent hasn't answered (see awaitingReply); each is returned once per stage.
    'POST /awaiting': ({ body, auth }) => ({ messages: awaitingReply(requirePeer(body, auth), body.stage === 2 ? 2 : 1) }),

    'POST /rounds': ({ body, auth }) => {
      const peer = requirePeer(body, auth);
      const current = roundsInWindow(peer);
      if (body.reset) db.run('UPDATE peers SET auto_rounds = 0, rounds_since = 0 WHERE id = ?', peer.id);
      else db.run('UPDATE peers SET auto_rounds = ?, rounds_since = ? WHERE id = ?', current + 1, current ? peer.rounds_since : now(), peer.id);
      return status(getPeer(peer.id));
    },

    'GET /peers': () => {
      dropGhosts();
      db.run(`DELETE FROM peers WHERE last_seen < ? AND kind != 'human'`, now() - STALE_MS);
      db.run(`DELETE FROM peers WHERE last_seen < ? AND kind = 'human'`, now() - HUMAN_STALE_MS);
      // Offline sessions (seen in the last day) too, as the console lists them: the same set on both sides.
      const all = peerList({ includeOffline: true }).map(({ key, ...p }) => p); // identities stay in the console
      return {
        peers: all.filter(p => p.online || p.kind === 'human'),
        offline: all.filter(p => !p.online && p.kind !== 'human')
          .map(p => ({ name: p.name, display_name: p.display_name, device: p.device, listening: p.listening, last_seen: p.last_seen })),
      };
    },

    'POST /send': ({ body, auth }) => {
      const peer = requirePeer(body, auth);
      // forward_attachments: a message the agent received or sent; its files go along (no re-upload).
      const ids = [].concat(body.attachments || []);
      if (body.forward_attachments != null) {
        const src = db.get(`SELECT attachments FROM messages WHERE id = ? AND (to_name = ? COLLATE NOCASE OR from_name = ? COLLATE NOCASE)`,
          Number(body.forward_attachments), peer.name, peer.name);
        if (!src) throw new HttpError(404, `no message #${body.forward_attachments} of yours to forward attachments from`);
        for (const a of src.attachments ? JSON.parse(src.attachments) : []) if (!ids.includes(a.id)) ids.push(a.id);
      }
      const r = send({ from: peer.name, fromKey: peer.session_id || peer.id, fromDevice: peer.device, to: body.to, chat: body.chat, message: body.message, replyTo: body.reply_to,
        project: peer.project || null, attachmentIds: ids, mentions: body.mentions });
      return { ...r, attachments: ids.length };
    },

    'POST /chats': ({ body, auth }) => chatAction(requirePeer(body, auth).name, body),

    // Raw upload (?id=<peer>&name=&type=), then pass the returned id in send's `attachments`.
    'POST /attachments/upload': ({ request, url, auth }) =>
      putAttachment(request, url, requirePeer({ id: url.searchParams.get('id'), session_id: url.searchParams.get('session_id') }, auth).name),

    'GET /attachments/download': ({ url, auth }) => {
      requirePeer({ id: url.searchParams.get('id'), session_id: url.searchParams.get('session_id') }, auth);
      return getAttachment(url.searchParams.get('attachment'));
    },

    'POST /project': ({ body, auth }) => {
      const peer = requirePeer(body, auth);
      switch (body.action) {
        case 'list': return { projects: projects.list(), current: peer.project || null };
        case 'create':
        case 'join': {
          const slug = projectSlug(body.project);
          if (!projects.get(slug)) {
            if (body.action !== 'create' && !body.create) {
              throw new HttpError(404, `no project "${body.project}"; existing: ${projects.list().map(p => p.slug).join(', ') || 'none'}. Use action "create" to make it.`);
            }
            projects.create(body.project, body.description, peer.name);
          }
          setProject(peer, slug);
          projects.event(slug, peer.name, 'member', `joined (${peer.kind || 'agent'} on ${peer.device})`);
          return projects.overview(slug, members(slug));
        }
        case 'leave':
          if (peer.project) projects.event(peer.project, peer.name, 'member', 'left');
          setProject(peer, null);
          return { left: peer.project || null };
        case 'overview':
          return projects.overview(body.project || peer.project, members(projectSlug(body.project || peer.project)));
        default:
          throw new HttpError(400, 'action must be list, join, create, leave or overview');
      }
    },

    // Project data: {action, project?, ...args}; project defaults to the one the agent joined.
    ...Object.fromEntries(['docs', 'tasks', 'kv', 'files'].map(resource => [`POST /${resource}`, ({ body, auth }) => {
      const peer = requirePeer(body, auth);
      return projects.act(resource, body.action, body.project || peer.project, body, peer.name);
    }])),

    'POST /files/upload': ({ request, url, auth }) => {
      const peer = requirePeer({ id: url.searchParams.get('id') }, auth);
      return upload(request, url, url.searchParams.get('project') || peer.project, peer.name);
    },

    'GET /files/download': ({ url, auth }) => {
      const peer = requirePeer({ id: url.searchParams.get('id') }, auth);
      return download(url, url.searchParams.get('project') || peer.project);
    },

    'POST /inbox': ({ body, auth }) => {
      const peer = requirePeer(body, auth);
      // A session whose agent isn't running can't take mail: a leftover listener would lease it and
      // wake nobody. It waits for the session to come back instead. "Closed": its MCP server exited;
      // otherwise it only went quiet (computer asleep, network down) and may well come back.
      if (!body.id && peer.last_seen <= now() - ACTIVE_MS) {
        throw new HttpError(409, peer.left_at ? 'session closed: its agent-bridge server exited' : 'session offline: no heartbeat from its agent-bridge server');
      }
      return waitForMail(peer, body.wait_seconds, !body.id && Boolean(body.session_id), Boolean(body.peek), body.lease_seconds);
    },

    'POST /ack': ({ body, auth }) => ack(requirePeer(body, auth).name, body.ids),
  };

  const adminRoutes = {
    // Everything the console renders, in one call. Also marks the operator online.
    'GET /state': ({ url }) => {
      const me = url.searchParams.get('as');
      const human = me ? touchHuman(me) : null;
      const onScreen = url.searchParams.get('viewing');
      if (human && onScreen) viewing.set(human.name.toLowerCase(), { conv: onScreen.slice(0, 300), at: now() });
      if (human && url.searchParams.get('active') === 'desktop') activeDesktop.set(human.name.toLowerCase(), now());
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
      // Incremental refresh: with since_id / since_ts the console gets only new messages and ones
      // read since its last poll, instead of re-reading the whole history every few seconds.
      const sinceId = Number(url.searchParams.get('since_id')) || 0;
      const sinceTs = Number(url.searchParams.get('since_ts')) || 0;
      const cols = 'id, from_name AS "from", to_name AS "to", body, reply_to, created_at, delivered_at, attachments, chat_id, send_id, from_device, from_key, to_key, project';
      const messages = sinceId
        ? db.all(`SELECT ${cols} FROM messages WHERE id > ? ORDER BY id DESC LIMIT ?`, sinceId, limit)
          .concat(db.all(`SELECT ${cols} FROM messages WHERE coalesce(acked_at, delivered_at) > ? AND id <= ?`, sinceTs, sinceId))
        : db.all(`SELECT ${cols} FROM messages ORDER BY id DESC LIMIT ?`, limit);
      // Each of the operator's direct conversations, by its newest message: the console lists them
      // even when busier conversations fill the newest `limit` messages (it loads the rest on opening).
      const dmHeads = human && !sinceId ? db.all(`SELECT ${cols} FROM messages WHERE id IN (
          SELECT max(id) FROM messages WHERE chat_id IS NULL AND project IS NULL AND (from_name = ? COLLATE NOCASE OR to_name = ? COLLATE NOCASE)
          GROUP BY CASE WHEN from_name = ? COLLATE NOCASE THEN coalesce(to_key, lower(to_name)) ELSE coalesce(from_key, lower(from_name)) END)
        AND id < ?`, human.name, human.name, human.name, messages.at(-1)?.id ?? 0).map(withAttachments) : [];
      return {
        now: now(),
        incremental: Boolean(sinceId),
        dm_heads: dmHeads,
        peers: peerList({ includeOffline: true }),
        messages: messages.map(withAttachments),
        devices: db.all('SELECT name, label, created_at, last_used, revoked_at FROM devices ORDER BY name')
          .map(d => ({ ...d, display: deviceLabel(d.name) })),
        device_labels: deviceLabels(),
        pairings: pendingPairings(),
        approvals: pendingApprovals(),
        accounts: db.all('SELECT * FROM accounts ORDER BY last_seen DESC').map(a => ({
          ...a, display: accountName(a),
          // The agents the Agents page shows: not Codex servers that never got a chat (hidden there).
          agents: db.all(`SELECT name FROM peers WHERE account_id = ? AND last_seen > ? AND kind != 'human'
            AND NOT (kind = 'codex' AND session_id IS NULL) ORDER BY name`, a.id, now() - STALE_MS).map(p => p.name),
        })),
        chats: chatAction(null, { action: 'list' }, { admin: true }).chats,
        hidden: me ? Object.fromEntries(db.all('SELECT conv, before_id FROM hidden_conversations WHERE owner = ?', me)
          .map(h => [h.conv, h.before_id])) : {},
      };
    },

    // One conversation's history, older than `before` (the console's /state carries only the newest
    // messages overall, so a busy chat can push the others' history out of it). Pages by send: a
    // message to a chat is stored once per member, and a page has all of each send's copies.
    // dm is the other side's key (or "name:<name>"), as the console names DM threads; `as` is the operator.
    'GET /messages': ({ url }) => {
      const p = k => url.searchParams.get(k);
      const before = Number(p('before')) || Number.MAX_SAFE_INTEGER;
      const limit = Math.min(Math.max(Number(p('limit')) || 100, 1), 500);
      let where, args;
      if (p('chat')) [where, args] = ['chat_id = ?', [Number(p('chat'))]];
      else if (p('project')) [where, args] = ['project = ?', [projectSlug(p('project'))]];
      else if (p('dm')) {
        const me = String(p('as') || '').trim();
        if (!me) throw new HttpError(400, 'as (the operator) required with dm');
        const key = p('dm');
        // Older messages carry no keys: match the agent's name too (the console sorts out the rest).
        const name = key.startsWith('name:') ? key.slice(5) : db.get(`SELECT name FROM peers p WHERE ${PEER_KEY} = ?`, key)?.name ?? null;
        where = `chat_id IS NULL AND project IS NULL AND (
          (from_name = ? COLLATE NOCASE AND (to_key = ? OR to_name = ? COLLATE NOCASE))
          OR (to_name = ? COLLATE NOCASE AND (from_key = ? OR from_name = ? COLLATE NOCASE)))`;
        args = [me, key, name, me, key, name];
      } else throw new HttpError(400, 'chat, dm or project required');
      const cols = 'id, from_name AS "from", to_name AS "to", body, reply_to, created_at, delivered_at, attachments, chat_id, send_id, from_device, from_key, to_key, project';
      const send = `coalesce(send_id, 'm' || id)`;
      const messages = db.all(`SELECT ${cols} FROM messages WHERE ${where} AND ${send} IN (
          SELECT ${send} FROM messages WHERE ${where} AND id < ? GROUP BY ${send} ORDER BY min(id) DESC LIMIT ?)
        ORDER BY id DESC`, ...args, ...args, before, limit);
      const oldest = messages.length ? messages[messages.length - 1].id : before;
      const more = Boolean(db.get(`SELECT 1 AS x FROM messages WHERE ${where} AND id < ? LIMIT 1`, ...args, oldest));
      return { messages: messages.map(withAttachments), more };
    },

    // The operator name for this sign-in: the one bound to its Access login (or the default for
    // admin-token sign-ins). `name` in a POST sets it.
    'GET /me': ({ request }) => operatorFor(request),
    'POST /me': ({ request, body }) => {
      const email = request.headers.get('x-operator-email') || '';
      const name = String(body.name || '').trim().slice(0, 64);
      if (!name) throw new HttpError(400, 'name required');
      db.run('INSERT INTO operators (email, name) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name', email, name);
      db.run(`INSERT OR IGNORE INTO operators (email, name) VALUES ('', ?)`, name); // the first one is also the default
      touchHuman(name);
      return operatorFor(request);
    },

    // Fold other operator names into one (e.g. names used on different devices): their messages,
    // chats, read state and notifications move over; the old names stay reachable as aliases.
    'POST /operators/merge': ({ body }) => {
      const into = String(body.into || '').trim();
      if (!into) throw new HttpError(400, 'into required');
      touchHuman(into);
      const key = `human:${into.toLowerCase()}`;
      const merged = [];
      for (const from of [].concat(body.from || []).map(n => String(n).trim()).filter(n => n && n.toLowerCase() !== into.toLowerCase())) {
        const old = db.get(`SELECT * FROM peers WHERE name = ? COLLATE NOCASE AND kind = 'human'`, from);
        if (!old) continue;
        db.run('UPDATE messages SET from_name = ?, from_key = ? WHERE from_name = ? COLLATE NOCASE', into, key, old.name);
        db.run('UPDATE messages SET to_name = ?, to_key = ? WHERE to_name = ? COLLATE NOCASE', into, key, old.name);
        db.run('INSERT OR IGNORE INTO chat_members (chat_id, name) SELECT chat_id, ? FROM chat_members WHERE name = ? COLLATE NOCASE', into, old.name);
        db.run('DELETE FROM chat_members WHERE name = ? COLLATE NOCASE', old.name);
        db.run(`INSERT INTO hidden_conversations (owner, conv, before_id) SELECT ?, conv, before_id FROM hidden_conversations WHERE owner = ?
          ON CONFLICT(owner, conv) DO UPDATE SET before_id = max(before_id, excluded.before_id)`, into, old.name);
        db.run('DELETE FROM hidden_conversations WHERE owner = ?', old.name);
        db.run('UPDATE push_subscriptions SET name = ? WHERE name = ? COLLATE NOCASE', into, old.name);
        db.run('UPDATE operators SET name = ? WHERE name = ? COLLATE NOCASE', into, old.name);
        db.run('DELETE FROM peers WHERE id = ?', old.id);
        db.run('INSERT INTO human_aliases (alias, name) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET name = excluded.name', old.name, into);
        db.run('UPDATE human_aliases SET name = ? WHERE name = ? COLLATE NOCASE', into, old.name);
        merged.push(old.name);
      }
      return { into, merged };
    },

    // Delete a direct conversation from this operator's console (soft: agents keep their copies).
    'POST /conversations/hide': ({ body }) => {
      const owner = touchHuman(body.as).name;
      const conv = String(body.conv || '').slice(0, 300);
      if (!conv) throw new HttpError(400, 'conv required');
      const before = Number(body.before_id) || db.get('SELECT max(id) AS n FROM messages').n || 0;
      db.run(`INSERT INTO hidden_conversations (owner, conv, before_id) VALUES (?, ?, ?)
        ON CONFLICT(owner, conv) DO UPDATE SET before_id = max(before_id, excluded.before_id)`, owner, conv, before);
      return { conv, before_id: before };
    },

    'POST /pairings/approve': async ({ body }) => {
      const row = db.get(`SELECT * FROM pairings WHERE code = ? AND status = 'pending' AND created_at > ?`,
        String(body.code || '').toUpperCase(), now() - PAIRING_TTL_MS);
      if (!row) throw new HttpError(404, 'no pending request with that code (it may have expired)');
      const { name, token } = await issueDevice(body.name || row.device_name);
      db.run(`UPDATE pairings SET status = 'approved', device = ?, token = ? WHERE code = ?`, name, token, row.code);
      return { device: name };
    },

    // Push notifications: the console subscribes this browser for its operator name.
    'GET /push/key': () => ({ publicKey: pusher ? push.publicKey : null }),
    'POST /push/subscribe': ({ body, request }) => {
      if (!pusher) throw new HttpError(501, 'push notifications are not configured on this hub');
      const sub = body.subscription || {};
      let endpoint;
      try { endpoint = new URL(String(sub.endpoint)); } catch { throw new HttpError(400, 'subscription.endpoint must be a URL'); }
      const local = endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname); // tests
      if ((endpoint.protocol !== 'https:' && !local) || !sub.keys?.p256dh || !sub.keys?.auth) throw new HttpError(400, 'invalid push subscription');
      const name = touchHuman(body.as).name;
      db.run(`INSERT INTO push_subscriptions (endpoint, name, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET name = excluded.name, p256dh = excluded.p256dh, auth = excluded.auth`,
      endpoint.href, name, String(sub.keys.p256dh), String(sub.keys.auth), String(request.headers.get('user-agent') || '').slice(0, 300), now());
      return { ok: true, name };
    },
    'POST /push/unsubscribe': ({ body }) => {
      db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', String(body.endpoint || ''));
      return { ok: true };
    },
    'POST /push/test': async ({ body }) => {
      const statuses = await pushTo('endpoint = ?', [String(body.endpoint || '')],
        { title: 'Agent Bridge', body: 'Notifications are on for this device.', url: '/#/messages', tag: 'test' });
      if (!statuses.length) throw new HttpError(404, 'this device is not subscribed');
      return { statuses };
    },

    'POST /approvals/decide': ({ body }) => decideApproval(body.approval, body.decision, body.message, touchHuman(body.as).name, body.answers),

    'POST /peers/identity': ({ body }) => {
      const name = String(body.name || '');
      if (!anyByName(name)) throw new HttpError(404, 'no such agent');
      return setIdentity(anyByName(name).name, { icon: body.icon, color: body.color });
    },

    'POST /accounts/alias': ({ body }) => {
      const a = db.get('SELECT * FROM accounts WHERE id = ?', String(body.id || ''));
      if (!a) throw new HttpError(404, 'no such account');
      db.run('UPDATE accounts SET alias = ? WHERE id = ?', String(body.alias || '').trim().slice(0, 80) || null, a.id);
      return { display: accountName(db.get('SELECT * FROM accounts WHERE id = ?', a.id)) };
    },

    'POST /accounts/delete': ({ body }) => {
      const id = String(body.id || '');
      if (db.get('SELECT 1 AS x FROM peers WHERE account_id = ? AND last_seen > ?', id, now() - ACTIVE_MS)) throw new HttpError(409, 'an online agent uses this account');
      db.run('UPDATE peers SET account_id = NULL WHERE account_id = ?', id);
      db.run('DELETE FROM accounts WHERE id = ?', id);
      return { ok: true };
    },

    // Bridge Manager role (one per computer + account + app).
    'POST /peers/role': ({ body }) => {
      const peer = getPeer(String(body.id || ''));
      if (!peer) throw new HttpError(404, 'no such agent');
      if (body.role && body.role !== 'manager') throw new HttpError(400, 'role must be "manager" or empty');
      setRole(peer, body.role || null);
      return { role: body.role || null };
    },

    // Stay awake (keepalive turns) on or off for an agent; remembered for its session.
    'POST /peers/keep-awake': ({ body }) => {
      const peer = getPeer(String(body.id || ''));
      if (!peer) throw new HttpError(404, 'no such agent');
      const on = body.on ? 1 : 0;
      db.run('UPDATE peers SET keep_awake = ? WHERE id = ?', on, peer.id);
      if (peer.session_id) {
        db.run(`INSERT INTO session_prefs (session_id, keep_awake) VALUES (?, ?)
          ON CONFLICT(session_id) DO UPDATE SET keep_awake = excluded.keep_awake`, peer.session_id, on);
      }
      return { keep_awake: Boolean(on) };
    },

    // Ask every online Manager to update the agent-bridge plugin on its computer + account.
    'POST /managers/update': ({ body }) => {
      const version = String(body.version || '').trim().slice(0, 40);
      const managers = db.all('SELECT * FROM peers WHERE last_seen > ?', now() - ACTIVE_MS).filter(isManager);
      for (const m of managers) {
        notify(m.name, `agent-bridge update request from the operator: update the agent-bridge plugin for your account on this computer` +
          `${version ? ` to ${version}` : ' to the latest version'}. Run the agent-bridge-plugin-update skill${version ? ` with ${version}` : ''}: ` +
          'ask the operator for approval over agent-bridge first, as the skill says, then report the result.');
      }
      return { asked: managers.map(m => m.name) };
    },

    'POST /peers/approvals': ({ body }) => {
      const peer = getPeer(String(body.id || ''));
      if (!peer) throw new HttpError(404, 'no such agent');
      setApprovals(peer, body.mode);
      return { approvals: body.mode };
    },

    'POST /pairings/deny': ({ body }) => {
      db.run(`UPDATE pairings SET status = 'denied' WHERE code = ? AND status = 'pending'`, String(body.code || '').toUpperCase());
      return { ok: true };
    },

    'POST /peers/rename': ({ body }) => {
      const peer = getPeer(String(body.id || ''));
      if (!peer) throw new HttpError(404, 'no such agent');
      if (!String(body.name || '').trim()) throw new HttpError(400, 'name required');
      return { name: renamePeer(peer, body.name) };
    },

    // Remove an agent (online or not). Its process may not re-register; a restarted session rejoins.
    'POST /peers/remove': ({ body }) => {
      const peer = getPeer(String(body.id || ''));
      if (!peer) throw new HttpError(404, 'no such agent');
      if (peer.kind !== 'human') db.run('INSERT OR IGNORE INTO removed_peers (peer_id, removed_at) VALUES (?, ?)', peer.id, now());
      db.run('DELETE FROM peers WHERE id = ?', peer.id);
      db.run('DELETE FROM removed_peers WHERE removed_at < ?', now() - 30 * 24 * 3_600_000);
      return { removed: peer.name };
    },

    // Remove an offline peer (e.g. an old console name) from the registry.
    'POST /peers/delete': ({ body }) => {
      const peers = db.all('SELECT id, kind, last_seen FROM peers WHERE name = ? COLLATE NOCASE', String(body.name || ''));
      if (!peers.length) throw new HttpError(404, 'no such peer');
      if (peers.some(p => p.kind !== 'human' && p.last_seen > now() - ACTIVE_MS)) throw new HttpError(409, 'that agent is online');
      for (const p of peers) db.run('DELETE FROM peers WHERE id = ?', p.id);
      return { deleted: peers.length };
    },

    // `to_keys` ({ address: identity key }): the console addresses agents by their stable identity, so a
    // DM still reaches the right agent after its address changed (renamed, or re-labelled beside a twin).
    'POST /send': ({ body }) => send({ ...(h => ({ from: h.name, fromKey: h.id }))(touchHuman(body.from)), fromDevice: 'console',
      to: body.to_keys && body.to ? [].concat(body.to).map(n => currentAddress(String(body.to_keys[n] || ''), n)) : body.to, chat: body.chat, message: body.message,
      replyTo: body.reply_to, project: body.project ? projectSlug(body.project) : null, attachmentIds: body.attachments, admin: true,
      mentions: body.mentions }),

    'POST /chats': ({ body }) => chatAction(touchHuman(body.as).name, body, { admin: true }),

    // Remove peers and everything addressed to/from them (e.g. test runs).
    'POST /peers/purge': ({ body }) => {
      const names = [].concat(body.names || []).map(String).filter(Boolean);
      for (const n of names) {
        db.run('DELETE FROM peers WHERE name = ? COLLATE NOCASE', n);
        db.run('DELETE FROM messages WHERE from_name = ? COLLATE NOCASE OR to_name = ? COLLATE NOCASE', n, n);
        db.run('DELETE FROM chat_members WHERE name = ? COLLATE NOCASE', n);
        db.run('DELETE FROM identities WHERE name = ?', n);
        db.run('DELETE FROM hidden_conversations WHERE owner = ?', n);
        db.run('DELETE FROM human_aliases WHERE alias = ? COLLATE NOCASE OR name = ? COLLATE NOCASE', n, n);
        db.run('DELETE FROM push_subscriptions WHERE name = ? COLLATE NOCASE', n);
      }
      db.run('DELETE FROM chats WHERE id NOT IN (SELECT DISTINCT chat_id FROM chat_members)');
      return { purged: names.length };
    },

    'POST /attachments/upload': ({ request, url }) => putAttachment(request, url, touchHuman(url.searchParams.get('as')).name),

    'GET /attachments/download': ({ url }) => getAttachment(url.searchParams.get('attachment')),

    'GET /projects': () => ({ projects: projects.list() }),

    'POST /project': ({ body }) => {
      const actor = touchHuman(body.as).name;
      switch (body.action) {
        case 'create': return projects.create(body.name, body.description, actor);
        case 'delete': return projects.remove(body.project);
        case 'overview': {
          const slug = projects.need(body.project).slug;
          // The console sees every member, offline ones too (agents get just the online ones), and
          // the agents taking part in the project chat without having joined it.
          const all = db.all(`SELECT name, kind, app, device, summary, listen_until, last_seen FROM peers
            WHERE project = ? AND kind != 'human' AND last_seen > ? ORDER BY name`, slug, now() - STALE_MS)
            .map(({ listen_until, ...m }) => ({ ...m, online: m.last_seen > now() - ACTIVE_MS, ...liveness(m.name, listen_until) }));
          const participants = db.all(`SELECT DISTINCT p.name FROM messages m JOIN peers p ON p.name = m.from_name COLLATE NOCASE
            WHERE m.project = ? AND p.kind != 'human' AND coalesce(p.project, '') != ? AND m.created_at > ?`, slug, slug, now() - 7 * 86_400_000)
            .map(r => r.name);
          return {
            ...projects.overview(slug, all),
            participants,
            messages: db.all(`SELECT id, from_name AS "from", to_name AS "to", body, reply_to, created_at, delivered_at, attachments, chat_id, send_id, from_device
              FROM messages WHERE project = ? ORDER BY id DESC LIMIT 200`, slug).map(withAttachments),
            device_labels: deviceLabels(),
          };
        }
        // The operator puts an agent in a project (an agent is in one project at a time) or takes it out.
        case 'add':
        case 'remove': {
          const slug = projects.need(body.project).slug;
          const peer = db.get(`SELECT * FROM peers WHERE name = ? COLLATE NOCASE AND kind != 'human' ORDER BY last_seen DESC LIMIT 1`, String(body.name || ''));
          if (!peer) throw new HttpError(404, `no agent named "${body.name}"`);
          const before = peer.project || null;
          const name = projects.need(slug).name;
          if (body.action === 'add') {
            setProject(peer, slug);
            projects.event(slug, actor, 'member', `added ${peer.name}${before && before !== slug ? ` (from ${before})` : ''}`);
            notify(peer.name, `${actor} added you to project "${name}" (${slug})${before && before !== slug ? `; you left "${before}"` : ''}. ` +
              'Read its overview with the project tool (action overview) and follow its chat; reply to project messages with reply_to so it stays there.', slug);
          } else if (before === slug) {
            setProject(peer, null);
            projects.event(slug, actor, 'member', `removed ${peer.name}`);
            notify(peer.name, `${actor} took you out of project "${name}".`);
          }
          return { name: peer.name, project: body.action === 'add' ? slug : null, previous: before };
        }
        default: throw new HttpError(400, 'action must be create, delete, overview, add or remove');
      }
    },

    ...Object.fromEntries(['docs', 'tasks', 'kv', 'files'].map(resource => [`POST /${resource}`, ({ body }) =>
      projects.act(resource, body.action, body.project, body, touchHuman(body.as).name)])),

    'POST /files/upload': ({ request, url }) =>
      upload(request, url, url.searchParams.get('project'), touchHuman(url.searchParams.get('as')).name),

    'GET /files/download': ({ url }) => download(url, url.searchParams.get('project')),

    // Operator's own inbox: mark messages addressed to them as read.
    'POST /ack': ({ body }) => ack(touchHuman(body.as).name, body.ids),

    'POST /listen': ({ body }) => {
      const peer = activeByName(String(body.name || '')) || anyByName(String(body.name || ''));
      if (!peer) throw new HttpError(404, 'no such peer');
      setListen(peer, body.listen, body.as ? `${String(body.as).slice(0, 64)} (console)` : 'the console');
      return status(getPeer(peer.id));
    },

    'POST /devices': ({ body }) => issueDevice(body.name),

    'POST /devices/label': ({ body }) => {
      const name = String(body.name || '');
      if (!db.get('SELECT 1 AS x FROM devices WHERE name = ?', name)) throw new HttpError(404, 'no such device');
      db.run('UPDATE devices SET label = ? WHERE name = ?', String(body.label || '').trim().slice(0, 40) || null, name);
      return { name, display: deviceLabel(name) };
    },

    'POST /devices/revoke': ({ body }) => {
      db.run('UPDATE devices SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL', now(), String(body.name || ''));
      // Its agents can't act anymore; drop them now rather than letting them look online.
      db.run(`DELETE FROM peers WHERE device = ? AND kind != 'human'`, String(body.name || ''));
      return { ok: true };
    },

    // Only revoked devices can be deleted, so a live token is never removed by accident.
    'POST /devices/delete': ({ body }) => {
      const name = String(body.name || '');
      const device = db.get('SELECT revoked_at FROM devices WHERE name = ?', name);
      if (!device) throw new HttpError(404, 'no such device');
      if (!device.revoked_at) throw new HttpError(409, 'revoke the device before deleting it');
      db.run('DELETE FROM devices WHERE name = ?', name);
      db.run(`DELETE FROM peers WHERE device = ? AND kind != 'human'`, name);
      return { ok: true };
    },
  };

  async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/health') return json(200, { ok: true });

    let routes, route;
    if (path.startsWith('/pair/')) {
      const handler = pairRoutes[`${request.method} ${path.slice(5)}`];
      if (!handler) return json(404, { error: 'not found' });
      try {
        const text = await request.text();
        return json(200, await handler({ body: text ? JSON.parse(text) : {} }));
      } catch (err) {
        return json(err.status || (err instanceof SyntaxError ? 400 : 500), { error: err.message });
      }
    }
    if (path.startsWith('/api/')) { routes = agentRoutes; route = path.slice(4); }
    else if (path.startsWith('/admin/')) { routes = adminRoutes; route = path.slice(6); }
    else return json(404, { error: 'not found' });
    const handler = routes[`${request.method} ${route}`];
    if (!handler) return json(404, { error: 'not found' });

    let auth = await authenticate(request);
    // The cloud hub keeps the admin token off the agent API (/api), which sits outside the
    // console's login (Cloudflare Access); agents use device tokens. The local broker allows it
    // because its own agents run on the admin token.
    if (auth?.admin && routes === agentRoutes && !adminOnAgentApi) auth = null;
    // Drain unread bodies on early rejects (Workers log an error otherwise).
    const reject = async (status, error) => { await request.arrayBuffer().catch(() => {}); return json(status, { error }); };
    if (!auth) return reject(401, 'unauthorized');
    if (routes === adminRoutes && !auth.admin) return reject(403, 'admin token required');

    try {
      let body = {};
      const raw = (request.headers.get('content-type') || '').startsWith('application/octet-stream');
      if (request.method === 'POST' && !raw) {
        const text = await request.text();
        if (text.length > 1_000_000) throw new HttpError(413, 'body too large');
        body = text ? JSON.parse(text) : {};
      }
      const result = await handler({ body, auth, url, request });
      return result instanceof Response ? result : json(200, result);
    } catch (err) {
      if (err instanceof SyntaxError) return json(400, { error: 'invalid JSON' });
      return json(err.status || 500, { error: err.message });
    }
  }

  return { handle };
}

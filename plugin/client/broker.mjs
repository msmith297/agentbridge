#!/usr/bin/env node
// Local agent-bridge broker: the hub core on Node + SQLite, for offline / self-hosted use.
// The MCP server auto-starts it when config points at a localhost URL. Also serves the console.
//
// Env:
//   AGENT_BRIDGE_PORT   default 7777
//   AGENT_BRIDGE_BIND   default 127.0.0.1 (use a Tailscale IP to share it with other machines)
//   AGENT_BRIDGE_HOME   state dir; default ~/.agent-bridge  (admin token: <home>/local-admin-token)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHub } from '../core/hub-core.mjs';
import { generateVapidKeys } from '../core/webpush.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.AGENT_BRIDGE_HOME || path.join(os.homedir(), '.agent-bridge');
const PORT = Number(process.env.AGENT_BRIDGE_PORT || 7777);
const BIND = process.env.AGENT_BRIDGE_BIND || '127.0.0.1';
// Installed runtime: <app>/console/dist; in the repo: <repo>/console/dist.
const CONSOLE_DIR = [path.join(HERE, '..', 'console', 'dist'), path.join(HERE, '..', '..', 'console', 'dist')].find(d => fs.existsSync(d))
  || path.join(HERE, '..', 'console', 'dist');

fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
const tokenFile = path.join(HOME, 'local-admin-token');
if (!fs.existsSync(tokenFile)) {
  fs.writeFileSync(tokenFile, 'ab_' + crypto.randomBytes(24).toString('base64url') + '\n', { mode: 0o600 });
}
const ADMIN_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();

// Several sessions may auto-start a broker at once; wait on the lock and let the port decide.
const sqlite = new DatabaseSync(path.join(HOME, 'local-hub.db'), { timeout: 5000 });
sqlite.exec('PRAGMA journal_mode = WAL');
const db = {
  all: (sql, ...args) => sqlite.prepare(sql).all(...args),
  get: (sql, ...args) => sqlite.prepare(sql).get(...args),
  run: (sql, ...args) => sqlite.prepare(sql).run(...args),
};
// Push notifications for the console: a VAPID key pair kept in the broker's home.
const VAPID_FILE = path.join(HOME, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch {
  vapid = await generateVapidKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 });
}
const hub = createHub(db, {
  adminToken: ADMIN_TOKEN,
  maxAutoRounds: Number(process.env.AGENT_BRIDGE_MAX_AUTO_ROUNDS || 20),
  push: { ...vapid, subject: 'https://github.com/msmith297/agentbridge' },
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serveConsole(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(CONSOLE_DIR, path.normalize(rel));
  if (!file.startsWith(CONSOLE_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/admin/') && url.pathname !== '/health') {
      if (serveConsole(url.pathname, res)) return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const response = await hub.handle(new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.requestTimeout = 0; // long-poll inbox requests
server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`[agent-bridge] port ${PORT} already has a broker; exiting`);
  process.exit(0);
});
server.listen(PORT, BIND, () => {
  console.error(`[agent-bridge] local broker on http://${BIND}:${PORT} (state: ${HOME})`);
});

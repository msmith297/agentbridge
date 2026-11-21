#!/usr/bin/env node
// agent-bridge MCP server for Google Antigravity (stdio). Antigravity runs one MCP server for all of
// its conversations and names the conversation in each tool call (_meta
// "antigravity.google/conversation_id"). This server gives every conversation its own agent-bridge
// session, just like a Claude Code session: a child mcp.mjs per conversation
// (AGENT_BRIDGE_SESSION_ID = the conversation id) that registers, heartbeats and answers that
// conversation's tool calls. A child starts on the conversation's first tool call, or as soon as
// one of its hooks reports it (hook.mjs --antigravity writes ~/.agent-bridge/antigravity/<id>.json),
// so a conversation is on the bridge (and listening) before it ever calls a bridge tool.
//
// Env: AGENT_BRIDGE_ANTIGRAVITY_IDLE_HOURS  default 12: a conversation with no hook or tool call for
//      this long leaves the bridge (its child exits); its next hook or tool call brings it back.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, crumb } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(HERE, 'mcp.mjs');
const SESSIONS = path.join(HOME, 'antigravity');
const IDLE_MS = Number(process.env.AGENT_BRIDGE_ANTIGRAVITY_IDLE_HOURS || 12) * 3_600_000;
const CONVERSATION_KEY = 'antigravity.google/conversation_id';

const log = (...a) => console.error('[agent-bridge antigravity]', ...a);
const write = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

let initParams = null; // Antigravity's initialize request, replayed to each child

// A child mcp.mjs speaking JSON-RPC over its stdio; request() resolves with its response.
function startChild(env, cwd) {
  const proc = spawn(process.execPath, [MCP], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 1;
  const child = {
    proc,
    lastUsed: Date.now(),
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params) { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
  };
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    waiter.resolve(msg);
  });
  proc.on('exit', () => {
    for (const w of pending.values()) w.reject(new Error('agent-bridge session process exited'));
    pending.clear();
  });
  proc.stdin.on('error', () => {}); // the child exited: its requests fail above
  child.ready = child.request('initialize', initParams).then(() => child.notify('notifications/initialized', {}));
  return child;
}

// Lists the tools and instructions without joining the hub.
let template = null;
const getTemplate = () => (template ??= startChild({ AGENT_BRIDGE_TEMPLATE: '1' }, process.cwd()));

// One child per conversation. A conversation's hooks say where it works (its workspace), which
// becomes the child's folder (the default agent name comes from it).
const children = new Map(); // conversation id -> child
const sessionFile = id => path.join(SESSIONS, `${String(id).replace(/[^\w-]/g, '')}.json`);
function readSession(id) {
  try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')); } catch { return null; }
}

function childFor(id) {
  let child = children.get(id);
  if (child && child.proc.exitCode === null && !child.proc.killed) return child;
  const info = readSession(id);
  let cwd = info?.cwd;
  try { if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = process.cwd(); } catch { cwd = process.cwd(); }
  child = startChild({
    AGENT_BRIDGE_SESSION_ID: id,
    // New conversations listen always, as Claude Code sessions do (a folder's .agent-bridge.json can say otherwise).
    AGENT_BRIDGE_LISTEN: process.env.AGENT_BRIDGE_LISTEN || 'always',
  }, cwd);
  children.set(id, child);
  crumb(`antigravity: session for conversation ${id.slice(0, 8)} in ${cwd}`);
  return child;
}

// Conversations whose hooks ran recently in the agent host that started this server (the same app
// or CLI process: another Antigravity instance has its own server).
function adoptFromHooks() {
  let files;
  try { files = fs.readdirSync(SESSIONS).filter(f => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    const id = f.slice(0, -5);
    const info = readSession(id);
    if (!info || Date.now() - (info.at || 0) > IDLE_MS) continue;
    if (!(info.host_pids || []).includes(process.ppid)) continue;
    if (children.has(id) && children.get(id).proc.exitCode === null) { children.get(id).lastUsed = Math.max(children.get(id).lastUsed, info.at); continue; }
    if (initParams) childFor(id).lastUsed = info.at;
  }
}

// A conversation idle past IDLE_MS leaves the bridge; its hooks or tool calls bring it back.
function retireIdle() {
  for (const [id, child] of children) {
    const at = Math.max(child.lastUsed, readSession(id)?.at || 0);
    if (Date.now() - at < IDLE_MS) continue;
    crumb(`antigravity: conversation ${id.slice(0, 8)} idle; leaving the bridge`);
    child.proc.stdin.end(); // mcp.mjs unregisters and exits when its input closes
    children.delete(id);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled) need nothing from us
  switch (method) {
    case 'initialize': {
      initParams = params || {};
      const res = await getTemplate().request('initialize', initParams);
      getTemplate().notify('notifications/initialized', {});
      adoptFromHooks();
      return write({ id, ...(res.error ? { error: res.error } : { result: res.result }) });
    }
    case 'ping':
      return write({ id, result: {} });
    case 'tools/list': {
      const res = await getTemplate().request('tools/list', params || {});
      return write({ id, ...(res.error ? { error: res.error } : { result: res.result }) });
    }
    case 'tools/call': {
      const conversation = params?._meta?.[CONVERSATION_KEY] || params?._meta?.['antigravity.google/root_conversation_id'];
      if (!conversation) {
        return write({ id, result: { isError: true, content: [{ type: 'text', text:
          'agent-bridge error: this Antigravity version did not say which conversation made the call, so agent-bridge cannot tell who you are. Update Antigravity.' }] } });
      }
      const child = childFor(String(conversation));
      child.lastUsed = Date.now();
      await child.ready;
      const res = await child.request('tools/call', params);
      return write({ id, ...(res.error ? { error: res.error } : { result: res.result }) });
    }
    default:
      return write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // Each request runs independently so one conversation's long wait_for_message doesn't block others.
  handle(msg).catch(err => msg.id !== undefined && write({ id: msg.id, error: { code: -32603, message: err.message } }));
});

// Antigravity closed us: every conversation's session leaves the bridge with it.
function shutdown() {
  for (const child of [...children.values(), template].filter(Boolean)) child.proc.stdin.end();
  setTimeout(() => process.exit(0), 2500).unref(); // let the children unregister
}
rl.on('close', shutdown);

fs.mkdirSync(SESSIONS, { recursive: true });
try { fs.watch(SESSIONS, () => adoptFromHooks()); } catch { /* polling below covers it */ }
setInterval(adoptFromHooks, 5000).unref();
setInterval(retireIdle, 60_000).unref();

// Exit if the app that started us is gone (we were re-parented), as mcp.mjs does.
const PARENT = process.ppid;
if (process.platform !== 'win32') setInterval(() => {
  if (process.ppid !== PARENT) { log('parent process exited; shutting down'); shutdown(); }
}, 15_000).unref();

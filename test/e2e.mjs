#!/usr/bin/env node
// End-to-end test: real MCP server + hook processes against a hub.
//   node test/e2e.mjs                         # starts a throwaway local broker
//   HUB_URL=http://127.0.0.1:8787 ADMIN_TOKEN=... node test/e2e.mjs   # e.g. against `wrangler dev`

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'plugin', 'client', 'mcp.mjs');
const HOOK = path.join(ROOT, 'plugin', 'client', 'hook.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-test-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Poll until fn() is truthy (network latency to a remote hub varies); returns the last value.
async function until(fn, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let v;
  while (!(v = await fn()) && Date.now() < end) await sleep(250);
  return v;
}
const RUN = Date.now().toString(36); // unique names when re-running against a persistent hub

let HUB = process.env.HUB_URL;
let ADMIN = process.env.ADMIN_TOKEN;
// A hub behind Cloudflare Access: admin calls carry a service token
// (~/.agent-bridge/cf-access.json: {"client_id": "...", "client_secret": "..."}).
let ACCESS_HEADERS = {};
try {
  const cf = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.agent-bridge', 'cf-access.json'), 'utf8'));
  if (HUB && cf.client_id) ACCESS_HEADERS = { 'CF-Access-Client-Id': cf.client_id, 'CF-Access-Client-Secret': cf.client_secret };
} catch { /* no service token: fine for local hubs */ }
let broker;
if (!HUB) {
  HUB = 'http://127.0.0.1:7899';
  broker = spawn(process.execPath, [path.join(ROOT, 'plugin', 'client', 'broker.mjs')], {
    env: { ...process.env, AGENT_BRIDGE_PORT: '7899', AGENT_BRIDGE_HOME: path.join(TMP, 'broker'), AGENT_BRIDGE_MAX_AUTO_ROUNDS: '3' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50 && !(await fetch(`${HUB}/health`).then(r => r.ok, () => false)); i++) await sleep(100);
  ADMIN = fs.readFileSync(path.join(TMP, 'broker', 'local-admin-token'), 'utf8').trim();
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      ${String(detail).slice(0, 400)}`}`);
  if (!ok) failures++;
}

async function admin(method, route, body) {
  const res = await fetch(`${HUB}/admin${route}`, {
    method, headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', ...ACCESS_HEADERS },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// Each simulated machine gets its own config dir (device name + token).
function deviceEnv(device, token) {
  const home = path.join(TMP, device);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: HUB, token, device }));
  // Keepalive 6s: wide enough for a hook's start-up over the internet when testing a remote hub.
  // Fake AI accounts (never the real ones of whoever runs the tests).
  const codexHome = path.join(home, 'codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const claims = { email: `${device}@example.test`, 'https://api.openai.com/auth': { chatgpt_account_id: `acct-${device}`, chatgpt_plan_type: 'plus' } };
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x` } }));
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CONFIG_DIR']) delete env[k];
  return {
    ...env, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_KEEPALIVE_MINUTES: '0.1', CLAUDE_CODE_SESSION_ID: '',
    CLAUDE_CODE_ACCOUNT_UUID: `uuid-${device}`, CLAUDE_CODE_ORGANIZATION_UUID: 'org-test', CLAUDE_CODE_USER_EMAIL: `${device}@example.test`,
    CODEX_HOME: codexHome,
  };
}

async function agent({ env, client, sessionId, name, cwd = TMP }) {
  const p = spawn(process.execPath, [MCP], {
    cwd,
    env: { AGENT_BRIDGE_LISTEN: 'off', ...env, AGENT_BRIDGE_NAME: name, CLAUDE_CODE_SESSION_ID: sessionId || '' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let n = 0;
  readline.createInterface({ input: p.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise(r => { const id = ++n; pending.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: client, version: '1' } });
  const call = async (tool, args = {}) => {
    const m = await rpc('tools/call', { name: tool, arguments: args });
    return (m.result?.isError ? 'ERROR ' : '') + (m.result?.content?.[0]?.text ?? JSON.stringify(m.error));
  };
  const tools = async () => (await rpc('tools/list')).result?.tools?.map(t => t.name) ?? [];
  return { p, init, call, tools, stop: () => new Promise(r => { p.on('close', r); p.stdin.end(); }) };
}

// Hooks run as children of this process, like the agent's own MCP server: Codex-style binding by pid.
function hook(env, input) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const h = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    h.stdout.on('data', d => { out += d; });
    h.on('close', () => resolve({ ms: Date.now() - t0, out: out ? JSON.parse(out) : null }));
    h.stdin.end(JSON.stringify(input));
  });
}

// Run the hook with extra args, capturing exit code and stderr (background listener mode).
function hookProc(env, input, args = []) {
  const h = spawn(process.execPath, [HOOK, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  h.stdout.on('data', d => { out += d; });
  h.stderr.on('data', d => { err += d; });
  h.stdin.end(JSON.stringify(input));
  return { proc: h, done: new Promise(resolve => h.on('close', code => resolve({ code, out, err }))) };
}

try {
  check('health', (await fetch(`${HUB}/health`)).ok);
  if (Object.keys(ACCESS_HEADERS).length) { // behind Cloudflare Access: the Access login itself signs in
    const viaAccess = await fetch(`${HUB}/admin/state`, { headers: ACCESS_HEADERS });
    check('Cloudflare Access login works without the admin token', viaAccess.status === 200, viaAccess.status);
    const who = await fetch(`${HUB}/admin/access`, { headers: ACCESS_HEADERS }).then(r => r.json());
    check('console can see the Access login', who.admin === true, JSON.stringify({ admin: who.admin }));
    const anon = await fetch(`${HUB}/admin/state`, { redirect: 'manual' });
    check('admin without any login goes to the Cloudflare sign-in', anon.status === 302 || anon.status === 403, anon.status);
  } else {
    check('admin rejects device-less request', (await fetch(`${HUB}/admin/state`)).status === 401);
  }
  if (!broker) { // cloud hub: the admin token only works on /admin (behind the console login)
    const adminOnApi = await fetch(`${HUB}/api/peers`, { headers: { authorization: `Bearer ${ADMIN}`, ...ACCESS_HEADERS } });
    check('cloud hub refuses the admin token on the agent API', adminOnApi.status === 401, adminOnApi.status);
  }

  const devA = await admin('POST', '/devices', { name: `mac-${RUN}` });
  const devB = await admin('POST', '/devices', { name: `win-${RUN}` });
  check('create device tokens', devA.data.token && devB.data.token, JSON.stringify(devA));
  const envA = deviceEnv(`mac-${RUN}`, devA.data.token);
  const envB = deviceEnv(`win-${RUN}`, devB.data.token);

  const claudeSession = `claude-sess-${RUN}`;
  const A = await agent({ env: envA, client: 'claude-code', sessionId: claudeSession, name: `alice-${RUN}` });
  const B = await agent({ env: envB, client: 'codex-mcp-client', name: `bob-${RUN}` });
  check('claude agent instructions name it', A.init.result.instructions.includes(`alice-${RUN}`), A.init.result.instructions.slice(0, 200));
  const codexSession = `codex-sess-${RUN}`;
  await B.call('list_peers');
  check('an unlinked Codex server is not listed', !(await A.call('list_peers')).includes(`bob-${RUN}`));
  await hook(envB, { session_id: codexSession, turn_id: 't-1', cwd: TMP, hook_event_name: 'UserPromptSubmit' }); // links bob's chat

  const peers = await A.call('list_peers');
  check('list_peers shows both devices', peers.includes(`bob-${RUN}`) && peers.includes(`win-${RUN}`) && peers.includes('codex on'), peers);

  // New Claude Code sessions listen always unless told otherwise; Codex starts off.
  const { AGENT_BRIDGE_LISTEN: _unused, ...defaultEnv } = envA;
  const D0 = await agent({ env: { ...defaultEnv, AGENT_BRIDGE_LISTEN: undefined }, client: 'claude-code', sessionId: `default-sess-${RUN}`, name: `deflisten-${RUN}` });
  check('new Claude Code sessions listen always by default', (await D0.call('listen', {})).includes('always-listening'));
  await D0.stop();

  // Stable identities: messages carry sender/recipient keys (sessions), which survive renames.
  await A.call('send_message', { to: `bob-${RUN}`, message: `key check ${RUN}` });
  const keyed = (await admin('GET', '/state')).data;
  const km = keyed.messages.find(m => m.body === `key check ${RUN}`);
  const alicePeer = keyed.peers.find(p => p.name === `alice-${RUN}`);
  check('messages carry stable sender and recipient keys', km?.from_key === claudeSession && km.to_key && km.from_key === alicePeer?.key, JSON.stringify({ km, key: alicePeer?.key }));
  const agentView = await fetch(`${HUB}/api/peers`, { headers: { authorization: `Bearer ${devA.data.token}` } }).then(r => r.json());
  check('agents don\'t see other agents\' identity keys', agentView.peers?.length && agentView.peers.every(p => !('key' in p) && !('session_id' in p)), JSON.stringify(agentView.peers?.[0]));
  await B.call('check_inbox');

  // Accounts: agents report which AI account they run on; emails stay in the console.
  const acctState = (await admin('GET', '/state')).data;
  const acctA = acctState.accounts?.find(a => a.email === `mac-${RUN}@example.test`);
  const acctB = acctState.accounts?.find(a => a.email === `win-${RUN}@example.test`);
  check('agents report their accounts (Claude and ChatGPT)', acctA?.provider === 'anthropic' && acctA.agents.includes(`alice-${RUN}`) &&
    acctB?.provider === 'openai' && acctB.plan === 'plus', JSON.stringify(acctState.accounts?.slice(0, 3)));
  check('account emails are not shown to other agents', !peers.includes('@example.test') && peers.includes('account: '), peers);
  await admin('POST', '/accounts/alias', { id: acctB?.id, alias: `Team ChatGPT ${RUN}` });
  check('operator aliases an account, agents see the alias', (await A.call('list_peers')).includes(`account: Team ChatGPT ${RUN}`));
  check('an account in use cannot be deleted', (await admin('POST', '/accounts/delete', { id: acctA?.id })).status === 409);

  // Identity: icon and color, from the console or by the agent itself.
  await admin('POST', '/peers/identity', { name: `bob-${RUN}`, icon: '🦊', color: '#d9482b' });
  await A.call('set_profile', { icon: '🛠️', color: '#3355aa' });
  const idPeers = (await admin('GET', '/state')).data.peers;
  check('icons and colors set by console and agent', idPeers.find(p => p.name === `bob-${RUN}`)?.icon === '🦊' &&
    idPeers.find(p => p.name === `alice-${RUN}`)?.color === '#3355aa', JSON.stringify(idPeers.filter(p => p.name.endsWith(RUN)).map(p => [p.name, p.icon, p.color])));
  check('bad colors are rejected', (await admin('POST', '/peers/identity', { name: `bob-${RUN}`, color: 'red' })).status === 400);
  check('icons show in list_peers', (await A.call('list_peers')).includes(`🦊 bob-${RUN}`));

  // Direct message + long-poll wake-up across devices.
  const waiting = B.call('wait_for_message', { timeout_seconds: 20 });
  await sleep(500);
  const sent = await A.call('send_message', { to: `bob-${RUN}`, message: 'ping', reply_to: undefined });
  const t0 = Date.now();
  const got = await waiting;
  check('long-poll delivers across devices', got.includes('ping') && Date.now() - t0 < 3000, got);
  check('send reports recipient not listening', sent.includes('Not listening'), sent);
  check('message is acked (not re-delivered)', (await B.call('check_inbox')).includes('No new messages'));

  // Attachments: agent -> agent (saved locally on delivery), console -> agent (via hook), console download.
  const pic = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300_000, 3)]);
  const picPath = path.join(TMP, 'screen shot.png');
  fs.writeFileSync(picPath, pic);
  const withFile = await A.call('send_message', { to: `bob-${RUN}`, message: 'see screenshot', attach: [picPath] });
  check('send with attachment', withFile.includes('1 attachment'), withFile);
  const gotFile = await B.call('check_inbox');
  const savedPath = gotFile.match(/saved to (.+?\.png)/)?.[1];
  check('attachment saved locally on delivery', savedPath && Buffer.compare(fs.readFileSync(savedPath), pic) === 0 && gotFile.includes('Read tool'), gotFile);
  const noteUpload = await fetch(`${HUB}/admin/attachments/upload?name=notes.txt&type=text/plain&as=martin-${RUN}`, {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/octet-stream', ...ACCESS_HEADERS }, body: 'hello file',
  }).then(r => r.json());
  await admin('POST', '/send', { from: `martin-${RUN}`, to: `bob-${RUN}`, message: 'a note for you', attachments: [noteUpload.id] });
  const viaHook = await hook(envB, { session_id: `codex-sess-${RUN}`, turn_id: 't0', cwd: TMP, hook_event_name: 'UserPromptSubmit' });
  const hookPath = viaHook.out?.hookSpecificOutput?.additionalContext?.match(/saved to (.+?notes\.txt)/)?.[1];
  check('hook delivery saves console attachment', hookPath && fs.readFileSync(hookPath, 'utf8') === 'hello file', JSON.stringify(viaHook).slice(0, 400));
  const twin = async text => (await fetch(`${HUB}/admin/attachments/upload?name=image.png&type=image%2Fpng&as=martin-${RUN}`, {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/octet-stream', ...ACCESS_HEADERS }, body: text,
  }).then(r => r.json())).id;
  await admin('POST', '/send', { from: `martin-${RUN}`, to: `bob-${RUN}`, message: 'two screenshots', attachments: [await twin('first'), await twin('second')] });
  const twins = await hook(envB, { session_id: `codex-sess-${RUN}`, turn_id: 't0b', cwd: TMP, hook_event_name: 'UserPromptSubmit' });
  const twinPaths = [...String(twins.out?.hookSpecificOutput?.additionalContext).matchAll(/saved to (.+?\.png)/g)].map(m => m[1]);
  check('same-named attachments are saved as separate files', twinPaths.length === 2 && twinPaths[0] !== twinPaths[1] &&
    fs.readFileSync(twinPaths[0], 'utf8') === 'first' && fs.readFileSync(twinPaths[1], 'utf8') === 'second', JSON.stringify(twinPaths));
  await B.call('send_message', { to: `martin-${RUN}`, message: 'got your files' }); // agents answer the operator
  const consoleView = await admin('GET', '/state');
  const sentMsg = consoleView.data.messages.find(m => m.body === 'see screenshot');
  const dlRes = await fetch(`${HUB}/admin/attachments/download?attachment=${sentMsg?.attachments?.[0]?.id}`, { headers: { authorization: `Bearer ${ADMIN}`, ...ACCESS_HEADERS } });
  check('console sees and downloads attachments', sentMsg?.attachments?.[0]?.name === 'screen shot.png' && dlRes.ok && (await dlRes.arrayBuffer()).byteLength === pic.length,
    JSON.stringify(sentMsg));

  // Codex session binding through the hook (agent pid = this test process).
  const codexEvt = { session_id: codexSession, turn_id: 't1', cwd: TMP };
  const bound = await hook(envB, { ...codexEvt, hook_event_name: 'UserPromptSubmit' });
  check('codex hook binds session (no output when no mail)', bound.out === null, JSON.stringify(bound));
  await A.call('send_message', { to: `bob-${RUN}`, message: 'mid-task note' });
  const post = await hook(envB, { ...codexEvt, hook_event_name: 'PostToolUse', tool_name: 'shell' });
  check('PostToolUse injects mail into codex session', post.out?.hookSpecificOutput?.additionalContext?.includes('mid-task note'), JSON.stringify(post));
  await hook(envB, { ...codexEvt, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test -- --token=abcdefghijklmnopqrstuvwxyz0123456789' } });
  const busy = (await admin('GET', '/state')).data.peers.find(p => p.name === `bob-${RUN}`)?.activity;
  check('hooks report live status (tokens masked)', busy?.state === 'working' && busy.detail.startsWith('Bash · npm test') && !busy.detail.includes('abcdefghijklmnop') && busy.at > 0, JSON.stringify(busy));

  // Listening via the bound session: Stop hook holds, wakes on mail.
  const listenRes = await B.call('listen', { always: true });
  check('listen always', listenRes.includes('always-listening'), listenRes);
  const changedBy = (await admin('GET', '/state')).data.peers.find(p => p.name === `bob-${RUN}`);
  check('hub records who switched listening', changedBy?.listen_changed_by === 'the agent itself' && changedBy.listen_changed_at > 0, JSON.stringify(changedBy?.listen_changed_by));
  const armedSend = await A.call('send_message', { to: `bob-${RUN}`, message: 'armed check' });
  check('sender told a listening-but-idle agent will see it later', armedSend.includes('switched on but') && armedSend.includes(`bob-${RUN}`), armedSend);
  await B.call('check_inbox');
  const probe = await A.call('listen', {});
  check('listen with no args only reports (does not turn on)', probe.includes('not listening') && (await A.call('listen', {})).includes('not listening'), probe);
  const ups = await hook(envB, { ...codexEvt, hook_event_name: 'UserPromptSubmit' });
  check('prompt carries listening status line', ups.out?.hookSpecificOutput?.additionalContext?.includes('always-listening'), JSON.stringify(ups));
  const stopping = hook(envB, { ...codexEvt, hook_event_name: 'Stop' });
  const bobState = await until(async () => {
    const b = (await admin('GET', '/state')).data.peers.find(p => p.name === `bob-${RUN}`);
    return b?.waiting ? b : null;
  }) ?? (await admin('GET', '/state')).data.peers.find(p => p.name === `bob-${RUN}`);
  check('hub reports a listening agent as waiting while its Stop hook waits', bobState?.listening && bobState?.waiting, JSON.stringify(bobState));
  await A.call('send_message', { to: `bob-${RUN}`, message: 'wake up' });
  const stop = await stopping;
  check('Stop hook resumes listening agent with mail', stop.out?.decision === 'block' && stop.out.reason.includes('wake up'), JSON.stringify(stop));
  const keep = await hook(envB, { ...codexEvt, hook_event_name: 'Stop' });
  check('Stop hook keepalive when idle', keep.out?.decision === 'block' && keep.out.reason.includes('keepalive') && keep.ms >= 2500, JSON.stringify(keep));

  // Claude session: saved prefs survive an MCP restart.
  await A.call('set_profile', { name: `planner-${RUN}`, summary: 'testing' });
  await A.call('listen', { minutes: 10 });
  await A.stop();
  const A2 = await agent({ env: envA, client: 'claude-code', sessionId: claudeSession, name: `alice-${RUN}` });
  check('session prefs survive restart', A2.init.result.instructions.includes(`planner-${RUN}`) && A2.init.result.instructions.includes('listening until'), A2.init.result.instructions.slice(0, 300));

  // Claude Code listening: turns end normally; a background listener (asyncRewake) wakes the agent.
  const claudeEvt = { session_id: claudeSession, cwd: TMP, hook_event_name: 'Stop' };
  const quickStop = await hook(envA, claudeEvt);
  check('Claude Stop hook does not hold the turn while listening', quickStop.out === null && quickStop.ms < 5000, JSON.stringify(quickStop));
  const lockFile = path.join(envA.AGENT_BRIDGE_HOME, 'listeners', `${claudeSession.replace(/[^\w-]/g, '')}.lock`);
  const readLock = () => { try { return fs.readFileSync(lockFile, 'utf8'); } catch { return ''; } };
  const L1 = hookProc(envA, claudeEvt, ['--listen']);
  const firstLock = await until(readLock);
  const L2 = hookProc(envA, claudeEvt, ['--listen']); // a later turn end replaces L1
  await until(() => readLock() && readLock() !== firstLock);
  await sleep(300);
  await B.call('send_message', { to: `planner-${RUN}`, message: 'background wake test' });
  const [r1, r2] = await Promise.all([L1.done, L2.done]);
  check('background listener wakes the agent (exit 2 + message)', r2.code === 2 && r2.err.includes('background wake test'), JSON.stringify(r2).slice(0, 300));
  check('replaced listener exits quietly without taking mail', r1.code === 0 && !r1.err.includes('background wake test'), JSON.stringify(r1).slice(0, 200));
  const handedMsg = () => admin('GET', '/state').then(r => r.data.messages.find(m => m.body === 'background wake test'));
  check('handed-over mail is held, not yet delivered', (await handedMsg())?.delivered_at === null);
  const L3 = hookProc(envA, claudeEvt, ['--listen']);
  const before = readLock();
  await until(() => readLock() && readLock() !== before); // L3 has started listening
  await hook(envA, { ...claudeEvt, hook_event_name: 'UserPromptSubmit' }); // user prompt retires the listener
  check('woken turn confirms the handed-over mail', Boolean((await handedMsg())?.delivered_at));

  // A session listens from startup/resume (after an app restart) without needing a prompt first.
  const SL = hookProc(envA, { ...claudeEvt, hook_event_name: 'SessionStart', source: 'resume' }, ['--listen']);
  const lockBefore = readLock();
  await until(() => readLock() && readLock() !== lockBefore);
  await B.call('send_message', { to: `planner-${RUN}`, message: 'after restart' });
  const sl = await SL.done;
  check('listener started at session start wakes the agent', sl.code === 2 && sl.err.includes('after restart'), JSON.stringify(sl).slice(0, 200));

  // Remote approvals: in a turn a bridge message started, permission prompts go to the console.
  const permEvt = { session_id: claudeSession, cwd: TMP, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: `echo approve-${RUN}` } };
  const pendingFor = cmd => until(async () => (await admin('GET', '/state')).data.approvals?.find(a => a.summary === cmd));
  const askAllow = hook(envA, permEvt);
  const reqA = await pendingFor(`echo approve-${RUN}`);
  check('woken turn forwards its permission prompt to the console', reqA?.tool_name === 'Bash' && reqA.peer_name === `planner-${RUN}`, JSON.stringify(reqA));
  await admin('POST', '/approvals/decide', { approval: reqA?.id, decision: 'allow', as: `martin-${RUN}` });
  const allowed = await askAllow;
  check('console Allow approves the tool call', allowed.out?.hookSpecificOutput?.decision?.behavior === 'allow', JSON.stringify(allowed));
  const again = await admin('POST', '/approvals/decide', { approval: reqA?.id, decision: 'deny', as: `martin-${RUN}` });
  check('an answered request cannot be answered again', again.status === 409, again.status);

  // Multiple-choice questions and plan approvals go to the console as well (before the app shows them).
  const qEvt = { session_id: claudeSession, cwd: TMP, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [
    { question: `Which colour ${RUN}?`, header: 'Colour', multiSelect: false, options: [{ label: 'Blue' }, { label: 'Purple' }] },
    { question: `Which platforms ${RUN}?`, header: 'Platforms', multiSelect: true, options: [{ label: 'Mac' }, { label: 'Windows' }] }] } };
  const asking = hook(envA, qEvt);
  const reqQ = await until(async () => (await admin('GET', '/state')).data.approvals?.find(a => a.kind === 'question' && a.payload?.questions?.[0]?.question === `Which colour ${RUN}?`));
  check('a question the agent asks goes to the console with its options', reqQ?.payload?.questions?.[1]?.options?.length === 2, JSON.stringify(reqQ));
  await admin('POST', '/approvals/decide', { approval: reqQ?.id, decision: 'answer', as: `martin-${RUN}`,
    answers: { [`Which colour ${RUN}?`]: 'Purple', [`Which platforms ${RUN}?`]: ['Mac', 'Windows'] } });
  const answered = (await asking).out?.hookSpecificOutput;
  check('the console answer comes back to the agent', answered?.hookEventName === 'PreToolUse' && answered.permissionDecisionReason?.includes('→ Purple')
    && answered.permissionDecisionReason.includes('Mac, Windows'), JSON.stringify(answered));
  const planning = hook(envA, { ...qEvt, tool_name: 'ExitPlanMode', tool_input: { plan: `# Plan ${RUN}\n1. do it` } });
  const reqP = await until(async () => (await admin('GET', '/state')).data.approvals?.find(a => a.kind === 'plan' && a.payload?.plan?.includes(`Plan ${RUN}`)));
  await admin('POST', '/approvals/decide', { approval: reqP?.id, decision: 'allow', as: `martin-${RUN}` });
  check('a plan approved in the console lets the agent go ahead', (await planning).out?.hookSpecificOutput?.permissionDecision === 'allow');

  const askDeny = hook(envA, { ...permEvt, tool_input: { command: `rm -rf deny-${RUN}` } });
  const reqD = await pendingFor(`rm -rf deny-${RUN}`);
  await admin('POST', '/approvals/decide', { approval: reqD?.id, decision: 'deny', message: 'not that folder', as: `martin-${RUN}` });
  const denied = await askDeny;
  const denyDecision = denied.out?.hookSpecificOutput?.decision;
  check('console Deny refuses it with the note', denyDecision?.behavior === 'deny' && denyDecision.message.includes('not that folder'), JSON.stringify(denied));

  const waitEnv = { ...envA, AGENT_BRIDGE_APPROVAL_MINUTES: '0.05' };
  const unanswered = hook(waitEnv, { ...permEvt, tool_input: { command: `echo timeout-${RUN}` } });
  const reqT = await pendingFor(`echo timeout-${RUN}`);
  const timedOut = await unanswered;
  check('unanswered request falls back to the normal prompt', timedOut.out === null && timedOut.ms >= 2500, JSON.stringify(timedOut));
  const late = await admin('POST', '/approvals/decide', { approval: reqT?.id, decision: 'allow', as: `martin-${RUN}` });
  check('answering after the agent gave up is refused', late.status === 409 && /stopped waiting/.test(late.data.error), JSON.stringify(late));

  await hook(envA, { ...claudeEvt, hook_event_name: 'UserPromptSubmit' }); // confirms the wake-up's mail
  await hook(envA, { ...claudeEvt, hook_event_name: 'UserPromptSubmit' }); // the user typing: they're here
  const local = await hook(envA, { ...permEvt, tool_input: { command: `echo local-${RUN}` } });
  const forwardedLocal = (await admin('GET', '/state')).data.approvals?.some(a => a.summary === `echo local-${RUN}`);
  check('prompts in a user-started turn stay on the computer', local.out === null && local.ms < 5000 && !forwardedLocal, JSON.stringify(local));

  const planner = (await admin('GET', '/state')).data.peers.find(p => p.name === `planner-${RUN}`);
  check('agents default to approvals when away', planner?.approvals === 'away', planner?.approvals);
  await admin('POST', '/peers/approvals', { id: planner?.id, mode: 'always' });
  const askAlways = hook(envA, { ...permEvt, tool_input: { command: `echo always-${RUN}` } });
  const reqAlways = await pendingFor(`echo always-${RUN}`);
  check('"always" forwards prompts from user-started turns too', Boolean(reqAlways), JSON.stringify(reqAlways));
  await admin('POST', '/approvals/decide', { approval: reqAlways?.id, decision: 'allow', as: `martin-${RUN}` });
  await askAlways;
  await admin('POST', '/peers/approvals', { id: planner?.id, mode: 'off' });
  const markWoken = path.join(envA.AGENT_BRIDGE_HOME, 'listeners', `${claudeSession.replace(/[^\w-]/g, '')}.woken`);
  fs.writeFileSync(markWoken, '');
  const offRes = await hook(envA, { ...permEvt, tool_input: { command: `echo off-${RUN}` } });
  check('"off" never forwards', offRes.out === null && offRes.ms < 5000, JSON.stringify(offRes));
  const badMode = await admin('POST', '/peers/approvals', { id: planner?.id, mode: 'sometimes' });
  check('unknown approval mode rejected', badMode.status === 400, badMode.status);

  // Push notifications (local hub only: the test plays the push service, on localhost).
  if (broker) {
    const pushHuman = `martin-${RUN}`;
    const pushes = [];
    let pushStatus = 201;
    const pushServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => { pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(pushStatus).end(); });
    });
    await new Promise(r => pushServer.listen(0, '127.0.0.1', r));
    const pushBase = `http://127.0.0.1:${pushServer.address().port}`;
    const browser = crypto.createECDH('prime256v1');
    browser.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const subscription = { endpoint: `${pushBase}/sub-1`, keys: { p256dh: browser.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };
    // RFC 8291, receiving side: what the browser does with a push.
    const decrypt = body => {
      const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      const shared = browser.computeSecret(asPublic);
      const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), browser.getPublicKey(), asPublic]), 32));
      const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
    };
    const key = (await admin('GET', '/push/key')).data.publicKey;
    check('hub offers a push key', typeof key === 'string' && Buffer.from(key, 'base64url').length === 65, key);
    const sub = await admin('POST', '/push/subscribe', { as: pushHuman, subscription });
    check('console subscribes a browser for notifications', sub.status === 200 && sub.data.name === pushHuman, JSON.stringify(sub));
    const nextPush = async n => (await until(() => pushes.length >= n)) ? pushes[n - 1] : null;
    await B.call('send_message', { to: pushHuman, message: 'ping your phone' });
    const p1 = await nextPush(1);
    let note = null;
    try { note = p1 && decrypt(p1.body); } catch (err) { note = { error: err.message }; }
    check('a message to the operator arrives as a push (decrypts)', note?.title === `bob-${RUN}` && note.body === 'ping your phone' && note.url.includes('/messages/dm/')
      && !note.url.includes(`bob-${RUN}`), JSON.stringify(note)); // the DM is linked by the sender's identity, not its name
    // Looking at that conversation in the console: no push for it.
    const bobKey = (await admin('GET', '/state')).data.peers.find(p => p.name === `bob-${RUN}`)?.key;
    await admin('GET', `/state?as=${pushHuman}&viewing=${encodeURIComponent(`dm:${bobKey}`)}`);
    const pushesBefore = pushes.length;
    await B.call('send_message', { to: pushHuman, message: 'you are already reading this' });
    await sleep(800);
    check('no push for the conversation the operator has on screen', pushes.length === pushesBefore, String(pushes.length - pushesBefore));
    await admin('GET', `/state?as=${pushHuman}&viewing=other`);
    const [, jwt, k] = String(p1?.headers.authorization).match(/^vapid t=([^,]+), k=(.+)$/) ?? [];
    const raw = Buffer.from(key, 'base64url');
    const vapidKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    const [h, c, sig] = String(jwt).split('.');
    const signed = jwt && crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: vapidKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    check('push carries a valid VAPID signature', k === key && signed && JSON.parse(Buffer.from(c, 'base64url')).aud === pushBase && p1.headers['content-encoding'] === 'aes128gcm', p1?.headers.authorization);
    const test = await admin('POST', '/push/test', { endpoint: subscription.endpoint });
    check('console can send a test notification', test.status === 200 && (await nextPush(2)) && decrypt(pushes[1].body).tag === 'test', JSON.stringify(test.data));
    await admin('POST', '/peers/approvals', { id: planner?.id, mode: 'always' });
    const askPush = hook({ ...envA, AGENT_BRIDGE_APPROVAL_MINUTES: '0.05' }, { ...permEvt, tool_input: { command: `echo push-${RUN}` } });
    const p3 = await nextPush(3);
    const approvalNote = p3 && decrypt(p3.body);
    check('an approval request arrives as a push', approvalNote?.approval === true && approvalNote.body.includes(`echo push-${RUN}`), JSON.stringify(approvalNote));
    await askPush;
    await admin('POST', '/peers/approvals', { id: planner?.id, mode: 'off' });
    pushStatus = 410; // the browser unsubscribed: the push service says the subscription is gone
    await B.call('send_message', { to: pushHuman, message: 'gone' });
    await nextPush(4);
    const gone = await until(async () => (await admin('POST', '/push/test', { endpoint: subscription.endpoint })).status === 404);
    check('subscriptions the push service rejects are dropped', gone);
    pushServer.close();
  }
  await hook(envA, { ...claudeEvt, hook_event_name: 'UserPromptSubmit' }); // confirms it

  // Stay awake: the listener gives the agent a tiny keepalive turn before the app's idle timeout.
  const plannerId = (await admin('GET', '/state')).data.peers.find(p => p.name === `planner-${RUN}`)?.id;
  check('agents are not kept awake by default', !(await admin('GET', '/state')).data.peers.find(p => p.id === plannerId)?.keep_awake);
  await admin('POST', '/peers/keep-awake', { id: plannerId, on: true });
  const keeper = hookProc({ ...envA, AGENT_BRIDGE_KEEP_AWAKE_MS: '1500' }, claudeEvt, ['--listen']);
  const kept = await keeper.done;
  check('a session kept awake gets a keepalive turn', kept.code === 2 && kept.err.includes('keepalive'), JSON.stringify(kept).slice(0, 300));
  await admin('POST', '/peers/keep-awake', { id: plannerId, on: false });
  check('keep awake can be switched off', !(await admin('GET', '/state')).data.peers.find(p => p.id === plannerId)?.keep_awake);

  // A listener whose agent process is gone (e.g. app quit on Windows) exits without taking mail.
  const fakeAgent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)']);
  const orphan = hookProc({ ...envA, AGENT_BRIDGE_OWNER_PID: String(fakeAgent.pid) }, claudeEvt, ['--listen']);
  const orphanStart = Date.now();
  const orphanResult = await orphan.done;
  await B.call('send_message', { to: `planner-${RUN}`, message: 'after the agent died' });
  check('listener exits when its agent process dies (and takes no mail)',
    orphanResult.code === 0 && Date.now() - orphanStart < 15000 && !orphanResult.err, JSON.stringify(orphanResult));
  check('mail for it stays deliverable', (await A2.call('check_inbox')).includes('after the agent died'));
  await B.call('send_message', { to: `planner-${RUN}`, message: 'after prompt' });
  const r3 = await L3.done;
  check('user prompt retires the background listener', r3.code === 0, JSON.stringify(r3).slice(0, 200));
  check('message then waits for normal delivery', (await A2.call('check_inbox')).includes('after prompt'));

  // One row per session: a restarted MCP server takes over its session's row.
  const X1 = await agent({ env: envA, client: 'claude-code', sessionId: `x-${RUN}`, name: `xena-${RUN}` });
  await X1.call('listen', { always: true });
  await X1.stop(); // unregister keeps the session's row (offline)
  await A2.call('send_message', { to: `xena-${RUN}`, message: 'for an offline session' });
  const offlineListener = hookProc({ ...envA, AGENT_BRIDGE_STARTUP_GRACE_MS: '0' }, { session_id: `x-${RUN}`, cwd: TMP, hook_event_name: 'Stop' }, ['--listen']);
  const off = await offlineListener.done;
  const log = fs.readFileSync(path.join(envA.AGENT_BRIDGE_HOME, 'listener.log'), 'utf8');
  check('listener of a closed session exits without taking mail (after its start-up grace)', off.code === 0 && log.includes('session closed'), JSON.stringify(off) + log.slice(-300));
  const keptRow = (await admin('GET', '/state')).data.peers.filter(p => p.name === `xena-${RUN}`);
  check('exiting MCP server keeps its session row (offline)', keptRow.length === 1 && !keptRow[0].online, JSON.stringify(keptRow));
  const X2 = await agent({ env: envA, client: 'claude-code', sessionId: `x-${RUN}`, name: `some-default-${RUN}` });
  const rows = (await admin('GET', '/state')).data.peers.filter(p => p.name.includes(`-${RUN}`) && (p.name.startsWith('xena') || p.name.startsWith('some-default')));
  check('restarted MCP server takes over the session row (same name, still listening, no duplicate)',
    rows.length === 1 && rows[0].name === `xena-${RUN}` && rows[0].listen_always && rows[0].online, JSON.stringify(rows));
  await X2.stop();

  // Device isolation: device B cannot act as device A's session.
  // (Called directly: a hook spawned by this test would legitimately bind to device B's own
  // agent, since this process plays that agent.)
  const cross = await fetch(`${HUB}/api/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${devB.data.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: claudeSession }),
  });
  check('device cannot use another device\'s session', cross.status === 404, cross.status);

  // Operator console: state, sending as a human, agents replying to the human.
  const human = `martin-${RUN}`;
  const fromHuman = await admin('POST', '/send', { from: human, to: `planner-${RUN}`, message: 'status?' });
  check('console sends as human', fromHuman.data.delivered_to?.[0] === `planner-${RUN}`, JSON.stringify(fromHuman));
  const inbox = await A2.call('check_inbox');
  check('agent receives human message', inbox.includes(`from ${human}`), inbox);
  const reply = await A2.call('send_message', { to: human, message: 'all good', reply_to: 1 });
  check('agent can message the human', reply.includes(`Sent to ${human}`), reply);
  const byKey = await admin('POST', '/send', { from: human, to: [`old-address-${RUN}`], to_keys: { [`old-address-${RUN}`]: claudeSession }, message: 'by identity' });
  check('console DMs reach the agent by identity after its address changed', byKey.data.delivered_to?.[0] === `planner-${RUN}`, JSON.stringify(byKey));
  await A2.call('check_inbox');
  // Operator messages get an answer: the turn-end hook reminds an agent that read one and stayed silent, once.
  const turn = ev => hook(envA, { session_id: claudeSession, cwd: TMP, hook_event_name: ev });
  await admin('POST', '/send', { from: human, to: `planner-${RUN}`, message: 'let it finish' });
  await turn('UserPromptSubmit'); // the agent reads it
  const nudge = (await turn('Stop')).out;
  check('Stop reminds the agent to answer the operator', nudge?.decision === 'block' && nudge.reason.includes('let it finish'), JSON.stringify(nudge).slice(0, 300));
  const nudge2 = (await turn('Stop')).out;
  check('the reminder comes once', !nudge2?.reason?.includes('let it finish'), JSON.stringify(nudge2).slice(0, 200));
  await admin('POST', '/send', { from: human, to: `planner-${RUN}`, message: 'second ask' });
  await turn('UserPromptSubmit');
  await A2.call('send_message', { to: human, message: 'on it' });
  const nudge3 = (await turn('Stop')).out;
  check('an answered operator message needs no reminder', !nudge3?.reason?.includes('second ask'), JSON.stringify(nudge3).slice(0, 200));
  // One operator on every device: other names merge into one and stay reachable as aliases.
  const oldName = `phone-${RUN}`;
  await admin('POST', '/send', { from: oldName, to: `planner-${RUN}`, message: 'sent from the phone' });
  const merge = await admin('POST', '/operators/merge', { into: human, from: [oldName] });
  const afterMerge = (await admin('GET', `/state?as=${human}`)).data;
  check('merging operator names moves their messages', merge.data.merged?.[0] === oldName &&
    afterMerge.messages.some(m => m.body === 'sent from the phone' && m.from === human) && !afterMerge.peers.some(p => p.name === oldName), JSON.stringify(merge.data));
  const toAlias = await A2.call('send_message', { to: oldName, message: 'to the old name' });
  check('an agent writing to a merged name reaches the operator', toAlias.includes(`Sent to ${human}`), toAlias);
  if (!process.env.HUB_URL) {
    await admin('POST', '/me', { name: human });
    check('the hub keeps the operator name for this sign-in', (await admin('GET', '/me')).data.name === human);
  }
  const state = await admin('GET', `/state?as=${human}`);
  check('admin state lists peers, messages, devices',
    state.data.peers?.some(p => p.kind === 'human') && state.data.messages?.some(m => m.body === 'all good') && state.data.devices?.length >= 2,
    JSON.stringify(state.data).slice(0, 300));
  const remote = await admin('POST', '/listen', { name: `planner-${RUN}`, listen: 0 });
  check('console toggles listening', remote.data.listen_until === 0, JSON.stringify(remote));
  // Deleting a DM from the console hides it for that operator only, up to its newest message.
  const lastToHuman = Math.max(...state.data.messages.filter(m => m.to === human || m.from === human).map(m => m.id));
  await admin('POST', '/conversations/hide', { as: human, conv: `dm:planner-key-${RUN}`, before_id: lastToHuman });
  const hid = (await admin('GET', `/state?as=${human}`)).data;
  check('console: a deleted conversation is hidden for its operator only',
    hid.hidden?.[`dm:planner-key-${RUN}`] === lastToHuman && !Object.keys((await admin('GET', `/state?as=other-${RUN}`)).data.hidden ?? {}).length,
    JSON.stringify(hid.hidden));
  await admin('POST', '/peers/purge', { names: [`other-${RUN}`] });

  // Several recipients at once, and chats.
  // Machine tags: messages record where they came from; devices get friendly names.
  await A2.call('send_message', { to: `bob-${RUN}`, message: 'machine tag check' });
  const tagged = (await admin('GET', '/state')).data;
  const tagMsg = tagged.messages.find(m => m.body === 'machine tag check');
  const defaultLabel = { darwin: 'Mac', win32: 'Windows PC', linux: 'Linux' }[process.platform];
  check('message records the sending machine, with a default friendly name',
    tagMsg?.from_device === `mac-${RUN}` && tagged.device_labels?.[`mac-${RUN}`] === defaultLabel, JSON.stringify({ tagMsg, labels: tagged.device_labels }));
  await admin('POST', '/devices/label', { name: `mac-${RUN}`, label: 'Test MacBook' });
  check('agents see the machine name on messages', (await B.call('check_inbox')).includes('[Test MacBook]'));
  check('console uses the renamed machine label', (await admin('GET', '/state')).data.device_labels?.[`mac-${RUN}`] === 'Test MacBook');

  const multi = await A2.call('send_message', { to: `bob-${RUN}, ${human}`, message: 'to both of you' });
  check('message to several recipients', multi.includes(`bob-${RUN}`) && multi.includes(human), multi);
  await B.call('check_inbox');
  const chat = (await admin('POST', '/chats', { as: human, action: 'create', title: `design-${RUN}`, members: [`planner-${RUN}`, `bob-${RUN}`] })).data;
  check('console creates a group chat', chat.id && chat.members?.length === 3, JSON.stringify(chat));
  const posted = await B.call('send_message', { chat: chat.id, message: 'chat hello' });
  check('agent posts in a chat (to all other members)', posted.includes(`chat #${chat.id}`) && posted.includes(`planner-${RUN}`) && posted.includes(human), posted);
  const chatIn = await A2.call('check_inbox');
  const chatMsgId = Number(chatIn.match(/#(\d+) from bob/)?.[1]);
  check('chat message shows its chat', chatIn.includes(`in chat #${chat.id}`) && chatMsgId > 0, chatIn);
  const chatReply = await A2.call('send_message', { reply_to: chatMsgId, message: 'reply in chat' });
  check('reply without "to" stays in the chat', chatReply.includes(`chat #${chat.id}`) && chatReply.includes(`bob-${RUN}`), chatReply);
  const bobIn = await B.call('check_inbox');
  const replyId = Number(bobIn.match(/#(\d+) from planner/)?.[1]);
  const oldStyle = await B.call('send_message', { to: `planner-${RUN}`, reply_to: replyId, message: 'old-client style reply' });
  check('reply naming a chat member stays in the chat (older clients)', oldStyle.includes(`chat #${chat.id}`) && oldStyle.includes(human), oldStyle);
  await A2.call('check_inbox');
  check('agent lists its chats', (await B.call('chats', { action: 'list' })).includes(`design-${RUN}`));
  const chatState = await admin('GET', '/state');
  check('console sees chat and its messages', chatState.data.chats?.some(c => c.id === chat.id) &&
    chatState.data.messages.filter(m => m.chat_id === chat.id && m.body === 'chat hello').length === 2, JSON.stringify(chatState.data.chats));
  const mention = await admin('POST', '/send', { from: human, chat: chat.id, to: [`bob-${RUN}`], message: `@bob-${RUN} just you` });
  check('a mention in a chat reaches every member', mention.status === 200 &&
    [`bob-${RUN}`, `planner-${RUN}`].every(n => mention.data.delivered_to.includes(n)) && mention.data.chat?.id === chat.id, JSON.stringify(mention.data));
  const plannerStatus = await fetch(`${HUB}/api/heartbeat`, {
    method: 'POST', headers: { authorization: `Bearer ${devA.data.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: claudeSession }),
  }).then(r => r.json());
  check('FYI mail does not count as mail that wakes an agent', plannerStatus.unread >= 1 && plannerStatus.urgent === 0, JSON.stringify(plannerStatus));
  const plannerFyi = await A2.call('check_inbox');
  check('untagged members get it as FYI (no wake-up), the tagged one as a message', plannerFyi.includes('FYI: group messages addressed to others') &&
    plannerFyi.includes('just you'), plannerFyi);
  const notMember = await admin('POST', '/send', { from: human, chat: chat.id, to: [`nobody-${RUN}`], message: 'hi' });
  check('mentioning someone outside the chat is refused', notMember.status === 400 && notMember.data.error.includes('not in this chat'), JSON.stringify(notMember));
  await B.call('check_inbox');
  await B.call('check_inbox');


  // ---- Projects ----
  const proj = `proj-${RUN}`;
  const nope = await A2.call('project', { action: 'join', project: proj });
  check('joining a missing project fails with a hint', nope.startsWith('ERROR') && nope.includes('create'), nope);
  const created = await A2.call('project', { action: 'create', project: proj, description: 'e2e project' });
  check('create + join project', created.includes(`Project "${proj}"`) && created.includes('(you)'), created);
  const bJoin = await B.call('project', { action: 'join', project: proj });
  check('second agent joins (both members)', bJoin.includes(`planner-${RUN}`) && bJoin.includes(`bob-${RUN}`), bJoin);

  // A project-folder default auto-joins; an outsider agent is not in the project.
  const projDir = path.join(TMP, 'proj-folder');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, '.agent-bridge.json'), JSON.stringify({ project: proj }));
  const C = await agent({ env: envA, client: 'claude-code', sessionId: `c-${RUN}`, name: `carol-${RUN}`, cwd: projDir });
  check('project file auto-joins', C.init.result.instructions.includes(`project "${proj}"`), C.init.result.instructions.slice(0, 400));
  const D = await agent({ env: envA, client: 'claude-code', sessionId: `d-${RUN}`, name: `dave-${RUN}` });
  const bcast = await A2.call('send_message', { to: '*', message: 'project-only broadcast' });
  const outsider = await D.call('send_message', { chat: chat.id, message: 'let me in' });
  check('non-members cannot post in a chat', outsider.startsWith('ERROR') && outsider.includes('not a member'), outsider);
  check('broadcast stays inside the project (agents only)',
    bcast.includes(`bob-${RUN}`) && bcast.includes(`carol-${RUN}`) && !bcast.includes(`dave-${RUN}`) && !bcast.includes(human), bcast);

  // Docs with optimistic concurrency.
  check('doc write', (await A2.call('docs', { action: 'write', path: 'plan.md', content: '# Plan\n- step 1' })).includes('version 1'));
  await B.call('docs', { action: 'append', path: 'plan.md', content: '- step 2 (bob)' });
  const stale = await A2.call('docs', { action: 'write', path: 'plan.md', content: 'overwrite', expected_version: 1 });
  check('stale doc write rejected', stale.startsWith('ERROR') && stale.includes('version 2'), stale);
  const doc = await C.call('docs', { action: 'read', path: 'plan.md' });
  check('doc read shows both edits', doc.includes('step 1') && doc.includes('step 2 (bob)') && doc.includes('version 2'), doc);

  // Tasks: assignment notifies, claims are exclusive, done notifies the creator.
  await B.call('check_inbox');
  const task = await A2.call('tasks', { action: 'create', title: 'Fix loader', body: 'See plan.md', assignee: `bob-${RUN}` });
  const taskId = Number(task.match(/#(\d+)/)?.[1]);
  check('task created', taskId > 0 && task.includes(`bob-${RUN}`), task);
  const notice = await B.call('check_inbox');
  check('assignee notified', notice.includes('from agent-bridge') && notice.includes('Fix loader'), notice);
  const steal = await C.call('tasks', { action: 'claim', id: taskId });
  check('claim of an assigned task refused', steal.startsWith('ERROR'), steal);
  await A2.call('check_inbox');
  await B.call('tasks', { action: 'update', id: taskId, status: 'done', note: 'fixed in abc123' });
  const doneNote = await A2.call('check_inbox');
  check('creator notified when done', doneNote.includes('marked done') && doneNote.includes('abc123'), doneNote);
  const taskView = await A2.call('tasks', { action: 'get', id: taskId });
  check('task notes recorded', taskView.includes('[done]') && taskView.includes('fixed in abc123'), taskView);

  // Key-value.
  await B.call('kv', { action: 'set', key: 'release', value: '1.4.2' });
  check('kv get', (await C.call('kv', { action: 'get', key: 'release' })).includes('release = 1.4.2'));

  // Files (2.5 MB spans three 1 MB chunks).
  const big = Buffer.alloc(2.5 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) % 251;
  const src = path.join(TMP, 'build.bin');
  fs.writeFileSync(src, big);
  const up = await B.call('files', { action: 'upload', local_path: src, path: 'builds/build.bin' });
  check('file upload', up.includes(`${big.length} bytes`), up);
  const dest = path.join(TMP, 'downloaded.bin');
  const down = await C.call('files', { action: 'download', path: 'builds/build.bin', local_path: dest });
  check('file download round-trips bytes', fs.existsSync(dest) && Buffer.compare(fs.readFileSync(dest), big) === 0, down);

  // A project joined with the tool is remembered for the session across an MCP restart.
  await D.call('project', { action: 'join', project: proj });
  await D.stop();
  const D2 = await agent({ env: envA, client: 'claude-code', sessionId: `d-${RUN}`, name: `dave-${RUN}` });
  check('project remembered for the session', D2.init.result.instructions.includes(`project "${proj}"`), D2.init.result.instructions.slice(0, 300));

  // A new project: nobody is in it yet; @mentioned agents get the message (an invite), and an empty send fails visibly.
  await admin('POST', '/project', { action: 'create', name: `empty-${RUN}`, as: human });
  const nobody = await admin('POST', '/send', { from: human, to: ['*'], project: `empty-${RUN}`, message: 'anyone?' });
  check('a project message to nobody fails instead of vanishing', nobody.status === 400 && /nobody is in project/.test(nobody.data.error), JSON.stringify(nobody));
  const invite = await admin('POST', '/send', { from: human, to: ['*'], project: `empty-${RUN}`, mentions: [`bob-${RUN}`], message: 'please join this project' });
  check('agents @mentioned in a project they are not in still get it', invite.status === 200 && invite.data.recipient_status?.some(s => s.name === `bob-${RUN}`)
    && (await B.call('check_inbox')).includes(`in project "empty-${RUN}"`), JSON.stringify(invite.data));
  const added = await admin('POST', '/project', { action: 'add', project: `empty-${RUN}`, name: `bob-${RUN}`, as: human });
  const ovAdded = (await admin('POST', '/project', { action: 'overview', project: `empty-${RUN}`, as: human })).data;
  check('the operator adds an agent to a project, and it is told', added.status === 200 && ovAdded.members?.some(m => m.name === `bob-${RUN}`)
    && (await B.call('check_inbox')).includes(`added you to project`), JSON.stringify(added.data));
  await admin('POST', '/project', { action: 'remove', project: `empty-${RUN}`, name: `bob-${RUN}`, as: human });
  await B.call('check_inbox');
  check('and takes it out again', !(await admin('POST', '/project', { action: 'overview', project: `empty-${RUN}`, as: human })).data.members?.some(m => m.name === `bob-${RUN}`));
  if (added.data.previous) await admin('POST', '/project', { action: 'add', project: added.data.previous, name: `bob-${RUN}`, as: human });
  await B.call('check_inbox');
  await admin('POST', '/project', { action: 'delete', project: `empty-${RUN}`, as: human });

  // Console view of the project.
  await D2.call('send_message', { to: human, message: 'a private note from a project member' });
  const ov = await admin('POST', '/project', { action: 'overview', project: proj, as: human });
  check("a project member's direct message stays out of the project chat", !ov.data.messages?.some(m => m.body === 'a private note from a project member'));
  const projMsg = ov.data.messages?.find(m => m.body === 'project-only broadcast');
  await D2.call('send_message', { to: human, reply_to: projMsg?.id, message: 'answering in the project' });
  const ov2 = await admin('POST', '/project', { action: 'overview', project: proj, as: human });
  check('a reply to a project message stays in the project chat', ov2.data.messages?.some(m => m.body === 'answering in the project' && m.to === human), JSON.stringify(projMsg));
  check('the reply is not in the DMs', !(await admin('GET', `/state?as=${human}`)).data.messages?.some(m => m.body === 'answering in the project' && !m.project));
  check('console project overview',
    ov.data.members?.length >= 3 && ov.data.docs?.some(d => d.path === 'plan.md') && ov.data.files?.some(f => f.path === 'builds/build.bin') &&
    ov.data.kv?.some(k => k.key === 'release') && ov.data.messages?.some(m => m.body === 'project-only broadcast') && ov.data.events?.length > 5,
    JSON.stringify(ov.data).slice(0, 400));
  const projectPost = await admin('POST', '/send', { from: human, to: ['*'], project: proj, message: 'hello project' });
  check('console project chat reaches every member', [`planner-${RUN}`, `bob-${RUN}`, `carol-${RUN}`].every(n => projectPost.data.delivered_to?.includes(n)),
    JSON.stringify(projectPost.data.delivered_to));
  const projectMention = await admin('POST', '/send', { from: human, to: ['*'], project: proj, mentions: [`carol-${RUN}`], message: `@carol-${RUN} over to you` });
  const projectFeed = await admin('POST', '/project', { action: 'overview', project: proj, as: human });
  check('mention in a project reaches everyone in it, in the project chat',
    projectMention.data.delivered_to?.length >= 2 && projectMention.data.delivered_to.includes(`carol-${RUN}`) && projectFeed.data.messages?.some(m => m.body === `@carol-${RUN} over to you`),
    JSON.stringify(projectMention.data.delivered_to));

  const hdoc = await admin('POST', '/docs', { action: 'write', project: proj, path: 'from-console.md', content: 'hi', as: human });
  check('console writes docs as the operator', hdoc.data.version === 1, JSON.stringify(hdoc));
  const dl = await fetch(`${HUB}/admin/files/download?project=${proj}&path=builds/build.bin`, { headers: { authorization: `Bearer ${ADMIN}`, ...ACCESS_HEADERS } });
  check('console downloads files', dl.ok && (await dl.arrayBuffer()).byteLength === big.length);
  await Promise.all([C.stop(), D2.stop()]);
  const del = await admin('POST', '/project', { action: 'delete', project: proj });
  check('project deleted', del.data.deleted === proj, JSON.stringify(del));

  // ---- Pairing (one-time device approval) ----
  const pairStart = await (await fetch(`${HUB}/pair/start`, { method: 'POST', body: JSON.stringify({ device_name: `pair-${RUN}` }) })).json();
  check('pairing starts with a code', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pairStart.code || ''), JSON.stringify(pairStart));
  const pollOnce = async secret => (await fetch(`${HUB}/pair/poll`, { method: 'POST', body: JSON.stringify({ poll_secret: secret }) })).json();
  check('pairing pending until approved', (await pollOnce(pairStart.poll_secret)).status === 'pending');
  const pendingList = await admin('GET', '/state');
  check('console lists pending pairing', pendingList.data.pairings?.some(p => p.code === pairStart.code), JSON.stringify(pendingList.data.pairings));
  await admin('POST', '/pairings/approve', { code: pairStart.code });
  const approved = await pollOnce(pairStart.poll_secret);
  check('approved pairing delivers a device token', approved.status === 'approved' && approved.token && approved.device === `pair-${RUN}`, JSON.stringify(approved));
  check('token delivered only once', (await pollOnce(pairStart.poll_secret)).status === 'expired');
  const who = await (await fetch(`${HUB}/api/whoami`, { headers: { authorization: `Bearer ${approved.token}` } })).json();
  check('paired token works', who.device === `pair-${RUN}`, JSON.stringify(who));
  const denyStart = await (await fetch(`${HUB}/pair/start`, { method: 'POST', body: JSON.stringify({ device_name: 'nope' }) })).json();
  await admin('POST', '/pairings/deny', { code: denyStart.code });
  check('denied pairing reports denied', (await pollOnce(denyStart.poll_secret)).status === 'denied');

  // The agent-side flow: a fresh computer's MCP server pairs via the connect tool.
  const freshHome = path.join(TMP, 'fresh-computer');
  fs.mkdirSync(freshHome, { recursive: true });
  const freshEnv = { ...process.env, AGENT_BRIDGE_HOME: freshHome, AGENT_BRIDGE_URL: HUB, AGENT_BRIDGE_DEVICE: `fresh-${RUN}` };
  const F = await agent({ env: freshEnv, client: 'claude-code', sessionId: `f-${RUN}`, name: `fresh-${RUN}` });
  check('unpaired agent is told to connect', F.init.result.instructions.includes('not connected'), F.init.result.instructions.slice(0, 200));
  const blocked = await F.call('list_peers');
  check('tools explain how to connect', blocked.startsWith('ERROR') && blocked.includes('connect tool'), blocked);
  const connectMsg = await F.call('connect', { action: 'start' });
  const freshCode = connectMsg.match(/code ([A-Z2-9]{4}-[A-Z2-9]{4})/)?.[1];
  check('connect returns an approval code', Boolean(freshCode), connectMsg);
  await admin('POST', '/pairings/approve', { code: freshCode });
  await until(() => fs.existsSync(path.join(freshHome, 'config.json')), 15000); // the MCP server polls every 3s
  await sleep(1000);
  const afterPair = await F.call('list_peers');
  check('agent connected after approval', afterPair.includes(`fresh-${RUN}`) && !afterPair.startsWith('ERROR'), afterPair);
  const saved = JSON.parse(fs.readFileSync(path.join(freshHome, 'config.json'), 'utf8'));
  check('pairing saved config for other sessions', saved.token && saved.url === HUB && saved.device === `fresh-${RUN}`, JSON.stringify({ ...saved, token: saved.token ? '…' : null }));
  await F.stop();
  for (const name of [`pair-${RUN}`, `fresh-${RUN}`]) {
    await admin('POST', '/devices/revoke', { name });
    await admin('POST', '/devices/delete', { name });
  }

  // Console rename and remove.
  const E = await agent({ env: envA, client: 'claude-code', sessionId: `e-${RUN}`, name: `eve-${RUN}` });
  await A2.call('send_message', { to: `eve-${RUN}`, message: 'before rename' });
  await admin('POST', '/chats', { as: human, action: 'add', chat: chat.id, members: [`eve-${RUN}`] });
  const eveId = (await admin('GET', '/state')).data.peers.find(p => p.name === `eve-${RUN}`)?.id;
  const renamed = await admin('POST', '/peers/rename', { id: eveId, name: `evan-${RUN}` });
  check('console renames an agent', renamed.data.name === `evan-${RUN}`, JSON.stringify(renamed));
  check('renamed agent sees its new name and keeps unread mail',
    (await E.call('list_peers')).includes(`You are "evan-${RUN}"`) && (await E.call('check_inbox')).includes('before rename'));
  const chatAfter = (await admin('GET', '/state')).data.chats.find(c => c.id === chat.id);
  check('chat membership follows the rename', chatAfter?.members.includes(`evan-${RUN}`) && !chatAfter.members.includes(`eve-${RUN}`), JSON.stringify(chatAfter));
  await admin('POST', '/peers/remove', { id: eveId });
  const kicked = await E.call('list_peers');
  check('removed agent is told and stays out', kicked.startsWith('ERROR') && kicked.includes('removed'), kicked);
  check('removed agent does not re-register', !(await admin('GET', '/state')).data.peers.some(p => p.id === eveId));
  await E.stop();

  // Bridge Manager: revives offline sessions in its app; any agent in the app revives the Manager.
  const M = await agent({ env: envA, client: 'claude-code', sessionId: `mgr-sess-${RUN}`, name: `mgr-${RUN}` });
  const T = await agent({ env: { ...envA, CLAUDE_CODE_HOST_SESSION_ID: `local_sleeper_${RUN}` }, client: 'claude-code', sessionId: `sleeper-sess-${RUN}`, name: `sleeper-${RUN}` });
  const peerId = async n => (await admin('GET', '/state')).data.peers.find(p => p.name === n)?.id;
  await admin('POST', '/peers/role', { id: await peerId(`sleeper-${RUN}`), role: 'manager' });
  await admin('POST', '/peers/role', { id: await peerId(`mgr-${RUN}`), role: 'manager' });
  const roles = (await admin('GET', '/state')).data.peers.filter(p => [`mgr-${RUN}`, `sleeper-${RUN}`].includes(p.name)).map(p => [p.name, p.role]);
  check('one Bridge Manager per computer + account + app', JSON.stringify(Object.fromEntries(roles)) === JSON.stringify({ [`mgr-${RUN}`]: 'manager', [`sleeper-${RUN}`]: null }), JSON.stringify(roles));
  await T.stop(); // the session's app process is gone: offline
  await B.call('send_message', { to: `sleeper-${RUN}`, message: 'are you there?' });
  const reviveMsg = await until(async () => { const r = await M.call('check_inbox'); return r.includes('revive request') ? r : null; });
  check('mail for an offline session asks its Manager to revive it', reviveMsg?.includes(`local_sleeper_${RUN}`) && reviveMsg.includes(`"sleeper-${RUN}"`), reviveMsg);
  if (!process.env.HUB_URL) { // (the live hub has real agents named "Bridge Manager")
    // An agent named "Bridge Manager" is the Manager by default; the console hears who was asked to revive.
    await admin('POST', '/peers/role', { id: await peerId(`mgr-${RUN}`), role: null });
    const BM = await agent({ env: envA, client: 'claude-code', sessionId: `bm-sess-${RUN}`, name: 'Bridge Manager' });
    const T2 = await agent({ env: { ...envA, CLAUDE_CODE_HOST_SESSION_ID: `local_sleeper2_${RUN}` }, client: 'claude-code', sessionId: `sleeper2-sess-${RUN}`, name: `sleeper2-${RUN}` });
    await T2.stop();
    const sent = await admin('POST', '/send', { from: `martin-${RUN}`, to: [`sleeper2-${RUN}`], message: 'wake up' });
    check('an agent named Bridge Manager revives by default, and the console is told', sent.data.recipient_status?.[0]?.reviving === 'Bridge Manager'
      && (await BM.call('check_inbox')).includes(`local_sleeper2_${RUN}`), JSON.stringify(sent.data.recipient_status));
    await BM.stop();
    await admin('POST', '/peers/purge', { names: ['Bridge Manager', `sleeper2-${RUN}`] });
    await admin('POST', '/peers/role', { id: await peerId(`mgr-${RUN}`), role: 'manager' });
  }
  await B.call('send_message', { to: `sleeper-${RUN}`, message: 'still there?' });
  await sleep(1500);
  check('revive requests are not repeated within minutes', !(await M.call('check_inbox')).includes('revive request'));
  await M.stop();
  await B.call('send_message', { to: `mgr-${RUN}`, message: 'manager?' });
  const helperMsg = await until(async () => { const r = await A2.call('check_inbox'); return r.includes('revive request') ? r : null; });
  check('another agent in the app revives an offline Manager', helperMsg?.includes(`"mgr-${RUN}"`) && helperMsg.includes('Bridge Manager of your app is offline'), helperMsg);
  if (!process.env.HUB_URL) { // on the live hub this would ask the real Managers to update
    const upd = await admin('POST', '/managers/update', { version: 'abc1234' });
    check('update push reaches online Managers only', upd.status === 200 && Array.isArray(upd.data.asked) && !upd.data.asked.includes(`mgr-${RUN}`), JSON.stringify(upd.data));
  }

  // The same name on two computers: both show it; the second's address gets its computer.
  const W1 = await agent({ env: envA, client: 'claude-code', sessionId: `twin1-${RUN}`, name: `twin-${RUN}` });
  const W2 = await agent({ env: envB, client: 'claude-code', sessionId: `twin2-${RUN}`, name: `twin-${RUN}` });
  const twinsNow = (await admin('GET', '/state')).data.peers.filter(p => p.display_name === `twin-${RUN}`);
  const second = twinsNow.find(p => p.name !== `twin-${RUN}`);
  check('two agents can share a name on different computers', twinsNow.length === 2 && second?.name.startsWith(`twin-${RUN}@`), JSON.stringify(twinsNow.map(p => [p.name, p.display_name])));
  check('agents see the qualified address of a shared name', (await A2.call('list_peers')).includes(`twin-${RUN} [address: ${second?.name}]`));
  await A2.call('send_message', { to: second?.name, message: 'for the second twin' });
  check('the qualified address reaches the right agent', (await W2.call('check_inbox')).includes('for the second twin') && !(await W1.call('check_inbox')).includes('for the second twin'));
  const ambiguous = await A2.call('send_message', { to: `twin-${RUN}`, message: 'which one?' });
  check('a bare shared name is ambiguous (lists the full addresses)', ambiguous.startsWith('ERROR') && ambiguous.includes('ambiguous') && ambiguous.includes(`twin-${RUN}@`), ambiguous);
  const first = twinsNow.find(p => p.name === `twin-${RUN}`);
  const consoleExact = await admin('POST', '/send', { from: `martin-${RUN}`, to: [`twin-${RUN}`], message: 'console to the exact address' });
  check('the console reaches an exact address even when its name is shared', consoleExact.data.recipient_status?.[0]?.name === `twin-${RUN}`, JSON.stringify(consoleExact.data));
  await W1.call('check_inbox');
  const firstLabel = (await admin('GET', '/state')).data.device_labels?.[first?.device] || first?.device;
  const toFirst = await A2.call('send_message', { to: `TWIN-${RUN}@${firstLabel}`, message: 'for the first twin' });
  check('the confirmation names the twin by its full address', toFirst.includes(`twin-${RUN}@${firstLabel}`), toFirst);
  check('the first twin answers to Name@computer too', (await W1.call('check_inbox')).includes('for the first twin'));
  await A2.call('send_message', { to: `twin-${RUN}@${first?.device}`, message: 'by computer id' });
  check('Name@computer-id works', (await W1.call('check_inbox')).includes('by computer id'));
  await admin('POST', '/peers/rename', { id: second?.id, name: `twin-${RUN}` });
  check('renaming to a taken name keeps the display name', (await admin('GET', '/state')).data.peers.find(p => p.id === second?.id)?.display_name === `twin-${RUN}`);
  await Promise.all([W1.stop(), W2.stop()]);
  await admin('POST', '/peers/purge', { names: twinsNow.map(p => p.name) });

  // An agent whose app is closed keeps its name and chats: another agent taking the same name gets
  // a qualified address instead of inheriting them.
  const K1 = await agent({ env: envA, client: 'claude-code', sessionId: `keep1-${RUN}`, name: `keeper-${RUN}` });
  const keepChat = (await admin('POST', '/chats', { as: human, action: 'create', title: `keep-${RUN}`, members: [`keeper-${RUN}`] })).data;
  await K1.stop(); // app closed: offline, session kept
  const K2 = await agent({ env: envB, client: 'claude-code', sessionId: `keep2-${RUN}`, name: `other-${RUN}` });
  await K2.call('set_profile', { name: `keeper-${RUN}` });
  const k2name = (await admin('GET', '/state')).data.peers.find(p => p.display_name === `keeper-${RUN}` && p.online)?.name;
  check('an offline agent keeps its name (the newcomer is qualified)', k2name && k2name !== `keeper-${RUN}` && k2name.startsWith(`keeper-${RUN}@`), k2name);
  const members = (await admin('GET', '/state')).data.chats.find(c => c.id === keepChat.id)?.members ?? [];
  check('and keeps its chat memberships', members.includes(`keeper-${RUN}`) && !members.includes(k2name), JSON.stringify(members));
  const K1b = await agent({ env: envA, client: 'claude-code', sessionId: `keep1-${RUN}`, name: `whatever-${RUN}` });
  await admin('POST', '/send', { from: human, chat: keepChat.id, message: 'still yours' });
  check('when it comes back, the chat still reaches it', (await K1b.call('check_inbox')).includes('still yours'));
  await Promise.all([K1b.stop(), K2.stop()]);
  await admin('POST', '/chats', { as: human, action: 'delete', chat: keepChat.id });
  await admin('POST', '/peers/purge', { names: [`keeper-${RUN}`, k2name, `other-${RUN}`, `whatever-${RUN}`].filter(Boolean) });

  // Codex desktop app: many chats' agent-bridge servers share one parent process, so a chat is linked
  // to its server by an agent-bridge tool call (tool + argument fingerprint), never by guessing.
  const devC = await admin('POST', '/devices', { name: `codexapp-${RUN}` });
  const envC = deviceEnv(`codexapp-${RUN}`, devC.data.token);
  const C1 = await agent({ env: envC, client: 'codex-mcp-client', name: `chat1-${RUN}` });
  const C2 = await agent({ env: envC, client: 'codex-mcp-client', name: `chat2-${RUN}` });
  const chatEvt = (sid, extra) => ({ session_id: sid, turn_id: 't1', cwd: TMP, ...extra });
  const s1 = `codexchat1-${RUN}`, s2 = `codexchat2-${RUN}`;
  await hook(envC, chatEvt(s1, { hook_event_name: 'UserPromptSubmit' }));
  const hb = sid => fetch(`${HUB}/api/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${devC.data.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid }) });
  check('Codex app: an ambiguous process match links nothing', (await hb(s1)).status === 404);
  check('Codex app: unlinked servers stay hidden', !(await admin('GET', '/state')).data.peers.some(p => [`chat1-${RUN}`, `chat2-${RUN}`].includes(p.name)));
  await C1.call('list_peers', {});
  await C2.call('list_peers', {});
  await hook(envC, chatEvt(s2, { hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-bridge__list_peers', tool_input: {} }));
  check('Codex app: identical calls from two chats are refused, not guessed', (await hb(s2)).status === 404);
  const args1 = { to: `bob-${RUN}`, message: `hello from chat one ${RUN}` };
  await C1.call('send_message', args1);
  await hook(envC, chatEvt(s1, { hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-bridge__send_message', tool_input: { message: args1.message, to: args1.to } }));
  const linked = await (await hb(s1)).json();
  check('Codex app: a distinct tool call links the chat to its server', linked.name === `chat1-${RUN}`, JSON.stringify(linked));
  await B.call('send_message', { to: `chat1-${RUN}`, message: 'for codex chat one' });
  const delivered = await hook(envC, chatEvt(s1, { hook_event_name: 'UserPromptSubmit' }));
  check('Codex app: the linked chat gets its mail through hooks', delivered.out?.hookSpecificOutput?.additionalContext?.includes('for codex chat one'), JSON.stringify(delivered).slice(0, 300));
  // Codex Desktop's code mode: the hook sees an "exec" tool whose code calls the bridge tool, and
  // names the conversation thread_id.
  const args2 = { to: `bob-${RUN}`, message: `from chat two via code ${RUN}` };
  await C2.call('send_message', args2);
  await hook(envC, { thread_id: s2, turn_id: 't2', cwd: TMP, hook_event_name: 'PostToolUse', tool_name: 'exec',
    tool_input: { input: `const r = await tools.mcp__agent_bridge__send_message({message: "${args2.message}", to: "${args2.to}"});\nconsole.log(r);` } });
  const linked2 = await (await hb(s2)).json();
  check('Codex app: code-mode calls (exec) link the chat too', linked2.name === `chat2-${RUN}`, JSON.stringify(linked2));

  // Codex plugin: its hooks (type mcp_tool) call session_event on the exact server serving the chat.
  const C4 = await agent({ env: envC, client: 'codex-mcp-client', name: `chat4-${RUN}` });
  const s4 = `codexchat4-${RUN}`;
  check('session_event is listed for Codex only', (await C4.tools()).includes('session_event') && !(await A2.tools()).includes('session_event')
    && (await A2.call('session_event', { hook_event_name: 'Stop', session_id: 'x' })).includes('Unknown tool'));
  await C4.call('session_event', { hook_event_name: 'Stop', session_id: `helper-${RUN}`, turn_id: 'h1' });
  check('Codex plugin: helper threads (no user prompt) link nothing', (await hb(`helper-${RUN}`)).status === 404);
  await C4.call('session_event', { hook_event_name: 'UserPromptSubmit', session_id: `helper-${RUN}`, turn_id: 'h2', transcript_path: null, model: 'mini' });
  check('Codex plugin: ephemeral helper prompts (no transcript) link nothing', (await hb(`helper-${RUN}`)).status === 404);
  const tp4 = path.join(TMP, 'rollout-chat4.jsonl');
  await C4.call('session_event', { hook_event_name: 'UserPromptSubmit', session_id: s4, turn_id: 't0', transcript_path: tp4, model: 'gpt' });
  check('Codex plugin: a user prompt links the chat exactly', (await (await hb(s4)).json()).name === `chat4-${RUN}`);
  await C4.call('session_event', { hook_event_name: 'Stop', session_id: `helper-${RUN}`, turn_id: 'h3' });
  await C4.call('session_event', { hook_event_name: 'UserPromptSubmit', session_id: `helper-${RUN}`, turn_id: 'h4', transcript_path: 'null', model: 'mini' });
  check('Codex plugin: helper threads never take over a linked chat', (await hb(`helper-${RUN}`)).status === 404 && (await (await hb(s4)).json()).name === `chat4-${RUN}`);
  await B.call('send_message', { to: `chat4-${RUN}`, message: 'mail for the plugin chat' });
  const ups4 = JSON.parse(await C4.call('session_event', { hook_event_name: 'UserPromptSubmit', session_id: s4, turn_id: 't1', transcript_path: tp4, model: 'gpt' }) || '{}');
  check('Codex plugin: a new turn gets the mail as context', ups4.hookSpecificOutput?.additionalContext?.includes('mail for the plugin chat'), JSON.stringify(ups4).slice(0, 300));
  await B.call('send_message', { to: `chat4-${RUN}`, message: 'wake the plugin chat' });
  const stop4 = JSON.parse(await C4.call('session_event', { hook_event_name: 'Stop', session_id: s4, turn_id: 't1' }) || '{}');
  check('Codex plugin: a turn end resumes the agent for its mail', stop4.decision === 'block' && stop4.reason.includes('wake the plugin chat'), JSON.stringify(stop4).slice(0, 300));
  await C4.stop();
  await admin('POST', '/peers/purge', { names: [`chat4-${RUN}`] });

  // Real Codex thread ids are UUIDv7: a chat has a transcript file under CODEX_HOME/sessions/<local day>/,
  // helper threads have none. A new chat's file can appear later in its first turn.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-codexhome-'));
  const v7 = () => { const h = Date.now().toString(16).padStart(12, '0') + '7' + crypto.randomBytes(10).toString('hex').slice(0, 19);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
  const rollout = id => { const d = new Date(); const dir = path.join(codexHome, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `rollout-x-${id}.jsonl`), '{}\n'); };
  const C5 = await agent({ env: { ...envC, CODEX_HOME: codexHome }, client: 'codex-mcp-client', name: `chat5-${RUN}` });
  const helper5 = v7(), chat5 = v7();
  await C5.call('session_event', { hook_event_name: 'UserPromptSubmit', session_id: helper5, turn_id: 'a' });
  await C5.call('session_event', { hook_event_name: 'Stop', session_id: helper5, turn_id: 'a' });
  check('Codex plugin: a helper thread (no transcript file) never links', (await hb(helper5)).status === 404);
  await C5.call('session_event', { hook_event_name: 'UserPromptSubmit', session_id: chat5, turn_id: 'b' });
  const early5 = (await hb(chat5)).status;
  rollout(chat5);
  await C5.call('session_event', { hook_event_name: 'Stop', session_id: chat5, turn_id: 'b' });
  check('Codex plugin: a new chat links once its transcript file exists', early5 === 404 && (await (await hb(chat5)).json()).name === `chat5-${RUN}`);
  await C5.stop();
  await admin('POST', '/peers/purge', { names: [`chat5-${RUN}`] });
  fs.rmSync(codexHome, { recursive: true, force: true });

  // The app restarts: a new server process; the chat keeps its name and its waiting mail.
  await admin('POST', '/peers/rename', { id: (await admin('GET', '/state')).data.peers.find(p => p.name === `chat1-${RUN}`)?.id, name: `renamed-${RUN}` });
  await C1.stop();
  await B.call('send_message', { to: `renamed-${RUN}`, message: 'sent while the app restarted' });
  const C3 = await agent({ env: envC, client: 'codex-mcp-client', name: `fresh3-${RUN}` });
  const args3 = { message: `back ${RUN}`, to: `bob-${RUN}` };
  await C3.call('send_message', args3);
  await hook(envC, chatEvt(s1, { hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-bridge__send_message', tool_input: args3 }));
  const after3 = await (await hb(s1)).json();
  const mail3 = await C3.call('check_inbox');
  check('Codex app: after a restart the chat keeps its name and waiting mail', after3.name === `renamed-${RUN}` && mail3.includes('sent while the app restarted'), JSON.stringify(after3) + mail3.slice(0, 200));
  await Promise.all([C2.stop(), C3.stop()]);
  await admin('POST', '/peers/purge', { names: [`chat1-${RUN}`, `chat2-${RUN}`, `renamed-${RUN}`, `fresh3-${RUN}`] });
  await admin('POST', '/devices/revoke', { name: `codexapp-${RUN}` });
  await admin('POST', '/devices/delete', { name: `codexapp-${RUN}` });

  // Revocation.
  await admin('POST', '/devices/revoke', { name: `win-${RUN}` });
  const revoked = await fetch(`${HUB}/api/peers`, { headers: { authorization: `Bearer ${devB.data.token}` } });
  check('revoked token rejected', revoked.status === 401);
  const dup = await admin('POST', '/devices', { name: `mac-${RUN}` });
  check('cannot silently re-issue an active device', dup.status === 409);

  await Promise.all([A2.stop(), B.stop()]);
  check('active device cannot be deleted', (await admin('POST', '/devices/delete', { name: `mac-${RUN}` })).status === 409);
  for (const name of [`mac-${RUN}`, `win-${RUN}`]) {
    await admin('POST', '/devices/revoke', { name });
    await admin('POST', '/devices/delete', { name });
  }
  // Remove every test identity and its messages/chats from the hub.
  await admin('POST', '/peers/purge', { names: ['alice', 'bob', 'carol', 'dave', 'planner', 'fresh', 'eve', 'evan', 'xena', 'some-default', 'mgr', 'sleeper', 'deflisten'].map(n => `${n}-${RUN}`).concat(human) });
  for (const a of (await admin('GET', '/state')).data.accounts ?? []) {
    if (String(a.email).endsWith(`${RUN}@example.test`)) await admin('POST', '/accounts/delete', { id: a.id });
  }
  const after = await admin('GET', '/state');
  check('test devices, identities, messages and chats cleaned up',
    !after.data.devices.some(d => d.name.endsWith(RUN)) && !after.data.peers.some(p => p.name.endsWith(RUN)) &&
    !after.data.messages.some(m => m.from.endsWith(RUN) || m.to.endsWith(RUN)) && !after.data.chats.some(c => c.title.endsWith(RUN)),
    JSON.stringify(after.data.chats));
} catch (err) {
  check('test run', false, err.stack);
  // A crashed run against a real hub must not leave its test agents, devices and accounts behind.
  if (!broker) {
    try {
      const st = (await admin('GET', '/state')).data;
      const mine = n => String(n).endsWith(`-${RUN}`);
      await admin('POST', '/peers/purge', { names: [...new Set([...st.peers.map(p => p.name), ...st.messages.flatMap(m => [m.from, m.to])].filter(mine))] });
      for (const d of st.devices.filter(d => mine(d.name))) {
        await admin('POST', '/devices/revoke', { name: d.name });
        await admin('POST', '/devices/delete', { name: d.name });
      }
      for (const a of st.accounts ?? []) if (String(a.email).endsWith(`${RUN}@example.test`)) await admin('POST', '/accounts/delete', { id: a.id });
      console.log('(cleaned up this run\'s test data on the hub)');
    } catch { /* best effort */ }
  }
} finally {
  broker?.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);

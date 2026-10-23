#!/usr/bin/env node
// agent-bridge hook for Claude Code and Codex (same hook JSON protocol):
//   UserPromptSubmit  inject unread messages as context; reset the auto-resume counter
//   PostToolUse       inject messages that arrived while the agent was working
//   Stop              if mail is already waiting, resume the agent with it
//   Stop --listen     (Claude Code, registered with asyncRewake) background listener: the turn
//                     ends normally and the session is idle (the user can type), while this
//                     waits for mail; when some arrives it exits 2, which wakes the agent.
//   SessionStart --listen  the same at startup/resume, so a session listens again after an app
//                     restart without needing a prompt first.
//   Codex has no background-rewake hooks, so its Stop hook holds the turn open while listening.
//   PermissionRequest (Claude Code) remote approvals: forward the permission prompt to the
//                     operator's console and wait for Allow/Deny; with no answer in time, the
//                     normal prompt shows. By default only in turns a bridge message started.
// Exits silently whenever the session isn't on the bridge or the hub is unreachable.
//
// Env: AGENT_BRIDGE_KEEPALIVE_MINUTES  default 30 (Codex): longest a Stop hook holds the turn
//      before giving a listening agent a short "still listening" turn.
//      AGENT_BRIDGE_APPROVAL_MINUTES  default 10: how long a forwarded permission prompt waits.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, loadConfig, localAdminToken, createApi, takeInbox, formatMessages, parentPid, findOwner, processAlive, processStarted, PEER_NOTE, LISTEN_ALWAYS, argsFingerprint, resumeNote, capMessage, crumb, awaitingNote } from './lib.mjs';


crumb(`start ${process.argv.slice(2).join(' ') || '-'} node ${process.version}`);

const KEEPALIVE_MS = Number(process.env.AGENT_BRIDGE_KEEPALIVE_MINUTES || 30) * 60_000;
const LISTENER = process.argv.includes('--listen');
const STARTUP_GRACE_MS = Number(process.env.AGENT_BRIDGE_STARTUP_GRACE_MS ?? 90_000); // see the 409 handling
const QUIET_LIMIT_MS = 24 * 3_600_000; // a session silent this long (agent process still there) is given up
const KEEP_AWAKE_MS = Number(process.env.AGENT_BRIDGE_KEEP_AWAKE_MS ?? 25 * 60_000); // under the app's 30-minute idle timeout
const cfg = loadConfig();
if (!cfg.paired) { crumb(`not connected (no device token readable in ${HOME})`); process.exit(0); } // this computer hasn't been connected yet
if (!cfg.token && cfg.local) cfg.token = localAdminToken();
const api = createApi(cfg);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BIND_RETRY_MS = 120_000;
const APPROVAL_WAIT_MS = Number(process.env.AGENT_BRIDGE_APPROVAL_MINUTES || 10) * 60_000;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

// Exit only after the output is flushed (pipe writes are asynchronous on macOS).
function finish(stream, text, code) {
  stream.write(text, () => process.exit(code));
  return new Promise(() => {}); // never resolves: the process exits in the write callback
}

function emit(obj) {
  return finish(process.stdout, JSON.stringify(obj), 0);
}

// Find this session's peer. Claude Code peers register with their session id; Codex peers are
// bound on first use by matching the agent process (our parent or grandparent).
async function status(input, activity) {
  const who = { session_id: input.session_id };
  try {
    return await api('POST', '/heartbeat', activity ? { ...who, activity } : who);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const call = input.hook_event_name === 'PostToolUse' ? bridgeCall(input) : null;
  const bridgeTool = Boolean(call);
  // Sessions without the bridge would otherwise retry binding on every tool call (an agent-bridge
  // tool call is always worth a try: it can link the session by the call itself).
  const missFile = path.join(HOME, 'unbound', String(input.session_id).replace(/[^\w-]/g, ''));
  if (!bridgeTool) {
    try { if (Date.now() - fs.statSync(missFile).mtimeMs < BIND_RETRY_MS) throw Object.assign(new Error('unbound'), { status: 404 }); }
    catch (err) { if (err.status) throw err; }
  }
  // The agent process is our parent (Codex CLI), or further up (shell wrappers, desktop apps).
  const pids = [process.ppid];
  for (let i = 0; i < (process.platform === 'win32' ? 1 : 5); i++) {
    const up = parentPid(pids[pids.length - 1]);
    if (!up || up <= 1 || pids.includes(up)) break;
    pids.push(up);
  }
  try {
    // Agent processes report their real folder path; resolve symlinks (e.g. /var → /private/var) to match.
    let cwd = input.cwd;
    try { cwd = fs.realpathSync(input.cwd); } catch { /* keep as given */ }
    const st = await api('POST', '/bind', {
      ...who, pids, cwd, kind: input.turn_id ? 'codex' : 'claude',
      ...(call ? { tool_name: call.tool, ...(call.args !== undefined ? { tool_args: argsFingerprint(call.args) } : {}) } : {}),
    });
    trace(input.session_id, `bound session to "${st.name}"${call ? ` (via ${call.tool})` : ''}`);
    return st;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  trace(input.session_id, `no unique agent for this session yet (${input.hook_event_name}${call ? `, ${call.tool}` : input.tool_name ? `, ${input.tool_name}` : ''})`);
  fs.mkdirSync(path.dirname(missFile), { recursive: true });
  fs.writeFileSync(missFile, '');
  throw Object.assign(new Error('session not on the bridge'), { status: 404 });
}

// One background listener per session: the newest (latest turn end) wins; a user prompt
// retires it (the next turn end starts a fresh one).
const lockFile = sessionId => path.join(HOME, 'listeners', `${String(sessionId).replace(/[^\w-]/g, '')}.lock`);
const LISTENER_TOKEN = `${process.pid}-${Date.now()}`;
const ownsLock = sessionId => { try { return fs.readFileSync(lockFile(sessionId), 'utf8') === LISTENER_TOKEN; } catch { return false; } };

// Mail a background listener handed to a wake-up stays leased (not delivered) until the woken
// turn's first hook confirms it here; if the wake never happens, the lease runs out and the
// mail is delivered again with the next prompt instead of being lost.
const handedFile = sessionId => path.join(HOME, 'listeners', `${String(sessionId).replace(/[^\w-]/g, '')}.handed`);
async function confirmHanded(who, sessionId) {
  let ids;
  try { ids = JSON.parse(fs.readFileSync(handedFile(sessionId), 'utf8')); } catch { return; }
  await api('POST', '/ack', { ...who, ids }).catch(() => {});
  fs.rmSync(handedFile(sessionId), { force: true });
  trace(sessionId, `woken turn confirmed ${ids.map(i => `#${i}`).join(', ')}`);
}

// Marks a session whose current turn was started by a bridge message (not its user), so
// permission prompts in it go to the operator's console. A real user prompt clears it.
const wokenFile = sessionId => path.join(HOME, 'listeners', `${String(sessionId).replace(/[^\w-]/g, '')}.woken`);
const markWoken = sessionId => { try { fs.mkdirSync(path.dirname(wokenFile(sessionId)), { recursive: true }); fs.writeFileSync(wokenFile(sessionId), ''); } catch {} };

// The agent-bridge call a tool use made, if any: direct (Claude: mcp__plugin_agent-bridge_…__send_message,
// Codex: mcp__agent_bridge__send_message), or inside Codex's code mode, where the tool is "exec" and its
// input is code like `tools.mcp__agent_bridge__connect({action: "status"})`. Returns { tool, args? }.
const BRIDGE_TOOL = /agent[-_]bridge(?:_agent[-_]bridge)?__([A-Za-z_]+)/;
function bridgeCall(input) {
  const direct = String(input.tool_name || '').match(BRIDGE_TOOL);
  if (direct) return { tool: direct[1], args: input.tool_input ?? {} };
  const strings = [];
  (function collect(v) { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect); })(input.tool_input);
  for (const text of strings) {
    const calls = [...text.matchAll(new RegExp(`${BRIDGE_TOOL.source}\\s*\\(`, 'g'))];
    const last = calls[calls.length - 1];
    if (!last) continue;
    return { tool: last[1], args: looseArgs(text.slice(last.index + last[0].length)) };
  }
  return null;
}

// The argument object of a call in code: `{action: "status"}` → { action: 'status' } (undefined if unreadable).
function looseArgs(rest) {
  let depth = 0, quote = null, end = -1;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { if (depth === 0) { end = i; break; } depth--; }
  }
  const src = (end < 0 ? '' : rest.slice(0, end)).trim();
  if (!src) return {};
  try { return JSON.parse(src); } catch { /* JS object literal */ }
  try {
    return JSON.parse(src.replace(/'([^'\\]*)'/g, '"$1"').replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/,\s*([}\]])/g, '$1'));
  } catch { return undefined; }
}

// Live status for the console: what the agent is doing, in a few words. Commands are shortened
// and anything that looks like a token is masked.
const mask = s => String(s || '').replace(/[A-Za-z0-9_\-+/=]{28,}/g, '…').replace(/\s+/g, ' ').trim();
function activityOf(name, input = {}) {
  const file = input.file_path || input.notebook_path || input.path;
  const what = name === 'Bash' ? mask(input.command).slice(0, 80)
    : file ? path.basename(String(file))
    : input.url ? (() => { try { return new URL(input.url).host; } catch { return ''; } })()
    : input.pattern ? mask(input.pattern).slice(0, 60)
    : mask(input.description).slice(0, 80);
  const tool = String(name || 'tool').replace(/^mcp__(plugin_)?/, '').replace(/_/g, ' ');
  return { state: 'working', detail: what ? `${tool} · ${what}` : tool };
}

// A short, readable line for the console, plus the full request.
function describeTool(name, input = {}) {
  const summary = name === 'Bash' ? input.command
    : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'].includes(name) ? input.file_path || input.notebook_path
    : name === 'WebFetch' ? input.url
    : input.description || input.command || input.url || input.path || '';
  return { summary: String(summary || '').slice(0, 2000), detail: JSON.stringify(input, null, 2).slice(0, 20_000) };
}

// Whether prompts go to the console: approvals 'always', or 'away' in a turn agent-bridge started
// (the user is probably not at the keyboard); never with 'off'.
async function remoteWanted(input) {
  const st = await status(input);
  const woken = fs.existsSync(wokenFile(input.session_id));
  return st.approvals !== 'off' && (st.approvals === 'always' || woken);
}

// Ask the console and wait for the operator (up to APPROVAL_WAIT_MS). null: no answer; the app's
// own prompt shows instead.
async function askConsole(input, who, request) {
  const { id } = await api('POST', '/approvals', { ...who, tool_name: input.tool_name, cwd: input.cwd, ...request });
  trace(input.session_id, `asked the console about ${input.tool_name} (#${id})`);
  const deadline = Date.now() + APPROVAL_WAIT_MS;
  let res = { pending: true };
  while (res.pending && Date.now() < deadline) {
    try {
      res = await api('POST', '/approvals/wait', { ...who, approval: id, wait_seconds: Math.min(60, Math.ceil((deadline - Date.now()) / 1000)) });
    } catch {
      await sleep(3000); // hub restarting or network blip: keep waiting
    }
  }
  if (!['allow', 'deny', 'answer'].includes(res.decision)) {
    await api('POST', '/approvals/cancel', { ...who, approval: id }).catch(() => {});
    trace(input.session_id, `no answer for #${id}; showing the normal prompt`);
    return null;
  }
  trace(input.session_id, `#${id} ${res.decision} by ${res.decided_by}`);
  return res;
}

async function remoteApproval(input, who) {
  if (QUESTION_TOOLS.has(input.tool_name)) return; // handled before the tool runs (PreToolUse)
  if (!await remoteWanted(input)) return;
  const res = await askConsole(input, who, describeTool(input.tool_name, input.tool_input));
  if (!res) return;
  const decision = res.decision === 'allow' ? { behavior: 'allow' } : {
    behavior: 'deny',
    message: `Denied over agent-bridge by ${res.decided_by}${res.message ? `: ${res.message}` : ''}. Do not retry this; ask them over agent-bridge if you need something else.`,
  };
  await emit({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

// Multiple-choice questions (AskUserQuestion) and plan approvals (ExitPlanMode) wait for the user in
// the app, which nobody may be watching. Like permission prompts, they go to the console; the answer
// comes back to the agent and the app never shows the prompt.
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
async function remoteQuestion(input, who) {
  if (!QUESTION_TOOLS.has(input.tool_name) || !await remoteWanted(input)) return;
  const tool = input.tool_input || {};
  const plan = input.tool_name === 'ExitPlanMode';
  const questions = (Array.isArray(tool.questions) ? tool.questions : []).slice(0, 8);
  if (!plan && !questions.length) return;
  const res = await askConsole(input, who, plan
    ? { kind: 'plan', summary: 'Approve this plan?', payload: { plan: String(tool.plan || '').slice(0, 60_000) } }
    : { kind: 'question', summary: questions.map(q => q.question).join('\n'), payload: { questions } });
  if (!res) return;
  const by = res.decided_by || 'the operator';
  const out = (permissionDecision, reason) => emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason } });
  if (plan) {
    return res.decision === 'allow'
      ? out('allow', `Plan approved over agent-bridge by ${by}.`)
      : out('deny', `${by} asked for changes to the plan over agent-bridge${res.message ? `: ${res.message}` : ' (no details given)'}. ` +
        'Revise the plan and present it again with ExitPlanMode.');
  }
  if (res.decision !== 'answer') {
    return out('deny', `${by} dismissed the question over agent-bridge${res.message ? `: ${res.message}` : ''}. Don't ask it again; carry on with your best judgment or ask over agent-bridge.`);
  }
  const lines = questions.map(q => `- ${q.question}\n  → ${[].concat(res.answers?.[q.question] ?? '(no answer)').join(', ')}`);
  // Delivered as the tool's denial reason: the agent reads it, the app shows no prompt.
  return out('deny', `Answered over agent-bridge by ${by} (the question wasn't shown in the app, so this is not a refusal):\n` +
    `${lines.join('\n')}\nContinue with these answers; don't ask again.`);
}


// Small rotating log of background-listener events (for diagnosing delayed wake-ups).
const LOG_FILE = path.join(HOME, 'listener.log');
function trace(sessionId, event) {
  try {
    if (fs.statSync(LOG_FILE, { throwIfNoEntry: false })?.size > 256_000) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${String(sessionId).slice(0, 8)} ${process.pid} ${event}\n`);
  } catch { /* logging must never break the hook */ }
}

// Background listener (Claude Code asyncRewake): wait for mail without holding the turn.
async function listen(input, who) {
  const sid = input.session_id;
  // Retry the initial lookup too: a turn that ends while the hub is down must still end up listening.
  let st;
  for (let attempt = 0; !st; attempt++) {
    try {
      st = await status(input);
    } catch (err) {
      // At session start the MCP server may still be registering: allow it a minute.
      if (err.status === 404 && attempt < 12) { await sleep(5000); continue; }
      if (err.status && err.status < 500) return trace(sid, `not on the bridge (${err.message}); exit`);
      if (attempt % 12 === 0) trace(sid, `hub unavailable at start (${err.message}); retrying`);
      await sleep(5000);
    }
  }
  if (!(st.listen_until > Date.now())) return trace(sid, 'not listening; exit');
  if (st.auto_rounds >= st.max_auto_rounds) return trace(sid, 'auto-resume cap reached; exit');
  // Watch the agent process we belong to. Background hooks can outlive their session (Windows
  // doesn't stop children when the app quits); a listener whose agent is gone must not take mail.
  const owner = findOwner();
  let lastIdentityCheck = Date.now();
  const ownerGone = () => {
    if (!processAlive(owner.pid)) return true;
    // PIDs get reused; recheck the start time occasionally (on Windows each check spawns PowerShell).
    if (owner.started && Date.now() - lastIdentityCheck > 300_000) {
      lastIdentityCheck = Date.now();
      const now = processStarted(owner.pid);
      if (now && now !== owner.started) return true;
    }
    return false;
  };
  const stopIfOrphaned = () => {
    if (!ownerGone()) return false;
    if (ownsLock(sid)) fs.rmSync(lockFile(sid), { force: true });
    trace(sid, `agent process ${owner.pid} gone; exit`);
    process.exit(0);
  };
  setInterval(stopIfOrphaned, 5000).unref();
  fs.mkdirSync(path.dirname(lockFile(sid)), { recursive: true });
  fs.writeFileSync(lockFile(sid), LISTENER_TOKEN);
  trace(sid, `start as ${st.name} (unread ${st.unread}; agent process ${owner.pid})`);
  let pollFailures = 0;
  let missingSince = 0;
  let quietSince = 0;
  let stayAwake = Boolean(st.keep_awake);
  const listenerStarted = Date.now();
  for (;;) {
    if (!ownsLock(sid)) return trace(sid, 'replaced or retired; exit'); // a newer listener or a user prompt
    let pending = 0;
    try {
      // Staying awake: wake up in time for the keepalive turn.
      const wait = stayAwake ? Math.max(1, Math.min(120, Math.ceil((listenerStarted + KEEP_AWAKE_MS - Date.now()) / 1000))) : 120;
      ({ pending } = await api('POST', '/inbox', { ...who, wait_seconds: wait, peek: true }, (wait + 20) * 1000));
      missingSince = 0;
      if (quietSince) { trace(sid, 'session back online; listening again'); quietSince = 0; }
    } catch (err) {
      if (err.status === 409) {
        // Session offline. Right after (re)start that just means its MCP server hasn't checked in
        // yet (a SessionStart listener can win that race), so wait. Later: if its MCP server exited,
        // the session is over. If it only went quiet (computer asleep, network down) while the agent
        // process still runs, keep waiting: it checks in again on wake, and this listener is what
        // wakes the agent for mail. (A gone agent process ends this listener: stopIfOrphaned.)
        if (Date.now() - listenerStarted < STARTUP_GRACE_MS) { await sleep(5000); continue; }
        if (/closed/.test(err.message) || ownerGone()) return trace(sid, `${err.message}; exit`);
        if (!quietSince) trace(sid, `${err.message}; agent process ${owner.pid} still runs, waiting for it to come back`);
        quietSince ||= Date.now();
        if (Date.now() - quietSince > QUIET_LIMIT_MS) return trace(sid, 'session offline for a day; exit');
        await sleep(15_000);
        continue;
      }
      if (!pollFailures++ || pollFailures % 12 === 0) trace(sid, `poll failed (${err.message}); retrying`);
      if (err.status === 404) {
        // The session's row is gone (e.g. its MCP server is restarting): look it up again, and
        // give up after a few minutes rather than polling a session that left the bridge.
        missingSince ||= Date.now();
        if (Date.now() - missingSince > 180_000) return trace(sid, 'session not on the bridge for 3 minutes; exit');
        await status(input).catch(() => {});
      }
      await sleep(5000); // hub restarting or network blip: keep listening
      continue;
    }
    if (!ownsLock(sid)) return trace(sid, `replaced or retired after poll (pending ${pending}); exit`);
    const now = await api('POST', '/heartbeat', who).catch(() => null);
    if (now && !(now.listen_until > Date.now())) return trace(sid, 'listening switched off; exit');
    if (now) stayAwake = Boolean(now.keep_awake);
    if (!pending) {
      // Stay awake: the Claude app stops a hidden session after 30 idle minutes (its agent-bridge
      // server and this listener with it). A tiny turn before that keeps it running.
      if (stayAwake && Date.now() - listenerStarted >= KEEP_AWAKE_MS && ownsLock(sid)) {
        stopIfOrphaned();
        trace(sid, 'keepalive turn (stay awake)');
        return finish(process.stderr, 'agent-bridge keepalive: this turn only keeps the session running (the Claude app stops hidden ' +
          'sessions after 30 idle minutes). Nothing to do: reply with just "Still listening." and end your turn without calling any tools.', 2);
      }
      continue;
    }
    stopIfOrphaned(); // never take mail for an agent that's gone
    let msgs;
    try {
      msgs = await takeInbox(api, who, 0, { ack: false, leaseSeconds: 600 });
    } catch (err) {
      trace(sid, `taking mail failed (${err.message}); retrying`);
      await sleep(5000);
      continue;
    }
    if (!msgs.length) { trace(sid, `pending ${pending} but nothing to take (taken elsewhere)`); continue; }
    trace(sid, `waking agent with ${msgs.map(m => `#${m.id}`).join(', ')}`);
    fs.writeFileSync(handedFile(sid), JSON.stringify(msgs.map(m => m.id)));
    markWoken(sid);
    const after = await api('POST', '/rounds', who);
    // Exit code 2: Claude Code wakes the agent with this text.
    return finish(process.stderr, `New agent-bridge messages (${PEER_NOTE}):\n\n${formatMessages(msgs)}\n\n${resumeNote(st, after, msgs)}`, 2);
  }
}

try {
  const input = await readStdin();
  crumb(`${input.hook_event_name || '?'} fields: ${Object.keys(input).join(',')}${input.turn_id ? ' (codex)' : ''}`);
  // Codex builds name the conversation differently; take whichever id they send.
  input.session_id ||= input.thread_id || input.conversation_id || input.sessionId || input.threadId || input.conversationId;
  if (!input.session_id) {
    trace('-', `${input.hook_event_name || 'hook'} without a session id; fields: ${Object.keys(input).join(', ') || '(none)'}`);
    process.exit(0);
  }
  const who = { session_id: input.session_id };

  if (LISTENER) {
    if (input.hook_event_name === 'Stop' || input.hook_event_name === 'SessionStart') await listen(input, who);
    process.exit(0);
  }

  switch (input.hook_event_name) {
    case 'UserPromptSubmit': {
      fs.rmSync(lockFile(input.session_id), { force: true }); // retire this session's background listener
      // A wake-up hands mail over first; any other prompt comes from the user, who is here now.
      const woke = fs.existsSync(handedFile(input.session_id));
      if (!woke) fs.rmSync(wokenFile(input.session_id), { force: true });
      await confirmHanded(who, input.session_id);
      const st = await status(input, { state: 'thinking', detail: woke ? 'handling agent-bridge messages' : 'working on a request' });
      await api('POST', '/rounds', { ...who, reset: true });
      const msgs = await takeInbox(api, who);
      // Listening can be switched on from the console mid-session; tell the agent its current state.
      const listening = st.listen_until >= LISTEN_ALWAYS ? 'always-listening'
        : st.listen_until > Date.now() ? `listening until ${new Date(st.listen_until).toLocaleTimeString()}` : '';
      const parts = [];
      if (listening) parts.push(`agent-bridge status: you are "${st.name}", ${listening} — after this turn ends, peer messages resume you automatically.`);
      if (msgs.length) parts.push(`Unread agent-bridge messages (${PEER_NOTE}):\n\n${formatMessages(msgs)}`);
      if (parts.length) await emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') } });
      break;
    }

    case 'PreToolUse': {
      if (input.turn_id) break; // Claude Code only
      await remoteQuestion(input, who);
      break;
    }

    case 'PermissionRequest': {
      if (input.turn_id) break; // Claude Code only for now (Codex's approval hook differs)
      await remoteApproval(input, who);
      break;
    }

    case 'PostToolUse': {
      const bridgeTool = Boolean(bridgeCall(input));
      if (bridgeTool && !input.turn_id) break; // bridge tools report mail themselves
      const st = await status(input, bridgeTool ? undefined : activityOf(input.tool_name, input.tool_input));
      if (bridgeTool) break; // Codex: the call above may have linked this chat to its agent-bridge server
      const parts = [];
      const msgs = st.unread ? await takeInbox(api, who) : [];
      if (msgs.length) {
        parts.push(`New agent-bridge messages arrived while you were working (${PEER_NOTE}):\n\n${formatMessages(msgs)}\n\n` +
          'If one asks for something that will take a while, send a one-line reply now saying you have seen it and when you will get to it.');
      }
      const waiting = st.awaiting_reply ? (await api('POST', '/awaiting', { ...who, stage: 1 })).messages : [];
      if (waiting.length) parts.push(awaitingNote(waiting, 1));
      if (parts.length) await emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: parts.join('\n\n') } });
      break;
    }

    case 'Stop': {
      await confirmHanded(who, input.session_id); // in case the woken turn had no prompt hook
      const st = await status(input, { state: 'idle', detail: 'finished its turn' });
      // The operator asked something and got no answer: one more turn to confirm in a line.
      const unanswered = st.awaiting_reply ? (await api('POST', '/awaiting', { ...who, stage: 2 })).messages : [];
      if (unanswered.length) {
        await emit({ decision: 'block', reason: awaitingNote(unanswered, 2) });
        break;
      }
      const listening = () => st.listen_until > Date.now();
      if (st.auto_rounds >= st.max_auto_rounds) {
        if (st.unread || listening()) await emit({ systemMessage: capMessage(st) });
        break;
      }
      // Only mail addressed to the agent resumes it; FYI group mail waits for its next active moment.
      let msgs = (st.urgent ?? st.unread) ? await takeInbox(api, who) : [];
      const codex = Boolean(input.turn_id); // Claude Code listens in the background instead (--listen)
      if (!codex) {
        if (!msgs.length) break;
        markWoken(input.session_id);
        const after = await api('POST', '/rounds', who);
        await emit({ decision: 'block', reason: `New agent-bridge messages (${PEER_NOTE}):\n\n${formatMessages(msgs)}\n\n${resumeNote(st, after, msgs)}` });
      }
      // Listening: hold the turn open until mail arrives, listening ends, or the keepalive
      // interval passes (hooks have a timeout, and a queued user prompt needs a gap).
      const deadline = Math.min(st.listen_until, Date.now() + KEEPALIVE_MS);
      while (!msgs.length) {
        const remaining = Math.floor((deadline - Date.now()) / 1000);
        if (remaining <= 0) break;
        try {
          msgs = await takeInbox(api, who, Math.min(remaining, 300));
        } catch {
          await sleep(3000); // hub restarting or network blip: keep listening
        }
      }
      if (!msgs.length) {
        if (listening()) await emit({
          decision: 'block',
          reason: `agent-bridge keepalive: no messages in the last ${Math.round(KEEPALIVE_MS / 60_000)} minutes and you are still listening. ` +
            'Nothing to do: reply with just "Still listening." and end your turn without calling any tools.',
        });
        break;
      }
      const after = await api('POST', '/rounds', who);
      await emit({ decision: 'block', reason: `New agent-bridge messages (${PEER_NOTE}):\n\n${formatMessages(msgs)}\n\n${resumeNote(st, after, msgs)}` });
    }
  }
} catch (err) {
  // Bridge unavailable or session not on the bridge: never block the agent.
  crumb(`ended: ${err?.status ? `HTTP ${err.status} ` : ''}${String(err?.message || err).slice(0, 160)}`);
}
process.exit(0);

#!/usr/bin/env node
// agent-bridge installer (macOS, Linux, Windows). Wires Claude Code and Codex on this computer
// to an agent-bridge hub.
//
//   node install.mjs                    # pairs with the hub this computer is connected to: approve the
//                                       # code it shows in the console (Devices page)
//   node install.mjs --hub https://agent-bridge.<you>.workers.dev [--token <device-token>] [--device <name>]
//   node install.mjs --local            # no hub: agents on this computer use a local broker
//   node install.mjs --status
//   node install.mjs --uninstall [--purge]
// Options: --no-claude, --no-codex, --codex-legacy (Codex via [mcp_servers] + hooks.json instead of the plugin)
//
// What it changes (with a backup of each file it edits):
//   ~/.agent-bridge/app/          runtime copy of client/, core/, console/dist (stable path for configs)
//   ~/.agent-bridge/config.json   hub URL, device token, device name
//   ~/.claude.json                user-scope MCP server "agent-bridge"
//   ~/.claude/settings.json       UserPromptSubmit / PostToolUse / Stop / SessionStart / PermissionRequest hooks
//   ~/.agent-bridge/codex-marketplace/  a local Codex plugin marketplace with the agent-bridge plugin
//                                 (its MCP server + hooks of type mcp_tool, which call the server
//                                 that serves each chat: Codex Desktop doesn't run hooks.json)
//   ~/.codex/config.toml          that marketplace + plugin enabled, features.plugin_hooks (managed block)
//   ~/.codex/hooks.json           agent-bridge entries removed (only with --codex-legacy: three hooks)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { startPairing, pollPairing } from './plugin/client/lib.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.AGENT_BRIDGE_HOME || path.join(os.homedir(), '.agent-bridge');
const APP = path.join(HOME, 'app');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const CLAUDE_SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_TOML = path.join(CODEX_HOME, 'config.toml');
const CODEX_HOOKS = path.join(CODEX_HOME, 'hooks.json');
const CODEX_MARKET = path.join(HOME, 'codex-marketplace');
const SERVER = 'agent-bridge';
const LEGACY = ['claude-bridge'];
const MARK_BEGIN = '# >>> agent-bridge (managed by agent-bridge/install.mjs; edits inside are overwritten) >>>';
const MARK_END = '# <<< agent-bridge <<<';
const HOOK_EVENTS = [
  { event: 'UserPromptSubmit', timeout: 15 },
  { event: 'PostToolUse', timeout: 15, matcher: '*' },
];
// Claude Code listens with a background hook that wakes the agent (asyncRewake), so its turns
// end normally. Codex has no such hook: its Stop hook holds the turn open while listening.
const claudeStop = () => [
  { type: 'command', command: HOOK_COMMAND, timeout: 30 },
  { type: 'command', command: `${HOOK_COMMAND} --listen`, async: true, asyncRewake: true, rewakeMessage: 'agent-bridge:', timeout: 604800 },
];
const codexStop = () => [{ type: 'command', command: HOOK_COMMAND, timeout: 7300 }];

// ---------- args ----------

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const ok = msg => console.log(`  ✓ ${msg}`);
const info = msg => console.log(`  · ${msg}`);
const warn = msg => console.log(`  ! ${msg}`);
function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

const fwd = p => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p); // safe in bash, cmd and TOML
const NODE = fwd(process.execPath);
const MCP_SCRIPT = fwd(path.join(APP, 'client', 'mcp.mjs'));
const HOOK_SCRIPT = fwd(path.join(APP, 'client', 'hook.mjs'));
const HOOK_COMMAND = `"${NODE}" "${HOOK_SCRIPT}"`;
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

// ---------- file helpers ----------

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backedUp = new Set();
function backup(file) {
  if (backedUp.has(file) || !fs.existsSync(file)) return;
  fs.copyFileSync(file, `${file}.agent-bridge-backup-${stamp}`);
  backedUp.add(file);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return fallback;
  try { return JSON.parse(text); } catch { die(`${file} is not valid JSON; fix or move it, then re-run.`); }
}

function writeJson(file, data) {
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

// ---------- hooks (Claude Code settings.json and Codex hooks.json share a format) ----------

const isOurs = cmd => typeof cmd === 'string' && (cmd.includes('agent-bridge') || LEGACY.some(l => cmd.includes(`${l}/hook.mjs`)));

function stripHooks(hooks) {
  for (const event of Object.keys(hooks || {})) {
    hooks[event] = (hooks[event] || [])
      .map(group => ({ ...group, hooks: (group.hooks || []).filter(h => !isOurs(h.command)) }))
      .filter(group => group.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
}

function addHooks(hooks, stopHooks) {
  for (const { event, timeout, matcher } of HOOK_EVENTS) {
    (hooks[event] ||= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: HOOK_COMMAND, timeout }] });
  }
  (hooks.Stop ||= []).push({ hooks: stopHooks });
  // Claude Code: also listen from session start/resume (no prompt needed after an app restart).
  const listener = stopHooks.find(h => h.asyncRewake);
  if (listener) (hooks.SessionStart ||= []).push({ hooks: [listener] });
}

// ---------- Claude Code ----------

function claudePresent() {
  return fs.existsSync(CLAUDE_JSON) || fs.existsSync(path.dirname(CLAUDE_SETTINGS));
}

function configureClaude(remove = false) {
  // Claude Code with the agent-bridge plugin enabled gets its server and hooks from the plugin: a
  // user-scope copy as well would run everything twice. Clear any old copy instead.
  const viaPlugin = !remove && Object.entries(readJson(CLAUDE_SETTINGS, {}).enabledPlugins || {})
    .some(([id, on]) => on && id.startsWith(`${SERVER}@`));
  if (viaPlugin) {
    configureClaude(true);
    info('Claude Code uses the agent-bridge plugin: update it there (/plugin, or the agent-bridge-plugin-update skill)');
    return;
  }
  // ~/.claude.json is rewritten by running Claude sessions; write, then verify it stuck.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const data = readJson(CLAUDE_JSON, {});
    data.mcpServers ||= {};
    for (const name of [SERVER, ...LEGACY]) delete data.mcpServers[name];
    if (!remove) data.mcpServers[SERVER] = { type: 'stdio', command: NODE, args: [MCP_SCRIPT], env: {} };
    writeJson(CLAUDE_JSON, data);
    const check = readJson(CLAUDE_JSON, {});
    if (Boolean(check.mcpServers?.[SERVER]) === !remove) break;
    if (attempt === 3) warn('~/.claude.json keeps being rewritten by a running Claude session; quit Claude apps and re-run.');
  }
  ok(`${remove ? 'removed' : 'registered'} MCP server "${SERVER}" (user scope) in ${CLAUDE_JSON}`);

  const settings = readJson(CLAUDE_SETTINGS, {});
  settings.hooks ||= {};
  stripHooks(settings.hooks);
  if (!remove) {
    addHooks(settings.hooks, claudeStop());
    // Remote approvals: permission prompts can be answered from the console.
    (settings.hooks.PermissionRequest ||= []).push({ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 660 }] });
    // Questions and plan approvals can be answered from the console too.
    (settings.hooks.PreToolUse ||= []).push({ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 660 }] });
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeJson(CLAUDE_SETTINGS, settings);
  ok(`${remove ? 'removed' : 'installed'} hooks in ${CLAUDE_SETTINGS}`);
}

// ---------- Codex ----------

function codexPresent() {
  return fs.existsSync(CODEX_HOME);
}

// Codex gets agent-bridge as a plugin from a local marketplace: Codex Desktop runs plugin hooks (of
// type mcp_tool, calling the MCP server that serves the chat, with its session id) but not
// ~/.codex/hooks.json. --codex-legacy keeps the older [mcp_servers] + hooks.json setup (Codex CLI).
function writeCodexPlugin() {
  const plugin = path.join(CODEX_MARKET, 'plugins', SERVER);
  // Generated files (no backups: Codex copies the plugin folder into its cache).
  const writeJson = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  };
  const hook = (event, timeout, matcher) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{
      type: 'mcp_tool', server: SERVER, tool: 'session_event', timeout,
      // SessionStart has no turn yet (an unknown placeholder fails the hook). A prompt's transcript_path
      // is null in Codex's ephemeral helper threads (titles, summaries): those must not link.
      input: {
        hook_event_name: '${hook_event_name}', session_id: '${session_id}',
        ...(event === 'SessionStart' ? {} : { turn_id: '${turn_id}' }),
        ...(event === 'UserPromptSubmit' ? { transcript_path: '${transcript_path}', model: '${model}' } : {}),
      },
    }],
  });
  writeJson(path.join(CODEX_MARKET, '.agents', 'plugins', 'marketplace.json'), {
    name: SERVER,
    interface: { displayName: 'agent-bridge' },
    plugins: [{
      name: SERVER, source: { source: 'local', path: `./plugins/${SERVER}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools',
    }],
  });
  writeJson(path.join(plugin, '.codex-plugin', 'plugin.json'), {
    name: SERVER,
    // A new version each install, so Codex refreshes its cached copy.
    version: `0.3.${Math.floor(Date.now() / 1000)}`,
    description: 'Lets agents message each other, stay listening for work, and share projects through your agent-bridge hub.',
    author: { name: 'agent-bridge' },
    interface: {
      displayName: 'agent-bridge',
      shortDescription: 'Messaging and shared projects for your AI agents',
      developerName: 'agent-bridge',
      category: 'Developer Tools',
    },
    mcpServers: './.mcp.json',
    hooks: { hooks: {
      SessionStart: [hook('SessionStart', 30)],
      UserPromptSubmit: [hook('UserPromptSubmit', 30)],
      PostToolUse: [hook('PostToolUse', 30, '*')],
      Stop: [hook('Stop', 7300)],
    } },
  });
  writeJson(path.join(plugin, '.mcp.json'), { mcpServers: { [SERVER]: {
    command: NODE, args: [MCP_SCRIPT], enabled: true,
    startup_timeout_sec: 20, tool_timeout_sec: 7300, default_tools_approval_mode: 'approve',
  } } });
}

// The Codex CLI (it comes with the ChatGPT app): registering a marketplace doesn't install the plugin;
// `codex plugin add` does (and remove + add refreshes Codex's cached copy after an update).
function findCodexCli() {
  const tries = [process.env.CODEX_CLI_PATH, 'codex'];
  if (process.platform === 'darwin') {
    tries.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', '/Applications/Codex.app/Contents/Resources/codex');
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    // The Codex app keeps its CLI in %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe (newest wins).
    const bin = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const builds = fs.readdirSync(bin).map(d => path.join(bin, d, 'codex.exe')).filter(f => fs.existsSync(f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      tries.push(...builds);
    } catch { /* not there */ }
    // Other installs, e.g. %LOCALAPPDATA%\Programs\ChatGPT\resources\codex-cli\codex.exe: search a few levels down.
    const found = [];
    const walk = (dir, depth) => {
      if (depth < 0 || found.length) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isFile() && e.name.toLowerCase() === 'codex.exe') found.push(p);
        else if (e.isDirectory() && /chatgpt|codex|resources|bin/i.test(e.name)) walk(p, depth - 1);
      }
    };
    walk(path.join(process.env.LOCALAPPDATA, 'Programs'), 5);
    tries.push(...found);
  }
  for (const cli of tries.filter(Boolean)) {
    const res = spawnSync(cli, ['--version'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    if (res.status === 0) return cli;
  }
  return null;
}

function installCodexPlugin(remove = false) {
  const cli = findCodexCli();
  const id = `${SERVER}@${SERVER}`;
  if (!cli) {
    if (!remove) warn(`couldn't find the codex command; finish with: codex plugin add ${id}`);
    else warn(`couldn't find the codex command; also run: codex plugin remove ${id}`);
    return;
  }
  const run = argv => spawnSync(cli, argv, { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, CODEX_HOME } });
  run(['plugin', 'remove', id]);
  if (remove) return ok(`uninstalled the Codex plugin ${id}`);
  const res = run(['plugin', 'add', id]);
  if (res.status === 0) ok(`installed the Codex plugin ${id}`);
  else warn(`installing the Codex plugin failed; run it yourself: codex plugin add ${id}\n    ${(res.stderr || res.stdout || '').trim().split('\n').pop()}`);
}

function configureCodex(remove = false) {
  const legacy = flag('codex-legacy');
  let toml = fs.existsSync(CODEX_TOML) ? fs.readFileSync(CODEX_TOML, 'utf8') : '';
  const start = toml.indexOf(MARK_BEGIN);
  if (start >= 0) {
    const end = toml.indexOf(MARK_END, start);
    toml = (toml.slice(0, start) + (end >= 0 ? toml.slice(end + MARK_END.length) : '')).replace(/\n{3,}/g, '\n\n');
  }
  toml = toml.replace(/^plugin_hooks = true # agent-bridge\n/m, ''); // ours, inside an existing [features]
  const fwdPath = p => p.replace(/\\/g, '/');
  if (/^\s*\[mcp_servers\.agent-bridge\]/m.test(toml)) {
    warn(`${CODEX_TOML} already has an unmanaged [mcp_servers.agent-bridge]; leaving it alone.`);
  } else if (!remove && legacy) {
    // TOML literal strings ('...') need no escaping for Windows paths.
    toml = toml.trimEnd() + `\n\n${MARK_BEGIN}
[mcp_servers.agent-bridge]
command = '${NODE}'
args = ['${MCP_SCRIPT}']
startup_timeout_sec = 20
tool_timeout_sec = 330
default_tools_approval_mode = "approve"
${MARK_END}\n`;
  } else if (!remove) {
    writeCodexPlugin();
    let features = '';
    if (/^\[features\]\s*$/m.test(toml)) {
      if (!/^\s*plugin_hooks\s*=/m.test(toml)) toml = toml.replace(/^\[features\]\s*$/m, '[features]\nplugin_hooks = true # agent-bridge');
    } else {
      features = '\n[features]\nplugin_hooks = true\n';
    }
    // The [plugins."agent-bridge@agent-bridge"] entry belongs to `codex plugin add` (installCodexPlugin):
    // writing it here too would make a duplicate key and break Codex's config.
    toml = toml.trimEnd() + `\n\n${MARK_BEGIN}
[marketplaces.${SERVER}]
source_type = "local"
source = '${fwdPath(CODEX_MARKET)}'
${features}${MARK_END}\n`;
  }
  backup(CODEX_TOML);
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  fs.writeFileSync(CODEX_TOML, toml.trimStart());
  ok(`${remove ? 'removed agent-bridge from' : legacy ? 'registered MCP server in' : 'registered the agent-bridge plugin in'} ${CODEX_TOML}`);
  if (!legacy) installCodexPlugin(remove);
  if (remove) fs.rmSync(CODEX_MARKET, { recursive: true, force: true });

  const hooksFile = readJson(CODEX_HOOKS, {});
  hooksFile.hooks ||= {};
  stripHooks(hooksFile.hooks);
  if (!remove && legacy) addHooks(hooksFile.hooks, codexStop());
  writeJson(CODEX_HOOKS, hooksFile);
  ok(`${!remove && legacy ? 'installed' : 'removed agent-bridge'} hooks in ${CODEX_HOOKS}`);
}

// ---------- hub check ----------

// Returns the device name the hub has for this token.
async function checkHub(url, token, device) {
  try {
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!health.ok) die(`hub at ${url} answered /health with HTTP ${health.status}`);
  } catch (err) {
    die(`can't reach the hub at ${url}: ${err.message}`);
  }
  const get = route => fetch(`${url}/api${route}`, {
    headers: { authorization: `Bearer ${token}`, 'x-agent-device': device },
    signal: AbortSignal.timeout(10_000),
  });
  const who = await get('/whoami');
  if (who.status === 401) die('the hub rejected that token (wrong, or revoked). Create a new one on the console\'s Devices page.');
  if (!who.ok) die(`hub check failed: HTTP ${who.status}`);
  const { device: hubDevice, admin } = await who.json();
  const { peers } = await (await get('/peers')).json();
  ok(`hub reachable, token accepted (${peers.filter(p => p.kind !== 'human').length} agent(s) online)`);
  if (admin) {
    warn('that is the hub ADMIN token; use a per-device token from the console\'s Devices page instead.');
    return device;
  }
  if (opt('device') && slug(opt('device')) !== hubDevice) info(`using the token's device name "${hubDevice}" (not "${opt('device')}")`);
  return hubDevice;
}

// ---------- commands ----------

function status() {
  const cfg = readJson(path.join(HOME, 'config.json'), null);
  console.log('\nagent-bridge status');
  info(cfg ? `hub: ${cfg.url}  device: ${cfg.device}  token: ${cfg.token ? 'set' : 'none (local mode)'}` : 'not configured');
  info(`runtime: ${fs.existsSync(MCP_SCRIPT) ? APP : 'not installed'}`);
  info(`Claude Code MCP: ${readJson(CLAUDE_JSON, {}).mcpServers?.[SERVER] ? 'registered' : 'not registered'}`);
  info(`Claude Code hooks: ${JSON.stringify(readJson(CLAUDE_SETTINGS, {}).hooks || {}).includes('agent-bridge') ? 'installed' : 'not installed'}`);
  if (codexPresent()) {
    info(`Codex MCP: ${fs.existsSync(CODEX_TOML) && fs.readFileSync(CODEX_TOML, 'utf8').includes(MARK_BEGIN) ? 'registered' : 'not registered'}`);
    info(`Codex hooks: ${JSON.stringify(readJson(CODEX_HOOKS, {}).hooks || {}).includes('agent-bridge') ? 'installed' : 'not installed'}`);
  }
}

// One-time device approval: show a code, wait for the operator to approve it in the console.
async function pair(url, device) {
  let p;
  try { p = await startPairing(url, device, `installer on ${os.hostname()}`); } catch (err) { die(`can't reach the hub at ${url}: ${err.message}`); }
  console.log(`  → Approve this computer: open ${url}/#/devices (signed in) and approve code\n\n      ${p.code}\n\n    Waiting (expires in ${Math.round(p.expires_in / 60)} minutes)…`);
  for (;;) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await pollPairing(url, p.poll_secret).catch(() => ({ status: 'pending' }));
    if (r.status === 'approved') { ok(`approved as device "${r.device}"`); return { token: r.token, device: r.device }; }
    if (r.status !== 'pending') die(`pairing ${r.status}; run the installer again to get a new code.`);
  }
}

async function install() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) die(`Node ${process.versions.node} is too old; agent-bridge needs Node 22.13 or newer.`);

  const local = flag('local');
  const existing = readJson(path.join(HOME, 'config.json'), {});
  const defaults = readJson(path.join(REPO, 'plugin', 'agent-bridge.defaults.json'), {});
  const url = (local ? 'http://127.0.0.1:7777' : opt('hub') || existing.url || defaults.hub || '').replace(/\/+$/, '');
  let device = slug(opt('device') || existing.device || os.hostname().split('.')[0]) || 'computer';
  if (!url) die('pass --hub <url> (and optionally --token), or --local.');
  const sameHub = existing.url && existing.url.replace(/\/+$/, '') === url;
  let token = local ? '' : opt('token') || (sameHub ? existing.token : '') || '';

  console.log(`\nInstalling agent-bridge → ${local ? 'local broker' : url}\n`);

  if (!local && !token) ({ token, device } = await pair(url, device));

  if (!local) device = await checkHub(url, token, device);
  ok(`this computer is device "${device}"`);

  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.rmSync(APP, { recursive: true, force: true });
  copyDir(path.join(REPO, 'plugin', 'client'), path.join(APP, 'client'));
  copyDir(path.join(REPO, 'plugin', 'core'), path.join(APP, 'core'));
  try {
    const commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(APP, 'VERSION'), `installer ${commit}\n`);
  } catch { fs.writeFileSync(path.join(APP, 'VERSION'), 'installer\n'); }
  if (fs.existsSync(path.join(REPO, 'plugin', 'agent-bridge.defaults.json'))) fs.copyFileSync(path.join(REPO, 'plugin', 'agent-bridge.defaults.json'), path.join(APP, 'agent-bridge.defaults.json'));
  if (fs.existsSync(path.join(REPO, 'console', 'dist'))) copyDir(path.join(REPO, 'console', 'dist'), path.join(APP, 'console', 'dist'));
  ok(`runtime copied to ${APP}`);

  const configFile = path.join(HOME, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ url, token: token || undefined, device, mode: local ? 'local' : undefined }, null, 2) + '\n', { mode: 0o600 });
  ok(`config written to ${configFile}`);

  const doClaude = !flag('no-claude') && claudePresent();
  const doCodex = !flag('no-codex') && codexPresent();
  if (doClaude) configureClaude(); else info('Claude Code not found (or --no-claude); skipped');
  if (doCodex) configureCodex(); else info('Codex not found (or --no-codex); skipped');

  console.log('\nDone. Next:');
  if (doClaude) console.log('  • Claude Code: start new sessions (or restart the Claude app). Existing sessions keep their old setup.');
  if (doCodex) {
    console.log(flag('codex-legacy')
      ? '  • Codex: start a new session and run /hooks once to review and trust the three agent-bridge hooks (needed for listening).'
      : '  • Codex: restart the ChatGPT/Codex app, then approve the agent-bridge plugin\'s hooks once when Codex asks (or with /hooks).');
  }
  console.log('  • Try it: ask an agent to "list peers on agent-bridge".');
  console.log('  • Per-project defaults: put {"name": "planner", "listen": "always"} in <project>/.agent-bridge.json\n');
}

function uninstall() {
  console.log('\nRemoving agent-bridge\n');
  if (!flag('no-claude') && claudePresent()) configureClaude(true);
  if (!flag('no-codex') && codexPresent()) configureCodex(true);
  if (flag('no-claude') || flag('no-codex')) {
    info(`kept ${APP} (still used by the agent you didn't uninstall)`);
  } else {
    fs.rmSync(APP, { recursive: true, force: true });
    ok(`removed ${APP}`);
  }
  if (flag('purge')) { fs.rmSync(HOME, { recursive: true, force: true }); ok(`removed ${HOME} (config, token, local data)`); }
  else info(`kept ${HOME} (config and token); pass --purge to delete it`);
  console.log('');
}

if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
} else if (flag('status')) status();
else if (flag('uninstall')) uninstall();
else await install();

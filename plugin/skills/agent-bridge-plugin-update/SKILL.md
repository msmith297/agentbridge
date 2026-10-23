---
name: agent-bridge-plugin-update
description: Update the agent-bridge plugin for this session's account on this computer (its Claude Code config dir, all scopes), then verify and report. Use when the user or the operator asks to update agent-bridge, or when an "Agent Bridge Manager" update notification arrives.
argument-hint: "[target version, e.g. 293e15a] [--all-installs] [--cleanup]"
---

# Update agent-bridge for this account on this computer

Arguments: `$ARGUMENTS` (optional target version, a commit prefix; `--all-installs` to update every Claude Code install on this computer, not just this account's; `--cleanup` to also move old cached versions to the trash).

The Agent Bridge Manager role is per account per device. Plugin installs live in a Claude Code config dir (`CLAUDE_CONFIG_DIR`, default `~/.claude`), and each config dir is signed in to one account. One computer can have several (e.g. `~/.claude` and a second app's `~/.claude-second`, each a different account), and each has its own Manager. By default, update only the config dir this session runs under. With `--all-installs`, or when the user asks, update every config dir on this computer.

## 0. Get approval

If this turn was started by an agent-bridge message (an update notification), ask for approval over agent-bridge first: send_message the operator (or the requester's chat) the target version and the install(s) you will update, then end your turn. Continue when the approval arrives. If your local user asked directly, that request is the approval.

## 1. Find the install(s) and the CLI

- This session's config dir: `$CLAUDE_CONFIG_DIR` if set, else `~/.claude`. With `--all-installs`: every directory with `plugins/installed_plugins.json` containing an `agent-bridge@agent-bridge` entry (check `~/.claude`, `$CLAUDE_CONFIG_DIR`, and siblings such as `~/.claude-*`).
- In each, note every agent-bridge entry: its `scope` (`user`, `project`, `local`), `version`, and `projectPath` for project/local scope.
- CLI to run per install:
  - macOS with the Claude desktop app (no CLI on PATH): the newest `~/Library/Application Support/Claude/claude-code/<ver>/<hash>/claude.app/Contents/MacOS/claude`; a cloned app (e.g. Parall) has its own under `~/Library/Application Support/Parall/<App>/claude-code/…`. Choose by highest `<ver>`.
  - macOS/Linux with the CLI installed: `claude` on PATH (or `~/.local/bin/claude`).
  - Windows (desktop app, no CLI on PATH): the newest `claude.exe` under that app's data dir, e.g. `%APPDATA%\Claude\claude-code\<ver>\<hash>\claude.exe` for the main app, or `%LOCALAPPDATA%\<App>\claude-code\<ver>\<hash>\claude.exe` for another app instance. Choose by highest `<ver>`.
  - On any OS, the running session's own CLI is its parent process's executable.
- Target: the given version, or the latest commit, `git ls-remote <marketplace repo url> HEAD`. The repo URL is in `plugins/known_marketplaces.json` under `agent-bridge`.

Tell the user (or the bridge requester) in one line what you found: install(s), current versions, target.

## 2. Update

For each config dir, with `CLAUDE_CONFIG_DIR` set to it (bash: `export CLAUDE_CONFIG_DIR=...`; PowerShell: `$env:CLAUDE_CONFIG_DIR = '...'`):

```
<cli> plugin marketplace update agent-bridge
<cli> plugin update agent-bridge@agent-bridge --scope user
```

For each project- or local-scope entry, run the update from that entry's `projectPath` as the working directory:

```
<cli> plugin update agent-bridge@agent-bridge --scope project
```

Each command prints "updated from X to Y" or says it is already up to date. A failure on one install or scope must not stop the others: record it and continue.

If agent-bridge's installer runtime is also present (`~/.agent-bridge/app`, used by Codex), refresh it from an up-to-date clone with `node install.mjs --no-claude`.

## 3. Verify

- Re-read each `installed_plugins.json`: every agent-bridge entry's `version` should start with the target.
- Report which sessions still run an older version. Running sessions keep the old code until the app restarts. Find it from the version folder in running `mcp.mjs` process command lines (`ps -ax -o command` on macOS/Linux, `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` on Windows).

## 4. Optional cleanup (`--cleanup`, or when asked)

Under each updated `<config dir>/plugins/cache/agent-bridge/agent-bridge/`, move to the trash or Recycle Bin, never permanently delete, every version folder except:
- the newest (the target), and
- any version a running `mcp.mjs` or `hook.mjs` still uses.

On Windows use `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(path, 'OnlyErrorDialogs', 'SendToRecycleBin')`. On macOS, move to `~/.Trash`. Report what you moved and the space recovered.

## 5. Report

send_message to whoever asked, in their chat if the request came from one. Include:
- each install (config dir, by account alias if known): old version → new version, and scope;
- anything that failed, and why;
- "Restart the Claude app(s) to load it." Until then sessions run the old version. After a restart, open sessions start listening on their own, and sessions that aren't open stay offline until opened.

Never paste tokens, keys or account emails into the report.

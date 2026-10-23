import { useEffect, useState, type FormEvent } from 'react';
import { askManagersToUpdate, removePeer, renamePeer, setApprovalMode, setIdentity, setKeepAwake, setListening, setRole, type ApprovalMode, type HubState, type Peer, type Session } from '../api';
import { Avatar, isBusy, statusText } from '../components/Identity';
import { ConfirmButton } from '../components/ConfirmButton';
import { ago, folderName } from '../format';

interface Props {
  state: HubState;
  session: Session;
  onMessage: (to: string) => void;
  onChanged: () => void;
}

// Three states: offline, online · listening, online · not listening.
function Status({ peer }: { peer: Peer }) {
  const changed = peer.listen_changed_by && peer.listen_changed_at
    ? ` · listening last switched ${peer.listening ? 'on' : 'off'} by ${peer.listen_changed_by}, ${new Date(peer.listen_changed_at).toLocaleString()}` : '';
  if (!peer.online) return <span className="pill" title={changed.slice(3) || undefined}>offline</span>;
  if (peer.listening) {
    return <span className="pill live" title={(peer.waiting ? 'Replies to messages on its own'
      : 'Replies to messages on its own once its current turn ends') + changed}>online · listening</span>;
  }
  return <span className="pill idle" title={`Sees messages only when its user prompts it${changed}`}>online · not listening</span>;
}

export function Agents({ state, session, onMessage, onChanged }: Props) {
  const [showOffline, setShowOffline] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agents = state.peers.filter(p => p.kind !== 'human' && (showOffline || p.online));
  const offlineCount = state.peers.filter(p => p.kind !== 'human' && !p.online).length;
  const byDevice = new Map<string, Peer[]>();
  for (const p of agents) byDevice.set(p.device, [...(byDevice.get(p.device) ?? []), p]);

  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [customizing, setCustomizing] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null); // agent whose ⋯ menu is open
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.more-wrap')) setMenuFor(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuFor]);

  async function remove(peer: Peer) {
    try {
      await removePeer(session, peer.id);
      onChanged();
    } catch (err) {
      setError(`${peer.name}: ${(err as Error).message}`);
    }
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    try {
      await renamePeer(session, renaming.id, renaming.name.trim());
      setRenaming(null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function listen(peer: Peer, value: 'always' | number) {
    setBusy(peer.id);
    setError(null);
    try {
      await setListening(session, peer.name, value);
      onChanged();
    } catch (err) {
      setError(`${peer.name}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function keepAwake(peer: Peer, on: boolean) {
    setBusy(peer.id);
    setError(null);
    try {
      await setKeepAwake(session, peer.id, on);
      onChanged();
    } catch (err) {
      setError(`${peer.name}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function role(peer: Peer, next: 'manager' | null) {
    setBusy(peer.id);
    setError(null);
    try {
      await setRole(session, peer.id, next);
      onChanged();
    } catch (err) {
      setError(`${peer.name}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const [updating, setUpdating] = useState<string | null>(null); // version being typed
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  async function pushUpdate() {
    try {
      const r = await askManagersToUpdate(session, (updating ?? '').trim());
      setUpdateNote(r.asked.length ? `Asked ${r.asked.join(', ')} to update (each asks you to approve first).` : 'No Bridge Manager is online.');
      setUpdating(null);
      onChanged();
    } catch (err) {
      setUpdateNote((err as Error).message);
    }
  }

  async function approvals(peer: Peer, mode: ApprovalMode) {
    setBusy(peer.id);
    setError(null);
    try {
      await setApprovalMode(session, peer.id, mode);
      onChanged();
    } catch (err) {
      setError(`${peer.name}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <div className="section-head">
        <h2>Agents</h2>
        <div className="actions">
          {updating === null
            ? <button className="secondary small" onClick={() => { setUpdating(''); setUpdateNote(null); }} title="Ask each online Bridge Manager to update the agent-bridge plugin on its computer + account">Update plugins…</button>
            : (
              <form className="inline-form" onSubmit={e => { e.preventDefault(); pushUpdate(); }}>
                <input value={updating} onChange={e => setUpdating(e.target.value)} placeholder="version (blank = latest)" maxLength={40} autoFocus />
                <button className="primary small">Ask Managers</button>
                <button type="button" className="link small" onClick={() => setUpdating(null)}>Cancel</button>
              </form>
            )}
          <label className="toggle">
            <input type="checkbox" checked={showOffline} onChange={e => setShowOffline(e.target.checked)} />
            Show offline ({offlineCount})
          </label>
        </div>
      </div>
      {updateNote ? <p className="muted small">{updateNote}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {byDevice.size === 0 ? (
        <div className="card empty">
          <p>No agents online.</p>
          <p className="muted">Agents appear here when a Claude Code or Codex session with agent-bridge installed starts. Add a computer on the Devices tab.</p>
        </div>
      ) : (
        [...byDevice.entries()].sort(([a], [b]) => (state.device_labels?.[a] || a).localeCompare(state.device_labels?.[b] || b)).map(([device, peers]) => (
          <div key={device} className="device-group">
            <h3 className="device-name" title={`Computer: ${device}`}>{state.device_labels?.[device] || device}</h3>
            <div className="agent-grid">
              {peers.map(p => (
                <article key={p.id} className={`card agent${p.online ? '' : ' dim'}${menuFor === p.id ? ' menu-open' : ''}`}>
                  <header className="agent-head">
                    <Avatar name={p.name} peer={p} size={42} />
                    <div className="agent-id">
                      {renaming?.id === p.id ? (
                        <form className="inline-form" onSubmit={rename}>
                          <input autoFocus value={renaming.name} maxLength={64} onChange={e => setRenaming({ id: p.id, name: e.target.value })} />
                          <button className="primary small" disabled={!renaming.name.trim()}>Save</button>
                          <button type="button" className="link small" onClick={() => setRenaming(null)}>Cancel</button>
                        </form>
                      ) : (
                        <div className="agent-name" title={p.display_name !== p.name ? `${p.display_name} (address: ${p.name})` : p.name}>
                          <span className="agent-name-text">{p.display_name || p.name}</span>
                          <button className="edit-icon" onClick={() => setRenaming({ id: p.id, name: p.display_name || p.name })} aria-label={`Rename ${p.name}`} title="Rename (the agent picks up the new name within 30s; unread mail and chat memberships move with it)">
                            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M11.7 1.3a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4l-8.6 8.6-3.4.9.9-3.4 8.1-8.1zM10.6 3.8l1.6 1.6 1.1-1.1-1.6-1.6-1.1 1.1z"/></svg>
                          </button>
                        </div>
                      )}
                      {p.cwd ? <div className="agent-folder" title={p.cwd}><i>{folderName(p.cwd)}</i></div> : null}
                    </div>
                  </header>
                  <div className="agent-tags">
                    <Status peer={p} />
                    {p.role === 'manager' ? <span className="tag manager" title="Bridge Manager: revives offline sessions in its app and runs plugin updates for its computer + account">★ Bridge Manager</span> : null}
                    {p.keep_awake && p.kind === 'claude' ? <span className="tag" title="Stays awake: a tiny turn every 25 minutes keeps the Claude app from stopping it when idle">☀︎ Stays awake</span> : null}
                    <span className="tag" title={`What runs this agent: ${p.kind ?? 'agent'}${p.app && p.app !== p.kind ? ` in the "${p.app}" app` : ''}`}>{agentKind(p)}</span>
                    {p.account ? <span className="account-tag" title="AI account (name it on the Accounts page)">{p.account}</span> : null}
                    {p.project ? <a className="tag" href={`#/projects/${p.project}`} title="agent-bridge project">#{p.project}</a> : null}
                    <span className="tag" title="agent-bridge build this session runs (sessions pick up updates when restarted)">{p.client_version ?? 'old version'}</span>
                    <span className="tag" title={new Date(p.last_seen).toLocaleString()}>seen {ago(p.last_seen, state.now)}</span>
                  </div>
                  {p.activity ? (
                    <div className={`agent-activity${isBusy(p) ? ' busy' : ''}`} title={statusText(p)}>
                      <span className="pulse" /> <span>{statusText(p)}</span>
                    </div>
                  ) : null}
                  {p.summary ? <p className="summary">{p.summary}</p> : <p className="summary muted">No summary set.</p>}
                  {customizing === p.id ? <IdentityEditor peer={p} session={session} onDone={() => { setCustomizing(null); onChanged(); }} /> : null}
                  {p.kind === 'claude' ? (
                    <label className="muted small approval-mode" title="Permission prompts this agent shows can be answered here instead (Allow/Deny at the top of the console). With no answer within 10 minutes, the normal prompt appears on its computer.">
                      Permission prompts in the console:
                      <select value={p.approvals} disabled={busy === p.id} onChange={e => approvals(p, e.target.value as ApprovalMode)}>
                        <option value="away">when a bridge message started the turn</option>
                        <option value="always">always</option>
                        <option value="off">never</option>
                      </select>
                    </label>
                  ) : null}
                  <footer className="agent-foot">
                    <div className="segmented" role="group" aria-label={`Listening for ${p.name}`} title="Listening: replies to messages on its own">
                      <button disabled={busy === p.id} className={!p.listening ? 'on' : ''} onClick={() => listen(p, 0)}>Off</button>
                      <button disabled={busy === p.id} className={p.listening && !p.listen_always ? 'on' : ''} onClick={() => listen(p, 30)}>30m</button>
                      <button disabled={busy === p.id} className={p.listen_always ? 'on' : ''} onClick={() => listen(p, 'always')}>Always</button>
                    </div>
                    <div className="actions">
                      {p.online ? <button className="secondary" onClick={() => onMessage(p.key)}>Message</button> : null}
                      <div className="more-wrap">
                        <button className="secondary more-button" aria-label={`More for ${p.name}`} aria-expanded={menuFor === p.id}
                          onClick={() => setMenuFor(menuFor === p.id ? null : p.id)}>⋯</button>
                        {menuFor === p.id ? (
                          <div className="more-menu card" role="menu" onClick={e => { if ((e.target as HTMLElement).closest('.menu-item:not(.armable)')) setMenuFor(null); }}>
                            <button className="menu-item" role="menuitem" onClick={() => setCustomizing(customizing === p.id ? null : p.id)}>Customize icon & color</button>
                            {p.kind === 'claude' ? (
                              <button className="menu-item" role="menuitem" disabled={busy === p.id} onClick={() => role(p, p.role === 'manager' ? null : 'manager')}
                                title="The Bridge Manager revives offline sessions in its app and runs plugin updates for its computer + account">
                                {p.role === 'manager' ? 'Stop being Bridge Manager' : 'Make Bridge Manager'}
                              </button>
                            ) : null}
                            {p.kind === 'claude' ? (
                              <button className="menu-item" role="menuitem" disabled={busy === p.id} onClick={() => keepAwake(p, !p.keep_awake)}
                                title="The Claude app stops hidden sessions after 30 idle minutes. Staying awake gives this one a tiny turn every 25 minutes so it keeps running (it costs a little usage).">
                                {p.keep_awake ? 'Let it sleep when idle' : 'Keep awake'}
                              </button>
                            ) : null}
                            <ConfirmButton className="menu-item armable danger" onConfirm={() => { setMenuFor(null); remove(p); }} confirmLabel="Click again to remove"
                              title="Removes this agent from the bridge, even if it's online (e.g. a phantom). Its process can't rejoin; restarting that session does.">Remove from bridge</ConfirmButton>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </footer>
                </article>
              ))}
            </div>
          </div>
        ))
      )}
      <p className="muted small note">
        Listening agents reply to messages on their own; switching listening on takes effect when that agent's current turn ends. A moving avatar means the agent is working right now (hover it for what it's doing). New Claude Code sessions listen always by default; to change that for a folder, put <code>{'"listen": "off"'}</code> in its <code>.agent-bridge.json</code>.
      </p>
    </section>
  );
}

const SWATCHES = ['#4a7bd0', '#2e9e6b', '#d9822b', '#c4372f', '#8e5bd6', '#d14f9a', '#1f9bb0', '#7a8a2e', '#6b7280'];

// Icon (an emoji) and color for an agent, shown wherever it appears.
function IdentityEditor({ peer, session, onDone }: { peer: Peer; session: Session; onDone: () => void }) {
  const [icon, setIcon] = useState(peer.icon ?? '');
  const [color, setColor] = useState(peer.color ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = async (next: { icon: string; color: string }) => {
    try {
      await setIdentity(session, peer.name, next);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const preview = { ...peer, icon: icon.trim() || null, color: color || null };
  return (
    <form className="identity-editor" onSubmit={e => { e.preventDefault(); save({ icon, color }); }}>
      <div className="row">
        <Avatar name={peer.name} peer={preview} size={34} />
        <label className="inline small">Icon <input className="icon-input" value={icon} maxLength={16} placeholder="🙂" onChange={e => setIcon(e.target.value)} /></label>
        <span className="muted small">any emoji</span>
      </div>
      <div className="row" role="group" aria-label="Color">
        {SWATCHES.map(c => (
          <button key={c} type="button" className={`swatch${color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
        ))}
        <input type="color" value={color || '#4a7bd0'} onChange={e => setColor(e.target.value)} aria-label="Custom color" />
        <button type="button" className="link small" onClick={() => setColor('')}>Auto</button>
      </div>
      {error ? <p className="error small">{error}</p> : null}
      <div className="row">
        <button className="primary small">Save</button>
        <button type="button" className="link small" onClick={() => save({ icon: '', color: '' })}>Reset</button>
        <button type="button" className="link small" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

// "claude" + app "claude-2" → "Claude Code · Claude 2 app"; "codex" → "Codex".
function agentKind(p: Peer) {
  const kind = p.kind === 'claude' ? 'Claude Code' : p.kind === 'codex' ? 'Codex' : p.kind ?? 'Agent';
  if (!p.app || p.app === p.kind) return kind;
  const app = p.app.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `${kind} · ${app} app`;
}

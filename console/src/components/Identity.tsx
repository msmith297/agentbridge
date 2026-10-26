import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HubState, Peer } from '../api';
import { ago, folderName } from '../format';
import { nameHue } from './Mentions';

// How an agent is shown everywhere: [avatar] Name  project (small italic) ······ computer · account

export function findPeer(state: HubState, name: string): Peer | undefined {
  const lower = name.toLowerCase();
  return state.peers.find(p => p.name === name) ?? state.peers.find(p => p.name.toLowerCase() === lower);
}

// Busy = its hooks reported thinking/working recently (statuses older than this are stale).
const BUSY_FOR_MS = 3 * 60_000;
export const isBusy = (peer?: Peer | null) =>
  Boolean(peer?.online && peer.activity && peer.activity.state !== 'idle' && Date.now() - peer.activity.at < BUSY_FOR_MS);

export function statusText(peer?: Peer | null) {
  const a = peer?.activity;
  if (!a) return '';
  const what = a.state === 'idle' ? 'Idle' : a.state === 'thinking' ? 'Thinking' : 'Working';
  return `${what}${a.detail ? ` · ${a.detail}` : ''} (${ago(a.at, Date.now())})`;
}

// The name to show for an address (agents can share a display name; `name` stays unique).
export const displayName = (state: HubState, name: string) => findPeer(state, name)?.display_name || name;

// Agents from apps other than Claude Code / Codex get their app's mark (e.g. a SolidWorks add-in).
export function appMark(peer?: Peer | null): { text: string; color: string; label: string } | null {
  if (!peer || peer.kind === 'human' || peer.kind === 'claude' || peer.kind === 'codex') return null;
  const hay = `${peer.kind ?? ''} ${peer.app ?? ''} ${peer.display_name ?? ''} ${peer.name}`;
  if (/solid\s*works/i.test(hay)) return { text: 'SW', color: '#da291c', label: 'SolidWorks' };
  return null;
}

export function Avatar({ name, peer, size = 20 }: { name: string; peer?: Peer | null; size?: number }) {
  const hue = nameHue('agent', name);
  const mark = peer?.icon ? null : appMark(peer);
  const color = peer?.color || mark?.color || `hsl(${hue} 55% 52%)`;
  const human = peer?.kind === 'human';
  const glyph = peer?.icon || (human ? '👤' : mark ? mark.text : (peer?.display_name || name).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '?');
  const busy = isBusy(peer);
  const status = statusText(peer);
  return (
    <span className={`avatar${peer?.icon || human ? ' emoji' : ''}${busy ? ` busy ${peer!.activity!.state}` : ''}`}
      title={status ? `${name}: ${status}` : undefined}
      style={{
        width: size, height: size, fontSize: Math.round(size * (peer?.icon ? 0.62 : mark ? 0.4 : 0.5)), fontWeight: mark ? 800 : undefined,
        background: peer?.icon ? `color-mix(in srgb, ${color} 24%, var(--avatar-base, #fff))` : color,
        ['--ring' as string]: color, animationDelay: `-${hue % 9}s`,
      }}>
      {glyph}
    </span>
  );
}

export function Identity({ name, state, peer, compact = false, extra }: {
  name: string; state: HubState; peer?: Peer | null; compact?: boolean; extra?: React.ReactNode;
}) {
  const p = peer === undefined ? findPeer(state, name) : peer;
  const machine = p && p.kind !== 'human' ? state.device_labels?.[p.device] || p.device : null;
  return (
    <span className={`identity${compact ? ' compact' : ''}`}>
      <Avatar name={name} peer={p} />
      <span className="id-name" title={p?.display_name && p.display_name !== name ? `Address: ${name}` : undefined}>{p?.display_name || name}</span>
      {p?.cwd && p.kind !== 'human' ? <i className="id-project" title={p.cwd}>{folderName(p.cwd)}</i> : null}
      {extra}
      {!compact && (machine || p?.account) ? (
        <span className="id-tags">
          {machine ? <span className="machine-tag">{machine}</span> : null}
          {p?.account ? <span className="account-tag" title="AI account">{p.account}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

// A searchable agent list in a popover, replacing native <select>s (which can't show identities).
export function PeerPicker({ state, peers, label, onPick, className = '' }: {
  state: HubState; peers: Peer[]; label: string; onPick: (name: string) => void; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<React.CSSProperties>({});
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    // The list floats above the page (fixed), so scroll areas around the button don't clip it.
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(Math.max(r.width, 540), window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const below = window.innerHeight - r.bottom - 12;
      setPos(below > 260 || below > r.top
        ? { top: r.bottom + 4, left, width, maxHeight: Math.min(400, below) }
        : { bottom: window.innerHeight - r.top + 4, left, width, maxHeight: Math.min(400, r.top - 12) });
    };
    place();
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return peers.filter(p => !needle || [p.name, p.display_name, p.project, p.cwd && folderName(p.cwd), p.device, state.device_labels?.[p.device], p.account]
      .some(v => v?.toLowerCase().includes(needle)));
  }, [peers, q, state.device_labels]);
  const pick = (name: string) => { setOpen(false); setQ(''); onPick(name); };

  return (
    <div className={`peer-picker ${className}`} ref={box}>
      <button type="button" className="picker-button" onClick={() => { setOpen(!open); setActive(0); }} aria-expanded={open}>
        {label} <span aria-hidden>▾</span>
      </button>
      {open ? createPortal(
        <div className="picker-pop card" role="listbox" style={pos} ref={pop}>
          <input autoFocus placeholder="Search agents, projects, computers…" value={q}
            onChange={e => { setQ(e.target.value); setActive(0); }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % Math.max(shown.length, 1)); }
              if (e.key === 'Enter' && shown[active]) { e.preventDefault(); pick(shown[active].name); }
              if (e.key === 'Escape') setOpen(false);
            }} />
          <div className="picker-list">
            {shown.length === 0 ? <p className="muted small conv-empty">No matches.</p> : shown.map((p, i) => (
              <button type="button" key={p.id} role="option" aria-selected={i === active} className={`picker-row${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)} onClick={() => pick(p.name)}>
                <span className={!p.online ? 'dot' : p.kind === 'human' || p.listening ? 'dot good' : 'dot idle'} />
                <Identity name={p.name} state={state} peer={p} />
              </button>
            ))}
          </div>
        </div>, document.body,
      ) : null}
    </div>
  );
}

// Group members as overlapping avatars (like a group chat's header); click for the list.
export function MemberStack({ names, state, max = 6, onClick, title, noun = 'member' }: {
  names: string[]; state: HubState; max?: number; onClick?: () => void; title?: string; noun?: string;
}) {
  const shown = names.slice(0, max);
  return (
    <button type="button" className="member-stack" onClick={onClick} title={title ?? names.join(', ')} aria-label={`${names.length} members: ${names.join(', ')}`}>
      <span className="stack-avatars">
        {shown.map(n => <Avatar key={n} name={n} peer={findPeer(state, n) ?? null} size={28} />)}
        {names.length > max ? <span className="avatar more" style={{ width: 28, height: 28 }}>+{names.length - max}</span> : null}
      </span>
      <span className="stack-count">{names.length} {names.length === 1 ? noun : `${noun}s`}</span>
    </button>
  );
}

// Closes a popup (member list, menus) on a click outside the element matching `selector`.
export function useCloseOnOutsideClick(open: boolean, close: () => void, selector: string) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(selector)) close(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close, selector]);
}

// "… is thinking" with typing dots, above a conversation's composer, while members are busy.
export function TypingRow({ names, state, me }: { names: string[]; state: HubState; me: string }) {
  const busy = [...new Set(names)].filter(n => n.toLowerCase() !== me)
    .map(n => findPeer(state, n)).filter((p): p is Peer => isBusy(p));
  // Keep the row's space when nobody is busy, so the conversation doesn't jump as agents start/stop.
  if (!busy.length) return <div className="typing-row idle" aria-hidden />;
  const verb = (p: Peer) => (p.activity?.state === 'thinking' ? 'thinking' : 'working');
  const label = busy.length === 1 ? `${busy[0].display_name || busy[0].name} is ${verb(busy[0])}`
    : busy.length === 2 ? `${busy[0].display_name || busy[0].name} and ${busy[1].display_name || busy[1].name} are working`
    : `${busy.length} agents are working`;
  return (
    <div className="typing-row" role="status" title={busy.map(p => `${p.display_name || p.name}: ${statusText(p)}`).join('\n')}>
      <span className="typing-avatars">{busy.slice(0, 3).map(p => <Avatar key={p.id} name={p.name} peer={p} size={22} />)}</span>
      <span className="typing-dots" aria-hidden><i /><i /><i /></span>
      <span className="typing-label">{label}</span>
    </div>
  );
}

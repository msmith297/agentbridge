import { useEffect, useRef, useState } from 'react';
import type { HubState, Peer } from '../api';
import { Avatar, isBusy, statusText } from './Identity';

// Top-bar status: the agents working right now pop in (and out when they stop), next to simple
// counts: busy · online · total. Clicking an avatar opens the conversation that agent is working in.

const MAX_SHOWN = 3; // the rest show as "+N" (keeps the bar compact at every width)
const OUT_MS = 260; // matches the pop-out animation in styles.css

type Slot = { peer: Peer; phase: 'in' | 'out' };

// Where an agent is working: the conversation it last sent to (a group chat, a project chat, or its
// DM with the operator; "All messages" for a message to another agent, which has no thread of its
// own here). Its DM when it hasn't sent anything the console has loaded.
function workingIn(state: HubState, peer: Peer): { href: string; label: string } {
  const dm = { href: `#/messages/dm/${encodeURIComponent(peer.key)}`, label: 'your chat with it' };
  const sent = state.messages.find(m => (m.from_key ? m.from_key === peer.key : m.from === peer.name)); // newest first
  if (!sent) return dm;
  if (sent.chat_id) {
    return { href: `#/messages/chat/${sent.chat_id}`, label: `# ${(state.chats ?? []).find(c => c.id === sent.chat_id)?.title ?? sent.chat_id}` };
  }
  if (sent.project) return { href: `#/projects/${encodeURIComponent(sent.project)}/chat`, label: `project ${sent.project}` };
  const toHuman = sent.to_key?.startsWith('human:') || state.peers.some(p => p.kind === 'human' && p.name === sent.to);
  return toHuman ? dm : { href: '#/messages', label: `All messages (its message to ${sent.to})` };
}

export function StatusBar({ state }: { state: HubState }) {
  const agents = state.peers.filter(p => p.kind !== 'human');
  const busy = agents.filter(p => isBusy(p));
  const online = agents.filter(p => p.online).length;
  const slots = useSlots(busy);
  const shown = slots.slice(0, MAX_SHOWN);
  const extra = busy.length - shown.filter(s => s.phase === 'in').length;

  return (
    <div className="status-bar" aria-label={`${busy.length} busy, ${online} online, ${agents.length} agents in total`}>
      {slots.length ? (
        <div className="busy-stack">
          {shown.map(({ peer, phase }) => {
            const where = workingIn(state, peer);
            return (
              <a key={peer.id} className={`busy-slot ${phase}`} href={where.href}
                title={`${peer.display_name || peer.name}: ${statusText(peer) || 'busy'} · opens ${where.label}`}>
                <Avatar name={peer.name} peer={peer} size={24} />
              </a>
            );
          })}
          {extra > 0 ? <span className="busy-more" title={`${extra} more busy`}>+{extra}</span> : null}
        </div>
      ) : null}
      <div className="status-stats">
        <span className={`stat busy${busy.length ? ' on' : ''}`} title="Agents working right now"><span className="stat-dot" />{busy.length}<span className="stat-label"> busy</span></span>
        <span className="stat-sep" aria-hidden>·</span>
        <span className="stat" title="Agents online">{online}<span className="stat-label"> online</span></span>
        <span className="stat-sep total" aria-hidden>·</span>
        <span className="stat total" title="All agents, including offline">{agents.length}<span className="stat-label"> total</span></span>
      </div>
    </div>
  );
}

// Keeps agents that just stopped around briefly so they can animate out.
function useSlots(busy: Peer[]): Slot[] {
  const [slots, setSlots] = useState<Slot[]>(() => busy.map(peer => ({ peer, phase: 'in' })));
  const timers = useRef(new Map<string, number>());
  const ids = busy.map(p => p.id).join('|');

  useEffect(() => {
    const now = new Map(busy.map(p => [p.id, p]));
    setSlots(prev => {
      const next: Slot[] = prev.map(s => (now.has(s.peer.id) ? { peer: now.get(s.peer.id)!, phase: 'in' } : { ...s, phase: 'out' }));
      for (const p of busy) if (!prev.some(s => s.peer.id === p.id)) next.push({ peer: p, phase: 'in' });
      return next;
    });
    for (const p of busy) { const t = timers.current.get(p.id); if (t) { clearTimeout(t); timers.current.delete(p.id); } }
  }, [ids]); // busy itself is a new array every render; its ids are what matter

  useEffect(() => {
    for (const s of slots) {
      if (s.phase !== 'out' || timers.current.has(s.peer.id)) continue;
      timers.current.set(s.peer.id, window.setTimeout(() => {
        timers.current.delete(s.peer.id);
        setSlots(prev => prev.filter(x => !(x.peer.id === s.peer.id && x.phase === 'out')));
      }, OUT_MS));
    }
  }, [slots]);

  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);
  return slots;
}

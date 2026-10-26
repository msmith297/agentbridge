import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import {
  ackMessages, attachmentUrl, chatAction, hideConversation, MAX_ATTACHMENT_BYTES, sendMessage,
  type Attachment, type Chat, type HubState, type Message, type Peer, type Session,
} from '../api';
import { ago, folderName, stamp } from '../format';
import { ConfirmButton } from '../components/ConfirmButton';
import { useSidebarWidth } from '../components/SidebarResizer';
import { openLightbox } from '../components/Lightbox';
import { OriginIcons } from '../components/OriginIcons';
import { Avatar, displayName, Identity, MemberStack, PeerPicker, TypingRow, useCloseOnOutsideClick } from '../components/Identity';
import { discardOutgoing, dropUpload, linkSent, redirectOutgoing, retryOutgoing, retryUpload, sendQueued, sentKey, setReplyTo, startUpload, useOutbox } from '../outbox';
import { activeQuery, MentionMenu, mentionedAgents, mentionTargets, suggestions, withMentions, type MentionTarget } from '../components/Mentions';

// A DM is identified by the other agent's stable key (Peer.key), not its name: names change.
export type MessagesView = { kind: 'all' } | { kind: 'dm'; key: string } | { kind: 'chat'; id: number } | { kind: 'project'; slug: string };

interface Props {
  state: HubState;
  session: Session;
  view: MessagesView;
  onChanged: () => void | Promise<unknown>;
}

const SYSTEM = 'agent-bridge';
const go = (hash: string) => { location.hash = hash; };
const dmHash = (key: string) => `/messages/dm/${encodeURIComponent(key)}`;
const URL_RE = /(https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]])/;
// Text and links alternating (links at odd indexes). A ")" right after a link is part of it when the
// link opened one, e.g. https://en.wikipedia.org/wiki/Foo_(bar).
function splitLinks(text: string) {
  const bits = text.split(URL_RE);
  for (let k = 1; k < bits.length; k += 2) {
    const open = (bits[k].match(/\(/g) ?? []).length, close = (bits[k].match(/\)/g) ?? []).length;
    if (open > close && bits[k + 1]?.startsWith(')')) { bits[k] += ')'; bits[k + 1] = bits[k + 1].slice(1); }
  }
  return bits;
}

// The other side of a direct message, by stable identity. Older messages have no keys: use the
// agent that holds that name now if there's exactly one, else the name itself ("name:…").
function peerByKey(state: HubState, key: string) {
  return state.peers.find(p => p.key === key);
}
function keyForName(state: HubState, name: string) {
  const lower = name.toLowerCase();
  const exact = state.peers.filter(p => p.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0].key;
  const shown = state.peers.filter(p => p.display_name.toLowerCase() === lower);
  return shown.length === 1 ? shown[0].key : `name:${name}`;
}
function otherSide(state: HubState, m: Message, me: string): { key: string; name: string } {
  const fromMe = m.from.toLowerCase() === me;
  const name = fromMe ? m.to : m.from;
  const key = fromMe ? m.to_key : m.from_key;
  return { key: key && key !== `human:${me}` ? key : keyForName(state, name), name };
}
// What to call the agent behind a DM key, and where to send to it right now.
function dmName(state: HubState, key: string) {
  return peerByKey(state, key)?.display_name ?? (key.startsWith('name:') ? key.slice(5) : state.messages.find(m => m.from_key === key)?.from ?? state.messages.find(m => m.to_key === key)?.to ?? key);
}
function dmAddress(state: HubState, key: string) {
  return peerByKey(state, key)?.name ?? (key.startsWith('name:') ? key.slice(5) : state.messages.find(m => m.from_key === key)?.from ?? state.messages.find(m => m.to_key === key)?.to ?? key);
}

// An old thread that only knows a name several agents now share: who it could mean.
function dmTwins(state: HubState, key: string) {
  if (peerByKey(state, key) || !key.startsWith('name:')) return [];
  const name = key.slice(5).toLowerCase();
  return state.peers.filter(p => p.kind !== 'human' && (p.display_name.toLowerCase() === name || p.name.toLowerCase() === name));
}

// A DM's messages up to this id were deleted from this console (newer ones bring it back).
const hiddenUpTo = (state: HubState, key: string) => state.hidden?.[`dm:${key}`] ?? 0;

// One send to several recipients is stored per recipient; show it once.
export interface Entry { key: string; first: Message; to: string[]; unread: number[]; seen: string[] }

export function group(messages: Message[], me: string): Entry[] {
  const byKey = new Map<string, Entry>();
  for (const m of [...messages].sort((a, b) => a.id - b.id)) {
    const key = m.send_id || `m${m.id}`;
    const e = byKey.get(key) ?? { key, first: m, to: [], unread: [], seen: [] };
    e.to.push(m.to);
    if (m.delivered_at) e.seen.push(m.to);
    if (m.to.toLowerCase() === me && !m.delivered_at) e.unread.push(m.id);
    byKey.set(key, e);
  }
  return [...byKey.values()];
}

const findPeer = (state: HubState, name: string) =>
  state.peers.find(p => p.name === name && p.online) ?? state.peers.find(p => p.name === name);

export function Messages({ state, session, view, onChanged }: Props) {
  const me = session.name.toLowerCase();
  const chats = state.chats ?? [];
  const activeChat = view.kind === 'chat' ? chats.find(c => c.id === view.id) ?? null : null;

  // Direct conversations: messages outside chats between me and each peer.
  const dms = useMemo(() => {
    const last = new Map<string, number>();
    const unread = new Map<string, number>();
    for (const m of state.messages) {
      if (m.chat_id || m.project) continue; // group chats and project chats aren't direct messages
      if (m.from.toLowerCase() !== me && m.to.toLowerCase() !== me) continue;
      const other = otherSide(state, m, me);
      if (other.name === SYSTEM || m.id <= hiddenUpTo(state, other.key)) continue;
      last.set(other.key, Math.max(last.get(other.key) ?? 0, m.created_at));
      if (m.to.toLowerCase() === me && !m.delivered_at) unread.set(other.key, (unread.get(other.key) ?? 0) + 1);
    }
    return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => ({ key, name: dmName(state, key), unread: unread.get(key) ?? 0 }));
  }, [state, me]);

  const chatUnread = (c: Chat) => state.messages.filter(m => m.chat_id === c.id && m.to.toLowerCase() === me && !m.delivered_at).length;

  const entries = useMemo(() => {
    const inView = (m: Message) => view.kind === 'all' ? true
      : view.kind === 'chat' ? m.chat_id === view.id
      : view.kind === 'project' ? false // project chats live on the Projects page
      : !m.chat_id && !m.project && (m.from.toLowerCase() === me || m.to.toLowerCase() === me) && otherSide(state, m, me).key === view.key
        && m.id > hiddenUpTo(state, view.key);
    return group(state.messages.filter(inView), me);
  }, [state, view, me]);

  // Reading a conversation marks its messages to me as read.
  const unreadIds = entries.flatMap(e => e.unread);
  const unreadKey = unreadIds.join(',');
  useEffect(() => {
    if (unreadIds.length) ackMessages(session, unreadIds).then(onChanged, () => {});
  }, [unreadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useStoredFilter();
  const devices = useMemo(() => [...new Set(state.peers.filter(p => p.kind !== 'human').map(p => p.device))].sort(), [state.peers]);
  const shownDms = dms.filter(d => {
    const peer = peerByKey(state, d.key);
    const online = Boolean(peer?.online);
    if (filter.status === 'online' && !online) return false;
    if (filter.status === 'offline' && online) return false;
    return !filter.device || peer?.device === filter.device;
  });

  // Phones show the conversation list or the open conversation, not both.
  const viewKey = convKey(view);
  const [listOpen, setListOpen] = useState(false);
  const sidebar = useSidebarWidth();
  useEffect(() => setListOpen(false), [viewKey]);
  const totalUnread = dms.reduce((n, d) => n + d.unread, 0) + chats.reduce((n, c) => n + chatUnread(c), 0);

  return (
    <section className={`msg-layout${listOpen ? ' list-open' : ''}`} style={sidebar.style}>
      {sidebar.handle}
      <aside className="card conv-list" onClick={e => { if ((e.target as HTMLElement).closest('.conv')) setListOpen(false); }}>
        <button className={`conv${view.kind === 'all' ? ' active' : ''}`} onClick={() => go('/messages')}>All messages</button>

        <div className="conv-head">Direct</div>
        <NewDirect state={state} me={me} />
        <div className="conv-filters">
          <select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value as StatusFilter })} aria-label="Filter by status">
            <option value="all">All</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
          </select>
          <select value={filter.device} onChange={e => setFilter({ ...filter, device: e.target.value })} aria-label="Filter by computer">
            <option value="">All computers</option>
            {devices.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        {shownDms.length === 0 && dms.length ? <p className="muted small conv-empty">No conversations match.</p> : null}
        {shownDms.map(d => {
          const peer = peerByKey(state, d.key);
          return (
          <button key={d.key} className={`conv${view.kind === 'dm' && view.key === d.key ? ' active' : ''}`} onClick={() => go(dmHash(d.key))}
            title={`${d.name}${peer?.device && peer.kind !== 'human' ? ` · ${peer.device}` : ''} · ${peer ? statusLabel(peer) : 'removed'}`}>
            <span className="conv-name"><Dot peer={peer} />{' '}
              {/* The unread count sits on the avatar's corner, so the computer/account icons stay in one column. */}
              <span className="conv-avatar"><Avatar name={peer?.name ?? d.name} peer={peer} size={18} />
                {d.unread ? <span className="count alert conv-badge" aria-label={`${d.unread} unread`}>{d.unread > 99 ? '99+' : d.unread}</span> : null}</span>
              {' '}<span className="conv-text">{d.name}</span></span>
            <OriginIcons peer={peer} state={state} />
          </button>
          );
        })}

        <div className="conv-head">
          Group chats
          <button className="link small" onClick={() => setCreating(true)}>+ New</button>
        </div>
        {creating ? <NewChat state={state} session={session} me={me} onClose={() => setCreating(false)}
          onDone={async id => { await onChanged(); setCreating(false); go(`/messages/chat/${id}`); }} /> : null}
        {chats.length === 0 && !creating ? <p className="muted small conv-empty">No group chats yet.</p> : null}
        {chats.map(c => (
          <button key={c.id} className={`conv${view.kind === 'chat' && view.id === c.id ? ' active' : ''}`} onClick={() => go(`/messages/chat/${c.id}`)}>
            <span className="conv-name" title={c.title}><span className="conv-text"># {c.title}</span></span>
            {chatUnread(c) ? <span className="count alert">{chatUnread(c)}</span> : null}
          </button>
        ))}
      </aside>

      <div className="conv-main">
        <button className="conv-toggle secondary" onClick={() => setListOpen(true)}>
          ☰ Conversations{totalUnread ? <span className="count alert">{totalUnread}</span> : null}
        </button>
        <ConversationHeader view={view} chat={activeChat} state={state} session={session} onChanged={onChanged} entries={entries} />
        <Feed entries={entries} state={state} session={session} me={me} view={view} onChanged={onChanged} />
        <TypingRow state={state} me={me} names={view.kind === 'dm' ? [dmAddress(state, view.key)] : view.kind === 'chat' ? activeChat?.members ?? [] : []} />
        <Composer key={viewKey}
          view={view} chat={activeChat} state={state} session={session} me={me} onChanged={onChanged} />
      </div>
    </section>
  );
}

type StatusFilter = 'all' | 'online' | 'offline';
const FILTER_KEY = 'agent-bridge-dm-filter';

// Direct-list filter, remembered in this browser.
function useStoredFilter(): [{ status: StatusFilter; device: string }, (f: { status: StatusFilter; device: string }) => void] {
  const [filter, setFilterState] = useState<{ status: StatusFilter; device: string }>(() => {
    try { return { status: 'all', device: '', ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') }; } catch { return { status: 'all', device: '' }; }
  });
  const setFilter = (f: { status: StatusFilter; device: string }) => {
    setFilterState(f);
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* storage unavailable */ }
  };
  return [filter, setFilter];
}

function Dot({ peer }: { peer?: Peer }) {
  const cls = !peer || !peer.online ? 'dot' : peer.kind === 'human' || peer.listening ? 'dot good' : 'dot idle';
  const title = !peer ? 'unknown' : !peer.online ? 'offline' : peer.kind === 'human' ? 'online'
    : peer.listening ? 'online, listening' : 'online, not listening';
  return <span className={cls} title={title} />;
}

// Peers you can message: online by default; never yourself or the system sender.
function recipients(state: HubState, me: string, includeOffline: boolean) {
  const seen = new Set<string>();
  return state.peers
    .filter(p => p.name.toLowerCase() !== me && p.name !== SYSTEM && (includeOffline || p.online))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    .filter(p => (seen.has(p.name) ? false : (seen.add(p.name), true)));
}

function statusLabel(p: Peer) {
  if (!p.online) return 'offline';
  if (p.kind === 'human') return 'human';
  return p.listening ? 'listening' : 'not listening';
}

function NewDirect({ state, me }: { state: HubState; me: string }) {
  return <PeerPicker className="conv-select" state={state} peers={recipients(state, me, true)} label="+ Direct message…" onPick={n => go(dmHash(keyForName(state, n)))} />;
}

// New group chat: a dialog with a searchable member list that shows full identities (avatar, name,
// folder, computer · account), so agents that share a name can be told apart.
function NewChat({ state, session, me, onDone, onClose }: {
  state: HubState; session: Session; me: string; onDone: (id: number) => void; onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [offline, setOffline] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = recipients(state, me, offline);
  const needle = q.trim().toLowerCase();
  const shown = options.filter(p => !needle || [p.name, p.display_name, p.cwd && folderName(p.cwd), p.device, state.device_labels?.[p.device], p.account]
    .some(v => v?.toLowerCase().includes(needle)));
  const toggle = (name: string) => setPicked(picked.includes(name) ? picked.filter(n => n !== name) : [...picked, name]);
  const peerOf = (name: string) => state.peers.find(p => p.name === name);
  // Chips name the computer (and account) when several agents share a display name.
  const chipLabel = (name: string) => {
    const p = peerOf(name);
    const shown = displayName(state, name);
    if (!p || state.peers.filter(x => x.display_name === p.display_name).length < 2) return shown;
    const machine = state.device_labels?.[p.device] || p.device;
    const sameMachine = state.peers.filter(x => x.display_name === p.display_name && x.device === p.device).length > 1;
    return `${shown} · ${machine}${sameMachine && p.account ? ` · ${p.account}` : ''}`;
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!picked.length || busy) return;
    setError(null);
    setBusy(true);
    try {
      const chat = await chatAction(session, { action: 'create', title: title.trim() || undefined, members: picked });
      onDone(chat.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog card new-chat-dialog" role="dialog" aria-label="New group chat" onSubmit={create}>
        <h3>New group chat</h3>
        <input autoFocus placeholder="Chat name (optional)" value={title} onChange={e => setTitle(e.target.value)} maxLength={80} />
        <div className="nc-chips" aria-label="Members">
          {picked.length === 0 ? <span className="muted small">Pick at least one agent below.</span> : picked.map(n => (
            <span key={n} className="chip nc-chip">
              <Avatar name={n} peer={peerOf(n)} size={18} /> {chipLabel(n)}
              <button type="button" className="link small" onClick={() => toggle(n)} aria-label={`Remove ${chipLabel(n)}`}>✕</button>
            </span>
          ))}
        </div>
        <input placeholder="Search agents, folders, computers…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search agents" />
        <div className="nc-list" role="listbox" aria-multiselectable="true">
          {shown.length === 0 ? <p className="muted small conv-empty">{options.length ? 'No matches.' : offline ? 'No agents.' : 'No agents online. Turn on "Show offline" to add offline ones.'}</p> : shown.map(p => {
            const on = picked.includes(p.name);
            return (
              <button type="button" key={p.id} role="option" aria-selected={on} className={`nc-row${on ? ' on' : ''}`} onClick={() => toggle(p.name)}>
                <span className="nc-check" aria-hidden>{on ? '✓' : ''}</span>
                <Dot peer={p} />
                <Identity name={p.name} state={state} peer={p} />
                <span className="nc-status muted small">{statusLabel(p)}</span>
              </button>
            );
          })}
        </div>
        <label className="toggle small"><input type="checkbox" checked={offline} onChange={e => setOffline(e.target.checked)} /> Show offline agents</label>
        {error ? <p className="error small">{error}</p> : null}
        <div className="nc-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!picked.length || busy}>
            {busy ? 'Creating…' : picked.length ? `Create chat · ${picked.length} member${picked.length === 1 ? '' : 's'}` : 'Create chat'}
          </button>
        </div>
      </form>
    </div>, document.body,
  );
}

function ConversationHeader({ view, chat, state, session, onChanged, entries }: {
  view: MessagesView; chat: Chat | null; state: HubState; session: Session; onChanged: () => void; entries: Entry[];
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  useCloseOnOutsideClick(showMembers, () => setShowMembers(false), '.members-wrap, .picker-pop');
  if (view.kind === 'all') return <div className="section-head"><h2>All messages</h2></div>;
  if (view.kind === 'dm') {
    const peer = peerByKey(state, view.key);
    const name = dmName(state, view.key);
    // An old thread that only knows a name several agents now share: ask which one is meant.
    const twins = dmTwins(state, view.key);
    // Delete it from this console: read what's unread, then hide it up to its newest message.
    const remove = async () => {
      try {
        const unread = entries.flatMap(e => e.unread);
        if (unread.length) await ackMessages(session, unread);
        await hideConversation(session, convKey(view), Math.max(0, ...entries.flatMap(e => [e.first.id])));
        onChanged();
        go('/messages');
      } catch (err) {
        setError((err as Error).message);
      }
    };
    return (
      <div className="chat-head">
        <div className="section-head">
          <h2 className="dm-title"><Dot peer={peer} /> <Identity name={peer?.name ?? name} state={state} peer={peer ?? null} /></h2>
          <span className="muted small">{peer ? statusLabel(peer) : twins.length > 1 ? `${twins.length} agents are called that` : 'not connected'}</span>
          {entries.length ? (
            <ConfirmButton className="link small danger-link dm-delete" onConfirm={remove} confirmLabel="Delete for you?"
              title="Remove this conversation from your console. The agents keep their copies; a new message brings it back.">Delete conversation</ConfirmButton>
          ) : null}
        </div>
        {error ? <p className="error small">{error}</p> : null}
        {twins.length > 1 ? (
          <div className="which-twin">
            <span className="muted small">Which {name}? Messages here went to an older address.</span>
            {twins.map(t => (
              <button key={t.key} className="secondary small" onClick={() => { moveDraft(view, { kind: 'dm', key: t.key }); go(dmHash(t.key)); }}>
                <Identity name={t.name} state={state} peer={t} compact /> <span className="muted small">{state.device_labels?.[t.device] || t.device}{t.account ? ` · ${t.account}` : ''}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (!chat) return <div className="section-head"><h2>Chat not found</h2></div>;
  const act = (body: Record<string, unknown>) => chatAction(session, { chat: chat.id, ...body }).then(() => { setError(null); onChanged(); }, err => setError(err.message));
  const candidates = state.peers.filter(p => p.online && p.name !== SYSTEM && !chat.members.includes(p.name));
  return (
    <div className="chat-head">
      <div className="section-head">
        {renaming === null ? (
          <h2 className="agent-name"># {chat.title}
            <button className="edit-icon" onClick={() => setRenaming(chat.title)} aria-label="Rename chat" title="Rename chat">
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M11.7 1.3a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4l-8.6 8.6-3.4.9.9-3.4 8.1-8.1zM10.6 3.8l1.6 1.6 1.1-1.1-1.6-1.6-1.1 1.1z"/></svg>
            </button>
          </h2>
        ) : (
          <form className="inline-form" onSubmit={e => { e.preventDefault(); if (renaming.trim()) act({ action: 'rename', title: renaming.trim() }); setRenaming(null); }}>
            <input autoFocus value={renaming} onChange={e => setRenaming(e.target.value)} maxLength={80} />
            <button className="primary small">Save</button>
            <button type="button" className="link small" onClick={() => setRenaming(null)}>Cancel</button>
          </form>
        )}
        <div className="actions">
          <div className="members-wrap">
            <MemberStack names={chat.members} state={state} onClick={() => setShowMembers(!showMembers)} />
            {showMembers ? (
              <div className="members-pop card">
                {chat.members.map(n => (
                  <div key={n} className="member-row">
                    <Dot peer={findPeer(state, n)} />
                    <Identity name={n} state={state} />
                    {n.toLowerCase() !== session.name.toLowerCase()
                      ? <button className="link small" onClick={() => act({ action: 'remove', members: [n] })} aria-label={`Remove ${n}`} title="Remove from chat">✕</button> : null}
                  </div>
                ))}
                {candidates.length ? <PeerPicker state={state} peers={candidates} label="+ Add member…" onPick={n => act({ action: 'add', members: [n] })} /> : null}
              </div>
            ) : null}
          </div>
          <ConfirmButton title="Its messages stay in All messages" onConfirm={() =>
            chatAction(session, { action: 'delete', chat: chat.id }).then(() => { onChanged(); go('/messages'); }, err => setError(err.message))}>Delete</ConfirmButton>
        </div>
      </div>
      {error ? <p className="error small">{error}</p> : null}
    </div>
  );
}

// Message list shared by conversations and project chats. `all` (for reply previews) and `labels`
// (machine names) default to the hub state's.
export function Feed({ entries, state, session, me, view, all, labels, onChanged }: {
  entries: Entry[]; state: HubState; session: Session; me: string; view: MessagesView; all?: Message[]; labels?: Record<string, string>;
  onChanged?: () => void;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { outgoing, uploads } = useOutbox();
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const conv = convKey(view);
  // A sent message replaces its pending copy under the same key; hide the pending one as soon as
  // the hub's copy is in the list (no flash of both).
  const linked = new Set(entries.map(e => sentKey(e.first.id)).filter(Boolean));
  const sending = outgoing.filter(o => (view.kind === 'all' || o.conv === conv) && !linked.has(o.key));
  // The hub's copy of something still being sent can arrive (by a poll) before the send returns:
  // keep showing the sending bubble until the two are linked, so the bubble isn't swapped for a
  // new element (which replayed its slide-in and looked like a blink).
  entries = entries.filter(e => !(e.first.from.toLowerCase() === me && !sentKey(e.first.id)
    && sending.some(o => !o.error && o.text && o.text === e.first.body && Math.abs(e.first.created_at - o.at) < 10 * 60_000)));
  // Messages that arrive while the view is open slide in; the ones already there don't.
  // (Per conversation: switching to another one doesn't animate its history.)
  const shownUpTo = useRef<number | null>(null);
  const shownConv = useRef(conv);
  if (shownUpTo.current === null || shownConv.current !== conv) {
    shownConv.current = conv;
    shownUpTo.current = entries.reduce((n, e) => Math.max(n, e.first.id), 0);
  }
  const pool = all ?? state.messages;
  const byId = useMemo(() => new Map(pool.map(m => [m.id, m])), [pool]);
  const mentionList = useMemo(() => mentionTargets(state, ''), [state]);
  const machines = labels ?? state.device_labels ?? {};
  const machine = (d?: string | null) => (d ? machines[d] ?? (d === 'console' ? 'Console' : d) : null);
  const chatTitle = (id?: number | null) => (state.chats ?? []).find(c => c.id === id)?.title;
  const accountOf = (name: string) => state.peers.find(p => p.name === name)?.account ?? null;
  const jump = (id: number) => {
    const el = document.getElementById(`m${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  };
  // "#1490" in a message links to that message when it's in this view.
  // Web links open in a new tab (trailing punctuation stays text).
  const linkRefs = (node: ReactNode): ReactNode => {
    const parts = Array.isArray(node) ? node : [node];
    return parts.map((part, i) => typeof part !== 'string' ? part : splitLinks(part).map((chunk, u) => u % 2 === 1
      ? <a key={`${i}-u${u}`} className="msg-link" href={chunk} target="_blank" rel="noopener noreferrer">{chunk}</a>
      : chunk.split(/(#\d{1,7}\b)/).map((bit, j) => {
        const id = /^#\d+$/.test(bit) ? Number(bit.slice(1)) : 0;
        return id && byId.has(id)
          ? <a key={`${i}-${u}-${j}`} className="msg-ref" href={`#m${id}`} onClick={e => { e.preventDefault(); jump(id); }}>{bit}</a>
          : bit;
      })));
  };
  // Reply: in "All messages", open the message's conversation and reply there.
  const reply = (m: Message, convo: string) => {
    if (view.kind !== 'all') return setReplyTo(conv, m);
    const target: MessagesView = m.chat_id ? { kind: 'chat', id: m.chat_id } : { kind: 'dm', key: otherSide(state, m, me).key };
    setReplyTo(convKey(target), m);
    location.hash = convo;
  };

  useEffect(() => {
    const el = feedRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, sending.length]);
  // Stay pinned to the bottom while content grows (images loading, receipts, typing row), so the
  // view never jumps when you're reading the latest messages.
  useEffect(() => {
    const el = feedRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    for (const child of Array.from(el.children)) ro.observe(child);
    ro.observe(el);
    return () => ro.disconnect();
  });

  return (
    <div className="feed card" ref={feedRef}
      onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {entries.length === 0 && !sending.length ? <p className="muted empty">No messages yet.</p> : [...entries.map(({ key, first: m, to, seen }, i) => {
        const toMe = to.some(n => n.toLowerCase() === me);
        const fromMe = m.from.toLowerCase() === me;
        const parent = m.reply_to ? byId.get(m.reply_to) : null;
        const convo = m.chat_id ? `/messages/chat/${m.chat_id}` : dmHash(otherSide(state, m, me).key);
        // Consecutive messages from one sender (same conversation, within 5 minutes) share one header.
        const prev = i > 0 ? entries[i - 1] : null;
        const cont = Boolean(prev && prev.first.from === m.from && (prev.first.chat_id ?? null) === (m.chat_id ?? null) &&
          prev.to.join() === to.join() && m.created_at - prev.first.created_at < 5 * 60_000);
        const sub = [machine(m.from_device), accountOf(m.from)].filter(Boolean).join(' · ');
        const fresh = m.id > (shownUpTo.current ?? 0);
        return (
          <div key={sentKey(m.id) ?? key} id={`m${m.id}`} className={`msg${toMe ? ' to-me' : ''}${fromMe ? ' mine' : ''}${cont ? ' cont' : ''}${fresh ? ' fresh' : ''}`}>
            {!fromMe ? (cont ? <span className="avatar-gap" /> : <Avatar name={m.from} peer={findPeer(state, m.from) ?? null} size={30} />) : null}
            <div className="msg-col">
              {!cont ? (
                <div className="msg-head">
                  {!fromMe ? <b className="msg-from">{displayName(state, m.from)}</b> : null}
                  {view.kind === 'chat' || view.kind === 'project' ? null
                    : view.kind === 'dm' && !fromMe ? null
                    : <span className="msg-to">to {to.map(n => displayName(state, n)).join(', ')}</span>}
                  {m.chat_id && view.kind !== 'chat' ? <a className="msg-to" href={`#/messages/chat/${m.chat_id}`}>in #{chatTitle(m.chat_id) ?? m.chat_id}</a> : null}
                  {m.project && !m.chat_id && view.kind !== 'project' ? <a className="msg-to" href={`#/projects/${encodeURIComponent(m.project)}`}>in project {m.project}</a> : null}
                  {sub && !fromMe ? <span className="msg-sub">{sub}</span> : null}
                  <time title={stamp(m.created_at)}>{ago(m.created_at, state.now)}</time>
                </div>
              ) : null}
              <div className="bubble">
                {parent ? (
                  <a className="quote" href={`#m${m.reply_to}`} onClick={e => { e.preventDefault(); jump(m.reply_to!); }}>
                    <b>{displayName(state, parent.from)}</b> {parent.body.slice(0, 90)}{parent.body.length > 90 ? '…' : ''}
                  </a>
                ) : null}
                {m.body !== '(attachment)' || !m.attachments?.length ? <div className="msg-body">{linkRefs(withMentions(m.body, mentionList))}</div> : null}
                {m.attachments?.length ? <Attachments session={session} list={m.attachments} /> : null}
              </div>
              {fromMe && (view.kind === 'dm' || view.kind === 'chat') && i === entries.length - 1 && !sending.length ? <Receipt to={to} seen={seen} state={state} /> : null}
            </div>
            <div className="msg-actions">
              <button title="Reply" aria-label={`Reply to #${m.id}`} onClick={() => reply(m, convo)}>↩</button>
              <button title="Forward" aria-label={`Forward #${m.id}`} onClick={() => setForwarding(m)}>↪</button>
              {view.kind === 'all' && (toMe || fromMe) && to.length === 1 ? <a href={`#${convo}`} title="Open conversation">↗</a> : null}
              <span className="msg-id" title={stamp(m.created_at)}>#{m.id}</span>
            </div>
          </div>
        );
      }),
      ...sending.map(o => {
        const ups = o.uploads.map(k => uploads.get(k)).filter(u => u !== undefined);
        const left = ups.filter(u => !u.id);
        const progress = ups.length ? ups.reduce((n, u) => n + (u.id ? 1 : u.progress), 0) / ups.length : 1;
        // Same header as the sent copy will have (time on its own line unless it continues a run of
        // mine), so nothing moves when it's replaced.
        const last = entries[entries.length - 1]?.first;
        const cont = Boolean(last && last.from.toLowerCase() === me && o.at - last.created_at < 5 * 60_000);
        return (
          <div key={o.key} className={`msg mine pending fresh${cont ? ' cont' : ''}`}>
            <div className="msg-col">
              {!cont ? <div className="msg-head"><time>just now</time></div> : null}
              <div className="bubble">
                {o.text ? <div className="msg-body">{withMentions(o.text, mentionList)}</div> : null}
                {ups.length ? (
                  <div className="attachments">
                    {ups.map(u => u.preview
                      ? <span key={u.key} className="thumb uploading"><img src={u.preview} alt={u.file.name} /></span>
                      : <span key={u.key} className="chip">📎 {u.file.name}</span>)}
                  </div>
                ) : null}
                {left.length && !o.error ? <div className="upload-progress"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div> : null}
              </div>
              <div className={`msg-status ${o.error ? 'error' : 'muted'} small`}>
                {o.error ? `Not sent: ${o.error}` : left.length ? `Uploading ${ups.length - left.length}/${ups.length} · ${Math.round(progress * 100)}%` : o.sent ? '✓ Sent' : 'Sending…'}
                {o.error ? <>
                  {' '}<button className="link small" onClick={() => retryOutgoing(o.key)}>Retry</button>
                  {' '}<button className="link small" onClick={() => discardOutgoing(o.key)}>Discard</button>
                </> : null}
                {o.error && o.conv.startsWith('dm:') ? (() => {
                  // Sent to a name several agents share: send it to one of them instead.
                  const twins = dmTwins(state, o.conv.slice(3));
                  return twins.length > 1 ? (
                    <div className="which-twin">
                      <span className="muted small">Send it to:</span>
                      {twins.map(t => (
                        <button key={t.key} className="secondary small" onClick={() => {
                          redirectOutgoing(session, o.key, `dm:${t.key}`,
                            async attachments => { await sendMessage(session, { to: [t.name], keys: { [t.name]: t.key }, message: o.text, attachments }); },
                            () => onChanged?.());
                          go(dmHash(t.key));
                        }}>
                          <Identity name={t.name} state={state} peer={t} compact /> <span className="muted small">{state.device_labels?.[t.device] || t.device}{t.account ? ` · ${t.account}` : ''}</span>
                        </button>
                      ))}
                    </div>
                  ) : null;
                })() : null}
              </div>
            </div>
          </div>
        );
      })]}
      {forwarding ? <ForwardDialog message={forwarding} state={state} session={session} me={me} chatTitle={chatTitle} onClose={() => setForwarding(null)} /> : null}
    </div>
  );
}

// Under my latest message, while waiting for an answer: has the agent picked it up, and what is it doing?
function Receipt({ to, seen, state }: { to: string[]; seen: string[]; state: HubState }) {
  const agents = to.filter(n => findPeer(state, n)?.kind !== 'human');
  if (!agents.length) return null;
  const names = (list: string[]) => list.map(n => displayName(state, n)).join(', ');
  const unseen = agents.filter(n => !seen.includes(n));
  const busy = agents.map(n => findPeer(state, n)).filter(p => p && seen.includes(p.name) && p.online && p.activity && p.activity.state !== 'idle');
  const text = !unseen.length ? (agents.length === 1 ? 'Seen' : 'Seen by all')
    : unseen.length === agents.length ? 'Sent · not seen yet'
    : `Seen by ${names(agents.filter(n => seen.includes(n)))} · not yet by ${names(unseen)}`;
  return (
    <div className="msg-status receipt muted small">
      {seen.length ? '✓✓ ' : '✓ '}{text}{busy.length ? ` · ${busy.length === 1 && agents.length === 1 ? 'working on it' : `${names(busy.map(p => p!.name))} working`}` : ''}
    </div>
  );
}

// Forward a message (with its attachments) to an agent or a group chat, with an optional note.
function ForwardDialog({ message: m, state, session, me, chatTitle, onClose }: {
  message: Message; state: HubState; session: Session; me: string; chatTitle: (id?: number | null) => string | undefined; onClose: () => void;
}) {
  const [target, setTarget] = useState<{ kind: 'dm'; name: string; key: string } | { kind: 'chat'; id: number; title: string } | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  async function send() {
    if (!target) return;
    setBusy(true);
    try {
      const where = m.chat_id ? ` in #${chatTitle(m.chat_id) ?? m.chat_id}` : '';
      const body = `${note.trim() ? `${note.trim()}\n\n` : ''}↪ Forwarded from ${m.from}${where} (#${m.id}):\n${m.body}`;
      await sendMessage(session, {
        ...(target.kind === 'dm' ? { to: [target.name] } : { chat: target.id }),
        message: body, attachments: (m.attachments ?? []).map(a => a.id),
      });
      onClose();
      go(target.kind === 'dm' ? dmHash(target.key) : `/messages/chat/${target.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog card" role="dialog" aria-label="Forward message">
        <h3>Forward message</h3>
        <blockquote className="forward-preview">
          <b>{m.from}</b> <span className="muted small">#{m.id}</span>
          <div>{m.body.length > 280 ? `${m.body.slice(0, 280)}…` : m.body}</div>
          {m.attachments?.length ? <div className="muted small">📎 {m.attachments.map(a => a.name).join(', ')}</div> : null}
        </blockquote>
        <div className="forward-targets">
          <PeerPicker state={state} peers={recipients(state, me, true)} label={target?.kind === 'dm' ? `To ${displayName(state, target.name)}` : 'To an agent…'}
            onPick={name => setTarget({ kind: 'dm', name, key: keyForName(state, name) })} />
          {(state.chats ?? []).length ? (
            <select value={target?.kind === 'chat' ? target.id : ''} aria-label="Or a group chat"
              onChange={e => { const c = state.chats.find(x => x.id === Number(e.target.value)); if (c) setTarget({ kind: 'chat', id: c.id, title: c.title }); }}>
              <option value="">…or a group chat</option>
              {state.chats.map(c => <option key={c.id} value={c.id}># {c.title}</option>)}
            </select>
          ) : null}
        </div>
        <textarea rows={2} placeholder="Add a note (optional)" value={note} onChange={e => setNote(e.target.value)} />
        {error ? <p className="error small">{error}</p> : null}
        <div className="composer-row">
          <span className="muted small">{target ? `Forwarding to ${target.kind === 'dm' ? displayName(state, target.name) : `# ${target.title}`}` : 'Pick who to send it to'}</span>
          <div className="actions">
            <button className="secondary" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={!target || busy} onClick={send}>{busy ? 'Sending…' : 'Forward'}</button>
          </div>
        </div>
      </div>
    </div>, document.body,
  );
}

// Touch screens: Enter adds a new line and the Send button sends, as in phone chat apps.
const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// One key per conversation (drafts, messages being sent).
export const convKey = (v: MessagesView) => v.kind === 'all' ? 'all' : v.kind === 'dm' ? `dm:${v.key}`
  : v.kind === 'chat' ? `chat:${v.id}` : `project:${v.slug}`;

// Unsent text, per conversation, kept in this browser until it's sent.
const draftKey = (v: MessagesView) => `agent-bridge-draft:${convKey(v)}`;
function loadDraft(v: MessagesView) { try { return localStorage.getItem(draftKey(v)) ?? ''; } catch { return ''; } }
function saveDraft(v: MessagesView, text: string) {
  try { if (text) localStorage.setItem(draftKey(v), text); else localStorage.removeItem(draftKey(v)); } catch { /* ignore */ }
}
function moveDraft(from: MessagesView, to: MessagesView) {
  const text = loadDraft(from);
  if (!text) return;
  saveDraft(to, [loadDraft(to), text].filter(Boolean).join('\n'));
  saveDraft(from, '');
}

type Notice = { kind: 'ok' | 'warn' | 'error'; text: string };
// A send's notice that should show in the conversation it moved to (see `landed` below).
const carried = new Map<string, Notice>();
const takeNotice = (conv: string) => { const n = carried.get(conv) ?? null; carried.delete(conv); return n; };

export function Composer({ view, chat, state, session, me, onChanged }: { view: MessagesView; chat: Chat | null; state: HubState; session: Session; me: string; onChanged: () => void }) {
  const [to, setTo] = useState<string[]>([]);
  const [offline, setOffline] = useState(false);
  const [text, setTextState] = useState(() => loadDraft(view));
  const setText = (t: string) => { setTextState(t); saveDraft(view, t); };
  const [files, setFiles] = useState<string[]>([]); // upload keys (see outbox): uploading as soon as added
  const { uploads, replying } = useOutbox();
  const replyTo = replying.get(convKey(view)) ?? null;
  useEffect(() => { if (replyTo) box.current?.focus(); }, [replyTo]);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(() => takeNotice(convKey(view)));
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null); // mention highlights drawn behind the textarea
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // "@" whose menu was closed

  const targets = useMemo(() => mentionTargets(state, me), [state, me]);
  // A name several agents share ("@Bridge Manager") means the one picked from the menu; typed by
  // hand it means all of them.
  const [picks, setPicks] = useState<Record<string, string>>({}); // lower display name -> agent address
  const mentioned = (() => {
    const names = mentionedAgents(text, targets);
    const shown = (n: string) => displayName(state, n).toLowerCase();
    return names.filter(n => !picks[shown(n)] || picks[shown(n)] === n || !names.includes(picks[shown(n)]));
  })();
  const typing = caret >= 0 ? activeQuery(text, caret) : null;
  const menu = typing && typing.at !== dismissedAt ? suggestions(targets, typing.query) : [];

  const options = recipients(state, me, offline).filter(p => !to.includes(p.name));
  const target = view.kind === 'dm' ? dmName(state, view.key) : view.kind === 'chat' ? (chat ? `# ${chat.title}` : '')
    : view.kind === 'project' ? `everyone in ${view.slug}` : to.map(n => (n === '*' ? 'everyone online' : n)).join(', ');
  // An old DM thread whose name several agents now share can't be answered until one is picked above.
  const ambiguous = view.kind === 'dm' && dmTwins(state, view.key).length > 1;
  const ready = view.kind === 'all' ? to.length > 0 || mentioned.length > 0 : (view.kind === 'dm' && !ambiguous) || view.kind === 'project' || Boolean(chat);
  // Who gets it: mentions add recipients to a new message or DM; in a project or chat everyone gets
  // it (like a group chat) but only the mentioned agents are notified.
  const inChat = (n: string) => !chat || chat.members.some(m => m.toLowerCase() === n.toLowerCase());
  const groupMentions = mentioned.filter(inChat);
  const recipientsFor = (): string[] | undefined =>
    view.kind === 'all' ? (to.includes('*') ? ['*'] : [...new Set([...to, ...mentioned])])
      : view.kind === 'dm' ? [...new Set([dmAddress(state, view.key), ...mentioned])]
      : view.kind === 'project' ? ['*']
      : groupMentions.length ? groupMentions : undefined;
  const mentionNote = !mentioned.length ? null
    : view.kind === 'project' || view.kind === 'chat'
      ? (groupMentions.length || view.kind === 'project'
        ? `Everyone in the ${view.kind === 'project' ? 'project' : 'chat'} sees it; only ${(view.kind === 'project' ? mentioned : groupMentions).map(n => displayName(state, n)).join(', ')} ${(view.kind === 'project' ? mentioned : groupMentions).length === 1 ? 'is' : 'are'} notified`
        : 'None of the mentioned agents are in this chat')
      : `Also to ${mentioned.filter(n => !to.includes(n) && !(view.kind === 'dm' && n === dmAddress(state, view.key))).map(n => displayName(state, n)).join(', ') || '(already a recipient)'}`;

  function pick(t: MentionTarget) {
    if (!typing) return;
    if (t.kind === 'agent') setPicks({ ...picks, [t.key.toLowerCase()]: t.agents[0] });
    const insert = `@${t.key} `;
    const next = text.slice(0, typing.at) + insert + text.slice(caret);
    const pos = typing.at + insert.length;
    setText(next);
    setDismissedAt(typing.at);
    setCaret(pos);
    requestAnimationFrame(() => { const el = box.current; if (el) { el.focus(); el.selectionStart = el.selectionEnd = pos; } });
  }

  function addFiles(list: FileList | File[] | null) {
    const picked = Array.from(list ?? []);
    const tooBig = picked.filter(f => f.size > MAX_ATTACHMENT_BYTES);
    if (tooBig.length) setNotice({ kind: 'error', text: `Over 25 MB: ${tooBig.map(f => f.name).join(', ')}` });
    const room = 20 - files.length;
    const keys = picked.filter(f => f.size <= MAX_ATTACHMENT_BYTES).slice(0, Math.max(room, 0)).map(f => startUpload(session, f));
    setFiles(prev => [...prev, ...keys]);
  }

  // The message shows in the conversation at once; uploads finish and it's delivered in the background.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  function send() {
    if (!ready || (!text.trim() && !files.length)) return;
    const message = text.trim();
    const target = {
      to: recipientsFor(), chat: view.kind === 'chat' ? view.id : undefined, project: view.kind === 'project' ? view.slug : undefined,
      keys: view.kind === 'dm' && !view.key.startsWith('name:') ? { [dmAddress(state, view.key)]: view.key } : undefined,
      mentions: view.kind === 'project' ? mentioned : undefined,
    };
    setNotice(null);
    const replyId = replyTo?.id ?? null;
    setReplyTo(convKey(view), null);
    sendQueued(session, convKey(view), message, files, async (attachments, key) => {
      const r = await sendMessage(session, { ...target, message, attachments, replyTo: replyId });
      linkSent(key, r.message_ids);
      // Success needs no notice (the receipt under the message says it); only "won't see it yet".
      const away = r.recipient_status.filter(s => s.kind !== 'human' && (!s.online || !s.listening));
      const reviving = away.filter(s => s.reviving).map(s => `${displayName(state, s.name)} is offline: asked ${displayName(state, s.reviving!)} to bring it back.`);
      const later = away.filter(s => !s.reviving).map(s => `${s.name}${s.online ? '' : ' (offline)'}`);
      const next: Notice | null = reviving.length || later.length ? { kind: 'warn', text: [...reviving,
        ...(later.length ? [`Not listening, so they'll see it with their next prompt: ${later.join(', ')}.`] : [])].join(' ') } : null;
      // An offline agent's old session can be gone (it restarted as a new one): the message went to
      // the agent's current identity, so follow it to that conversation instead of losing it from view.
      const landed = view.kind === 'dm' && !r.recipient_status.some(s => s.key === view.key) ? r.recipient_status[0]?.key : null;
      if (landed) {
        if (next) carried.set(`dm:${landed}`, next);
        if (view.kind === 'dm' && location.hash === `#${dmHash(view.key)}`) go(dmHash(landed)); // only if it is still open
        return;
      }
      if (mounted.current) setNotice(next);
    }, onChanged);
    setText('');
    setCaret(0);
    setDismissedAt(null);
    setFiles([]);
    setPicks({});
  }

  // Enter sends; Shift+Enter or Ctrl/Cmd+Enter starts a new line (browsers only do Shift+Enter themselves).
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (menu.length && !e.nativeEvent.isComposing) {
      const i = Math.min(menuIndex, menu.length - 1);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i + (e.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') { e.preventDefault(); pick(menu[i]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissedAt(typing!.at); return; }
    }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); setReplyTo(convKey(view), null); return; }
    if (touch || e.key !== 'Enter' || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!(e.metaKey || e.ctrlKey)) { send(); return; }
    const el = e.currentTarget;
    const at = el.selectionStart;
    setText(text.slice(0, at) + '\n' + text.slice(el.selectionEnd));
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = at + 1; });
  }
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length) { e.preventDefault(); addFiles(pasted); }
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  }

  return (
    <div className={`composer card${dragging ? ' dragging' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {view.kind === 'all' ? (
        <div className="composer-row to-row">
          <span className="small">To</span>
          <div className="chips">
            {to.map(n => (
              <span key={n} className="chip">{n === '*' ? 'Everyone online' : n}
                <button className="link small" onClick={() => setTo(to.filter(x => x !== n))} aria-label={`Remove ${n}`}>✕</button>
              </span>
            ))}
            {!to.includes('*') ? <>
              <PeerPicker state={state} peers={options} label={to.length ? '+ Add…' : 'Choose recipients…'} onPick={n => setTo([...to, n])} />
              {to.length === 0 ? <button type="button" className="link small" onClick={() => setTo(['*'])}>Everyone online</button> : null}
            </> : null}
          </div>
          <label className="toggle small"><input type="checkbox" checked={offline} onChange={e => setOffline(e.target.checked)} /> Show offline</label>
        </div>
      ) : null}
      {replyTo ? (
        <div className="reply-chip">
          <span>↩ Replying to <b>{replyTo.from}</b> #{replyTo.id}: <span className="muted">{replyTo.body.slice(0, 120)}{replyTo.body.length > 120 ? '…' : ''}</span></span>
          <button className="link small" onClick={() => setReplyTo(convKey(view), null)} aria-label="Cancel reply">✕</button>
        </div>
      ) : null}
      <div className="composer-input">
        {menu.length ? <MentionMenu items={menu} active={Math.min(menuIndex, menu.length - 1)} onPick={pick} /> : null}
        <div className="composer-highlights" aria-hidden ref={layer}>{withMentions(text, targets, true)}{'\n'}</div>
        <textarea ref={box} rows={3} value={text} onKeyDown={onKey} onPaste={onPaste}
          onScroll={e => { if (layer.current) layer.current.scrollTop = e.currentTarget.scrollTop; }}
          onChange={e => { setText(e.target.value); setCaret(e.target.selectionStart); setMenuIndex(0); if (dismissedAt !== null && e.target.value[dismissedAt] !== '@') setDismissedAt(null); }}
          onSelect={e => setCaret(e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setCaret(-1), 150)} onFocus={e => setCaret(e.currentTarget.selectionStart)}
          placeholder={ambiguous ? `Pick which ${target} above to reply to; your draft goes with you`
            : !ready ? 'Choose recipients, or @mention an agent or computer'
            : touch ? `Message ${target}… (@ to mention)`
            : `Message ${target}… (Enter to send, ⌘/Ctrl + Enter for a new line, @ to mention; paste or drop files to attach)`} />
      </div>
      {mentionNote ? <div className="muted small mention-note">{mentionNote}</div> : null}
      {files.length ? (
        <div className="chips">
          {files.map(k => uploads.get(k)).filter(u => u !== undefined).map(u => (
            <span key={u.key} className={`chip upload${u.error ? ' failed' : ''}`} title={u.error ?? undefined}>
              {u.preview ? <img className="chip-thumb" src={u.preview} alt="" /> : '📎'} {u.file.name || 'pasted image'}{' '}
              <span className="muted small">
                {u.error ? 'failed' : u.id ? `${Math.max(1, Math.round(u.file.size / 1024))} KB ✓` : `${Math.round(u.progress * 100)}%`}
              </span>
              {u.error ? <button className="link small" onClick={() => retryUpload(session, u.key)}>Retry</button> : null}
              <button className="link small" onClick={() => { setFiles(files.filter(x => x !== u.key)); dropUpload(u.key); }} aria-label={`Remove ${u.file.name}`}>✕</button>
              {!u.id && !u.error ? <span className="upload-bar" style={{ width: `${Math.round(u.progress * 100)}%` }} /> : null}
            </span>
          ))}
        </div>
      ) : null}
      <div className="composer-row">
        {notice ? <span className={notice.kind === 'error' ? 'error small' : notice.kind === 'warn' ? 'warn small' : 'muted small'}>{notice.text}</span> : <span />}
        <div className="actions">
          <input ref={fileInput} type="file" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
          <button className="secondary" onClick={() => fileInput.current?.click()} title="Attach files (or paste / drop them here)">Attach</button>
          <button className="primary" onClick={send} disabled={!ready || (!text.trim() && !files.length)}>Send</button>
        </div>
      </div>
    </div>
  );
}

function Attachments({ session, list }: { session: Session; list: Attachment[] }) {
  return <div className="attachments">{list.map(a => <AttachmentItem key={a.id} session={session} a={a} />)}</div>;
}

function AttachmentItem({ session, a }: { session: Session; a: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = a.content_type.startsWith('image/');
  useEffect(() => {
    if (isImage) attachmentUrl(session, a.id).then(setUrl, () => {});
  }, [session, a.id, isImage]);

  async function open(e: ReactMouseEvent<HTMLButtonElement>) {
    if (isImage && url) return openLightbox(e.currentTarget);
    const href = url ?? (await attachmentUrl(session, a.id));
    const link = document.createElement('a');
    link.href = href;
    if (isImage) link.target = '_blank'; else link.download = a.name;
    link.click();
  }

  const size = a.size < 1024 * 1024 ? `${Math.max(1, Math.round(a.size / 1024))} KB` : `${(a.size / 1024 / 1024).toFixed(1)} MB`;
  return isImage && url ? (
    <button className="thumb" onClick={open} title={`${a.name} (${size})`}
      data-lightbox-src={url} data-lightbox-name={a.name} data-lightbox-size={size}><img src={url} alt={a.name} /></button>
  ) : (
    <button className="chip" onClick={open}>📎 {a.name} <span className="muted small">{size}</span></button>
  );
}

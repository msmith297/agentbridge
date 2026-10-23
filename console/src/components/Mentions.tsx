import type { CSSProperties, ReactNode } from 'react';
import type { HubState } from '../api';

// @-mentions in the composer: "@agent name" addresses that agent; "@device" (or its display
// name, e.g. "@Windows desktop" or just "@windows") addresses every agent online on that computer. Matching is case-insensitive and longest-first, so an agent
// named "planner @macbook-pro" isn't also read as a mention of the device "macbook-pro".

const SYSTEM = 'agent-bridge';

export interface MentionTarget {
  kind: 'agent' | 'device';
  key: string;     // what follows the @ in the text (agent name or device name)
  aliases: string[]; // other spellings that also match (a computer's display name)
  label: string;   // shown in the menu
  detail: string;
  agents: string[]; // who it reaches
  color?: string | null; // an agent's chosen color
}

export function mentionTargets(state: HubState, me: string): MentionTarget[] {
  const agents = state.peers.filter(p => p.kind !== 'human' && p.name !== SYSTEM && p.name.toLowerCase() !== me);
  const machine = (device: string) => state.device_labels?.[device] || device;
  const seen = new Set<string>();
  const out: MentionTarget[] = [];
  for (const p of [...agents].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))) {
    if (seen.has(p.name.toLowerCase())) continue;
    seen.add(p.name.toLowerCase());
    out.push({
      // Mentions read like the names people see ("@Bridge Manager"); the full address still matches.
      kind: 'agent', key: p.display_name || p.name, aliases: p.display_name && p.display_name !== p.name ? [p.name] : [],
      label: p.display_name || p.name, agents: [p.name], color: p.color,
      detail: `${machine(p.device)}${p.account ? ` · ${p.account}` : ''} · ${!p.online ? 'offline' : p.listening ? 'listening' : 'not listening'}`,
    });
  }
  const devices = [...new Set(agents.map(p => p.device))].sort();
  const firstWord = (d: string) => machine(d).split(/\s+/)[0].toLowerCase();
  for (const device of devices) {
    const live = agents.filter(p => p.device === device && p.online).map(p => p.name);
    const label = machine(device);
    const aliases = label === device ? [] : [device];
    // "@windows" for "Windows desktop", when no other computer's name starts the same way.
    const word = firstWord(device);
    if (label !== device && word.length > 2 && devices.filter(d => firstWord(d) === word).length === 1) aliases.push(word);
    out.push({
      kind: 'device', key: label, aliases, label: label === device ? device : `${label} (${device})`, agents: [...new Set(live)],
      detail: live.length ? `all ${live.length} online agent${live.length === 1 ? '' : 's'} on this computer` : 'no agents online',
    });
  }
  return out;
}

const isWordChar = (c: string | undefined) => Boolean(c && /[\w-]/.test(c));

// Mentions in order of appearance, as [start, end, target] spans.
function scan(text: string, targets: MentionTarget[]) {
  const spellings = targets.flatMap(t => [t.key, ...t.aliases].map(s => ({ s: s.toLowerCase(), t })))
    .sort((a, b) => b.s.length - a.s.length);
  const spans: { start: number; end: number; target: MentionTarget }[] = [];
  const lower = text.toLowerCase();
  for (let i = lower.indexOf('@'); i !== -1; i = lower.indexOf('@', i + 1)) {
    if (i > 0 && isWordChar(text[i - 1])) continue; // e.g. an email address
    const hit = spellings.find(({ s }) => lower.startsWith(s, i + 1) && !isWordChar(text[i + 1 + s.length]));
    if (!hit) continue;
    const end = i + 1 + hit.s.length;
    spans.push({ start: i, end, target: hit.t });
    i = end - 1;
  }
  return spans;
}

// A stable hue per agent / computer, so the same one always gets the same color.
export function nameHue(kind: string, key: string) {
  let h = 0;
  for (const c of `${kind}:${key.toLowerCase()}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
const hue = (t: MentionTarget) => nameHue(t.kind, t.key);

// The agents a message's mentions reach (devices expanded to their online agents).
export function mentionedAgents(text: string, targets: MentionTarget[]): string[] {
  // A name several agents share matches all of them (the composer narrows it to the one picked).
  return [...new Set(scan(text, targets).flatMap(s => {
    const said = text.slice(s.start + 1, s.end).toLowerCase();
    return targets.filter(t => [t.key, ...t.aliases].some(x => x.toLowerCase() === said)).flatMap(t => t.agents);
  }))];
}

// Message text with mentions highlighted. `layout`: highlight only (no change to text metrics),
// for the layer drawn behind the composer's textarea.
export function withMentions(text: string, targets: MentionTarget[], layout = false): ReactNode {
  const spans = scan(text, targets);
  if (!spans.length) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const s of spans) {
    const style = (s.target.color ? { '--mc': s.target.color } : { '--mh': hue(s.target) }) as unknown as CSSProperties;
    parts.push(text.slice(at, s.start), (
      <span key={s.start} className={layout ? 'mention mention-bg' : 'mention'} style={style}
        title={layout ? undefined : s.target.kind === 'device' ? `${s.target.label}: ${s.target.detail}` : s.target.detail}>
        {text.slice(s.start, s.end)}
      </span>
    ));
    at = s.end;
  }
  parts.push(text.slice(at));
  return parts;
}

// The "@query" being typed just before the caret, if any.
export function activeQuery(text: string, caret: number): { at: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1 || (at > 0 && isWordChar(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (query.length > 64 || query.includes('\n')) return null;
  return { at, query };
}

export function suggestions(targets: MentionTarget[], query: string): MentionTarget[] {
  const q = query.toLowerCase();
  const score = (t: MentionTarget) => {
    const k = t.key.toLowerCase(), l = t.label.toLowerCase();
    if (k === q || t.aliases.some(a => a.toLowerCase() === q)) return -1; // fully typed already
    return k.startsWith(q) || l.startsWith(q) ? 0 : k.includes(q) || l.includes(q) ? 1 : 2;
  };
  return targets.map(t => ({ t, s: score(t) })).filter(x => x.s === 0 || x.s === 1)
    .sort((a, b) => a.s - b.s || Number(a.t.kind === 'device') - Number(b.t.kind === 'device'))
    .slice(0, 8).map(x => x.t);
}

export function MentionMenu({ items, active, onPick }: { items: MentionTarget[]; active: number; onPick: (t: MentionTarget) => void }) {
  return (
    <ul className="mention-menu card" role="listbox" aria-label="Mention an agent or computer">
      {items.map((t, i) => (
        <li key={`${t.kind}:${t.agents.join(',') || t.key}`} role="option" aria-selected={i === active} className={i === active ? 'active' : ''}
          onMouseDown={e => { e.preventDefault(); onPick(t); }}>
          <span className="mention-kind" aria-hidden>{t.kind === 'device' ? '🖥' : '@'}</span>
          <span className="mention-label">{t.label}</span>
          <span className="muted small">{t.detail}</span>
        </li>
      ))}
    </ul>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuthError, clearSession, fetchHistory, fetchState, getOperator, keepHistory, mergeState, saveSession, setOperator,
  type HistoryQuery, type HubState, type Message, type Session,
} from './api';
import { Login } from './pages/Login';
import { Approvals } from './components/Approvals';
import { Notifications } from './components/Notifications';
import { StatusBar } from './components/StatusBar';
import { UpdateBanner } from './components/UpdateBanner';
import { applyTheme, loadTheme, type Theme } from './theme';
import { Agents } from './pages/Agents';
import { Messages, type MessagesView } from './pages/Messages';
import { Devices } from './pages/Devices';
import { Accounts } from './pages/Accounts';
import { Projects } from './pages/Projects';
import { PROJECT_TABS, type ProjectTab } from './pages/Project';

export type Route = 'agents' | 'projects' | 'messages' | 'accounts' | 'devices';
const ROUTES: { id: Route; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'projects', label: 'Projects' },
  { id: 'messages', label: 'Messages' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'devices', label: 'Devices' },
];
const POLL_MS = 3000;
const LAST_VIEWS_KEY = 'agent-bridge-last-views';
const FULL_REFRESH_EVERY = 100; // polls between full reloads (catches deletions/purges)

interface RouteState { page: Route; slug?: string; tab: ProjectTab; messages: MessagesView }

// #/agents, #/projects, #/projects/<slug>[/<tab>], #/messages[/dm/<agent key> | /chat/<id>], ...
function readRoute(): RouteState {
  const [page, a, b] = location.hash.replace(/^#\/?/, '').split('/');
  const messages: MessagesView = page === 'messages' && a === 'dm' && b ? { kind: 'dm', key: decodeURIComponent(b) }
    : page === 'messages' && a === 'chat' && Number(b) ? { kind: 'chat', id: Number(b) }
    : { kind: 'all' };
  return {
    page: ROUTES.some(x => x.id === page) ? (page as Route) : 'agents',
    slug: page === 'projects' && a ? decodeURIComponent(a) : undefined,
    tab: PROJECT_TABS.includes(b as ProjectTab) ? (b as ProjectTab) : 'chat',
    messages,
  };
}

export function App({ initialSession }: { initialSession: Session | null }) {
  const [session, setSession] = useState<Session | null>(initialSession);
  const [loc, setLoc] = useState<RouteState>(readRoute);
  const route = loc.page;
  const [state, setState] = useState<HubState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);

  // One operator identity on every device: take the name the hub keeps for this sign-in (or, the
  // first time, give it this one).
  useEffect(() => {
    if (!session) return;
    const check = () => getOperator(session).then(me => {
      if (!me.name) return setOperator(session, session.name);
      if (me.name === session.name) return;
      const next = { ...session, name: me.name };
      saveSession(next);
      try { localStorage.setItem('agent-bridge-console-name', me.name); } catch { /* ignore */ }
      setState(null);
      setSession(next);
    }).catch(() => { /* older hub: keep this device's name */ });
    check();
    const timer = setInterval(check, 60_000); // e.g. after the name was changed or merged elsewhere
    return () => clearInterval(timer);
  }, [session?.token, session?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextTheme: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const cycleTheme = () => { const t = nextTheme[theme]; applyTheme(t); setTheme(t); };

  // Each top tab reopens where you left it (e.g. the conversation you were in), across reloads too.
  const [lastViews, setLastViews] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(LAST_VIEWS_KEY) || '{}'); } catch { return {}; }
  });
  useEffect(() => {
    const hash = location.hash;
    setLastViews(prev => {
      if (prev[loc.page] === hash) return prev;
      const next = { ...prev, [loc.page]: hash };
      try { localStorage.setItem(LAST_VIEWS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [loc]);

  useEffect(() => {
    const onHash = () => setLoc(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const signOut = useCallback(() => {
    const viaAccess = session ? !session.token : false;
    clearSession();
    setSession(null);
    setState(null);
    // A Cloudflare Access login would sign straight back in: end that login too.
    if (viaAccess) location.href = '/cdn-cgi/access/logout';
  }, [session]);

  // Poll cheaply: after the first load, ask only for changes since the last poll.
  const cursor = useRef<{ id: number; ts: number; polls: number } | null>(null);
  const history = useRef(new Map<number, Message>());
  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      const c = cursor.current;
      const full = !c || c.polls >= FULL_REFRESH_EVERY;
      const next = await fetchState(session, full ? undefined : { id: c.id, ts: c.ts });
      for (const m of next.dm_heads ?? []) history.current.set(m.id, m); // so every DM thread stays listed
      setState(prev => {
        const merged = keepHistory(mergeState(full ? null : prev, next), history.current, next.messages, full);
        cursor.current = { id: merged.messages[0]?.id ?? 0, ts: next.now, polls: full ? 0 : (c?.polls ?? 0) + 1 };
        return merged;
      });
      setError(null);
    } catch (err) {
      if (err instanceof AuthError) signOut();
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [session, signOut]);

  // A conversation's older messages: kept across polls (keepHistory), merged in as they arrive.
  const loadHistory = useCallback(async (q: HistoryQuery, before?: number) => {
    if (!session) return { more: false };
    const page = await fetchHistory(session, q, before);
    for (const m of page.messages) history.current.set(m.id, m);
    setState(prev => prev && keepHistory(prev, history.current));
    return { more: page.more, oldest: page.messages[page.messages.length - 1]?.id };
  }, [session]);

  useEffect(() => {
    if (!session) return;
    cursor.current = null;
    history.current.clear();
    refresh();
    // Don't poll while the tab is hidden; catch up as soon as it's visible again.
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [session, refresh]);

  if (!session) return <Login onSignIn={setSession} />;

  const me = session.name.toLowerCase();
  const unread = state?.messages.filter(m => m.to.toLowerCase() === me && !m.delivered_at).length ?? 0;
  const onlineAgents = state?.peers.filter(p => p.online && p.kind !== 'human').length ?? 0;

  const messageAgent = (to: string) => { location.hash = `/messages/dm/${encodeURIComponent(to)}`; };

  return (
    <div className={`shell${route === 'messages' || route === 'projects' ? ' full-bleed' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>⌁</span>
          <span>Agent Bridge</span>
        </div>
        <nav className="tabs">
          {ROUTES.map(r => (
            <a key={r.id} href={route !== r.id && lastViews[r.id]?.startsWith(`#/${r.id}`) ? lastViews[r.id] : `#/${r.id}`} className={route === r.id ? 'tab active' : 'tab'}>
              {r.label}
              {r.id === 'agents' && state ? <span className="count">{onlineAgents}</span> : null}
              {r.id === 'messages' && unread ? <span className="count alert">{unread}</span> : null}
            </a>
          ))}
        </nav>
        <div className="who">
          {state ? <StatusBar state={state} /> : null}
          <span className={error ? 'dot bad' : state ? 'dot good' : 'dot'} title={error ?? 'Connected'} />
          <span className="muted">{session.name}</span>
          <Notifications session={session} />
          <button className="link theme-toggle" onClick={cycleTheme} aria-label={`Theme: ${theme}. Switch to ${nextTheme[theme]}`}
            title={`Theme: ${theme === 'system' ? 'follows your system' : theme} (click for ${nextTheme[theme] === 'system' ? 'system' : nextTheme[theme]})`}>
            {theme === 'light' ? '☀︎' : theme === 'dark' ? '☾' : '◐'}
          </button>
          <button className="link" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {error ? <div className="banner">Can't reach the hub: {error}. Retrying…</div> : null}
      <UpdateBanner />
      {state?.pairings.length && route !== 'devices' ? (
        <a className="banner info" href="#/devices">
          {state.pairings.length === 1 ? `"${state.pairings[0].device_name}" is` : `${state.pairings.length} computers are`} waiting for approval to join. Review on Devices →
        </a>
      ) : null}

      {state ? <Approvals state={state} session={session} onChanged={refresh} /> : null}

      <main className="content">
        {!state ? (
          <p className="muted">Loading…</p>
        ) : route === 'agents' ? (
          <Agents state={state} session={session} onMessage={messageAgent} onChanged={refresh} />
        ) : route === 'projects' ? (
          <Projects state={state} session={session} slug={loc.slug} tab={loc.tab} onChanged={refresh} />
        ) : route === 'messages' ? (
          <Messages state={state} session={session} view={loc.messages} onChanged={refresh} loadHistory={loadHistory} />
        ) : route === 'accounts' ? (
          <Accounts state={state} session={session} onChanged={refresh} />
        ) : (
          <Devices state={state} session={session} onChanged={refresh} />
        )}
      </main>
    </div>
  );
}

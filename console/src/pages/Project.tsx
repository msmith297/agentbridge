import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmButton } from '../components/ConfirmButton';
import { ackMessages, deleteProject, projectOverview, setProjectMember, type HubState, type ProjectOverview, type Session } from '../api';
import { Composer, Feed, group } from './Messages';
import { displayName, Identity, MemberStack, PeerPicker, TypingRow, useCloseOnOutsideClick } from '../components/Identity';
import { Overview } from './project/Overview';
import { Tasks } from './project/Tasks';
import { Docs } from './project/Docs';
import { Files } from './project/Files';
import { Data } from './project/Data';

export const PROJECT_TABS = ['chat', 'tasks', 'docs', 'files', 'data', 'activity'] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export interface TabProps {
  session: Session;
  ov: ProjectOverview;
  refresh: () => void;
}

export function Project({ state, session, slug, tab, onChanged }: {
  state: HubState; session: Session; slug: string; tab: ProjectTab; onChanged: () => void;
}) {
  const [ov, setOv] = useState<ProjectOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useCloseOnOutsideClick(showMembers, () => setShowMembers(false), '.members-wrap, .picker-pop');
  const me = session.name.toLowerCase();

  const refresh = useCallback(async () => {
    try {
      setOv(await projectOverview(session, slug));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [session, slug]);

  useEffect(() => {
    refresh();
    // Chat wants quick updates; the other tabs change less often.
    const t = setInterval(() => { if (!document.hidden) refresh(); }, tab === 'chat' ? 3000 : 6000);
    return () => clearInterval(t);
  }, [refresh, tab]);

  const entries = useMemo(() => group(ov?.messages ?? [], me), [ov, me]);

  // Reading the project chat marks the operator's messages in it as read.
  const unread = entries.flatMap(e => e.unread);
  const unreadKey = unread.join(',');
  useEffect(() => {
    if (tab === 'chat' && unread.length) ackMessages(session, unread).then(() => { refresh(); onChanged(); }, () => {});
  }, [unreadKey, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  async function remove() {
    await deleteProject(session, slug);
    location.hash = '/projects';
    onChanged();
  }

  if (error && !ov) return <div className="card pad"><p className="error">{error}</p></div>;
  if (!ov) return <p className="muted">Loading…</p>;

  const counts: Record<ProjectTab, number | null> = {
    chat: null,
    tasks: ov.tasks.length,
    docs: ov.docs.length,
    files: ov.files.length,
    data: ov.kv.length,
    activity: null,
  };
  const view = { kind: 'project' as const, slug };

  return (
    <div className="project-pane">
      <div className="chat-head">
        <div className="section-head">
          <div>
            <h2># {ov.project.name}</h2>
            {ov.project.description ? <p className="muted project-desc">{ov.project.description}</p> : null}
          </div>
          <ConfirmButton onConfirm={remove} confirmLabel="Delete everything? Click again" title="Deletes the project's tasks, docs, data and files. Can't be undone.">Delete project</ConfirmButton>
        </div>
        <div className="members-wrap">
          {ov.members.length === 0 ? <span className="muted small">No agents in this project yet.</span>
            : <MemberStack names={ov.members.map(m => m.name)} state={state} onClick={() => setShowMembers(!showMembers)} />}
          {/* An agent is in one project at a time: adding moves it here from wherever it was. */}
          <PeerPicker className="add-member" state={state} label="+ Add agent"
            peers={state.peers.filter(p => p.kind !== 'human' && !ov.members.some(m => m.name === p.name))}
            onPick={async name => {
              try {
                const r = await setProjectMember(session, slug, name, true);
                setNote(`${displayName(state, name)} added${r.previous && r.previous !== slug ? ` (moved from ${r.previous})` : ''}.`);
                refresh();
              } catch (err) { setNote((err as Error).message); }
            }} />
          {ov.participants?.length ? <span className="muted small">Also in the chat: {ov.participants.map(n => displayName(state, n)).join(', ')}</span> : null}
          {note ? <span className="muted small">{note}</span> : null}
          {showMembers && ov.members.length ? (
            <div className="members-pop card">
              {ov.members.map(m => (
                <div key={m.name} className="member-row" title={m.summary || undefined}>
                  <span className={m.online === false ? 'dot' : m.listening ? 'dot good' : 'dot idle'} />
                  <Identity name={m.name} state={state} />
                  <button className="link small" onClick={async () => { await setProjectMember(session, slug, m.name, false).catch(() => {}); refresh(); }}
                    title="Take this agent out of the project">Remove</button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <nav className="subtabs">
        {PROJECT_TABS.map(t => (
          <a key={t} href={`#/projects/${slug}/${t}`} className={tab === t ? 'tab active' : 'tab'}>
            {t[0].toUpperCase() + t.slice(1)}
            {counts[t] ? <span className="count">{counts[t]}</span> : null}
          </a>
        ))}
      </nav>
      {error ? <div className="banner">Refresh failed: {error}</div> : null}

      {tab === 'chat' ? (
        <div className="project-chat">
          <Feed entries={entries} state={state} session={session} me={me} view={view} all={ov.messages} labels={ov.device_labels} />
          <TypingRow state={state} me={me} names={ov.members.map(m => m.name)} />
          <Composer view={view} chat={null} state={state} session={session} me={me} onChanged={() => { refresh(); onChanged(); }} />
        </div>
      ) : tab === 'tasks' ? <Tasks session={session} ov={ov} refresh={refresh} />
        : tab === 'docs' ? <Docs session={session} ov={ov} refresh={refresh} />
        : tab === 'files' ? <Files session={session} ov={ov} refresh={refresh} />
        : tab === 'data' ? <Data session={session} ov={ov} refresh={refresh} />
        : <Overview session={session} ov={ov} refresh={refresh} />}
    </div>
  );
}

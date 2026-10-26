import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { createProject, listProjects, type HubState, type ProjectSummary, type Session } from '../api';
import { ago } from '../format';
import { useSidebarWidth } from '../components/SidebarResizer';
import { Project, type ProjectTab } from './Project';

// Projects, laid out like conversations: the project list on the left, the selected project
// (chat first, then tasks/docs/files/data) on the right.
export function Projects({ state, session, slug, tab, onChanged }: {
  state: HubState; session: Session; slug?: string; tab: ProjectTab; onChanged: () => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProjects((await listProjects(session)).projects);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [session]);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const p = await createProject(session, name, description);
      setName(''); setDescription(''); setCreating(false);
      await load();
      location.hash = `/projects/${p.slug}`;
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Phones show the project list or the open project, not both.
  const [listOpen, setListOpen] = useState(!slug);
  const sidebar = useSidebarWidth();
  useEffect(() => setListOpen(!slug), [slug]);

  return (
    <section className={`msg-layout${listOpen ? ' list-open' : ''}`} style={sidebar.style}>
      {sidebar.handle}
      <aside className="card conv-list" onClick={e => { if ((e.target as HTMLElement).closest('.conv.active')) setListOpen(false); }}>
        <div className="conv-head">
          Projects
          <button className="link small" onClick={() => setCreating(!creating)}>{creating ? 'Cancel' : '+ New'}</button>
        </div>
        {creating ? (
          <form className="new-chat" onSubmit={create}>
            <input placeholder="Project name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} autoFocus />
            <input placeholder="What it's for (optional)" value={description} onChange={e => setDescription(e.target.value)} maxLength={1000} />
            <button className="primary small" disabled={!name.trim()}>Create project</button>
          </form>
        ) : null}
        {error ? <p className="error small conv-empty">{error}</p> : null}
        {!projects ? <p className="muted small conv-empty">Loading…</p> : projects.length === 0 ? <p className="muted small conv-empty">No projects yet.</p> : projects.map(p => (
          <button key={p.slug} className={`conv${slug === p.slug ? ' active' : ''}`} onClick={() => { location.hash = `/projects/${p.slug}`; }}
            title={p.description || p.name}>
            <span className="conv-name"><span className="conv-text"># {p.name}</span></span>
            <span className="muted small">{p.open_tasks ? `${p.open_tasks} open` : p.last_activity ? ago(p.last_activity, state.now) : ''}</span>
          </button>
        ))}
      </aside>

      <div className="conv-main">
        <button className="conv-toggle secondary" onClick={() => setListOpen(true)}>☰ Projects</button>
        {slug ? <Project key={slug} state={state} session={session} slug={slug} tab={tab} onChanged={() => { load(); onChanged(); }} /> : (
          <div className="card pad empty">
            <h2>Projects</h2>
            <p className="muted">
              Shared workspaces for your agents: a project chat, task board, docs, data and files. Pick a project on the left, or create one.
              Agents join with "join project <i>name</i> on agent-bridge", or <code>{'{"project": "name"}'}</code> in a folder's <code>.agent-bridge.json</code>.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

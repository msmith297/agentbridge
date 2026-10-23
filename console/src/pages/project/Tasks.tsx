import { useEffect, useState, type FormEvent } from 'react';
import { ConfirmButton } from '../../components/ConfirmButton';
import { projectAct, type Task, type TaskDetail, type TaskStatus } from '../../api';
import { ago, stamp } from '../../format';
import type { TabProps } from '../Project';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];

export function Tasks({ session, ov, refresh }: TabProps) {
  const slug = ov.project.slug;
  const [done, setDone] = useState<Task[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The overview only carries open tasks; fetch recent done ones for the last column.
  useEffect(() => {
    projectAct<Task[]>(session, 'tasks', 'list', slug, { status: 'done' }).then(setDone, () => {});
  }, [session, slug, ov]);

  const all = [...ov.tasks, ...done.slice(-20)];

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await projectAct(session, 'tasks', 'create', slug, { title, body, assignee: assignee || undefined });
      setTitle(''); setBody(''); setAssignee('');
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <form className="card pad task-form" onSubmit={create}>
        <input placeholder="New task title" value={title} onChange={e => setTitle(e.target.value)} required maxLength={200} />
        <textarea rows={2} placeholder="Details / acceptance criteria (optional)" value={body} onChange={e => setBody(e.target.value)} />
        <div className="composer-row">
          <label className="inline small">
            Assign to
            <input list="members" placeholder="anyone (unassigned)" value={assignee} onChange={e => setAssignee(e.target.value)} />
            <datalist id="members">{ov.members.map(m => <option key={m.name} value={m.name} />)}</datalist>
          </label>
          <button className="primary" disabled={!title.trim()}>Add task</button>
        </div>
        {error ? <p className="error small">{error}</p> : null}
      </form>

      <div className="board">
        {COLUMNS.map(col => {
          const items = all.filter(t => t.status === col.status);
          return (
            <div key={col.status} className="column">
              <div className="column-head">{col.label} <span className="count">{items.length}</span></div>
              {items.map(t => (
                <button key={t.id} className={`card task-card${selected === t.id ? ' selected' : ''}`} onClick={() => setSelected(t.id)}>
                  <div className="small muted">#{t.id}</div>
                  <div className="task-title">{t.title}</div>
                  <div className="small muted">{t.assignee ?? 'unassigned'} · {ago(t.updated_at)}</div>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {selected ? <TaskPanel key={selected} {...{ session, ov, refresh }} id={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function TaskPanel({ session, ov, refresh, id, onClose }: TabProps & { id: number; onClose: () => void }) {
  const slug = ov.project.slug;
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => projectAct<TaskDetail>(session, 'tasks', 'get', slug, { task_id: id }).then(setTask, err => setError(err.message));
  useEffect(() => { load(); }, [id]);

  async function update(changes: Record<string, unknown>) {
    setError(null);
    try {
      await projectAct(session, 'tasks', 'update', slug, { task_id: id, ...changes });
      setNote('');
      await load();
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    await projectAct(session, 'tasks', 'delete', slug, { task_id: id });
    onClose();
    refresh();
  }

  if (!task) return <div className="card pad task-panel">{error ? <p className="error">{error}</p> : 'Loading…'}</div>;

  return (
    <div className="card pad task-panel">
      <div className="section-head">
        <h3>#{task.id} {task.title}</h3>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      <p className="muted small">Created by {task.created_by} {ago(task.created_at)} · updated <span title={stamp(task.updated_at)}>{ago(task.updated_at)}</span></p>
      {task.body ? <div className="msg-body">{task.body}</div> : null}
      <div className="composer-row task-controls">
        <label className="inline small">
          Status
          <select value={task.status} onChange={e => update({ status: e.target.value })}>
            {COLUMNS.map(c => <option key={c.status} value={c.status}>{c.label}</option>)}
          </select>
        </label>
        <label className="inline small">
          Assignee
          <input list="members" defaultValue={task.assignee ?? ''} onBlur={e => { if (e.target.value !== (task.assignee ?? '')) update({ assignee: e.target.value }); }} />
        </label>
        <ConfirmButton onConfirm={remove}>Delete</ConfirmButton>
      </div>
      <h3 className="notes-head">Notes</h3>
      {task.notes.length === 0 ? <p className="muted small">No notes yet.</p> : (
        <ul className="plain activity">
          {task.notes.map((n, i) => <li key={i}><b>{n.author}</b> <span className="muted small">{ago(n.created_at)}</span><div className="msg-body small">{n.note}</div></li>)}
        </ul>
      )}
      <textarea rows={2} placeholder="Add a note" value={note} onChange={e => setNote(e.target.value)} />
      <div className="composer-row">
        {error ? <span className="error small">{error}</span> : <span />}
        <button className="secondary" onClick={() => update({ note })} disabled={!note.trim()}>Add note</button>
      </div>
    </div>
  );
}

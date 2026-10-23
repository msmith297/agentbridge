import { ago, stamp } from '../../format';
import type { TabProps } from '../Project';

export function Overview({ ov }: TabProps) {
  return (
    <div className="overview-grid">
      <div className="stack">
        <div className="card pad">
          <h3>Members online ({ov.members.length})</h3>
          {ov.members.length === 0 ? <p className="muted small">No agents in this project right now.</p> : (
            <ul className="plain">
              {ov.members.map(m => (
                <li key={m.name}>
                  <b>{m.name}</b> <span className="muted small">{m.kind ?? 'agent'} on {m.device}</span>{' '}
                  {m.listening ? <span className="pill live small">listening</span> : <span className="pill idle small">not listening</span>}
                  {m.summary ? <div className="small">{m.summary}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card pad">
          <h3>At a glance</h3>
          <p className="small">
            {ov.tasks.length} open task{ov.tasks.length === 1 ? '' : 's'} ({ov.tasks.filter(t => !t.assignee).length} unassigned) · {ov.done_tasks} done ·{' '}
            {ov.docs.length} doc{ov.docs.length === 1 ? '' : 's'} · {ov.files.length} file{ov.files.length === 1 ? '' : 's'} · {ov.kv.length} data key{ov.kv.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      <div className="stack">
        <div className="card pad">
          <h3>Activity</h3>
          {ov.events.length === 0 ? <p className="muted small">Nothing yet.</p> : (
            <ul className="plain activity">
              {ov.events.map((e, i) => (
                <li key={i}><b>{e.actor}</b> {e.summary} <span className="muted small" title={stamp(e.created_at)}>{ago(e.created_at)}</span></li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

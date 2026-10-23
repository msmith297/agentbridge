import { useEffect, useState } from 'react';
import { ConfirmButton } from '../../components/ConfirmButton';
import { projectAct, type Doc } from '../../api';
import { ago } from '../../format';
import type { TabProps } from '../Project';

export function Docs({ session, ov, refresh }: TabProps) {
  const slug = ov.project.slug;
  const [path, setPath] = useState<string | null>(ov.docs[0]?.path ?? null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // draft content while editing
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const meta = ov.docs.find(d => d.path === path);

  // Reload when a different doc is chosen or someone else saves a new version (unless editing).
  useEffect(() => {
    if (!path || editing !== null) return;
    if (doc?.path === path && doc.version === meta?.version) return;
    projectAct<Doc>(session, 'docs', 'read', slug, { path }).then(setDoc, err => setError(err.message));
  }, [session, slug, path, meta?.version, editing, doc]);

  async function save() {
    if (editing === null || !path) return;
    setError(null);
    try {
      await projectAct(session, 'docs', 'write', slug, { path, content: editing, expected_version: doc?.path === path ? doc.version : 0 });
      setEditing(null);
      setDoc(null);
      refresh();
    } catch (err) {
      setError(`${(err as Error).message}. Copy your text, cancel, and re-apply it to the latest version.`);
    }
  }

  async function remove() {
    if (!path) return;
    await projectAct(session, 'docs', 'delete', slug, { path });
    setPath(null);
    setDoc(null);
    refresh();
  }

  function startNew() {
    const p = newPath.trim().replace(/^\/+/, '');
    if (!p) return;
    setPath(p.endsWith('.md') ? p : `${p}.md`);
    setDoc(null);
    setEditing('');
    setNewPath('');
  }

  return (
    <div className="split">
      <aside className="card pad side-list">
        <div className="new-doc">
          <input placeholder="new-doc.md" value={newPath} onChange={e => setNewPath(e.target.value)} onKeyDown={e => e.key === 'Enter' && startNew()} />
          <button className="secondary small" onClick={startNew} disabled={!newPath.trim()}>New</button>
        </div>
        {ov.docs.length === 0 ? <p className="muted small">No docs yet.</p> : ov.docs.map(d => (
          <button key={d.path} className={`side-item${d.path === path ? ' active' : ''}`} onClick={() => { setEditing(null); setPath(d.path); }}>
            <span>{d.path}</span>
            <span className="muted small">v{d.version} · {d.updated_by} · {ago(d.updated_at)}</span>
          </button>
        ))}
      </aside>

      <div className="card pad doc-view">
        {!path ? <p className="muted">Choose a doc, or create one.</p> : (
          <>
            <div className="section-head">
              <h3>{path}{doc?.path === path ? <span className="muted small"> · version {doc.version}</span> : null}</h3>
              <div className="actions">
                {editing === null ? (
                  <>
                    <button className="secondary small" onClick={() => setEditing(doc?.path === path ? doc.content : '')}>Edit</button>
                    {meta ? <ConfirmButton onConfirm={remove}>Delete</ConfirmButton> : null}
                  </>
                ) : (
                  <>
                    <button className="link small" onClick={() => { setEditing(null); setError(null); }}>Cancel</button>
                    <button className="primary small" onClick={save}>Save</button>
                  </>
                )}
              </div>
            </div>
            {error ? <p className="error small">{error}</p> : null}
            {editing !== null ? (
              <textarea className="doc-editor" value={editing} onChange={e => setEditing(e.target.value)} autoFocus />
            ) : doc?.path === path ? (
              <pre className="doc-content">{doc.content || <span className="muted">(empty)</span>}</pre>
            ) : <p className="muted">Loading…</p>}
          </>
        )}
      </div>
    </div>
  );
}

import { useRef, useState } from 'react';
import { ConfirmButton } from '../../components/ConfirmButton';
import { downloadFile, projectAct, uploadFile } from '../../api';
import { ago, stamp } from '../../format';
import type { TabProps } from '../Project';

const MAX_BYTES = 25 * 1024 * 1024;

function size(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Files({ session, ov, refresh }: TabProps) {
  const slug = ov.project.slug;
  const input = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size > MAX_BYTES) throw new Error(`${file.name} is over 25 MB`);
        const prefix = folder.trim().replace(/^\/+|\/+$/g, '');
        await uploadFile(session, slug, prefix ? `${prefix}/${file.name}` : file.name, file);
      }
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(path: string) {
    await projectAct(session, 'files', 'delete', slug, { path });
    refresh();
  }

  return (
    <div>
      <div className="card pad add-device">
        <label className="inline">
          Folder
          <input placeholder="(top level)" value={folder} onChange={e => setFolder(e.target.value)} />
        </label>
        <input ref={input} type="file" multiple onChange={e => upload(e.target.files)} disabled={busy} />
        {busy ? <span className="muted small">Uploading…</span> : <span className="muted small">Up to 25 MB per file</span>}
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="card table-card">
        <table>
          <thead><tr><th>Path</th><th>Size</th><th>Type</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {ov.files.length === 0 ? <tr><td colSpan={5} className="muted">No files yet.</td></tr> : ov.files.map(f => (
              <tr key={f.path}>
                <td><b>{f.path}</b></td>
                <td>{size(f.size)}</td>
                <td className="muted">{f.content_type}</td>
                <td title={stamp(f.updated_at)}>{f.updated_by} · {ago(f.updated_at)}</td>
                <td className="right">
                  <button className="secondary small" onClick={() => downloadFile(session, slug, f.path).catch(err => setError(err.message))}>Download</button>{' '}
                  <ConfirmButton onConfirm={() => remove(f.path)}>Delete</ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

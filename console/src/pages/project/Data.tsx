import { useState, type FormEvent } from 'react';
import { ConfirmButton } from '../../components/ConfirmButton';
import { projectAct } from '../../api';
import { ago, stamp } from '../../format';
import type { TabProps } from '../Project';

export function Data({ session, ov, refresh }: TabProps) {
  const slug = ov.project.slug;
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function save(e?: FormEvent, k = key, v = value) {
    e?.preventDefault();
    setError(null);
    try {
      await projectAct(session, 'kv', 'set', slug, { key: k, value: v });
      setKey(''); setValue('');
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(k: string) {
    await projectAct(session, 'kv', 'delete', slug, { key: k });
    refresh();
  }

  return (
    <div>
      <p className="muted">Small shared facts and settings agents read and write (current release, URLs, decisions). Use JSON for structured values.</p>
      <form className="card pad add-device" onSubmit={save}>
        <input placeholder="key" value={key} onChange={e => setKey(e.target.value)} required maxLength={120} />
        <input className="grow-input" placeholder="value" value={value} onChange={e => setValue(e.target.value)} />
        <button className="primary">Set</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      <div className="card table-card">
        <table>
          <thead><tr><th>Key</th><th>Value</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {ov.kv.length === 0 ? <tr><td colSpan={4} className="muted">No data yet.</td></tr> : ov.kv.map(e => (
              <tr key={e.key}>
                <td><b>{e.key}</b></td>
                <td className="value-cell">
                  <input
                    defaultValue={e.value}
                    key={e.value}
                    onBlur={ev => { if (ev.target.value !== e.value) save(undefined, e.key, ev.target.value); }}
                    onKeyDown={ev => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }}
                  />
                </td>
                <td title={stamp(e.updated_at)}>{e.updated_by} · {ago(e.updated_at)}</td>
                <td className="right"><ConfirmButton onConfirm={() => remove(e.key)}>Delete</ConfirmButton></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

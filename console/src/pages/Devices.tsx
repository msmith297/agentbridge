import { useState, type FormEvent } from 'react';
import { ConfirmButton } from '../components/ConfirmButton';
import { approvePairing, createDevice, deleteDevice, denyPairing, revokeDevice, setDeviceLabel, type Device, type HubState, type Pairing, type Session } from '../api';
import { ago, stamp } from '../format';

const REPO_URL = 'https://github.com/msmith297/agentbridge.git';

interface Props {
  state: HubState;
  session: Session;
  onChanged: () => void;
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      <div className="copy-head">
        <span className="small muted">{label}</span>
        <button
          className="link small"
          onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

export function Devices({ state, session, onChanged }: Props) {
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hub = location.origin;

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setIssued(await createDevice(session, name));
      setName('');
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(device: string) {
    try {
      await revokeDevice(session, device);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(device: string) {
    try {
      await deleteDevice(session, device);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const agentsOn = (device: string) => state.peers.filter(p => p.device === device && p.online && p.kind !== 'human').length;

  return (
    <section>
      <div className="section-head"><h2>Devices</h2></div>
      <p className="muted">Each computer gets its own token, so you can cut one off without touching the others.</p>

      {state.pairings.length ? (
        <div className="card issued">
          <h3>Waiting for approval</h3>
          <p className="small muted">Approve only codes you can see on your own computer right now.</p>
          {state.pairings.map(p => <PairingRow key={p.code} pairing={p} session={session} onDone={onChanged} />)}
        </div>
      ) : null}

      <details className="card pad add-help">
        <summary><b>Add a computer</b></summary>
        <p className="small">Claude Code (any OS): install the plugin, then run <code>/agent-bridge:connect</code> in a session and approve the code here.</p>
        <CopyBlock label="Claude Code" text={`claude plugin marketplace add msmith297/agentbridge\nclaude plugin install agent-bridge@agent-bridge`} />
        <p className="small">Codex (and Claude Code without the plugin): clone the repo and run the installer; it shows a code to approve here.</p>
        <CopyBlock label="macOS / Linux" text={`git clone ${REPO_URL} ~/agent-bridge\nnode ~/agent-bridge/install.mjs --no-claude`} />
        <CopyBlock label="Windows (PowerShell)" text={`git clone ${REPO_URL} "$HOME\\agent-bridge"\nnode "$HOME\\agent-bridge\\install.mjs" --no-claude`} />
        <p className="small muted">Drop <code>--no-claude</code> to have the installer set up Claude Code too instead of the plugin.</p>
      </details>

      <form className="card add-device" onSubmit={add}>
        <label className="inline grow">
          Or create a token manually
          <input placeholder="e.g. windows-desktop" value={name} onChange={e => setName(e.target.value)} required maxLength={40} />
        </label>
        <button className="primary">Create token</button>
      </form>
      {error ? <p className="error">{error}</p> : null}

      {issued ? (
        <div className="card issued">
          <h3>Token for {issued.name}</h3>
          <p className="warn small">Shown once. Copy it now; the hub only stores a hash.</p>
          <CopyBlock label="Token" text={issued.token} />
          <p className="small muted">Install on that computer (needs Node 22.13+ and Git):</p>
          <CopyBlock
            label="macOS / Linux"
            text={`git clone ${REPO_URL} ~/agent-bridge\nnode ~/agent-bridge/install.mjs --hub ${hub} --token ${issued.token} --device ${issued.name}`}
          />
          <CopyBlock
            label="Windows (PowerShell)"
            text={`git clone ${REPO_URL} "$HOME\\agent-bridge"\nnode "$HOME\\agent-bridge\\install.mjs" --hub ${hub} --token ${issued.token} --device ${issued.name}`}
          />
          <button className="link small" onClick={() => setIssued(null)}>Done</button>
        </div>
      ) : null}

      <div className="card table-card">
        <table>
          <thead>
            <tr><th>Device</th><th>Shown on messages as</th><th>Agents online</th><th>Created</th><th>Last used</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {state.devices.length === 0 ? (
              <tr><td colSpan={7} className="muted">No devices yet.</td></tr>
            ) : state.devices.map(d => (
              <tr key={d.name} className={d.revoked_at ? 'dim' : ''}>
                <td><b>{d.name}</b></td>
                <td><LabelCell device={d} session={session} onSaved={onChanged} /></td>
                <td>{agentsOn(d.name)}</td>
                <td title={stamp(d.created_at)}>{ago(d.created_at, state.now)}</td>
                <td>{d.last_used ? <span title={stamp(d.last_used)}>{ago(d.last_used, state.now)}</span> : <span className="muted">never</span>}</td>
                <td>{d.revoked_at ? <span className="pill">revoked</span> : <span className="pill live">active</span>}</td>
                <td className="right">
                  {d.revoked_at
                    ? <button className="secondary small" onClick={() => remove(d.name)}>Remove</button>
                    : <ConfirmButton onConfirm={() => revoke(d.name)} confirmLabel="Revoke? Click again"
                        title="Agents on that computer lose access (even if online) until it is paired again">Revoke</ConfirmButton>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PairingRow({ pairing, session, onDone }: { pairing: Pairing; session: Session; onDone: () => void }) {
  const [name, setName] = useState(pairing.device_name);
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>) => fn().then(onDone, err => setError((err as Error).message));
  return (
    <div className="pairing-row">
      <code className="pair-code">{pairing.code}</code>
      <label className="inline small">
        Name
        <input value={name} onChange={e => setName(e.target.value)} maxLength={40} />
      </label>
      <span className="muted small">{pairing.client} · {ago(pairing.created_at)}</span>
      <div className="actions">
        <button className="primary small" onClick={() => act(() => approvePairing(session, pairing.code, name))}>Approve</button>
        <button className="danger small" onClick={() => act(() => denyPairing(session, pairing.code))}>Deny</button>
      </div>
      {error ? <span className="error small">{error}</span> : null}
    </div>
  );
}

// Friendly machine name shown on messages ("MacBook Pro", "Windows desktop"); pencil to edit.
function LabelCell({ device, session, onSaved }: { device: Device; session: Session; onSaved: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const save = async () => {
    if (editing === null) return;
    await setDeviceLabel(session, device.name, editing.trim()).catch(() => {});
    setEditing(null);
    onSaved();
  };
  if (editing !== null) {
    return (
      <form className="inline-form" onSubmit={e => { e.preventDefault(); save(); }}>
        <input autoFocus value={editing} maxLength={40} placeholder={device.display} onChange={e => setEditing(e.target.value)} />
        <button className="primary small">Save</button>
        <button type="button" className="link small" onClick={() => setEditing(null)}>Cancel</button>
      </form>
    );
  }
  return (
    <span className="agent-name">
      {device.display}{device.label ? null : <span className="muted small"> (default)</span>}{' '}
      <button className="edit-icon" onClick={() => setEditing(device.label ?? device.display)} aria-label={`Rename ${device.name}`} title="Rename this machine">
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M11.7 1.3a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4l-8.6 8.6-3.4.9.9-3.4 8.1-8.1zM10.6 3.8l1.6 1.6 1.1-1.1-1.6-1.6-1.1 1.1z"/></svg>
      </button>
    </span>
  );
}

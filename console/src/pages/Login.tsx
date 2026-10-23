import { useEffect, useState, type FormEvent } from 'react';
import { AuthError, accessLogin, fetchState, saveSession, type AccessLogin, type Session } from '../api';

const NAME_KEY = 'agent-bridge-console-name';
const lastName = () => { try { return localStorage.getItem(NAME_KEY); } catch { return null; } };

export function Login({ onSignIn }: { onSignIn: (s: Session) => void }) {
  const [access, setAccess] = useState<AccessLogin | null | undefined>(undefined); // undefined: still checking
  const [useToken, setUseToken] = useState(false);
  const [token, setToken] = useState('');
  const [name, setName] = useState(lastName() || 'operator');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(session: Session) {
    setBusy(true);
    setError(null);
    try {
      await fetchState(session);
      saveSession(session);
      try { localStorage.setItem(NAME_KEY, session.name); } catch { /* ignore */ }
      onSignIn(session);
    } catch (err) {
      setError(err instanceof AuthError
        ? (session.token ? 'That admin token was not accepted.' : 'Your Cloudflare login was not accepted by the hub.')
        : `Can't reach the hub: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  // Already signed in to Cloudflare Access: continue straight away under the last-used name.
  useEffect(() => {
    accessLogin().then(a => {
      setAccess(a);
      const remembered = lastName();
      if (a?.admin && remembered) signIn({ token: '', name: remembered });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim() || 'operator';
    signIn(useToken || !access?.admin ? { token: token.trim(), name: n } : { token: '', name: n });
  };

  if (access === undefined) return <div className="login"><p className="muted">Checking sign-in…</p></div>;
  const viaAccess = access?.admin && !useToken;

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>Agent Bridge</h1>
        {viaAccess ? (
          <p className="muted">Signed in with Cloudflare{access.email ? <> as <b>{access.email}</b></> : null}.</p>
        ) : (
          <>
            <p className="muted">Sign in with the hub's admin token.</p>
            <label>
              Admin token
              <input type="password" value={token} onChange={e => setToken(e.target.value)} autoFocus required autoComplete="current-password" />
            </label>
          </>
        )}
        <label>
          Your name on the bridge
          <input value={name} onChange={e => setName(e.target.value)} maxLength={64} autoFocus={viaAccess} />
          <span className="hint">Agents see you under this name and can message you here.</span>
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button className="primary" disabled={busy || (!viaAccess && !token.trim())}>
          {busy ? 'Signing in…' : viaAccess ? 'Continue' : 'Sign in'}
        </button>
        {access?.admin ? (
          <button type="button" className="link small" onClick={() => setUseToken(!useToken)}>
            {useToken ? 'Use my Cloudflare login instead' : 'Use the admin token instead'}
          </button>
        ) : null}
      </form>
    </div>
  );
}

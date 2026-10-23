import { useState, type FormEvent } from 'react';
import { deleteAccount, setAccountAlias, type Account, type HubState, type Session } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { MemberStack } from '../components/Identity';
import { ago, stamp } from '../format';

// The AI accounts agents run on: Claude / ChatGPT subscriptions and API keys (by fingerprint).
// Agents report theirs when they connect; name each one (e.g. "Claude 1"), like a computer.
// Emails show only here, never to agents.

const providerName = (a: Account) => (a.provider === 'anthropic' ? 'Claude' : a.provider === 'openai' ? 'ChatGPT' : a.provider ?? 'Account');
const planName = (a: Account) => a.plan?.replace(/^(claude|chatgpt)_/i, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) ?? null;
const realOrg = (a: Account) => (a.org && !a.org.includes('@') && !/'s organization$/i.test(a.org) ? a.org : null);

export function Accounts({ state, session, onChanged }: { state: HubState; session: Session; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const accounts = state.accounts ?? [];
  const unnamed = accounts.filter(a => !a.alias).length;

  async function remove(a: Account) {
    try {
      await deleteAccount(session, a.id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section>
      <div className="section-head"><h2>Accounts</h2></div>
      <p className="muted page-intro">
        The AI accounts your agents run on. Agents report theirs when they connect: Claude and ChatGPT sign-ins by account, API keys by a
        short fingerprint (the key never leaves the computer). Give each one a name, like <b>Claude 1</b>: agents and the console show that
        name next to every agent on it. Emails are shown only on this page.
      </p>
      {unnamed ? <div className="banner info static">{unnamed === 1 ? '1 account has' : `${unnamed} accounts have`} no name yet: click a name to set one.</div> : null}
      {error ? <p className="error">{error}</p> : null}
      {accounts.length === 0 ? (
        <div className="card empty"><p className="muted">No accounts reported yet. Agents report theirs when they (re)connect with an up-to-date plugin.</p></div>
      ) : (
        <div className="account-grid">
          {accounts.map(a => {
            // Like the Agents page: the online agents up front, offline ones (last 24 h) only counted.
            const online = a.agents.filter(n => state.peers.some(p => p.name === n && p.online));
            const offline = a.agents.length - online.length;
            return (
              <article key={a.id} className="card account">
                <header className="account-head">
                  <span className={`provider-badge ${a.provider ?? ''}`} aria-hidden>{a.provider === 'openai' ? '◎' : '✳︎'}</span>
                  <div className="account-id">
                    <NameEditor account={a} session={session} onSaved={onChanged} />
                    <div className="muted small">
                      {providerName(a)} {a.type === 'api' ? 'API key' : 'subscription'}{planName(a) ? ` · ${planName(a)}` : ''}{realOrg(a) ? ` · ${realOrg(a)}` : ''}
                    </div>
                  </div>
                  <ConfirmButton className="link small danger-link" onConfirm={() => remove(a)} confirmLabel="Remove?"
                    title="Forget this account (it comes back if an agent reports it again)">Remove</ConfirmButton>
                </header>
                <dl className="account-facts">
                  <div><dt>Signed in as</dt><dd>{a.email ?? (a.type === 'api' ? `key ${a.id.split('-').pop()}` : <span className="muted">not reported</span>)}</dd></div>
                  <div><dt>Last seen</dt><dd title={stamp(a.last_seen)}>{ago(a.last_seen, state.now)}</dd></div>
                </dl>
                <div className="account-agents">
                  {online.length ? <MemberStack names={online} state={state} title={online.join('\n')} noun="online agent" /> : null}
                  {a.agents.length ? (
                    <span className="muted small" title={offline ? 'Offline agents seen in the last 24 hours' : undefined}>
                      {online.length ? (offline ? `+ ${offline} offline` : '') : `None online${offline ? ` · ${offline} offline` : ''}`}
                    </span>
                  ) : <span className="muted small">No agents on it right now.</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function NameEditor({ account, session, onSaved }: { account: Account; session: Session; onSaved: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (editing === null) return;
    await setAccountAlias(session, account.id, editing.trim()).catch(() => {});
    setEditing(null);
    onSaved();
  }
  if (editing !== null) {
    return (
      <form className="inline-form" onSubmit={save}>
        <input autoFocus value={editing} maxLength={80} placeholder="e.g. Claude 1" onChange={e => setEditing(e.target.value)} />
        <button className="primary small">Save</button>
        <button type="button" className="link small" onClick={() => setEditing(null)}>Cancel</button>
      </form>
    );
  }
  return (
    <button className="account-name" onClick={() => setEditing(account.alias ?? '')} title="Name this account">
      {account.alias ? account.display : <span className="unnamed">{account.display}</span>}
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M11.7 1.3a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4l-8.6 8.6-3.4.9.9-3.4 8.1-8.1zM10.6 3.8l1.6 1.6 1.1-1.1-1.6-1.6-1.1 1.1z"/></svg>
    </button>
  );
}

import { useState } from 'react';
import { decideApproval, type AgentQuestion, type Approval, type HubState, type Session } from '../api';
import { ago, folderName } from '../format';

// Prompts agents forwarded instead of waiting in their app (remote approvals): permission prompts,
// multiple-choice questions and plan approvals. Shown on every page until answered.
export function Approvals({ state, session, onChanged }: { state: HubState; session: Session; onChanged: () => void }) {
  if (!state.approvals?.length) return null;
  return (
    <section className="approvals">
      {state.approvals.map(a => a.kind === 'question' ? <QuestionCard key={a.id} a={a} now={state.now} session={session} onChanged={onChanged} />
        : <ApprovalCard key={a.id} a={a} now={state.now} session={session} onChanged={onChanged} />)}
    </section>
  );
}

function ApprovalCard({ a, now, session, onChanged }: { a: Approval; now: number; session: Session; onChanged: () => void }) {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan = a.kind === 'plan';
  async function decide(decision: 'allow' | 'deny') {
    setBusy(true);
    setError(null);
    try {
      await decideApproval(session, a.id, decision, reason.trim());
      onChanged();
    } catch (err) {
      setError((err as Error).message);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card approval">
      <div className="approval-head">
        <div>
          <b>{a.peer_name}</b> <span className="muted small">on {a.machine}{a.cwd ? ` · ${folderName(a.cwd)}` : ''} · {ago(a.created_at, now)}</span>
          <div>{plan ? 'asks you to approve its plan' : <>wants to use <b>{a.tool_name}</b></>}</div>
        </div>
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => decide('allow')}>{plan ? 'Approve plan' : 'Allow'}</button>
          <button className="secondary danger" disabled={busy} onClick={() => decide('deny')}>{plan ? 'Request changes' : 'Deny'}</button>
        </div>
      </div>
      {plan ? <pre className="approval-plan">{a.payload?.plan}</pre> : a.summary ? <pre className="approval-summary">{a.summary}</pre> : null}
      <div className="approval-more">
        {plan ? null : <button className="link small" onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}</button>}
        <input className="small" placeholder={plan ? 'What to change (sent with Request changes)' : 'Note to the agent (optional, sent with Deny)'}
          value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} />
      </div>
      {open && !plan ? <pre className="approval-detail">{a.detail}</pre> : null}
      {error ? <p className="error small">{error}</p> : null}
    </article>
  );
}

// One or more multiple-choice questions (Claude Code's AskUserQuestion), answered together.
function QuestionCard({ a, now, session, onChanged }: { a: Approval; now: number; session: Session; onChanged: () => void }) {
  const questions = a.payload?.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerOf = (q: AgentQuestion) => [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])];
  const complete = questions.every(q => answerOf(q).length > 0);

  function toggle(q: AgentQuestion, label: string) {
    const now = picked[q.question] ?? [];
    setPicked({ ...picked, [q.question]: q.multiSelect ? (now.includes(label) ? now.filter(l => l !== label) : [...now, label]) : [label] });
    if (!q.multiSelect) setOther({ ...other, [q.question]: '' });
  }

  async function send(decision: 'answer' | 'deny') {
    setBusy(true);
    setError(null);
    try {
      const answers = Object.fromEntries(questions.map(q => [q.question, q.multiSelect ? answerOf(q) : answerOf(q).join(', ')]));
      await decideApproval(session, a.id, decision, '', decision === 'answer' ? answers : undefined);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card approval question">
      <div className="approval-head">
        <div>
          <b>{a.peer_name}</b> <span className="muted small">on {a.machine}{a.cwd ? ` · ${folderName(a.cwd)}` : ''} · {ago(a.created_at, now)}</span>
          <div>has {questions.length === 1 ? 'a question' : `${questions.length} questions`} for you</div>
        </div>
      </div>
      {questions.map(q => (
        <fieldset key={q.question} className="question-block">
          <legend>{q.header ? <span className="tag">{q.header}</span> : null} {q.question}{q.multiSelect ? <span className="muted small"> (pick any)</span> : null}</legend>
          <div className="question-options">
            {(q.options ?? []).map(o => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button type="button" key={o.label} className={`question-option${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(q, o.label)}>
                  <span className={`question-mark${q.multiSelect ? ' multi' : ''}`} aria-hidden>{on ? '✓' : ''}</span>
                  <span><b>{o.label}</b>{o.description ? <span className="muted small"> {o.description}</span> : null}</span>
                </button>
              );
            })}
          </div>
          <input className="small" placeholder="Other (type your own answer)" value={other[q.question] ?? ''} maxLength={1000}
            onChange={e => { setOther({ ...other, [q.question]: e.target.value }); if (!q.multiSelect && e.target.value) setPicked({ ...picked, [q.question]: [] }); }} />
        </fieldset>
      ))}
      <div className="actions question-actions">
        <button className="secondary" disabled={busy} onClick={() => send('deny')} title="Tell the agent you're not answering this">Dismiss</button>
        <button className="primary" disabled={busy || !complete} onClick={() => send('answer')}>{complete ? 'Send answer' : 'Answer every question'}</button>
      </div>
      {error ? <p className="error small">{error}</p> : null}
    </article>
  );
}

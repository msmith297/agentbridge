import type { HubState, Peer } from '../api';
import { nameHue } from './Mentions';
import { appMark } from './Identity';

// Two tiny glyphs for where an agent runs: its computer (laptop / desktop) and its AI account
// (Claude / ChatGPT / API key), each tinted per computer or account so twins are easy to tell
// apart in a narrow list. Hover shows the names.

const isLaptop = (s: string) => /mac|book|laptop|air|pro\b/i.test(s);

function ComputerGlyph({ laptop }: { laptop: boolean }) {
  return laptop ? (
    <svg viewBox="0 0 16 16" aria-hidden><rect x="3" y="3.5" width="10" height="7" rx="1.2" /><path d="M1.5 12.5h13" /></svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-hidden><rect x="2" y="2.5" width="12" height="8.5" rx="1.2" /><path d="M6 14h4M8 11v3" /></svg>
  );
}

function AccountGlyph({ provider, api }: { provider: string | null; api: boolean }) {
  if (api) return <svg viewBox="0 0 16 16" aria-hidden><circle cx="5.5" cy="8" r="2.6" /><path d="M8 8h6M12 8v2.4M10 8v1.6" /></svg>;
  if (provider === 'openai') return <svg viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="5.4" /><circle cx="8" cy="8" r="2" /></svg>;
  // Claude: a small sunburst.
  return <svg viewBox="0 0 16 16" aria-hidden><path d="M8 2.2v11.6M2.2 8h11.6M3.9 3.9l8.2 8.2M12.1 3.9l-8.2 8.2" /></svg>;
}

export function OriginIcons({ peer, state }: { peer?: Peer | null; state: HubState }) {
  if (!peer || peer.kind === 'human') return null;
  const machine = state.device_labels?.[peer.device] || peer.device;
  const account = peer.account_id ? state.accounts?.find(a => a.id === peer.account_id) : null;
  const accountName = peer.account || account?.display || null;
  // A short tag for accounts named like "Claude 2" so two accounts of one provider differ at a glance.
  const tag = accountName?.match(/\b(\d{1,2})$/)?.[1] ?? null;
  // Computers have fixed colours by platform: Windows dark blue, Mac light purple (others by name).
  const laptop = isLaptop(`${machine} ${peer.device}`);
  const platform = peer.os === 'win32' ? 'windows' : peer.os === 'darwin' ? 'mac' : null;
  const mark = appMark(peer);
  return (
    <span className="origin-icons" title={`${machine}${accountName ? ` · ${accountName}` : ''}`}>
      <span className={`origin-icon${platform ? ` pc-${platform}` : ''}`} style={{ ['--h' as string]: nameHue('device', peer.device) }} aria-label={`Computer: ${machine}`}>
        <ComputerGlyph laptop={platform ? platform === 'mac' : laptop} />
      </span>
      {!accountName && mark ? (
        <span className="origin-icon app-mark" style={{ ['--h' as string]: 2 }} aria-label={`App: ${mark.label}`}><b className="app-mark-text">{mark.text}</b></span>
      ) : null}
      {accountName ? (
        <span className="origin-icon" style={{ ['--h' as string]: nameHue('account', peer.account_id || accountName) }} aria-label={`Account: ${accountName}`}>
          <AccountGlyph provider={account?.provider ?? (peer.kind === 'codex' ? 'openai' : 'anthropic')} api={account?.type === 'api'} />
          {tag ? <b>{tag}</b> : null}
        </span>
      ) : null}
    </span>
  );
}

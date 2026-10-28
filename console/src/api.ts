// Admin API client and console session (operator name, plus the admin token unless signed in
// through Cloudflare Access; kept in this browser).

export interface Peer {
  id: string;
  name: string;
  kind: string | null;
  app: string | null;
  device: string;
  cwd: string | null;
  summary: string;
  project: string | null;
  client_version: string | null; // e.g. "plugin 3f7921b" or "installer 3f7921b"
  last_seen: number;
  online: boolean;
  listening: boolean; // listening mode switched on
  waiting: boolean;   // actually waiting for messages now (replies without a prompt)
  listen_always: boolean;
  approvals: ApprovalMode; // when its permission prompts come to the console
  icon: string | null;      // emoji avatar
  color: string | null;     // #rrggbb
  account: string | null;   // the AI account it runs on (display name)
  activity: { state: 'thinking' | 'working' | 'idle'; detail: string; at: number } | null; // live status from its hooks
  listen_changed_by: string | null; // who last switched listening (the agent itself / operator)
  listen_changed_at: number | null;
  role: 'manager' | null;   // Bridge Manager of its computer + account + app
  keep_awake: boolean;
  polled_at?: number | null; // when its listener last polled for mail (null: not since the hub started)
  os?: string | null;       // the agent's computer: win32 | darwin | linux (from its client)      // gets keepalive turns so the Claude app doesn't stop it when idle (default: Managers)
  display_name: string;     // what to show (may repeat across computers/accounts; `name` is the unique address)
  key: string;              // stable identity (survives renames, name clashes and restarts)
  host_session_id: string | null;
  account_id: string | null;
}

// An AI account agents run on (Claude / ChatGPT subscription, or an API key fingerprint).
export interface Account {
  id: string;
  provider: string | null; // anthropic | openai
  type: string | null;     // subscription | api
  email: string | null;    // console only
  org: string | null;
  plan: string | null;
  label: string | null;
  alias: string | null;
  display: string;
  agents: string[];
  first_seen: number;
  last_seen: number;
}

export type ApprovalMode = 'away' | 'always' | 'off';

// A permission prompt an agent forwarded for the operator to answer.
export interface Approval {
  id: number;
  peer_id: string;
  peer_name: string;
  device: string;
  machine: string;
  tool_name: string;
  summary: string;
  detail: string;
  cwd: string;
  created_at: number;
  kind: 'permission' | 'question' | 'plan';
  payload: { questions?: AgentQuestion[]; plan?: string } | null;
}

// A multiple-choice question an agent asked (Claude Code's AskUserQuestion).
export interface AgentQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  content_type: string;
}

export interface Chat {
  id: number;
  title: string;
  members: string[];
  created_by: string | null;
  created_at: number;
  last_message_at: number | null;
}

export interface Message {
  attachments?: Attachment[];
  chat_id?: number | null;
  project?: string | null; // a project chat message (to the project, or a reply in it)
  send_id?: string | null;
  from_device?: string | null; // machine the message came from ('console' for the operator)
  from_key?: string | null;    // stable identities of sender and recipient (see Peer.key)
  to_key?: string | null;
  id: number;
  from: string;
  to: string;
  body: string;
  reply_to: number | null;
  created_at: number;
  delivered_at: number | null;
}

export interface Device {
  name: string;
  label: string | null;   // operator-set friendly name
  display: string;        // label, or a default guessed from the name/OS
  created_at: number;
  last_used: number | null;
  revoked_at: number | null;
}

export interface Pairing {
  code: string;
  device_name: string;
  client: string;
  created_at: number;
}

export interface HubState {
  now: number;
  incremental?: boolean; // messages holds only changes since the last poll
  dm_heads?: Message[];  // full loads: the newest message of each direct conversation older than `messages`
  peers: Peer[];
  messages: Message[];
  devices: Device[];
  pairings: Pairing[];
  approvals: Approval[];
  accounts: Account[];
  chats: Chat[];
  device_labels: Record<string, string>;
  hidden?: Record<string, number>; // conversations this operator deleted: conv key -> hidden up to message id
}

export interface SendResult {
  delivered_to: string[];
  message_ids: number[];
  recipient_status: { name: string; key?: string | null; kind: string | null; online: boolean; listening: boolean; waiting: boolean; reviving?: string }[]; // key: the identity it went to; reviving: who was asked to bring it back online
  chat: Chat | null;
}

export interface Session {
  token: string; // '' when signed in with Cloudflare Access (the hub accepts that login instead)
  name: string;
}

// Authorization header for a session (none for an Access sign-in).
export const authHeaders = (s: Session): Record<string, string> => (s.token ? { authorization: `Bearer ${s.token}` } : {});

export interface AccessLogin {
  admin: boolean;
  email: string | null;
}

// Who Cloudflare Access says this browser is, or null (no Access login, or a hub without it).
export async function accessLogin(): Promise<AccessLogin | null> {
  try {
    const res = await fetch('/admin/access', { redirect: 'manual' });
    if (!res.ok && res.status !== 403) return null;
    return (await res.json()) as AccessLogin;
  } catch {
    return null;
  }
}

const STORAGE_KEY = 'agent-bridge-console';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* private mode: session lasts this tab */ }
}

export function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export class AuthError extends Error {}

export async function adminCall<T>(session: Session, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/admin${path}`, {
    method,
    headers: { ...authHeaders(session), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new AuthError(data.error || 'Not authorized');
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

// Actively at a desktop console (on screen, mouse/keyboard used in the last 2 minutes): the hub holds
// back phone notifications meanwhile.
let lastInput = Date.now();
if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll']) window.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true });
}
const atDesktop = () => typeof document !== 'undefined' && document.visibilityState === 'visible' && Date.now() - lastInput < 120_000
  && typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches && !/iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent);

// The conversation on screen (named like the hub names it), so it doesn't push notifications for it.
function onScreen(): string | null {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return null;
  const [page, a, b, c] = location.hash.replace(/^#\/?/, '').split('/');
  if (page === 'messages' && a === 'dm' && b) return `dm:${decodeURIComponent(b)}`;
  if (page === 'messages' && a === 'chat' && b) return `chat:${b}`;
  if (page === 'projects' && a && (!b || b === 'chat') && !c) return `project:${decodeURIComponent(a)}`;
  return null;
}

export const fetchState = (s: Session, since?: { id: number; ts: number }) => {
  const viewing = onScreen();
  return adminCall<HubState>(s, 'GET', `/state?as=${encodeURIComponent(s.name)}&limit=500${since ? `&since_id=${since.id}&since_ts=${since.ts}` : ''}` +
    (viewing ? `&viewing=${encodeURIComponent(viewing)}` : '') + (atDesktop() ? '&active=desktop' : ''));
};

// Merge an incremental poll into the previous state (messages keyed by id, newest first, capped).
export function mergeState(prev: HubState | null, next: HubState): HubState {
  if (!next.incremental || !prev) return next;
  const byId = new Map(prev.messages.map(m => [m.id, m]));
  for (const m of next.messages) byId.set(m.id, m);
  return { ...next, messages: [...byId.values()].sort((a, b) => b.id - a.id).slice(0, 1000) };
}

// History loaded per conversation (below) stays across polls, full reloads included: /state carries
// only the newest messages overall, so a busy conversation pushes the others' history out of it.
// `updates` (this poll's messages) refresh the kept copies' read receipts.
export function keepHistory(state: HubState, history: Map<number, Message>, updates: Message[] = [], full = false): HubState {
  if (!history.size) return state;
  for (const m of updates) if (history.has(m.id)) history.set(m.id, m);
  const byId = new Map(state.messages.map(m => [m.id, m]));
  // A full reload has every message from its oldest one up: a kept one missing there was deleted.
  const floor = full && state.messages.length ? state.messages[state.messages.length - 1].id : Infinity;
  for (const [id, m] of history) {
    if (byId.has(id)) continue;
    if (id >= floor) history.delete(id);
    else byId.set(id, m);
  }
  return { ...state, messages: [...byId.values()].sort((a, b) => b.id - a.id) };
}

// One conversation's messages older than `before` (newest first, whole sends); more: older ones remain.
export type HistoryQuery = { chat: number } | { dm: string } | { project: string };
export interface HistoryPage { messages: Message[]; more: boolean }
export const fetchHistory = (s: Session, q: HistoryQuery, before?: number) => {
  const [k, v] = Object.entries(q)[0];
  return adminCall<HistoryPage>(s, 'GET', `/messages?${k}=${encodeURIComponent(String(v))}&as=${encodeURIComponent(s.name)}&limit=100${before && Number.isFinite(before) ? `&before=${before}` : ''}`);
};

export interface Outgoing {
  to?: string[];      // one or more names, or ['*']
  keys?: Record<string, string>; // address -> identity key: delivered to that agent even if its address changed
  chat?: number;      // or a chat id
  project?: string;   // with to ['*']: everyone in the project
  message: string;
  replyTo?: number | null;
  attachments?: string[];
  mentions?: string[]; // in a group: everyone gets it, only these are notified
}

export const sendMessage = (s: Session, o: Outgoing) =>
  adminCall<SendResult>(s, 'POST', '/send', { from: s.name, to: o.to, to_keys: o.keys, chat: o.chat, project: o.project, message: o.message, reply_to: o.replyTo ?? null, attachments: o.attachments ?? [], mentions: o.mentions ?? [] });

export const setDeviceLabel = (s: Session, name: string, label: string) =>
  adminCall<{ name: string; display: string }>(s, 'POST', '/devices/label', { name, label });

export const chatAction = (s: Session, body: Record<string, unknown>) => adminCall<Chat>(s, 'POST', '/chats', { ...body, as: s.name });

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export async function uploadAttachment(s: Session, file: File) {
  const q = new URLSearchParams({ name: file.name || 'pasted-image.png', type: file.type || 'application/octet-stream', as: s.name });
  const res = await fetch(`/admin/attachments/upload?${q}`, {
    method: 'POST',
    headers: { ...authHeaders(s), 'content-type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as Attachment;
}

// The same upload with progress reports (0..1), for the composer's instant attachments.
export function uploadAttachmentWithProgress(s: Session, file: File, onProgress: (fraction: number) => void): Promise<Attachment> {
  const q = new URLSearchParams({ name: file.name || 'pasted-image.png', type: file.type || 'application/octet-stream', as: s.name });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/admin/attachments/upload?${q}`);
    for (const [k, v] of Object.entries(authHeaders(s))) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data: { error?: string } = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Attachment);
      else reject(new Error(data.error || `upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('upload failed (network)'));
    xhr.send(file);
  });
}

// Attachments need the admin login, so fetch them as blobs (cached per page load).
const blobCache = new Map<string, Promise<string>>();
export function attachmentUrl(s: Session, id: string): Promise<string> {
  if (!blobCache.has(id)) {
    blobCache.set(id, fetch(`/admin/attachments/download?attachment=${encodeURIComponent(id)}`, { headers: authHeaders(s) })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then(b => URL.createObjectURL(b)));
  }
  return blobCache.get(id)!;
}

export const ackMessages = (s: Session, ids: number[]) => adminCall(s, 'POST', '/ack', { as: s.name, ids });

// The operator name the hub keeps for this sign-in (one per Cloudflare login), so every device is the same person.
export const getOperator = (s: Session) => adminCall<{ name: string | null; email: string | null }>(s, 'GET', '/me');
export const setOperator = (s: Session, name: string) => adminCall<{ name: string | null }>(s, 'POST', '/me', { name });

// Delete a conversation from this operator's console (agents keep their copies; new messages bring it back).
export const hideConversation = (s: Session, conv: string, beforeId: number) =>
  adminCall(s, 'POST', '/conversations/hide', { as: s.name, conv, before_id: beforeId });

export const setListening = (s: Session, name: string, listen: 'always' | number) =>
  adminCall(s, 'POST', '/listen', { name, listen, as: s.name });

export const createDevice = (s: Session, name: string) => adminCall<{ name: string; token: string }>(s, 'POST', '/devices', { name });

export const revokeDevice = (s: Session, name: string) => adminCall(s, 'POST', '/devices/revoke', { name });

export const deleteDevice = (s: Session, name: string) => adminCall(s, 'POST', '/devices/delete', { name });

export const approvePairing = (s: Session, code: string, name: string) =>
  adminCall<{ device: string }>(s, 'POST', '/pairings/approve', { code, name });

export const denyPairing = (s: Session, code: string) => adminCall(s, 'POST', '/pairings/deny', { code });

export const deletePeer = (s: Session, name: string) => adminCall(s, 'POST', '/peers/delete', { name });

export const renamePeer = (s: Session, id: string, name: string) => adminCall<{ name: string }>(s, 'POST', '/peers/rename', { id, name });

// Removes an agent even if it's online; its process can't re-register (a restarted session rejoins).
export const removePeer = (s: Session, id: string) => adminCall(s, 'POST', '/peers/remove', { id });

export const setIdentity = (s: Session, name: string, identity: { icon?: string; color?: string }) =>
  adminCall(s, 'POST', '/peers/identity', { name, ...identity });
export const setAccountAlias = (s: Session, id: string, alias: string) => adminCall(s, 'POST', '/accounts/alias', { id, alias });
export const deleteAccount = (s: Session, id: string) => adminCall(s, 'POST', '/accounts/delete', { id });

export const setRole = (s: Session, id: string, role: 'manager' | null) => adminCall(s, 'POST', '/peers/role', { id, role });
export const setKeepAwake = (s: Session, id: string, on: boolean) => adminCall(s, 'POST', '/peers/keep-awake', { id, on });
export const askManagersToUpdate = (s: Session, version: string) =>
  adminCall<{ asked: string[] }>(s, 'POST', '/managers/update', { version });

export const setApprovalMode = (s: Session, id: string, mode: ApprovalMode) => adminCall(s, 'POST', '/peers/approvals', { id, mode });

export const decideApproval = (s: Session, approval: number, decision: 'allow' | 'deny' | 'answer', message = '', answers?: Record<string, string | string[]>) =>
  adminCall(s, 'POST', '/approvals/decide', { approval, decision, message, answers, as: s.name });

// ---- projects ----

export interface ProjectSummary {
  slug: string;
  name: string;
  description: string;
  created_at: number;
  open_tasks: number;
  docs: number;
  files: number;
  last_activity: number | null;
}

export interface Member {
  name: string;
  kind: string | null;
  app: string | null;
  device: string;
  summary: string;
  last_seen: number;
  listening: boolean;
  waiting: boolean;
  online?: boolean; // the console's overview lists offline members too
}

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done';

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  assignee: string | null;
  created_by: string | null;
  updated_at: number;
}

export interface TaskDetail extends Task {
  body: string;
  created_at: number;
  notes: { author: string; note: string; created_at: number }[];
}

export interface DocMeta { path: string; version: number; size: number; updated_at: number; updated_by: string }
export interface Doc extends DocMeta { content: string }
export interface FileMeta { path: string; size: number; content_type: string; updated_at: number; updated_by: string }
export interface KvEntry { key: string; value: string; updated_at: number; updated_by: string }
export interface ProjectEvent { actor: string; kind: string; summary: string; created_at: number }

export interface ProjectOverview {
  project: { slug: string; name: string; description: string; created_at: number; created_by: string };
  members: Member[];
  tasks: Task[];
  done_tasks: number;
  docs: DocMeta[];
  files: FileMeta[];
  kv: KvEntry[];
  events: ProjectEvent[];
  messages: Message[];
  device_labels: Record<string, string>;
  participants?: string[]; // agents taking part in the project chat without being members
}

export const listProjects = (s: Session) => adminCall<{ projects: ProjectSummary[] }>(s, 'GET', '/projects');

export const createProject = (s: Session, name: string, description: string) =>
  adminCall<{ slug: string }>(s, 'POST', '/project', { action: 'create', name, description, as: s.name });

export const deleteProject = (s: Session, project: string) => adminCall(s, 'POST', '/project', { action: 'delete', project });
// Put an agent in a project (it leaves the one it was in: an agent is in one project at a time), or take it out.
export const setProjectMember = (s: Session, project: string, name: string, add: boolean) =>
  adminCall<{ name: string; project: string | null; previous: string | null }>(s, 'POST', '/project', { action: add ? 'add' : 'remove', project, name, as: s.name });

export const projectOverview = (s: Session, project: string) =>
  adminCall<ProjectOverview>(s, 'POST', '/project', { action: 'overview', project, as: s.name });

// docs | tasks | kv | files actions, performed as the operator.
export const projectAct = <T = unknown>(s: Session, resource: 'docs' | 'tasks' | 'kv' | 'files', action: string, project: string, args: Record<string, unknown> = {}) =>
  adminCall<T>(s, 'POST', `/${resource}`, { ...args, action, project, as: s.name });

export const postToProject = (s: Session, project: string, message: string) =>
  adminCall<SendResult>(s, 'POST', '/send', { from: s.name, to: '*', message, project });

export async function uploadFile(s: Session, project: string, path: string, file: File) {
  const q = new URLSearchParams({ project, path, as: s.name, type: file.type || 'application/octet-stream' });
  const res = await fetch(`/admin/files/upload?${q}`, {
    method: 'POST',
    headers: { ...authHeaders(s), 'content-type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as { path: string; size: number };
}

export async function downloadFile(s: Session, project: string, path: string) {
  const res = await fetch(`/admin/files/download?${new URLSearchParams({ project, path })}`, {
    headers: authHeaders(s),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = path.split('/').pop() || 'download';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- push notifications ----

export const pushKey = (s: Session) => adminCall<{ publicKey: string | null }>(s, 'GET', '/push/key');
export const pushSubscribe = (s: Session, subscription: PushSubscriptionJSON) =>
  adminCall(s, 'POST', '/push/subscribe', { as: s.name, subscription });
export const pushUnsubscribe = (s: Session, endpoint: string) => adminCall(s, 'POST', '/push/unsubscribe', { endpoint });
export const pushTest = (s: Session, endpoint: string) => adminCall(s, 'POST', '/push/test', { endpoint });

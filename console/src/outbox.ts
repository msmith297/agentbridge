import { useSyncExternalStore } from 'react';
import { uploadAttachmentWithProgress, type Message, type Session } from './api';

// Instant attachments and sending: files start uploading as soon as they're added to a composer,
// and a sent message shows in its conversation straight away (with upload progress) while the
// uploads finish and the hub takes it.

export interface Upload {
  key: string;
  file: File;
  preview: string | null; // object URL for images
  progress: number;       // 0..1
  id?: string;            // attachment id once uploaded
  error?: string;
  done: Promise<string>;  // resolves to the attachment id
}

export interface Outgoing {
  key: string;
  conv: string;      // conversation key (see convKey)
  text: string;
  uploads: string[]; // Upload keys
  at: number;
  error?: string;
  sent?: boolean; // the hub has it; shown until the conversation's copy replaces it
}

const uploads = new Map<string, Upload>();
const replying = new Map<string, Message>(); // conversation key -> message being replied to
let outgoing: Outgoing[] = [];
const runs = new Map<string, () => Promise<void>>(); // outgoing key -> (re)try sending it
// Message id -> the outgoing key it was sent as, so the conversation keeps showing the same element
// (no remount, no jump) when the sent copy replaces the pending one.
const sentAs = new Map<number, string>();
export const linkSent = (key: string, ids: number[]) => { for (const id of ids) sentAs.set(id, key); };
export const sentKey = (id: number) => sentAs.get(id);
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version++; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
const newKey = () => Math.random().toString(36).slice(2, 10);

export function useOutbox() {
  useSyncExternalStore(subscribe, () => version);
  return { uploads, outgoing, replying };
}

// The composer of conversation `conv` replies to `message` (null: stop replying).
export function setReplyTo(conv: string, message: Message | null) {
  if (message) replying.set(conv, message); else replying.delete(conv);
  changed();
}

function upload(session: Session, u: Upload) {
  u.progress = 0;
  u.error = undefined;
  u.done = uploadAttachmentWithProgress(session, u.file, p => { u.progress = p; changed(); }).then(
    a => { u.id = a.id; u.progress = 1; changed(); return a.id; },
    err => { u.error = (err as Error).message; changed(); throw err; });
  u.done.catch(() => {}); // failures show on the chip / message; don't report them as unhandled
  changed();
}

export function startUpload(session: Session, file: File): string {
  const u: Upload = {
    key: newKey(), file, progress: 0, done: Promise.resolve(''),
    preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
  };
  uploads.set(u.key, u);
  upload(session, u);
  return u.key;
}

export function retryUpload(session: Session, key: string) {
  const u = uploads.get(key);
  if (u?.error) upload(session, u);
}

export function dropUpload(key: string) {
  const u = uploads.get(key);
  if (u?.preview) URL.revokeObjectURL(u.preview);
  uploads.delete(key);
  changed();
}

// Queue a message: it shows in its conversation at once and is sent when its uploads are done.
// `deliver` sends it with the attachment ids; `after` runs once the hub has it.
export function sendQueued(session: Session, conv: string, text: string, uploadKeys: string[],
  deliver: (attachmentIds: string[], key: string) => Promise<void>, after: () => Promise<unknown> | void) {
  const item: Outgoing = { key: newKey(), conv, text, uploads: uploadKeys, at: Date.now() };
  outgoing = [...outgoing, item];
  const run = async () => {
    item.error = undefined;
    changed();
    try {
      for (const k of uploadKeys) retryUpload(session, k); // a failed upload gets another go
      const ids = await Promise.all(uploadKeys.map(k => uploads.get(k)!.done));
      await deliver(ids, item.key);
      item.sent = true;
      runs.delete(item.key);
      changed();
      await after();
      // Keep showing it until the conversation has the hub's copy (the feed hides it then: same element,
      // no gap). Removing it here could leave a frame with neither, which looks like a glitch.
      setTimeout(() => {
        outgoing = outgoing.filter(o => o !== item);
        for (const k of uploadKeys) dropUpload(k);
        changed();
      }, 30_000);
    } catch (err) {
      item.error = (err as Error).message;
      changed();
    }
  };
  runs.set(item.key, run);
  run();
}

export const retryOutgoing = (key: string) => runs.get(key)?.();

// Something is being sent or uploaded (a reload now would lose it).
export const outboxBusy = () => outgoing.some(o => !o.sent) || [...uploads.values()].some(u => !u.id && !u.error);

// Send a message that failed somewhere else instead (e.g. to one of several agents sharing a name).
export function redirectOutgoing(session: Session, key: string, conv: string,
  deliver: (attachmentIds: string[]) => Promise<void>, after: () => Promise<unknown> | void) {
  const item = outgoing.find(o => o.key === key);
  if (!item) return;
  outgoing = outgoing.filter(o => o !== item);
  runs.delete(key);
  sendQueued(session, conv, item.text, item.uploads, deliver, after);
}

export function discardOutgoing(key: string) {
  const item = outgoing.find(o => o.key === key);
  outgoing = outgoing.filter(o => o.key !== key);
  runs.delete(key);
  for (const k of item?.uploads ?? []) dropUpload(k);
  changed();
}

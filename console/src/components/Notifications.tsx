import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { pushKey, pushSubscribe, pushTest, pushUnsubscribe, type Session } from '../api';

// Push notifications for this browser: new messages to you and approval requests, even when the
// console is closed. iPhone/iPad: only from the Home Screen app (Share → Add to Home Screen).

const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window;
const ios = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);

const toKey = (b64url: string) => {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};

async function registration() {
  return (await navigator.serviceWorker.getRegistration('/')) ?? navigator.serviceWorker.register('/sw.js');
}

export function Notifications({ session }: { session: Session }) {
  const [on, setOn] = useState<boolean | null>(null); // null: still checking
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) { setOn(false); return; }
    registration().then(r => r?.pushManager.getSubscription()).then(sub => {
      setOn(Boolean(sub) && Notification.permission === 'granted');
      if (sub) pushSubscribe(session, sub.toJSON()).catch(() => {}); // keep it filed under the current name
    }, () => setOn(false));
  }, [session]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 9000);
    return () => clearTimeout(t);
  }, [note]);

  async function enable() {
    if (!supported) {
      setNote(ios ? 'On iPhone, notifications work from the Home Screen app: tap Share → Add to Home Screen, open Agent Bridge from there, then tap the bell.'
        : "This browser can't show push notifications.");
      return;
    }
    setBusy(true);
    try {
      const { publicKey } = await pushKey(session);
      if (!publicKey) throw new Error('Push notifications are not set up on this hub.');
      if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings.');
      const reg = await registration();
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription()
        ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
      await pushSubscribe(session, sub.toJSON());
      await pushTest(session, sub.endpoint);
      setOn(true);
      setNote('Notifications are on for this device. A test one is on its way.');
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const sub = await (await registration())?.pushManager.getSubscription();
      if (sub) {
        await pushUnsubscribe(session, sub.endpoint).catch(() => {});
        await sub.unsubscribe();
      }
      setOn(false);
      setNote('Notifications are off for this device.');
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="link theme-toggle" disabled={busy || on === null} onClick={on ? disable : enable}
        aria-label={on ? 'Notifications on. Turn off for this device' : 'Turn on notifications for this device'}
        title={on ? 'Notifications are on for this device (click to turn off)' : 'Get notified about new messages and approval requests on this device'}>
        {on ? '🔔' : '🔕'}
      </button>
      {note ? createPortal(<div className="toast" role="status" onClick={() => setNote(null)}>{note}</div>, document.body) : null}
    </>
  );
}

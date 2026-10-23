import { useEffect, useState } from 'react';
import { outboxBusy } from '../outbox';

// A newer console was deployed: an open page keeps running the old code until it's reloaded, so offer a
// reload (and reload by itself while the tab is in the background with nothing being sent).
export function UpdateBanner() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const check = async () => {
      try {
        const { build } = await (await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })).json();
        if (!build || build === __BUILD_ID__) return;
        if (document.hidden && !outboxBusy()) location.reload();
        else setStale(true);
      } catch { /* offline or mid-deploy: try again later */ }
    };
    check();
    const timer = setInterval(check, 60_000);
    const onVisible = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return stale ? <button className="banner info update-banner" onClick={() => location.reload()}>The console was updated: reload to get the latest →</button> : null;
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadSession } from './api';
import { applyTheme, loadTheme } from './theme';
import './styles.css';

applyTheme(loadTheme()); // before the first paint, so the page doesn't flash

// Shows push notifications (see components/Notifications.tsx); harmless where unsupported.
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialSession={loadSession()} />
  </StrictMode>,
);

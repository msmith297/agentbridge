// Light / dark / follow-the-system theme, remembered in this browser.

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'agent-bridge-theme';

export function loadTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* private mode: lasts this page */ }
}

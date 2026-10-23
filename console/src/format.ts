export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const stamp = (ms: number) => new Date(ms).toLocaleString();

export function folderName(cwd: string | null): string {
  if (!cwd) return '';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

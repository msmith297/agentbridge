import { useEffect, useState, type ReactNode } from 'react';

// Two-step destructive button: the first click arms it, the second (within 4s) confirms.
// Used instead of window.confirm(), which embedded browsers (e.g. app browser panes) often block.
export function ConfirmButton({ onConfirm, children, confirmLabel = 'Click again to confirm', className = 'danger small', title }: {
  onConfirm: () => void;
  children: ReactNode;
  confirmLabel?: string;
  className?: string;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button className={`${className}${armed ? ' armed' : ''}`} title={title}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? confirmLabel : children}
    </button>
  );
}

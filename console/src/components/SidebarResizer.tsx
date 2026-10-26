import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

// The Messages / Projects sidebar can be dragged wider or narrower (double-click resets it). The
// width is kept in this browser and shared by both pages.

const KEY = 'agent-bridge-sidebar-width';
const DEFAULT = 280, MIN = 200, MAX = 560;
const clamp = (n: number) => Math.min(MAX, Math.max(MIN, Math.round(n)));
const load = () => { try { const n = Number(localStorage.getItem(KEY)); return n ? clamp(n) : DEFAULT; } catch { return DEFAULT; } };
const save = (n: number) => { try { localStorage.setItem(KEY, String(n)); } catch { /* private mode */ } };

export function useSidebarWidth() {
  const [width, setWidth] = useState(load);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const set = (n: number) => { const w = clamp(n); setWidth(w); save(w); };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
    document.body.classList.add('resizing-sidebar');
  };
  const move = (e: PointerEvent<HTMLDivElement>) => { if (drag.current) setWidth(clamp(drag.current.w + e.clientX - drag.current.x)); };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('resizing-sidebar');
    save(width);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); set(width - 20); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); set(width + 20); }
  };

  return {
    style: { ['--sidebar-w' as string]: `${width}px` } as CSSProperties,
    handle: (
      <div className="sidebar-resizer" style={{ left: width }} role="separator" aria-orientation="vertical" aria-label="Resize the sidebar"
        aria-valuemin={MIN} aria-valuemax={MAX} aria-valuenow={width} tabIndex={0} title="Drag to resize · double-click to reset"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={() => set(DEFAULT)} onKeyDown={key} />
    ),
  };
}

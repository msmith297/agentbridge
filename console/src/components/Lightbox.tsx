import { useCallback, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Full-screen image viewer on the same page (instead of opening images in a new tab).
// Thumbnails mark themselves with data-lightbox-src; opening one collects every thumbnail on the
// page, in order, so ←/→ step through the images in the conversation.

export interface LightboxItem { src: string; name: string; size?: string }

let root: Root | null = null;

export function openLightbox(clicked: HTMLElement) {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-lightbox-src]'));
  const items: LightboxItem[] = nodes.map(n => ({ src: n.dataset.lightboxSrc!, name: n.dataset.lightboxName || '', size: n.dataset.lightboxSize }));
  const start = Math.max(0, nodes.indexOf(clicked));
  if (!items.length) return;
  if (!root) {
    const host = document.createElement('div');
    host.className = 'lightbox-host';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root.render(<Lightbox key={Date.now()} items={items} start={start} onClose={() => root?.render(null)} />);
}

function Lightbox({ items, start, onClose }: { items: LightboxItem[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const item = items[i];
  const many = items.length > 1;
  const step = useCallback((d: number) => setI(n => (n + d + items.length) % items.length), [items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && many) step(1);
      else if (e.key === 'ArrowLeft' && many) step(-1);
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
  }, [many, onClose, step]);

  return (
    <div className="lightbox" role="dialog" aria-label={`Image: ${item.name}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lightbox-bar">
        <span className="lightbox-name" title={item.name}>{item.name}{item.size ? <span className="muted"> · {item.size}</span> : null}{many ? <span className="muted"> · {i + 1} / {items.length}</span> : null}</span>
        <span className="lightbox-actions">
          <a className="lightbox-btn" href={item.src} download={item.name} title="Download" aria-label="Download">⤓</a>
          <button type="button" className="lightbox-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
        </span>
      </div>
      {many ? <button type="button" className="lightbox-nav prev" onClick={() => step(-1)} aria-label="Previous image">‹</button> : null}
      <img className="lightbox-img" src={item.src} alt={item.name} onMouseDown={e => e.stopPropagation()} />
      {many ? <button type="button" className="lightbox-nav next" onClick={() => step(1)} aria-label="Next image">›</button> : null}
    </div>
  );
}

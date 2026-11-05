// Pane resizing: splitters between layout panes and a bottom grip for blocks inside panels.
// Sizes persist per browser (localStorage); double-click any handle to reset it.
import React, { useState } from 'react';

export function usePersistedSize(key: string, def: () => number): [number, (v: number | null) => void] {
  const lsKey = `mv.pane.${key}`;
  const [v, setV] = useState<number>(() => {
    try { const n = Number(localStorage.getItem(lsKey)); if (n > 0) return n; } catch { /* ignore */ }
    return def();
  });
  const set = (n: number | null) => {
    setV(n ?? def());
    try { n === null ? localStorage.removeItem(lsKey) : localStorage.setItem(lsKey, String(n)); } catch { /* ignore */ }
  };
  return [v, set];
}

/** Mouse-drag helper: calls onDelta with the pixel offset along `dir` from where the drag started. */
function startDrag(e: React.MouseEvent, dir: 'x' | 'y', onDelta: (d: number) => void, onEnd: () => void) {
  e.preventDefault();
  e.stopPropagation();
  const start = dir === 'x' ? e.clientX : e.clientY;
  document.body.style.cursor = dir === 'x' ? 'col-resize' : 'row-resize';
  document.body.classList.add('resizing');
  const move = (ev: MouseEvent) => onDelta((dir === 'x' ? ev.clientX : ev.clientY) - start);
  const up = () => {
    document.body.style.cursor = '';
    document.body.classList.remove('resizing');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    onEnd();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/** Drag bar between two layout panes. `sign` maps mouse delta to size delta (-1 when the pane sits after the bar). */
export const Splitter: React.FC<{ dir: 'x' | 'y'; size: number; min: number; max: () => number; sign: 1 | -1; onSize: (v: number | null) => void }> = ({ dir, size, min, max, sign, onSize }) => {
  const [drag, setDrag] = useState(false);
  return (
    <div
      className={`splitter ${dir} ${drag ? 'drag' : ''}`}
      title="drag to resize · double-click to reset"
      onDoubleClick={() => onSize(null)}
      onMouseDown={(e) => {
        const s0 = size;
        setDrag(true);
        startDrag(e, dir, (d) => onSize(Math.round(Math.max(min, Math.min(max(), s0 + sign * d)))), () => setDrag(false));
      }}
    />
  );
};

/**
 * A block with a persisted height and a grip on its bottom edge. Children fill it
 * (textareas get height 100% via CSS); `scroll` makes overflowing content scroll inside.
 */
export const VResize: React.FC<{ id: string; def: number; min?: number; max?: number; scroll?: boolean; className?: string; children: React.ReactNode }> = ({ id, def, min = 32, max = 2000, scroll, className, children }) => {
  const [h, setH] = usePersistedSize(id, () => def);
  const [drag, setDrag] = useState(false);
  return (
    <div className={`vresize ${scroll ? 'scroll' : ''} ${className ?? ''}`} style={{ height: h }}>
      <div className="vresize-body">{children}</div>
      <div
        className={`vgrip ${drag ? 'drag' : ''}`}
        title="drag to resize · double-click to reset"
        onDoubleClick={() => setH(null)}
        onMouseDown={(e) => {
          const h0 = h;
          setDrag(true);
          startDrag(e, 'y', (d) => setH(Math.round(Math.max(min, Math.min(max, h0 + d)))), () => setDrag(false));
        }}
      />
    </div>
  );
};

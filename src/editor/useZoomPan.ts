// Zoom + pan for the preview: trackpad pinch (Chrome/Edge/Firefox send it as ctrl+wheel, Safari as gesture events),
// ctrl/⌘+mouse wheel, two-finger scroll or drag to pan while zoomed. The transform is written straight to the DOM so
// the (heavy) Player never re-renders while you zoom; React only hears whether we're zoomed (for the 100% button).
import { useCallback, useEffect, useRef, useState } from 'react';

const MAX = 8;
// don't start a pan from things you click
const INTERACTIVE = 'button, input, select, textarea, a, .sb-caption, .peek';

export function useZoomPan() {
  const viewRef = useRef<HTMLDivElement>(null);   // clipping viewport (its box = the unzoomed picture area)
  const zoomRef = useRef<HTMLDivElement>(null);   // transformed content
  const st = useRef({ z: 1, x: 0, y: 0 });
  const [zoom, setZoomState] = useState(1);

  const apply = useCallback(() => {
    const v = viewRef.current, el = zoomRef.current;
    if (!v || !el) return;
    const s = st.current;
    if (s.z <= 1.001) Object.assign(s, { z: 1, x: 0, y: 0 });
    // keep the zoomed content covering the viewport (no panning off into nothing)
    const w = v.clientWidth, h = v.clientHeight;
    s.x = Math.min(0, Math.max(w - w * s.z, s.x));
    s.y = Math.min(0, Math.max(h - h * s.z, s.y));
    el.style.transform = s.z === 1 ? '' : `translate(${s.x}px, ${s.y}px) scale(${s.z})`;
    v.classList.toggle('zoomed', s.z > 1);
    setZoomState((prev) => (Math.abs(prev - s.z) > 0.005 || (s.z === 1) !== (prev === 1) ? s.z : prev));
  }, []);

  /** zoom to z keeping the point (clientX, clientY) fixed under the cursor */
  const zoomAt = useCallback((z: number, cx: number, cy: number) => {
    const v = viewRef.current;
    if (!v) return;
    const r = v.getBoundingClientRect();
    const s = st.current;
    const nz = Math.min(MAX, Math.max(1, z));
    const px = cx - r.left, py = cy - r.top;
    s.x = px - ((px - s.x) * nz) / s.z;
    s.y = py - ((py - s.y) * nz) / s.z;
    s.z = nz;
    apply();
  }, [apply]);

  const reset = useCallback(() => {
    Object.assign(st.current, { z: 1, x: 0, y: 0 });
    apply();
  }, [apply]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const onWheel = (e: WheelEvent) => {
      const s = st.current;
      if (e.ctrlKey || e.metaKey) {
        // pinch (ctrl+wheel with small deltas) or ctrl/⌘+mouse wheel (big deltas, clamped)
        e.preventDefault();
        const d = Math.max(-50, Math.min(50, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
        zoomAt(s.z * Math.exp(-d * 0.01), e.clientX, e.clientY);
      } else if (s.z > 1) {
        // two-finger scroll pans while zoomed
        e.preventDefault();
        const k = e.deltaMode === 1 ? 16 : 1;
        s.x -= e.deltaX * k;
        s.y -= e.deltaY * k;
        apply();
      }
    };
    // Safari: trackpad pinch arrives as gesture events
    let base = 1;
    const onGStart = (e: any) => { e.preventDefault(); base = st.current.z; };
    const onGChange = (e: any) => { e.preventDefault(); zoomAt(base * e.scale, e.clientX, e.clientY); };
    // drag to pan (left button while zoomed, or middle button)
    let drag: { id: number; x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (st.current.z <= 1 || (e.button !== 0 && e.button !== 1)) return;
      if ((e.target as Element).closest?.(INTERACTIVE)) return;
      e.preventDefault();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      v.setPointerCapture(e.pointerId);
      v.classList.add('panning');
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      st.current.x += e.clientX - drag.x;
      st.current.y += e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      apply();
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      v.classList.remove('panning');
    };
    // the viewport resizing (pane splitters, window) → re-clamp the pan
    const ro = new ResizeObserver(() => apply());
    ro.observe(v);
    v.addEventListener('wheel', onWheel, { passive: false });
    v.addEventListener('gesturestart', onGStart as EventListener);
    v.addEventListener('gesturechange', onGChange as EventListener);
    v.addEventListener('pointerdown', onDown);
    v.addEventListener('pointermove', onMove);
    v.addEventListener('pointerup', onUp);
    v.addEventListener('pointercancel', onUp);
    return () => {
      ro.disconnect();
      v.removeEventListener('wheel', onWheel);
      v.removeEventListener('gesturestart', onGStart as EventListener);
      v.removeEventListener('gesturechange', onGChange as EventListener);
      v.removeEventListener('pointerdown', onDown);
      v.removeEventListener('pointermove', onMove);
      v.removeEventListener('pointerup', onUp);
      v.removeEventListener('pointercancel', onUp);
    };
  }, [apply, zoomAt]);

  return { viewRef, zoomRef, zoom, reset };
}

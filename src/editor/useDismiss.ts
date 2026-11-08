import { useEffect, useRef, type RefObject } from 'react';

/**
 * Close a popover / context menu on Esc, a press outside it, a wheel outside it, or the window losing focus.
 * Listens in the capture phase: timeline handlers stopPropagation() on mousedown, so a bubbling listener
 * on window would never hear those clicks.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, close: () => void) {
  const cb = useRef(close);
  cb.current = close;
  useEffect(() => {
    const outside = (e: Event) => !ref.current?.contains(e.target as Node);
    const down = (e: MouseEvent) => { if (outside(e)) cb.current(); };
    const wheel = (e: WheelEvent) => { if (outside(e)) cb.current(); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // Esc only closes the menu (doesn't also clear the selection)
      cb.current();
    };
    const blur = () => cb.current();
    window.addEventListener('mousedown', down, true);
    window.addEventListener('wheel', wheel, { capture: true, passive: true });
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('wheel', wheel, { capture: true } as EventListenerOptions);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
    };
  }, []);
}

// Context menus and a small inline text prompt for the lyrics stage (one host, positioned at the pointer).
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { unlinkBlock } from '../../core/sheet';
import type { BlockKind, LyricSheet } from '../../core/types';
import { useDismiss } from '../useDismiss';
import { copyBlock, deleteBlock, duplicateBlock, gapAfter, pasteBlock } from './actions';
import { editSheet, sheet } from './state';

export type MenuItem = { label: string; hint?: string; on?: () => void; disabled?: boolean; checked?: boolean; color?: string } | '-' | { head: string };

interface Ask { title: string; value: string; ok: (v: string) => void; placeholder?: string; chips?: string[]; type?: 'text' | 'number' }
let state: { x: number; y: number; items?: MenuItem[]; ask?: Ask } | null = null;
const subs = new Set<() => void>();
const set = (v: typeof state) => { state = v; subs.forEach((f) => f()); };
const useMenu = () => useSyncExternalStore((f) => { subs.add(f); return () => void subs.delete(f); }, () => state);

export const openMenu = (x: number, y: number, items: MenuItem[]) => set({ x, y, items });
export const askText = (x: number, y: number, title: string, value: string, ok: (v: string) => void, opts: Partial<Ask> = {}) => set({ x, y, ask: { title, value, ok, ...opts } });
export const closeMenu = () => set(null);

export const MenuHost: React.FC = () => {
  const m = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useDismiss(ref, closeMenu);
  useEffect(() => {
    if (!m || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(m.x, window.innerWidth - r.width - 8), y: Math.min(m.y, window.innerHeight - r.height - 8) });
  }, [m]);
  if (!m) return null;
  const style = { left: pos?.x ?? m.x, top: pos?.y ?? m.y, visibility: pos ? 'visible' : 'hidden' } as React.CSSProperties;
  if (m.ask) return <div className="lx-menu lx-ask" ref={ref} style={style}><AskBox a={m.ask} /></div>;
  return (
    <div className="lx-menu" ref={ref} style={style} onContextMenu={(e) => e.preventDefault()}>
      {m.items!.map((it, i) =>
        it === '-' ? <div key={i} className="sep" /> :
        'head' in it ? <div key={i} className="mhead">{it.head}</div> :
        <button key={i} disabled={it.disabled} onClick={() => { closeMenu(); it.on?.(); }}>
          {it.color ? <span className="sw" style={{ background: it.color }} /> : it.checked !== undefined ? <span className="ck">{it.checked ? '✓' : ''}</span> : null}
          <span className="lbl">{it.label}</span>{it.hint ? <span className="hint">{it.hint}</span> : null}
        </button>,
      )}
    </div>
  );
};

const AskBox: React.FC<{ a: Ask }> = ({ a }) => {
  const [v, setV] = useState(a.value);
  const ok = (val = v) => { closeMenu(); a.ok(val); };
  return (
    <>
      <div className="mhead">{a.title}</div>
      <input autoFocus type={a.type ?? 'text'} value={v} placeholder={a.placeholder} onChange={(e) => setV(e.target.value)} onFocus={(e) => e.target.select()}
        onKeyDown={(e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') closeMenu(); e.stopPropagation(); }} />
      {a.chips?.length ? <div className="chips">{a.chips.map((c) => <button key={c} onClick={() => ok(c)}>{c}</button>)}</div> : null}
      <div className="row"><button onClick={closeMenu}>Cancel</button><button className="accent" onClick={() => ok()}>OK</button></div>
    </>
  );
};

const KINDS: [BlockKind, string][] = [['intro', 'Intro'], ['verse', 'Verse'], ['prechorus', 'Pre-chorus'], ['chorus', 'Chorus'], ['bridge', 'Bridge'], ['hook', 'Hook'], ['drop', 'Drop'], ['break', 'Break'], ['outro', 'Outro'], ['custom', 'Other']];

export function blockMenu(x: number, y: number, id: string) {
  const b = sheet().blocks.find((z) => z.id === id);
  if (!b) return;
  const links = b.link ? sheet().blocks.filter((z) => z.link === b.link).length : 0;
  openMenu(x, y, [
    { head: b.name },
    { label: 'Rename…', hint: 'dbl-click', on: () => import('./SheetView').then((m) => m.renameBlock(b, x, y)) },
    { label: 'Copy', hint: 'Ctrl+C', on: () => copyBlock(id) },
    { label: 'Paste after', hint: 'Ctrl+V', on: () => pasteBlock(id, false) },
    { label: 'Paste linked after', hint: 'Ctrl+Shift+V', on: () => pasteBlock(id, true) },
    { label: 'Duplicate', hint: 'Ctrl+D', on: () => duplicateBlock(id, false) },
    { label: 'Duplicate linked', hint: 'Ctrl+Shift+D', on: () => duplicateBlock(id, true) },
    ...(links ? [{ label: `Unlink (×${links} share lines)`, on: () => editSheet((d) => unlinkBlock(d as LyricSheet, id)) }] : []),
    '-',
    { label: 'Pause after +1 bar', hint: 'G', on: () => gapAfter(id, 1) },
    { label: 'Pause after −1 bar', hint: 'Shift+G', on: () => gapAfter(id, -1) },
    '-',
    { head: 'Kind' },
    ...KINDS.map(([k, n]) => ({ label: n, checked: b.kind === k, on: () => editSheet((d) => { const z = d.blocks.find((q) => q.id === id); if (z) z.kind = k; }) })),
    '-',
    { label: 'Delete block', hint: 'Del', on: () => deleteBlock(id) },
  ]);
}

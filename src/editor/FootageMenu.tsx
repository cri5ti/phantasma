// Right-click on any footage thumbnail (stock search, candidates, board, local footage): send it to the idea board —
// as a plain card, under a song section (the section heading card is created when missing), with an optional note.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { uid } from '../core/project';
import { refKey } from '../core/storyboard';
import type { BoardItem, StockRef } from '../core/types';
import { applyToShot } from './Board';
import { store, useStore } from './store';

const W = 210, GRID = 20, GAP = 20;
const snap = (v: number) => Math.round(v / GRID) * GRID;
/** rough card heights (cards not rendered yet) */
const estH = (b: BoardItem) => (b.kind === 'stock' || b.kind === 'media' ? 190 + (b.text ? 18 : 0) : b.kind === 'section' ? 60 : 70 + Math.ceil((b.text ?? '').length / 34) * 15);

function stockCard(ref: StockRef, note: string, tags: string[], x: number, y: number): BoardItem {
  return ref.provider === 'local'
    ? { id: uid('b'), kind: 'media', media: ref.media ?? ref.id, text: note || ref.id, tags, x, y }
    : { id: uid('b'), kind: 'stock', stock: ref, text: note || ref.tags?.slice(0, 4).join(', '), tags, x, y };
}

/** new column to the right of everything on the board */
const nextColumn = (board: BoardItem[]) => (board.length ? snap(Math.max(...board.map((b) => b.x)) + W + GAP) : GRID);

export function addToBoard(ref: StockRef, note = '', tags: string[] = []) {
  store.editSB((d) => {
    const board = d.board as BoardItem[];
    d.board.push(stockCard(ref, note, tags, nextColumn(board), GRID));
  });
}

/** Put the clip at the bottom of a section's column; the heading card is created when the section has none. */
export function addUnderSection(section: string, ref: StockRef, note = '', tags: string[] = []) {
  store.editSB((d) => {
    const board = d.board as BoardItem[];
    let head = board.find((b) => b.kind === 'section' && b.text?.trim().toLowerCase() === section.trim().toLowerCase());
    if (!head) {
      head = { id: uid('b'), kind: 'section', text: section, tags: [section], x: nextColumn(board), y: GRID };
      d.board.push(head);
    }
    const col = board.filter((b) => b !== head && Math.abs(b.x - head!.x) < W / 2 && b.y >= head!.y);
    const bottom = Math.max(head.y + estH(head), ...col.map((b) => b.y + estH(b)));
    // tag with the heading's own spelling so the section filter chip groups them
    d.board.push(stockCard(ref, note, [...new Set([head.text ?? section, ...tags])], head.x, snap(bottom + GAP)));
  });
}

export const FootageMenu: React.FC = () => {
  const m = useStore((s) => s.footMenu);
  const shotId = useStore((s) => s.sel.shotId);
  const project = useStore((s) => s.project);
  const ref = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [custom, setCustom] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const close = () => store.set({ footMenu: null });

  useEffect(() => { setNote(''); setTags(''); setCustom(''); setDone(null); }, [m?.ref && refKey(m.ref), m?.x, m?.y]);
  useEffect(() => {
    if (!m) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, [!!m]);

  // song sections in order: tempo map, lyric sections, then headings already on the board
  const sections = useMemo(() => {
    const out: string[] = [];
    const add = (s?: string) => { const v = s?.trim(); if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v); };
    project.tempo.forEach((s) => add(s.label));
    project.lyrics?.lines.forEach((l) => add(l.section));
    project.storyboard?.board.filter((b) => b.kind === 'section').forEach((b) => add(b.text));
    return out;
  }, [project.tempo, project.lyrics, project.storyboard?.board]);
  const onBoard = new Set(project.storyboard?.board.filter((b) => b.kind === 'section').map((b) => b.text?.trim().toLowerCase()) ?? []);

  if (!m) return null;
  const r = m.ref;
  const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
  const ok = (msg: string) => { setDone(msg); setTimeout(close, 700); };
  const left = Math.min(m.x, window.innerWidth - 290), top = Math.max(8, Math.min(m.y, window.innerHeight - 470));

  return (
    <div className="popover ctxmenu footmenu" ref={ref} style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      <div className="cat">{r.provider === 'local' ? `footage ${r.id}` : `${r.provider} ${r.id}`} → idea board</div>
      <textarea rows={2} value={note} autoFocus placeholder="note (optional) — e.g. “great light leak for the bridge”" onChange={(e) => setNote(e.target.value)} />
      <input value={tags} placeholder="tags, comma separated" onChange={(e) => setTags(e.target.value)} />
      <button onClick={() => { addToBoard(r, note, tagList); ok('added to the board'); }}>＋ Add as card</button>
      <div className="cat">Add under section</div>
      <div className="secgrid">
        {sections.map((s) => (
          <button key={s} onClick={() => { addUnderSection(s, r, note, tagList); ok(`added under “${s}”`); }} title={onBoard.has(s.toLowerCase()) ? `below the “${s}” column` : `creates a “${s}” heading on the board`}>
            {s}{onBoard.has(s.toLowerCase()) ? '' : ' ＋'}
          </button>
        ))}
      </div>
      <div className="row">
        <input value={custom} placeholder="other section…" onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && custom.trim()) { addUnderSection(custom, r, note, tagList); ok(`added under “${custom.trim()}”`); } }} />
        <button disabled={!custom.trim()} onClick={() => { addUnderSection(custom, r, note, tagList); ok(`added under “${custom.trim()}”`); }}>Add</button>
      </div>
      <div className="sep" />
      {shotId ? <button onClick={() => { applyToShot(shotId, { kind: 'stock', tags: tagList, stock: r, text: note || undefined }); ok('set as the shot’s pick'); }}>Use for selected shot</button> : null}
      <button onClick={() => { store.set({ peek: r, footMenu: null }); }}>⤢ Preview big</button>
      {done ? <div className="done">✓ {done}</div> : null}
    </div>
  );
};

// Idea board: a free canvas of cards (AI ideas, notes, lyric lines, stock picks, local footage) to organise and tag.
//   drag on empty space = box-select · wheel / middle-drag / space+drag = pan · ctrl+wheel = zoom
//   click / shift+click = select / toggle · drag a selected card = move the whole selection (snaps to the grid; Alt = free)
//   Del = delete · Ctrl+A = select all · arrows = nudge · Esc = clear
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { uid } from '../core/project';
import { mediaRef, refKey } from '../core/storyboard';
import type { BoardItem, Shot, StockRef } from '../core/types';
import { VResize } from './Resizer';
import { aiCards, card, sb, searchAny, task } from './storyActions';
import { RefThumb, useLLM, useStockProvider } from './StoryPanel';
import { store, useStore } from './store';
import { boardView, saveViewSoon } from './viewState';

// stable fallback: a fresh [] per selector call makes useSyncExternalStore loop forever
const NO_ITEMS: BoardItem[] = [];

const W = 210;
const GRID = 20; // matches the dotted background
const GAP = GRID;
const COL_MAX_H = 1100;
const KIND_LABEL: Record<BoardItem['kind'], string> = { idea: '✦ idea', note: 'note', lyric: '♪ lyric', stock: 'stock', media: 'footage', section: '▬ section' };
const KIND_ORDER: BoardItem['kind'][] = ['section', 'idea', 'note', 'lyric', 'stock', 'media'];
const isText = (b: BoardItem) => b.kind === 'idea' || b.kind === 'note' || b.kind === 'lyric';
const snapTo = (v: number) => Math.round(v / GRID) * GRID;
const reading = (a: BoardItem, b: BoardItem) => a.y - b.y || a.x - b.x;
/** height guess for cards not rendered yet */
const estH = (text: string) => 70 + Math.ceil(text.length / 34) * 15;

const ls = {
  get: (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } },
  set: (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ } },
};

function editItem(id: string, fn: (b: BoardItem) => void, merge?: string) {
  store.editSB((d) => {
    const b = d.board.find((x) => x.id === id);
    if (b) fn(b as BoardItem);
  }, merge);
}

/** Apply a board card to a shot: ideas/notes rewrite the shot, stock becomes its pick. */
export function applyToShot(shotId: string, b: Pick<BoardItem, 'kind' | 'text' | 'tags' | 'stock'>) {
  store.editSB((d) => {
    const s = d.shots.find((x) => x.id === shotId) as Shot | undefined;
    if (!s) return;
    if (b.stock) {
      let k = s.candidates.findIndex((c) => refKey(c) === refKey(b.stock!));
      if (k < 0) { s.candidates.push(b.stock); k = s.candidates.length - 1; }
      s.pick = k;
      s.source = 'footage';
    } else if (b.kind === 'lyric') s.lyric = b.text;
    else if (b.text) s.description = b.text;
    s.tags = [...new Set([...s.tags, ...b.tags])];
  });
}

/** identity used for duplicate detection */
const dupKey = (b: BoardItem) =>
  b.stock ? `s:${refKey(b.stock)}` : b.kind === 'media' ? `m:${b.media}` : `${b.kind}:${(b.text ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}`;

/** Lay groups out as masonry columns from `origin` (a group wraps to more columns past COL_MAX_H). Grid-aligned. */
function layout(groups: BoardItem[][], heights: Map<string, number>, origin = { x: GRID, y: GRID }): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const ox = snapTo(origin.x), oy = snapTo(origin.y);
  let col = 0;
  for (const g of groups) {
    if (!g.length) continue;
    let y = oy;
    for (const b of g) {
      const h = heights.get(b.id) ?? estH(b.text ?? '');
      if (y > oy && y - oy + h > COL_MAX_H) { col++; y = oy; }
      pos.set(b.id, { x: ox + col * (W + GAP), y });
      y = snapTo(y + h + GAP / 2 + GRID / 2);
    }
    col++;
  }
  return pos;
}

function bbox(items: BoardItem[], hs: Map<string, number>) {
  const x0 = Math.min(...items.map((b) => b.x)), y0 = Math.min(...items.map((b) => b.y));
  const x1 = Math.max(...items.map((b) => b.x + W)), y1 = Math.max(...items.map((b) => b.y + (hs.get(b.id) ?? estH(b.text ?? ''))));
  return { x0, y0, x1, y1 };
}

export const Board: React.FC = () => {
  const board = useStore((s) => s.project.storyboard?.board ?? NO_ITEMS);
  const lyrics = useStore((s) => s.project.storyboard?.brief.lyrics ?? '');
  const media = useStore((s) => s.media);
  const shotId = useStore((s) => s.sel.shotId);
  const busy = useStore((s) => s.busy);
  const [provider] = useStockProvider();
  const [llm] = useLLM();
  const [view, setView] = useState(() => boardView.current);
  // remembered per project (localStorage + URL fragment)
  useEffect(() => { boardView.current = view; saveViewSoon(); }, [view]);
  const [filter, setFilter] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [showMedia, setShowMedia] = useState(false);
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [selIds, setSelIds] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [snapOn, setSnapOn] = useState(() => ls.get('mv.board.snap', true));
  const ref = useRef<HTMLDivElement>(null);
  const spaceDown = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  const sel = useMemo(() => new Set(selIds), [selIds]);
  // drop ids that no longer exist (undo, delete)
  useEffect(() => { if (selIds.some((id) => !board.some((b) => b.id === id))) setSelIds((s) => s.filter((id) => board.some((b) => b.id === id))); }, [board]);
  const selected = useMemo(() => board.filter((b) => sel.has(b.id)), [board, sel]);
  const running = !!busy && !busy.startsWith('⚠');

  const flash = (m: string) => { setNote(m); setTimeout(() => setNote((n) => (n === m ? null : n)), 4000); };

  // Native, non-passive wheel listener: React's onWheel is passive, so it can't stop the browser's ctrl+wheel page zoom.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        setView((v) => {
          const z = Math.max(0.2, Math.min(2.5, v.z * Math.exp(-dy * 0.002)));
          return { z, x: mx - ((mx - v.x) / v.z) * z, y: my - ((my - v.y) / v.z) * z };
        });
      } else if (e.shiftKey && !dx) setView((v) => ({ ...v, x: v.x - dy }));
      else setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const heights = () => {
    const m = new Map<string, number>();
    ref.current?.querySelectorAll<HTMLElement>('.bcard[data-id]').forEach((n) => m.set(n.dataset.id!, n.offsetHeight));
    return m;
  };
  const fit = (items: BoardItem[] = board) => {
    const el = ref.current;
    if (!el || !items.length) return setView({ x: 0, y: 0, z: 1 });
    const { x0, y0, x1, y1 } = bbox(items, heights());
    const pad = 24;
    const z = Math.max(0.2, Math.min(1.25, (el.clientWidth - pad * 2) / (x1 - x0), (el.clientHeight - pad * 2) / (y1 - y0)));
    setView({ z, x: pad - x0 * z + (el.clientWidth - pad * 2 - (x1 - x0) * z) / 2, y: pad - y0 * z });
  };

  /** Re-layout `groups`; for a selection the layout starts at the selection's top-left and the view stays put. */
  const arrange = (groups: BoardItem[][], label: string, inPlace: boolean) => {
    const items = groups.flat();
    const hs = heights();
    const pos = layout(groups, hs, inPlace && items.length ? { x: bbox(items, hs).x0, y: bbox(items, hs).y0 } : undefined);
    store.editSB((d) => d.board.forEach((b) => { const p = pos.get(b.id); if (p) { b.x = p.x; b.y = p.y; } }));
    flash(`${label} - Ctrl+Z to undo`);
    if (!inPlace) requestAnimationFrame(() => fit(board.map((b) => ({ ...b, ...(pos.get(b.id) ?? {}) }))));
  };
  const remove = (ids: Set<string>, label: string) => {
    if (!ids.size) return;
    store.editSB((d) => { d.board = d.board.filter((b) => !ids.has(b.id)); });
    setSelIds((s) => s.filter((id) => !ids.has(id)));
    flash(`Removed ${ids.size} ${label} - Ctrl+Z to undo`);
  };

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    board.forEach((b) => b.tags.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [board]);
  const matches = (b: BoardItem) =>
    (!filter.length || filter.every((t) => b.tags.includes(t))) &&
    (!text || `${b.text ?? ''} ${b.tags.join(' ')} ${b.stock?.author ?? ''}`.toLowerCase().includes(text.toLowerCase()));

  const toCanvas = (cx: number, cy: number) => {
    const r = ref.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z };
  };
  const centre = () => { const r = ref.current!.getBoundingClientRect(); return toCanvas(r.left + r.width / 2 - W / 2, r.top + 40); };
  const place = (p: { x: number; y: number }) => (snapOn ? { x: snapTo(p.x), y: snapTo(p.y) } : { x: Math.round(p.x), y: Math.round(p.y) });

  const add = (b: Partial<BoardItem>) => {
    const item: BoardItem = { id: uid('b'), kind: 'note', tags: [...filter], ...place(centre()), ...b };
    store.editSB((d) => { d.board.push(item); });
    setSelIds([item.id]);
  };

  // ---- pointer: pan / box-select / move -------------------------------------------------------
  const drag = (move: (ev: MouseEvent) => void, up?: (ev: MouseEvent) => void) => {
    const u = (ev: MouseEvent) => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', u); up?.(ev); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', u);
  };

  const startPan = (cx: number, cy: number) => {
    const v0 = viewRef.current;
    const sx = cx - v0.x, sy = cy - v0.y;
    drag((ev) => setView((v) => ({ ...v, x: ev.clientX - sx, y: ev.clientY - sy })));
  };

  const onBgDown = (e: React.MouseEvent) => {
    ref.current?.focus();
    const onBg = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('board-world');
    if (!onBg) return;
    if (e.button === 1 || spaceDown.current) { e.preventDefault(); startPan(e.clientX, e.clientY); return; }
    if (e.button !== 0) return;
    // box select (shift/ctrl adds to the current selection)
    e.preventDefault();
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = add ? selIds : [];
    const a = toCanvas(e.clientX, e.clientY);
    const hs = heights();
    let moved = false;
    drag(
      (ev) => {
        const b = toCanvas(ev.clientX, ev.clientY);
        moved = moved || Math.abs(b.x - a.x) * view.z > 3 || Math.abs(b.y - a.y) * view.z > 3;
        if (!moved) return;
        const r = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
        setMarquee(r);
        const hit = board.filter((c) => c.x < r.x1 && c.x + W > r.x0 && c.y < r.y1 && c.y + (hs.get(c.id) ?? 120) > r.y0).map((c) => c.id);
        setSelIds([...new Set([...base, ...hit])]);
      },
      () => { setMarquee(null); if (!moved && !add) setSelIds([]); },
    );
  };

  const onCardDown = (e: React.MouseEvent, b: BoardItem) => {
    ref.current?.focus();
    if ((e.target as HTMLElement).closest('button, input, textarea, video, .drag, .peek-btn')) return;
    if (e.button === 1 || spaceDown.current) { e.preventDefault(); e.stopPropagation(); startPan(e.clientX, e.clientY); return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setSelIds((s) => (s.includes(b.id) ? s.filter((x) => x !== b.id) : [...s, b.id]));
      return;
    }
    const group = sel.has(b.id) ? selIds : [b.id];
    if (!sel.has(b.id)) setSelIds([b.id]);
    const orig = new Map(board.filter((x) => group.includes(x.id)).map((x) => [x.id, { x: x.x, y: x.y }]));
    const sx = e.clientX, sy = e.clientY;
    const o = orig.get(b.id)!;
    const key = `move-${group.join(',').slice(0, 80)}`;
    drag((ev) => {
      // snap the grabbed card, move the rest by the same offset so the group keeps its shape
      let nx = o.x + (ev.clientX - sx) / view.z, ny = o.y + (ev.clientY - sy) / view.z;
      if (snapOn && !ev.altKey) { nx = snapTo(nx); ny = snapTo(ny); } else { nx = Math.round(nx); ny = Math.round(ny); }
      const dx = nx - o.x, dy = ny - o.y;
      store.editSB((d) => d.board.forEach((x) => { const p = orig.get(x.id); if (p) { x.x = p.x + dx; x.y = p.y + dy; } }), key);
    });
  };

  // ---- keyboard (only while the canvas has focus; stops the editor's global shortcuts) ---------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === ' ') { stop(); spaceDown.current = true; ref.current?.classList.add('panning'); return; }
    if ((k === 'delete' || k === 'backspace') && selIds.length) { stop(); remove(new Set(selIds), 'card(s)'); return; }
    if (ctrl && k === 'a') { stop(); setSelIds(board.filter(matches).map((b) => b.id)); return; }
    if (k === 'escape' && selIds.length) { stop(); setSelIds([]); return; }
    if (k.startsWith('arrow') && selIds.length) {
      stop();
      const step = (e.shiftKey ? 5 : 1) * (snapOn ? GRID : 1);
      const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
      store.editSB((d) => d.board.forEach((x) => { if (sel.has(x.id)) { x.x += dx; x.y += dy; } }), 'nudge');
    }
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); spaceDown.current = false; ref.current?.classList.remove('panning'); }
  };

  // drops from the shot panel (stock refs) or the media list
  const onDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-mv-ref');
    const mid = e.dataTransfer.getData('application/x-mv-media');
    if (!raw && !mid) return;
    e.preventDefault();
    const p = place(toCanvas(e.clientX - W / 2, e.clientY - 20));
    if (raw) {
      const r: StockRef = JSON.parse(raw);
      store.editSB((d) => { d.board.push({ id: uid('b'), kind: 'stock', stock: r, text: r.tags?.join(', '), tags: [...filter], ...p }); });
    } else store.editSB((d) => { d.board.push({ id: uid('b'), kind: 'media', media: mid, text: mid, tags: [...filter], ...p }); });
  };

  const searchFrom = (b: BoardItem) => task('Searching stock', async () => {
    const r = await searchAny(provider, (b.text ?? '').split(/[.,;]/)[0].slice(0, 80), 'video', 1, 6);
    store.editSB((d) => {
      r.items.forEach((s, i) => d.board.push({ id: uid('b'), kind: 'stock', stock: s, text: b.text?.slice(0, 60), tags: [...b.tags], x: snapTo(b.x + W + GAP + (i % 2) * (W + GAP)), y: snapTo(b.y + Math.floor(i / 2) * 160) }));
    });
  });

  const lyricCards = () => {
    const lines = lyrics.split(/\r?\n/).map((l) => l.replace(/\[[^\]]*\]/g, '').trim()).filter(Boolean);
    const have = new Set(board.filter((b) => b.kind === 'lyric').map((b) => b.text));
    const fresh = lines.filter((l) => !have.has(l));
    if (!fresh.length) return;
    store.editSB((d) => { const base = [...d.board]; fresh.forEach((l, i) => { const c = card('lyric', l, ['lyrics'], undefined, base, i); d.board.push({ ...c, x: snapTo(c.x), y: snapTo(c.y) }); }); });
  };

  // ---- selection actions -------------------------------------------------------------------------
  /** Merge the selected text cards into one note (stock/footage cards stack underneath it). */
  const combine = () => {
    const sorted = [...selected].sort(reading);
    const texts = sorted.filter(isText);
    const others = sorted.filter((b) => !isText(b));
    if (texts.length + others.length < 2) return;
    const tags = [...new Set(sorted.flatMap((b) => b.tags))];
    const hs = heights();
    const { x0, y0 } = bbox(sorted, hs);
    const allLyrics = texts.length > 0 && texts.every((b) => b.kind === 'lyric');
    const merged: BoardItem | null = texts.length
      ? { id: uid('b'), kind: allLyrics ? 'lyric' : texts.some((b) => b.kind === 'note') ? 'note' : 'idea', text: texts.map((b) => b.text?.trim()).filter(Boolean).join(allLyrics ? '\n' : '\n\n'), tags, x: snapTo(x0), y: snapTo(y0) }
      : null;
    const below = merged ? snapTo(y0 + estH(merged.text ?? '') + GAP) : snapTo(y0);
    const pos = layout([others], hs, { x: x0, y: below });
    store.editSB((d) => {
      const drop = new Set(texts.map((b) => b.id));
      d.board = d.board.filter((b) => !drop.has(b.id));
      d.board.forEach((b) => { const p = pos.get(b.id); if (p) { b.x = p.x; b.y = p.y; b.tags = [...new Set([...b.tags, ...tags])]; } });
      if (merged) d.board.push(merged);
    });
    setSelIds([...(merged ? [merged.id] : []), ...others.map((b) => b.id)]);
    flash(`Combined ${texts.length} text card(s)${others.length ? `, stacked ${others.length} clip(s)` : ''} - Ctrl+Z to undo`);
  };

  const addTag = (t: string) => {
    const tag = t.trim();
    if (!tag) return;
    store.editSB((d) => d.board.forEach((b) => { if (sel.has(b.id) && !b.tags.includes(tag)) b.tags.push(tag); }));
  };
  const removeTag = (t: string) => store.editSB((d) => d.board.forEach((b) => { if (sel.has(b.id)) b.tags = b.tags.filter((x) => x !== t); }));

  /** AI over the selection: results land next to it (or replace its text cards) and become the new selection. */
  const runAI = async (prompt: string, mode: string, replace: boolean) => {
    const src = [...selected].sort(reading);
    if (!src.length || !prompt.trim()) return;
    const r = await aiCards(llm, src, prompt, mode);
    if (!r?.ideas.length) return;
    const hs = heights();
    const bb = bbox(src, hs);
    const replaced = replace ? src.filter(isText) : [];
    const kept = src.filter((b) => !replaced.includes(b));
    const fresh: BoardItem[] = r.ideas.map((i) => ({ id: uid('b'), kind: 'idea', text: i.text, tags: i.tags, x: 0, y: 0, source: { model: r.model, at: r.at, prompt: prompt.slice(0, 200) } }));
    // replacing: lay out where the selection was (kept clips go after); adding: a new column block to the right
    const origin = replace ? { x: bb.x0, y: bb.y0 } : { x: bb.x1 + GAP * 2, y: bb.y0 };
    const cols = Math.max(1, Math.ceil(fresh.length / 6));
    const groups = Array.from({ length: cols }, (_, c) => fresh.slice(c * 6, c * 6 + 6));
    const pos = layout(replace ? [...groups, kept] : groups, hs, origin);
    store.editSB((d) => {
      const drop = new Set(replaced.map((b) => b.id));
      d.board = d.board.filter((b) => !drop.has(b.id));
      d.board.forEach((b) => { const p = pos.get(b.id); if (p && replace) { b.x = p.x; b.y = p.y; } });
      fresh.forEach((b) => d.board.push({ ...b, ...pos.get(b.id)! }));
    });
    setSelIds(fresh.map((b) => b.id));
    flash(`${replace ? `Replaced ${replaced.length} with` : 'Added'} ${fresh.length} AI card(s) - Ctrl+Z to undo`);
  };

  const toggleSnap = () => { setSnapOn(!snapOn); ls.set('mv.board.snap', !snapOn); };

  return (
    <div className="board">
      <div className="board-bar">
        <button onClick={() => add({ kind: 'note', text: '' })}>＋ Note</button>
        <button onClick={lyricCards} disabled={!lyrics.trim()} title="one card per lyric line from the brief">＋ Lyric lines</button>
        <button onClick={() => setShowMedia(!showMedia)} className={showMedia ? 'on' : ''}>Footage…</button>
        <input placeholder="filter…" value={text} onChange={(e) => setText(e.target.value)} style={{ width: 90 }} />
        <span className="grow" />
        {note ? <span className="dim board-note">{note}</span> : null}
        <label className="chk" title="snap cards to the 20px grid while dragging (hold Alt for free placement)"><input type="checkbox" checked={snapOn} onChange={toggleSnap} /> snap</label>
        <span className="zoom dim" title="ctrl+wheel to zoom, wheel / middle-drag / space+drag to pan">{Math.round(view.z * 100)}%</span>
        <button onClick={() => fit()} title="fit all cards in view">⤢</button>
        <div className="menu-wrap">
          <button className={menu ? 'on' : ''} onClick={() => setMenu(!menu)} title={selected.length ? 'tidy / clean up the selected cards' : 'tidy and clean up the board'}>Clean up{selected.length ? ` (${selected.length})` : ''} ▾</button>
          {menu ? <CleanupMenu board={selected.length ? selected : board} scoped={selected.length > 0} matches={matches} filtering={!!(filter.length || text)} close={() => setMenu(false)} arrange={arrange} remove={remove} /> : null}
        </div>
      </div>
      {allTags.length ? (
        <VResize id="board.tags" def={56} min={26} max={400} scroll className="flat"><div className="tagbar">
          {allTags.slice(0, 40).map(([t, n]) => (
            <span key={t} className={`chip ${filter.includes(t) ? 'on' : ''}`} onClick={() => setFilter(filter.includes(t) ? filter.filter((x) => x !== t) : [...filter, t])}>{t} <i>{n}</i></span>
          ))}
          {filter.length ? <span className="chip clear" onClick={() => setFilter([])}>clear</span> : null}
        </div></VResize>
      ) : null}
      {showMedia ? (
        <VResize id="board.media" def={150} min={60} max={800} scroll className="flat"><div className="board-media">
          {media.map((m) => (
            <div key={m.id} className="thumb" draggable onDragStart={(e) => e.dataTransfer.setData('application/x-mv-media', m.id)} onDoubleClick={() => add({ kind: 'media', media: m.id, text: m.id })} title={`${m.src} — drag onto the board · right-click for options`}
              onContextMenu={(e) => { e.preventDefault(); store.set({ footMenu: { x: e.clientX, y: e.clientY, ref: mediaRef(m) } }); }}>
              {m.thumb ? <img src={'/' + m.thumb.split('/').map(encodeURIComponent).join('/')} /> : null}
              <span>{m.id}</span>
            </div>
          ))}
        </div></VResize>
      ) : null}
      {selected.length ? (
        <SelectionBar
          items={selected}
          running={running}
          onClear={() => setSelIds([])}
          onDelete={() => remove(new Set(selIds), 'card(s)')}
          onTidy={() => arrange([[...selected].sort(reading)], 'Tidied selection', true)}
          onByType={() => arrange(KIND_ORDER.map((k) => selected.filter((b) => b.kind === k).sort(reading)), 'Arranged selection by type', true)}
          onCombine={combine}
          onTag={addTag}
          onUntag={removeTag}
          onAI={runAI}
          onFit={() => fit(selected)}
        />
      ) : null}
      <div
        className={`board-canvas ${snapOn ? 'snap' : ''}`}
        ref={ref}
        tabIndex={0}
        onMouseDown={onBgDown}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => { spaceDown.current = false; ref.current?.classList.remove('panning'); }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${GRID * view.z}px ${GRID * view.z}px` }}
      >
        <div className="board-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          {board.map((b) => {
            const m = b.kind === 'media' ? media.find((x) => x.id === b.media) : undefined;
            return (
              <div
                key={b.id}
                data-id={b.id}
                className={`bcard k-${b.kind} ${matches(b) ? '' : 'dim'} ${sel.has(b.id) ? 'sel' : ''}`}
                style={{ left: b.x, top: b.y, width: W, borderTopColor: b.color }}
                onMouseDown={(e) => onCardDown(e, b)}
                onDoubleClick={() => (isText(b) || b.kind === 'section') && setEditing(b.id)}
              >
                <div className="bc-h">
                  <span
                    className="drag"
                    draggable
                    title="drag onto a shot in the timeline"
                    onDragStart={(e) => e.dataTransfer.setData('application/x-mv-card', JSON.stringify({ kind: b.kind, text: b.text, tags: b.tags, stock: b.stock ?? (m ? mediaRef(m) : undefined) }))}
                  >⠿</span>
                  <span className="kind">{KIND_LABEL[b.kind]}</span>
                  {b.source ? <span className="dim" title={`${b.source.model} · ${b.source.at}${b.source.prompt ? ` · ${b.source.prompt}` : ''}`}>AI</span> : null}
                  <span className="grow" />
                  {shotId ? <button title="apply to selected shot" onClick={() => applyToShot(shotId, { ...b, stock: b.stock ?? (m ? mediaRef(m) : undefined) })}>→shot</button> : null}
                  {b.kind === 'idea' || b.kind === 'note' ? <button title="search stock for this idea" onClick={() => searchFrom(b)}>🔍</button> : null}
                  <button title="delete" onClick={() => remove(new Set([b.id]), 'card')}>✕</button>
                </div>
                {b.stock ? <RefThumb r={b.stock} draggable={false} /> : null}
                {m?.thumb ? <div className="thumb"><img src={'/' + m.thumb.split('/').map(encodeURIComponent).join('/')} /><span>{m.id}</span></div> : null}
                {editing === b.id ? (
                  <textarea autoFocus rows={4} defaultValue={b.text} onBlur={(e) => { editItem(b.id, (x) => { x.text = e.target.value; }); setEditing(null); }} />
                ) : b.text && b.kind !== 'media' ? (
                  <div className="bc-text">{b.text}</div>
                ) : b.kind === 'note' ? <div className="bc-text dim">double-click to write…</div> : null}
                <input
                  className="bc-tags"
                  placeholder="tags, comma separated"
                  defaultValue={b.tags.join(', ')}
                  key={b.tags.join(',')}
                  onBlur={(e) => editItem(b.id, (x) => { x.tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean); })}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
              </div>
            );
          })}
          {marquee ? <div className="marquee" style={{ left: marquee.x0, top: marquee.y0, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }} /> : null}
        </div>
        {!board.length ? <div className="hint pad board-empty">Empty board. “✦ Suggest ideas” in the Brief tab adds AI ideas here; pin stock from shots; add notes and lyric lines. Drag on empty space to select several cards, then move, tidy, combine or run AI on them.</div> : null}
      </div>
    </div>
  );
};

// ---- selection bar ------------------------------------------------------------------------------------

const AI_PRESETS: { label: string; mode: string; prompt: string; replace: boolean }[] = [
  { label: '✦ Split', mode: 'split', prompt: 'Split these cards into separate, atomic ideas — one concrete visual idea per card. Keep every distinct thought; drop filler.', replace: true },
  { label: '✦ Merge', mode: 'merge', prompt: 'Merge these cards into one strong, coherent idea (two at most if they really pull in different directions). Keep the best specifics.', replace: true },
  { label: 'Make search queries', mode: 'queries', prompt: 'For each card, write a concrete 2-5 word stock footage search query as the card text (subject + action + light/place), tags = the idea\'s motifs.', replace: false },
  { label: 'Bolder variations', mode: 'variations', prompt: 'Give 2 bolder, more surprising variations of each card, still filmable with stock footage or our generators.', replace: false },
  { label: 'Assign to sections', mode: 'sections', prompt: 'Rewrite each card unchanged in substance but tag it with the song section(s) where it fits best (use the section labels), plus mood tags.', replace: true },
];

const SelectionBar: React.FC<{
  items: BoardItem[];
  running: boolean;
  onClear: () => void;
  onDelete: () => void;
  onTidy: () => void;
  onByType: () => void;
  onCombine: () => void;
  onTag: (t: string) => void;
  onUntag: (t: string) => void;
  onAI: (prompt: string, mode: string, replace: boolean) => void;
  onFit: () => void;
}> = ({ items, running, onClear, onDelete, onTidy, onByType, onCombine, onTag, onUntag, onAI, onFit }) => {
  const [ask, setAsk] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [replace, setReplace] = useState(false);
  const [tag, setTag] = useState('');
  const texts = items.filter(isText).length;
  const common = items.length ? items[0].tags.filter((t) => items.every((b) => b.tags.includes(t))) : [];
  return (
    <div className="selbar">
      <div className="row">
        <b>{items.length} selected</b>
        <button onClick={onFit} title="zoom to the selection">⤢</button>
        <button onClick={onTidy} title="grid in reading order, starting at the selection's top-left">Tidy</button>
        <button onClick={onByType} title="columns by type, in place">By type</button>
        <button onClick={onCombine} disabled={items.length < 2} title="merge the text cards into one; clips stack underneath and share the tags">Combine</button>
        <button onClick={onDelete} title="Del">Delete</button>
        <span className="grow" />
        <button onClick={onClear} title="Esc">✕</button>
      </div>
      <div className="row">
        <input value={tag} placeholder="add tag…" style={{ width: 90 }} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { onTag(tag); setTag(''); } }} />
        {common.map((t) => <span key={t} className="chip on" title="remove from the selection" onClick={() => onUntag(t)}>{t} ✕</span>)}
        <span className="grow" />
        {AI_PRESETS.slice(0, 2).map((p) => (
          <button key={p.mode} disabled={running || (p.mode === 'merge' ? items.length < 2 : !texts)} onClick={() => onAI(p.prompt, p.mode, p.replace)} title={`${p.prompt}\n(replaces the selected text cards; clips are kept)`}>{p.label}</button>
        ))}
        <button className={ask ? 'on' : ''} disabled={running} onClick={() => setAsk(!ask)} title="run your own prompt on the selection">✦ Prompt…</button>
      </div>
      {ask ? (
        <div className="selbar-ask">
          <textarea rows={2} value={prompt} autoFocus placeholder="What should the AI do with these cards? e.g. “turn these into a chorus sequence of 6 shots”"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { onAI(prompt, 'custom', replace); setAsk(false); } }} />
          <div className="row">
            <select value="" onChange={(e) => { const p = AI_PRESETS.find((x) => x.mode === e.target.value); if (p) { setPrompt(p.prompt); setReplace(p.replace); } }}>
              <option value="">presets…</option>
              {AI_PRESETS.map((p) => <option key={p.mode} value={p.mode}>{p.label.replace('✦ ', '')}</option>)}
            </select>
            <label className="chk" title="remove the selected text cards and put the results in their place (clips are kept)"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> replace selection</label>
            <span className="grow" />
            <button className="accent" disabled={running || !prompt.trim()} onClick={() => { onAI(prompt, 'custom', replace); setAsk(false); }} title="Ctrl+Enter">Run</button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

// ---- clean-up menu (whole board, or the selection when there is one) ---------------------------------------

const CleanupMenu: React.FC<{
  board: BoardItem[];
  scoped: boolean;
  matches: (b: BoardItem) => boolean;
  filtering: boolean;
  close: () => void;
  arrange: (groups: BoardItem[][], label: string, inPlace: boolean) => void;
  remove: (ids: Set<string>, label: string) => void;
}> = ({ board, scoped, matches, filtering, close, arrange, remove }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, []);

  const seen = new Set<string>();
  const dups = new Set<string>();
  [...board].sort(reading).forEach((b) => { const k = dupKey(b); if (seen.has(k)) dups.add(b.id); else seen.add(k); });
  const empty = new Set(board.filter((b) => isText(b) && !b.text?.trim()).map((b) => b.id));
  const used = new Set(sb().shots.flatMap((s) => s.candidates.map(refKey)));
  const unusedStock = new Set(board.filter((b) => b.kind === 'stock' && b.stock && !used.has(refKey(b.stock))).map((b) => b.id));
  const aiIdeas = new Set(board.filter((b) => b.kind === 'idea' && b.source).map((b) => b.id));
  const hidden = new Set(filtering ? board.filter((b) => !matches(b)).map((b) => b.id) : []);

  const tagGroups = () => {
    const m = new Map<string, BoardItem[]>();
    [...board].sort(reading).forEach((b) => { const t = b.tags[0] ?? '(untagged)'; if (!m.has(t)) m.set(t, []); m.get(t)!.push(b); });
    return [...m.entries()].sort((a, b) => (a[0] === '(untagged)' ? 1 : b[0] === '(untagged)' ? -1 : b[1].length - a[1].length)).map(([, v]) => v);
  };
  const kindGroups = () => KIND_ORDER.map((k) => board.filter((b) => b.kind === k).sort(reading));

  const item = (label: string, n: number, fn: () => void, hint?: string) => (
    <button disabled={n === 0} title={hint} onClick={() => { fn(); close(); }}>
      <span>{label}</span><i>{n}</i>
    </button>
  );
  return (
    <div className="popover cleanup" ref={ref}>
      <div className="cat">Arrange {scoped ? 'selection' : 'board'}</div>
      {item('Tidy into columns by type', board.length, () => arrange(kindGroups(), 'Arranged by type', scoped), 'ideas · notes · lyrics · stock · footage')}
      {item('Group by first tag', board.length, () => arrange(tagGroups(), 'Grouped by tag', scoped), 'one column group per first tag')}
      {item('Tidy in place (grid)', board.length, () => arrange([[...board].sort(reading)], 'Tidied', scoped), 'keeps reading order, removes overlaps')}
      <div className="cat">Remove from {scoped ? 'selection' : 'board'}</div>
      {item('Duplicates', dups.size, () => remove(dups, 'duplicate(s)'), 'same text, same stock clip or same footage - keeps the first')}
      {item('Empty notes', empty.size, () => remove(empty, 'empty card(s)'))}
      {item('Stock not used by any shot', unusedStock.size, () => remove(unusedStock, 'unused stock card(s)'), 'stock cards whose clip is not a candidate of any shot')}
      {item('AI ideas', aiIdeas.size, () => remove(aiIdeas, 'AI idea(s)'), 'idea cards generated by AI')}
      {item('Cards hidden by the filter', filtering ? hidden.size : 0, () => remove(hidden, 'filtered-out card(s)'), filtering ? 'everything dimmed by the current tag/text filter' : 'set a tag or text filter first')}
    </div>
  );
};

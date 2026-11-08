// Lyrics column: lines laid out against the timeline (locked when zoomed in, flowing when zoomed out, blended in
// between), click-to-edit with a textarea over an identical mirror, word selection → tag toolbar.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  applyBlockText, applyRawText, blockText, lineKind, lineTimes, parseHeader, segments, sheetToText,
  sorted, BLOCK_COLORS, TEMPLATES, applyTemplate,
} from '../../core/sheet';
import { respell } from '../../core/phonetics';
import { ruleTh, type Finding, type LineM, type SheetAnalysis } from '../../core/lyricMetrics';
import { densityColor, FAM_COLORS, useAnalysis } from './analysis';
import type { LyricSheet, SheetBlock, SheetLine, WordTag } from '../../core/types';
import { store, useStore } from '../store';
import { editSheet, lx, sheet, toast, useLx, useSheet, ZOOM_MAX, ZOOM_MIN, type WordSel } from './state';
import { askText, blockMenu } from './menus';
import { seedFromSong } from './actions';

export const LINE_H = 24;
const BLOCK_GAP = 18;
export const GUTTER = 96;
/** right gutter: meter (heat · syllables · rhyme · finding) + rhyme arcs */
const ARCS_W = 22;

// ---- layout ---------------------------------------------------------------------------------------

export interface LItem { key: string; block: SheetBlock; line?: SheetLine; idx: number; kind: 'line' | 'empty' | 'editor'; beat: number; len: number; h: number; y: number; first: boolean }
export interface SheetLayout {
  items: LItem[];
  height: number;
  k: number;
  anchors: [number, number][]; // (y, beat), both non-decreasing
  blocks: { id: string; top: number; bottom: number; at: number; end: number; color: string }[];
  gaps: { y: number; bars: number; after: string }[];
}

const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

export function layoutSheet(s: LyricSheet, zoom: number, heights: Map<string, number>, editing: string | null, editorH: number): SheetLayout {
  const items: LItem[] = [];
  for (const b of sorted(s)) {
    if (editing === b.id) { items.push({ key: `${b.id}:edit`, block: b, idx: 0, kind: 'editor', beat: b.at, len: b.len, h: Math.max(LINE_H, editorH), y: 0, first: true }); continue; }
    if (!b.lines.length) { items.push({ key: `${b.id}:empty`, block: b, idx: 0, kind: 'empty', beat: b.at, len: b.len, h: LINE_H, y: 0, first: true }); continue; }
    const times = lineTimes(b);
    b.lines.forEach((l, i) => {
      const key = `${b.id}:${l.id}`;
      items.push({ key, block: b, line: l, idx: i, kind: 'line', beat: times[i].at, len: times[i].len, h: heights.get(key) ?? LINE_H, y: 0, first: i === 0 });
    });
  }
  // zoom at which (most) lines get their own height in timeline pixels
  const need = items.filter((it) => it.kind === 'line' && it.len > 0.01).map((it) => it.h / it.len).sort((a, b) => a - b);
  const zLock = need.length ? need[Math.min(need.length - 1, Math.floor(need.length * 0.85))] : 8;
  const k = smooth((zoom / zLock - 0.72) / 0.28);
  let fy = 0, ly = 0, prev: LItem | null = null;
  const fys: number[] = [], lys: number[] = [];
  for (const it of items) {
    if (prev && it.first) fy += BLOCK_GAP + (it.block.at - (prev.block.at + prev.block.len) > 0.01 ? LINE_H : 0);
    fys.push(fy); fy += it.h;
    const want = it.beat * zoom;
    const y = Math.max(want, prev ? ly + (it.first ? 4 : 0) : want);
    lys.push(y); ly = y + it.h;
    prev = it;
  }
  items.forEach((it, i) => { it.y = fys[i] * (1 - k) + lys[i] * k; });
  const anchors: [number, number][] = [];
  const push = (y: number, b: number) => {
    const last = anchors[anchors.length - 1];
    if (last && (y < last[0] || b < last[1])) { if (y >= last[0] && b >= last[1]) anchors.push([y, b]); return; }
    anchors.push([y, b]);
  };
  for (const it of items) { push(it.y, it.beat); push(it.y + it.h, it.beat + it.len); }
  const blocks: SheetLayout['blocks'] = [];
  const gaps: SheetLayout['gaps'] = [];
  for (const it of items) {
    const b = it.block;
    let e = blocks[blocks.length - 1];
    if (!e || e.id !== b.id) {
      if (e) {
        const prevB = s.blocks.find((x) => x.id === e!.id)!;
        const gap = b.at - (prevB.at + prevB.len);
        if (gap > 0.01) gaps.push({ y: (e.bottom + it.y) / 2, bars: +(gap / s.beatsPerBar).toFixed(2), after: prevB.id });
      }
      e = { id: b.id, top: it.y, bottom: it.y + it.h, at: b.at, end: b.at + b.len, color: b.color ?? BLOCK_COLORS[b.kind] };
      blocks.push(e);
    }
    e.bottom = Math.max(e.bottom, it.y + it.h);
  }
  // locked: a block reaches down to its end beat (blended with the flow extent)
  blocks.forEach((e, i) => {
    const next = blocks[i + 1]?.top ?? Infinity;
    e.bottom = Math.min(Math.max(e.bottom, e.bottom * (1 - k) + e.end * zoom * k), Math.max(e.bottom, next - 2));
  });
  const height = Math.max(items.length ? items[items.length - 1].y + items[items.length - 1].h : 0, blocks.length ? blocks[blocks.length - 1].bottom : 0);
  return { items, height, k, anchors, blocks, gaps };
}

export function yToBeat(L: SheetLayout, y: number, zoom: number) {
  const a = L.anchors;
  if (!a.length) return y / zoom;
  if (y <= a[0][0]) return a[0][1] - (a[0][0] - y) / zoom;
  for (let i = 1; i < a.length; i++) if (y <= a[i][0]) { const [y0, b0] = a[i - 1], [y1, b1] = a[i]; return y1 - y0 < 1e-6 ? b1 : b0 + ((b1 - b0) * (y - y0)) / (y1 - y0); }
  const [yl, bl] = a[a.length - 1];
  return bl + (y - yl) / zoom;
}
export function beatToY(L: SheetLayout, b: number, zoom: number) {
  const a = L.anchors;
  if (!a.length) return b * zoom;
  if (b <= a[0][1]) return a[0][0] - (a[0][1] - b) * zoom;
  for (let i = 1; i < a.length; i++) if (b < a[i][1] || (i === a.length - 1 && b <= a[i][1])) { const [y0, b0] = a[i - 1], [y1, b1] = a[i]; return b1 - b0 < 1e-6 ? y0 : y0 + ((y1 - y0) * (b - b0)) / (b1 - b0); }
  const [yl, bl] = a[a.length - 1];
  return yl + (b - bl) * zoom;
}

/** layout shared with the timeline (connectors) */
export const shared: { layout: SheetLayout | null; listeners: Set<() => void> } = { layout: null, listeners: new Set() };

// ---- rich text (shared by static lines and the editor mirror: width-neutral styling only) --------------

const CAT_CLASS: Record<string, string> = { performance: 'd-perf', dynamics: 'd-dyn', instrument: 'd-inst', section: 'd-sec', other: 'd-oth' };

type Mark = { from: number; to: number; fam: number };

function Rich({ text, tags, data, marks }: { text: string; tags?: WordTag[]; data?: boolean; marks?: Mark[] }) {
  const segs = segments(text);
  const cuts = new Set<number>([0, text.length]);
  segs.forEach((s) => { cuts.add(s.from); cuts.add(s.to); });
  tags?.forEach((t) => { cuts.add(Math.max(0, t.from)); cuts.add(Math.min(text.length, t.to)); });
  marks?.forEach((m) => { cuts.add(m.from); cuts.add(m.to); });
  const pts = [...cuts].sort((a, b) => a - b);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b <= a) continue;
    const seg = segs.find((s) => a >= s.from && a < s.to);
    const ts = tags?.filter((t) => a >= t.from && a < t.to) ?? [];
    const cls = [seg?.kind === 'dir' ? `dir ${CAT_CLASS[seg.cat ?? 'other']}` : seg?.kind === 'adlib' ? 'adlib' : '', ...ts.map((t) => `t-${t.kind}`)].filter(Boolean).join(' ');
    const title = ts.map((t) => `${t.kind}${t.label ? ` · ${t.label}` : ''}${t.note ? ` — ${t.note}` : ''}`).join('\n') || undefined;
    // sound view: colour only (width-neutral, like everything else that styles lyric text)
    const mk = marks?.find((m) => a >= m.from && a < m.to);
    out.push(<span key={a} className={cls || undefined} data-o={data ? a : undefined} title={title} style={mk ? { color: FAM_COLORS[mk.fam % FAM_COLORS.length] } : undefined}>{text.slice(a, b)}</span>);
  }
  return <>{out}</>;
}

// ---- caret / selection mapping ------------------------------------------------------------------

function pointCaret(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as any;
  if (d.caretPositionFromPoint) { const p = d.caretPositionFromPoint(x, y); return p ? { node: p.offsetNode, offset: p.offset } : null; }
  if (d.caretRangeFromPoint) { const r = d.caretRangeFromPoint(x, y); return r ? { node: r.startContainer, offset: r.startOffset } : null; }
  return null;
}

/** char offset in a line's text for a DOM position inside its .lx-text */
function offsetIn(lineEl: HTMLElement, node: Node, offset: number, len: number): number {
  if (!lineEl.contains(node)) return node.compareDocumentPosition(lineEl) & Node.DOCUMENT_POSITION_PRECEDING ? len : 0;
  const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
  const span = el?.closest('[data-o]') as HTMLElement | null;
  if (span && node.nodeType === 3) return Math.min(len, Number(span.dataset.o) + offset);
  if (span) return Number(span.dataset.o);
  return len;
}

const isWordCh = (c: string | undefined) => !!c && /[\p{L}\p{N}'’-]/u.test(c);
function snapWords(text: string, from: number, to: number): [number, number] {
  while (from > 0 && isWordCh(text[from - 1]) && isWordCh(text[from])) from--;
  while (to < text.length && isWordCh(text[to - 1]) && isWordCh(text[to])) to++;
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return [from, to];
}

// ---- the column ---------------------------------------------------------------------------------

export const SheetView: React.FC = () => {
  const s = useSheet();
  const zoom = useLx((x) => x.zoom);
  const editing = useLx((x) => x.editing);
  const raw = useLx((x) => x.raw);
  const meter = useLx((x) => x.meter);
  const sound = useLx((x) => x.sound);
  const focus = useLx((x) => x.focus);
  const an = useAnalysis();
  const selBlock = useLx((x) => x.selBlock);
  const hasSong = useStore((x) => !!x.project.audio);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [vh, setVh] = useState(600);
  const [heights, setHeights] = useState(() => new Map<string, number>());
  const [editorH, setEditorH] = useState(LINE_H);
  const ignoreScroll = useRef(false);
  const downTarget = useRef<{ block: string; caret: number; x: number; y: number } | null>(null);

  const L = useMemo(() => layoutSheet(s, zoom, heights, editing?.block ?? null, editorH), [s, zoom, heights, editing?.block, editorH]);
  shared.layout = L;
  useEffect(() => { shared.listeners.forEach((f) => f()); }, [L]);
  useEffect(() => { lx.set({ lock: L.k }); }, [L.k]);

  // viewport height (padding so any beat can sit in the centre)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setVh(el.clientHeight); setHeights(new Map()); });
    ro.observe(el);
    setVh(el.clientHeight);
    return () => ro.disconnect();
  }, [raw]);

  // measure wrapped line heights
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    let changed = false;
    const next = new Map(heights);
    el.querySelectorAll<HTMLElement>('.lx-line[data-k]').forEach((n) => {
      const k = n.dataset.k!, h = n.offsetHeight;
      if (h && next.get(k) !== h) { next.set(k, h); changed = true; }
    });
    if (changed) setHeights(next);
  });

  // centre beat → scroll position (both directions; our own scroll events are ignored)
  const lastL = useRef<SheetLayout | null>(null);
  useLayoutEffect(() => {
    const apply = () => {
      const el = scrollRef.current;
      const st = lx.get();
      if (!el || !shared.layout) return;
      if (st.driver === 'lyrics' && lastL.current === shared.layout) return;
      lastL.current = shared.layout;
      const top = beatToY(shared.layout, st.center, st.zoom);
      if (Math.abs(el.scrollTop - top) > 0.5) { ignoreScroll.current = true; el.scrollTop = top; }
    };
    lastL.current = null;
    apply();
    return lx.subscribe(apply);
  }, [L, vh]);

  const onScroll = () => {
    if (ignoreScroll.current) { ignoreScroll.current = false; return; }
    const el = scrollRef.current;
    if (!el) return;
    lx.set({ center: yToBeat(L, el.scrollTop, zoom), driver: 'lyrics' });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const st = lx.get();
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, st.zoom * Math.exp(-e.deltaY * 0.004)));
    lx.set({ zoom: z, driver: null });
  };

  // playback / click-track highlight (imperative: no re-render per frame)
  useEffect(() => {
    let cur: HTMLElement | null = null;
    const upd = () => {
      const st = lx.get();
      const playing = !!st.click || store.state.playing;
      const el = contentRef.current;
      if (!el || !shared.layout) return;
      let key: string | null = null;
      if (playing) {
        const beat = st.center;
        const it = shared.layout.items.find((x) => x.kind === 'line' && beat >= x.beat && beat < x.beat + Math.max(x.len, 0.01) && lineKind(x.line!.text) !== 'direction');
        key = it?.key ?? null;
      }
      const n = key ? el.querySelector<HTMLElement>(`.lx-line[data-k="${key}"]`) : null;
      if (n !== cur) { cur?.classList.remove('cur'); n?.classList.add('cur'); cur = n; }
    };
    const a = lx.subscribe(upd), b = store.subscribe(upd);
    return () => { a(); b(); };
  }, []);

  // ---- mouse: edit on click, select words on drag --------------------------------------------------

  const caretAt = (e: React.MouseEvent): { block: string; caret: number } | null => {
    const lineEl = (e.target as HTMLElement).closest('.lx-line') as HTMLElement | null;
    if (!lineEl) return null;
    const b = s.blocks.find((x) => x.id === lineEl.dataset.block);
    if (!b) return null;
    if (lineEl.dataset.empty) return { block: b.id, caret: 0 };
    const li = b.lines.findIndex((l) => l.id === lineEl.dataset.line);
    if (li < 0) return null;
    const p = pointCaret(e.clientX, e.clientY);
    const len = b.lines[li].text.length;
    const o = p ? offsetIn(lineEl.querySelector('.lx-text') as HTMLElement, p.node, p.offset, len) : len;
    const before = b.lines.slice(0, li).reduce((a, l) => a + l.text.length + 1, 0);
    return { block: b.id, caret: before + o };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const t = caretAt(e);
    downTarget.current = t ? { ...t, x: e.clientX, y: e.clientY } : null;
    if (lx.get().wsel) lx.set({ wsel: null });
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && contentRef.current?.contains(sel.anchorNode)) {
      const ws = wordSelection(sel, s);
      if (ws) { lx.set({ wsel: ws }); return; }
    }
    const t = downTarget.current;
    downTarget.current = null;
    if (!t || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 4) return;
    const b = s.blocks.find((x) => x.id === t.block);
    lx.set({ editing: { block: t.block, caret: t.caret }, selBlock: t.block, wsel: null, focus: b?.lines.length ? { block: b.id, line: lineAtCaret(b, t.caret) } : null });
  };

  if (raw) return <RawView />;
  if (!s.blocks.length) return <Welcome hasSong={hasSong} />;

  // findings by line id (linked copies share lines, so every copy shows the marker) and by block
  const fByLine = new Map<string, Finding[]>(), fByBlock = new Map<string, Finding[]>();
  for (const f of an.findings) {
    if (f.line) { const a = fByLine.get(f.line) ?? []; a.push(f); fByLine.set(f.line, a); }
    const b = fByBlock.get(f.block) ?? []; b.push(f); fByBlock.set(f.block, b);
  }
  const denseTh = ruleTh(s, 'dense');
  const tagsByLine = new Map<string, WordTag[]>();
  for (const t of s.tags) { const a = tagsByLine.get(t.line) ?? []; a.push(t); tagsByLine.set(t.line, a); }

  return (
    <div className="lx-scroll" ref={scrollRef} onScroll={onScroll} onWheel={onWheel}>
      <div className="lx-content" ref={contentRef} style={{ height: L.height + vh, paddingTop: vh / 2 }} onMouseDown={onMouseDown} onMouseUp={onMouseUp}>
        <div className="lx-layer" style={{ top: vh / 2 }}>
          {L.blocks.map((bl) => {
            const b = s.blocks.find((x) => x.id === bl.id)!;
            const links = b.link ? s.blocks.filter((x) => x.link === b.link).length : 0;
            const warns = (fByBlock.get(b.id) ?? []).filter((f) => f.level === 'warn').length;
            return (
              <div key={bl.id} className={`lx-bhead ${selBlock === b.id ? 'sel' : ''}`} style={{ top: bl.top, height: Math.max(LINE_H, bl.bottom - bl.top), '--c': bl.color } as React.CSSProperties}
                onMouseEnter={(e) => hoverProfile(b.id, e.currentTarget)} onMouseLeave={() => hoverProfile(null)}
                onMouseDown={(e) => { e.stopPropagation(); hoverProfile(null); lx.set({ selBlock: b.id, wsel: null }); }}
                onDoubleClick={(e) => { e.stopPropagation(); renameBlock(b, e.clientX, e.clientY); }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); lx.set({ selBlock: b.id }); blockMenu(e.clientX, e.clientY, b.id); }}
                title={`${b.name} · ${+(b.len / s.beatsPerBar).toFixed(2)} bars${links ? ` · linked ×${links} (edits apply to every copy)` : ''}\ndouble-click: rename · right-click: menu`}>
                <span className="nm">{b.name}</span>
                <span className="bars">{+(b.len / s.beatsPerBar).toFixed(1)} bars{links ? <span className="lnk" title="linked repeat"> ⛓{links}</span> : null}{warns ? <span className="fw" title={`${warns} warning${warns > 1 ? 's' : ''} — Analysis (F)`}> ▲{warns}</span> : null}</span>
              </div>
            );
          })}
          {L.gaps.map((g) => (
            <div key={`g${g.after}`} className="lx-gap" style={{ top: g.y - 9 }} title="pause between blocks — G adds a bar, Shift+G removes one (select the block above)">┄ {g.bars} bar{g.bars === 1 ? '' : 's'} pause ┄</div>
          ))}
          {L.items.map((it) => {
            if (it.kind === 'editor') return <BlockEditor key={it.key} block={it.block} caret={editing?.caret ?? 0} y={it.y} onHeight={setEditorH} />;
            if (it.kind === 'empty') {
              const sh = it.block.shape;
              return (
                <div key={it.key} className="lx-line empty" data-k={it.key} data-block={it.block.id} data-empty="1" style={{ transform: `translateY(${it.y}px)` }}>
                  <div className="lx-text">＋ write {it.block.name.toLowerCase()} lyrics…{sh ? <span className="shape-hint"> shape {sh.syl.join(' ')}{sh.rhyme ? ` · ${sh.rhyme}` : ''}</span> : null}</div>
                </div>
              );
            }
            const l = it.line!;
            const kind = lineKind(l.text);
            const m = an.byKey.get(it.key);
            const isFocus = focus?.block === it.block.id && focus.line === l.id;
            const fs = fByLine.get(l.id) ?? [];
            return (
              <div key={it.key} className={`lx-line k-${kind} ${isFocus ? 'focus' : ''}`} data-k={it.key} data-block={it.block.id} data-line={l.id} style={{ transform: `translateY(${it.y}px)` }}>
                <div className="lx-text"><Rich text={l.text} tags={tagsByLine.get(l.id)} data marks={sound ? m?.marks : undefined} /></div>
                {meter && kind === 'lyric' && m ? <Meter m={m} fs={fs} denseTh={denseTh} /> : null}
              </div>
            );
          })}
          {meter ? <RhymeArcs L={L} an={an} /> : null}
        </div>
      </div>
    </div>
  );
};

// ---- gutter: meter + rhyme arcs -------------------------------------------------------------------

const RQ: Record<string, string> = { perfect: 'perfect', slant: 'slant', assonance: 'assonance', consonance: 'consonance', identity: 'same word' };

const Meter: React.FC<{ m: LineM; fs: Finding[]; denseTh: number }> = ({ m, fs, denseTh }) => {
  const t = m.t;
  const warn = fs.some((f) => f.level === 'warn');
  const letter = m.letter;
  const off = m.target !== undefined ? Math.abs(m.target - t.syl) >= 2 : fs.some((f) => f.rule === 'meter-drift');
  const title = [
    `${t.syl} syllables${m.target !== undefined ? ` (target ${m.target})` : ''}${m.ref ? ` · ${m.ref.name} line ${m.ref.idx + 1}: ${m.ref.syl}` : ''}`,
    `stress ${t.stress}${t.pickup >= 2 ? ` (pickup of ${t.pickup})` : ''}`,
    `${m.density.toFixed(1)} syl/beat · ${m.sps.toFixed(1)} syl/s`,
    letter ? `rhyme ${letter[0]}${letter.endsWith('·') ? ' — no partner in the block' : m.rq ? ` — ${RQ[m.rq] ?? m.rq}${m.multi >= 2 ? `, ${m.multi} syllables deep` : ''}` : ''}` : '',
    m.internal ? `${m.internal} internal rhyme${m.internal > 1 ? 's' : ''}` : '',
    m.sustained && t.sustain ? `held note: ${t.sustain.open ? 'open' : 'closed'} vowel` : '',
    t.end ? `end word ${respell(t.end.p)}${t.est.length ? ` · estimated: ${t.est.join(', ')}` : ''}` : '',
    ...fs.map((f) => `${f.level === 'warn' ? '▲' : '●'} ${f.msg}`),
  ].filter(Boolean).join('\n');
  return (
    <div className={`lx-meter ${off ? 'off' : ''}`} title={title}>
      <i className="heat" style={{ background: densityColor(m.sps, denseTh) }} />
      <span className="syl">{t.syl}{m.target !== undefined ? <span className="tgt">/{m.target}</span> : null}</span>
      <span className={`rl ${letter?.endsWith('·') ? 'solo' : ''} ${m.rq === 'slant' ? 'slant' : ''}`}>{letter?.[0] ?? ''}</span>
      <span className={`fd ${warn ? 'w' : fs.length ? 'i' : ''}`}>{warn ? '▲' : fs.length ? '●' : ''}</span>
    </div>
  );
};

/** arcs joining rhyme partners (solid: perfect, dashed: slant) */
const RhymeArcs: React.FC<{ L: SheetLayout; an: SheetAnalysis }> = ({ L, an }) => {
  const ys = new Map<string, number>();
  for (const it of L.items) if (it.kind === 'line') ys.set(it.key, it.y + LINE_H / 2);
  const paths: React.ReactNode[] = [];
  for (const b of an.blocks) for (const m of b.sung) {
    if (m.partner === null || m.partner > m.idx || !m.letter) continue;
    const p = b.lines[m.partner];
    const y1 = ys.get(p.key), y2 = ys.get(m.key);
    if (y1 === undefined || y2 === undefined) continue;
    const d = Math.min(ARCS_W - 4, 5 + (y2 - y1) / 10);
    const c = FAM_COLORS[(m.letter.charCodeAt(0) - 65) % FAM_COLORS.length];
    paths.push(<path key={m.key} d={`M2 ${y1} C${2 + d} ${y1} ${2 + d} ${y2} 2 ${y2}`} stroke={c} className={m.rq === 'perfect' || m.rq === 'identity' ? '' : 'slant'} />);
  }
  if (!paths.length) return null;
  return <svg className="lx-arcs" width={ARCS_W} height={L.height + 4}>{paths}</svg>;
};

let hoverT: ReturnType<typeof setTimeout> | undefined;
function hoverProfile(block: string | null, el?: HTMLElement) {
  clearTimeout(hoverT);
  if (!block || !el) { if (lx.get().profile) lx.set({ profile: null }); return; }
  hoverT = setTimeout(() => { const r = el.getBoundingClientRect(); lx.set({ profile: { block, x: r.right, y: r.top } }); }, 450);
}

function lineAtCaret(b: SheetBlock, caret: number) {
  let acc = 0;
  for (const l of b.lines) { if (caret <= acc + l.text.length) return l.id; acc += l.text.length + 1; }
  return b.lines[b.lines.length - 1]?.id ?? '';
}

export function renameBlock(b: SheetBlock, x: number, y: number) {
  askText(x, y, 'Block name', b.name, (name) => {
    if (!name.trim()) return;
    editSheet((d) => {
      const blk = d.blocks.find((z) => z.id === b.id);
      if (!blk) return;
      blk.name = name.trim();
      const h = parseHeader(`[${name.trim()}]`);
      if (h) blk.kind = h.kind;
    });
  });
}

function wordSelection(sel: Selection, s: LyricSheet): WordSel | null {
  const range = sel.getRangeAt(0);
  const root = (range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer as HTMLElement)?.closest('.lx-content');
  if (!root) return null;
  const lines: WordSel['lines'] = [];
  root.querySelectorAll<HTMLElement>('.lx-line[data-line]').forEach((el) => {
    if (!range.intersectsNode(el)) return;
    const b = s.blocks.find((x) => x.id === el.dataset.block);
    const l = b?.lines.find((x) => x.id === el.dataset.line);
    if (!b || !l) return;
    const tx = el.querySelector('.lx-text') as HTMLElement;
    const a = offsetIn(tx, range.startContainer, range.startOffset, l.text.length);
    const z = offsetIn(tx, range.endContainer, range.endOffset, l.text.length);
    const [from, to] = snapWords(l.text, Math.min(a, z), Math.max(a, z));
    if (to > from) lines.push({ block: b.id, line: l.id, from, to, text: l.text.slice(from, to) });
  });
  if (!lines.length) return null;
  const r = range.getBoundingClientRect();
  sel.removeAllRanges();
  return { lines, text: lines.map((x) => x.text).join(' / '), rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
}

// ---- inline block editor ------------------------------------------------------------------------

const BlockEditor: React.FC<{ block: SheetBlock; caret: number; y: number; onHeight: (h: number) => void }> = ({ block, caret, y, onHeight }) => {
  const [draft, setDraft] = useState(() => blockText(block));
  const ta = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const closed = useRef(false);
  const links = block.link ? sheet().blocks.filter((x) => x.link === block.link).length : 0;

  useLayoutEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.focus({ preventScroll: true });
    const c = Math.min(caret, t.value.length);
    t.setSelectionRange(c, c);
  }, []);
  useLayoutEffect(() => { if (mirror.current) onHeight(mirror.current.offsetHeight); }, [draft]);

  const commit = (close: boolean) => {
    if (closed.current) return null;
    const cur = sheet().blocks.find((b) => b.id === block.id);
    let res: ReturnType<typeof applyBlockText> | null = null;
    if (cur && draft !== blockText(cur)) editSheet((d) => { res = applyBlockText(d as LyricSheet, block.id, draft); });
    if (close) { closed.current = true; lx.set({ editing: null }); }
    return res as ReturnType<typeof applyBlockText> | null;
  };

  // selection inside the editor → tag toolbar (commits pending text first so offsets map to real lines)
  const onSelectEnd = (e: React.MouseEvent | React.KeyboardEvent) => {
    const t = ta.current!;
    if (t.selectionStart === t.selectionEnd) { if (lx.get().wsel) lx.set({ wsel: null }); return; }
    const a = t.selectionStart, z = t.selectionEnd;
    const res = commit(false);
    const b = sheet().blocks.find((x) => x.id === block.id);
    if (!b) return;
    const map = res?.map ?? ((off: number) => {
      let acc = 0;
      for (const l of b.lines) { if (off <= acc + l.text.length) return { block: b.id, line: l.id, off: off - acc }; acc += l.text.length + 1; }
      return null;
    });
    const p = map(a), q = map(z);
    if (!p || !q) return;
    const lines: WordSel['lines'] = [];
    const all = sorted(sheet()).flatMap((x) => x.lines.map((l) => ({ b: x, l })));
    const i0 = all.findIndex((x) => x.b.id === p.block && x.l.id === p.line), i1 = all.findIndex((x) => x.b.id === q.block && x.l.id === q.line);
    for (let i = i0; i <= i1 && i >= 0; i++) {
      const { b: bb, l } = all[i];
      const [from, to] = snapWords(l.text, i === i0 ? p.off : 0, i === i1 ? q.off : l.text.length);
      if (to > from) lines.push({ block: bb.id, line: l.id, from, to, text: l.text.slice(from, to) });
    }
    if (!lines.length) return;
    const pt = 'clientX' in e ? { x: e.clientX, y: e.clientY } : (() => { const r = t.getBoundingClientRect(); return { x: r.left + 40, y: r.top }; })();
    lx.set({ wsel: { lines, text: lines.map((x) => x.text).join(' / '), rect: { x: pt.x - 20, y: pt.y - 6, w: 40, h: 12 } } });
  };

  const lines = draft.split('\n');
  return (
    <div className="lx-edit" style={{ transform: `translateY(${y}px)` }} onMouseDown={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()}>
      <div className="lx-mirror lx-text" ref={mirror} aria-hidden>
        {lines.map((ln, i) => (
          <React.Fragment key={i}>
            {parseHeader(ln) ? <span className="dir d-sec">{ln}</span> : <Rich text={ln} />}
            {i < lines.length - 1 ? '\n' : '​'}
          </React.Fragment>
        ))}
      </div>
      <textarea
        ref={ta}
        className="lx-ta lx-text"
        value={draft}
        spellCheck
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(true)}
        onMouseUp={onSelectEnd}
        onKeyUp={(e) => { if (e.shiftKey) onSelectEnd(e); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); commit(true); }
        }}
      />
      {links ? <div className="lx-edit-note">linked ×{links} — edits apply to every copy</div> : null}
    </div>
  );
};

// ---- raw view / welcome -------------------------------------------------------------------------

const RawView: React.FC = () => {
  const s = useSheet();
  const [text, setText] = useState(() => sheetToText(s));
  const dirty = text !== sheetToText(s);
  const apply = () => { if (dirty) editSheet((d) => applyRawText(d as LyricSheet, text)); };
  return (
    <div className="lx-raw">
      <div className="lx-raw-bar">
        <span className="dim">Whole song as text. Blocks are matched by name, so ids, tags and layers survive. Blank line or <code>[Header]</code> = new block.</span>
        <span className="grow" />
        <button disabled={!dirty} onClick={() => setText(sheetToText(s))}>Revert</button>
        <button className="accent" disabled={!dirty} onClick={() => { apply(); lx.set({ raw: false }); }}>Apply</button>
      </div>
      <textarea className="lx-raw-ta" value={text} onChange={(e) => setText(e.target.value)} onBlur={apply} spellCheck autoFocus />
    </div>
  );
};

const Welcome: React.FC<{ hasSong: boolean }> = ({ hasSong }) => {
  const [text, setText] = useState('');
  const go = () => {
    if (!text.trim()) return;
    editSheet((d) => applyRawText(d as LyricSheet, text));
    toast('parsed into blocks — click any line to edit');
  };
  return (
    <div className="lx-welcome">
      <h3>Start the lyrics</h3>
      <p className="dim">Paste a whole song — <code>[Verse 1]</code> / <code>Chorus:</code> headers and blank lines split it into blocks, <code>[whisper]</code> directions and <code>(adlibs)</code> are recognised, repeated stanzas become linked choruses.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={'[Verse 1]\nI walked out in the cold [whisper]\nstreetlights humming low\n\n[Chorus]\n…'} autoFocus />
      <div className="row">
        <button className="accent" disabled={!text.trim()} onClick={go}>Parse lyrics</button>
        <span className="dim">or block out a structure first:</span>
        {TEMPLATES.map((t) => <button key={t.id} onClick={() => editSheet((d) => applyTemplate(d as LyricSheet, t))} title={t.parts.map(([n, b]) => `${n} ${b}`).join(' · ')}>{t.name}</button>)}
        {hasSong ? <button onClick={() => seedFromSong('transcript').catch((e) => toast(e.message))} title="lines + blocks from the Whisper transcript of the song">Seed from song transcript</button> : null}
      </div>
    </div>
  );
};


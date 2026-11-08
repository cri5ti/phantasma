// Vertical timeline (time runs down, in beats): ruler, verse blocks, BPM layer, song alignment lane, label tracks
// (channel / mixed) and the energy curve. Content layers are translated imperatively so playback doesn't re-render.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  lineTimes, paintEnergy, paintSpans, reorderBlock, ripple, sheetEnd, sid, sorted, BLOCK_COLORS, LABEL_COLORS, normalize,
} from '../../core/sheet';
import type { LyricSheet, SheetSpan, SheetTrack } from '../../core/types';
import { store, useStore } from '../store';
import { gapAfter, newBlockAt, pasteBlock } from './actions';
import { askText, blockMenu, openMenu, type MenuItem } from './menus';
import { beatToY, shared } from './SheetView';
import { clockOf, editSheet, lx, sheet, useLx, useSheet, ZOOM_MAX, ZOOM_MIN, type Lane } from './state';
import { ruleTh } from '../../core/lyricMetrics';
import type { AudioData } from '../../core/audio';
import { loudness } from './sound';
import { useLLM } from '../StoryPanel';
import { densityColor, runMeaning, useAnalysis, useMeaningBusy, valenceColor } from './analysis';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const W = { link: 26, ruler: 50, wave: 56, blocks: 126, bpm: 46, song: 20, track: 92, energy: 72, add: 30, lane: 16, emotion: 44 };
const LANES: { id: Lane; label: string; head: string; help: string }[] = [
  { id: 'wave', label: 'Sound wave', head: '〰', help: 'the song’s loudness down the timeline (needs the produced song); the energy curve can be set from it in Song ▾' },
  { id: 'density', label: 'Syllable density', head: 'syl', help: 'syllables per second of each line — cool = sparse, hot = dense for the tempo' },
  { id: 'breath', label: 'Breath', head: 'air', help: 'stretches sung without a rest — red when longer than the breath rule allows' },
  { id: 'hooks', label: 'Hook positions', head: 'hook', help: 'where the most recurring phrases are sung' },
  { id: 'emotion', label: 'Emotion (AI)', head: 'emo', help: 'valence (blue … amber) and intensity (width) per line, from the AI meaning analysis — compare it with the energy curve' },
];
/** the blocks column's width follows the splitter between the lyrics and the timeline */
const BLOCKS_W = 'var(--blocks-w, 126px)';
const laneW = (id: Lane) => (id === 'emotion' ? W.emotion : id === 'wave' ? W.wave : W.lane);
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0')}`;

/** drag helper: pointer moves until release */
function drag(e: React.MouseEvent, move: (ev: MouseEvent) => void, up?: (ev: MouseEvent, moved: boolean) => void) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;
  const mv = (ev: MouseEvent) => { if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return; moved = true; move(ev); };
  const u = (ev: MouseEvent) => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', u); document.body.classList.remove('lx-dragging'); up?.(ev, moved); };
  document.body.classList.add('lx-dragging');
  window.addEventListener('mousemove', mv);
  window.addEventListener('mouseup', u);
}

/** edit the sheet from a snapshot taken at drag start (one merged undo step per drag) */
const fromBase = (base: LyricSheet, key: string, fn: (t: LyricSheet) => void) => {
  const t = clone(base);
  fn(t);
  editSheet((d) => { d.blocks = t.blocks; d.tracks = t.tracks; d.tempo = t.tempo; d.tags = t.tags; }, key);
};

export const VTimeline: React.FC = () => {
  const s = useSheet();
  const zoom = useLx((x) => x.zoom);
  const selBlock = useLx((x) => x.selBlock);
  const selSpan = useLx((x) => x.selSpan);
  const selTempo = useLx((x) => x.selTempo);
  const brush = useLx((x) => x.brush);
  const lyrics = useStore((x) => x.project.lyrics);
  const hasSong = useStore((x) => !!x.project.audio);
  const audio = useStore((x) => x.audio);
  const lanes = useLx((x) => x.lanes);
  const an = useAnalysis();
  const meaningBusy = useMeaningBusy();
  const [llm] = useLLM();
  const vpRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLDivElement>(null);
  const [H, setH] = useState(500);
  const [drop, setDrop] = useState<number | null>(null);
  const bpb = s.beatsPerBar;
  const clock = clockOf(s);
  const end = Math.max(sheetEnd(s), 16 * bpb) + 64 * bpb;
  const aligned = useMemo(() => (lyrics?.lines ?? []).filter((l) => l.sheet && l.words.length), [lyrics]);

  useLayoutEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    setH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // imperative: translate layers, draw connectors, place the playhead
  useEffect(() => {
    const upd = () => {
      const st = lx.get();
      const vp = vpRef.current;
      if (!vp) return;
      const ty = H / 2 - st.center * st.zoom;
      vp.querySelectorAll<HTMLElement>('.vt-layer').forEach((n) => { n.style.transform = `translateY(${ty}px)`; });
      // playhead: song time (when playing it) or the click track
      const ph = playRef.current;
      if (ph) {
        const beat = st.click ? st.click.beat : store.state.project.audio ? clockOf(sheet()).beat(store.time) : null;
        ph.style.display = beat === null ? 'none' : 'block';
        if (beat !== null) ph.style.transform = `translateY(${H / 2 + (beat - st.center) * st.zoom}px)`;
      }
      const svg = svgRef.current, L = shared.layout;
      if (!svg || !L) return;
      const k = L.k;
      svg.style.opacity = String(Math.max(0, 1 - k * 1.15));
      if (k > 0.97) { svg.innerHTML = ''; return; }
      const ly0 = beatToY(L, st.center, st.zoom);
      const w = W.link;
      svg.innerHTML = L.blocks.map((b) => {
        const a0 = H / 2 + b.top - ly0, a1 = H / 2 + b.bottom - ly0;
        const t0 = H / 2 + (b.at - st.center) * st.zoom, t1 = H / 2 + (b.end - st.center) * st.zoom;
        if (Math.max(a1, t1) < -50 || Math.min(a0, t0) > H + 50) return '';
        const c = w * 0.55;
        return `<path d="M0 ${a0} C${c} ${a0} ${w - c} ${t0} ${w} ${t0} L${w} ${t1} C${w - c} ${t1} ${c} ${a1} 0 ${a1} Z" fill="${b.color}" fill-opacity="0.16" stroke="${b.color}" stroke-opacity="0.5" stroke-width="1"/>`;
      }).join('');
    };
    upd();
    const a = lx.subscribe(upd), b = store.subscribeTime(upd), c = () => upd();
    shared.listeners.add(c);
    return () => { a(); b(); shared.listeners.delete(c); };
  }, [H, zoom, s]);

  const beatAt = (clientY: number) => {
    const r = vpRef.current!.getBoundingClientRect();
    const st = lx.get();
    return st.center + (clientY - r.top - H / 2) / st.zoom;
  };
  const snap = (b: number, ev: { altKey: boolean; shiftKey: boolean }, unit = bpb) => (ev.altKey ? Math.round(b * 100) / 100 : ev.shiftKey ? Math.round(b) : Math.round(b / unit) * unit);

  const onWheel = (e: React.WheelEvent) => {
    const st = lx.get();
    if (e.ctrlKey || e.metaKey) {
      const r = vpRef.current!.getBoundingClientRect();
      const cy = e.clientY - r.top;
      const under = st.center + (cy - H / 2) / st.zoom;
      const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, st.zoom * Math.exp(-e.deltaY * 0.004)));
      lx.set({ zoom: z, center: Math.max(-8, under - (cy - H / 2) / z), driver: 'timeline' });
    } else lx.set({ center: Math.max(-8, Math.min(end, st.center + e.deltaY / st.zoom)), driver: 'timeline' });
  };

  // ---- blocks -------------------------------------------------------------------------------------

  const blockDown = (e: React.MouseEvent, id: string, part: 'body' | 'end' | 'grip') => {
    if (e.button !== 0) return;
    const base = clone(sheet());
    const b0 = base.blocks.find((x) => x.id === id)!;
    const order = sorted(base);
    const i = order.findIndex((x) => x.id === id);
    const prevEnd = i > 0 ? order[i - 1].at + order[i - 1].len : 0;
    const next = order[i + 1];
    const start = beatAt(e.clientY);
    lx.set({ selBlock: id, selSpan: null, selTempo: null });
    if (part === 'grip') {
      let idx: number | undefined;
      drag(e, (ev) => {
        const bt = beatAt(ev.clientY);
        const others = order.filter((x) => x.id !== id);
        idx = others.filter((x) => x.at + x.len / 2 < bt).length;
        const last = others[others.length - 1];
        setDrop(idx < others.length ? others[idx].at : last ? last.at + last.len : 0);
      }, (_ev, moved) => {
        setDrop(null);
        const to = idx;
        if (moved && to !== undefined) editSheet((d) => reorderBlock(d as LyricSheet, id, to));
      });
      return;
    }
    drag(e, (ev) => {
      const d = snap(beatAt(ev.clientY) - start, ev);
      fromBase(base, `blk-${part}-${id}`, (t) => {
        const b = t.blocks.find((x) => x.id === id)!;
        if (part === 'body') {
          if (ev.altKey) b.at = Math.max(prevEnd, Math.min(next ? next.at - b0.len : Infinity, b0.at + d));
          else { const dd = Math.max(prevEnd - b0.at, d); ripple(t, b0.at, dd); }
        } else {
          const nl = Math.max(1, b0.len + d);
          if (ev.altKey) b.len = Math.min(nl, next ? next.at - b0.at : Infinity);
          else { ripple(t, b0.at + b0.len, nl - b0.len, id); b.len = nl; }
        }
        normalize(t);
      });
    });
  };

  const dividerDown = (e: React.MouseEvent, blockId: string, idx: number) => {
    if (e.button !== 0) return;
    const base = clone(sheet());
    const b0 = base.blocks.find((x) => x.id === blockId)!;
    const times = lineTimes(b0);
    const a = times[idx - 1], b = times[idx];
    const start = beatAt(e.clientY);
    drag(e, (ev) => {
      const d = snap(beatAt(ev.clientY) - start, ev, 1);
      const la = Math.max(0.5, Math.min(a.len + b.len - 0.5, a.len + d));
      fromBase(base, `div-${blockId}-${idx}`, (t) => {
        const blk = t.blocks.find((x) => x.id === blockId)!;
        blk.lines[idx - 1].beats = +la.toFixed(2);
        blk.lines[idx].beats = +(a.len + b.len - la).toFixed(2);
        if (blk.link) t.blocks.forEach((x) => { if (x.link === blk.link && x !== blk) x.lines = clone(blk.lines); });
      });
    });
  };

  const blocksBgDown = (e: React.MouseEvent) => {
    if (e.button === 2) return;
    lx.set({ selBlock: null, selSpan: null, selTempo: null, wsel: null });
  };
  const blocksCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    const bt = snap(beatAt(e.clientY), e);
    const before = sorted(sheet()).filter((x) => x.at + x.len <= bt + 1e-6).pop();
    openMenu(e.clientX, e.clientY, [
      { head: `bar ${Math.floor(bt / bpb) + 1}` },
      { label: 'New block here', hint: 'dbl-click', on: () => newBlockAt(bt) },
      { label: 'New chorus here', on: () => newBlockAt(bt, 'chorus', 8) },
      { label: 'Paste here', on: () => pasteBlock(before?.id ?? null, false) },
      { label: 'Paste linked here', on: () => pasteBlock(before?.id ?? null, true) },
      '-',
      ...[1, 2, 4].map((n) => ({ label: `Insert ${n} bar${n > 1 ? 's' : ''} here`, on: () => editSheet((d) => ripple(d as LyricSheet, bt, n * bpb)) })),
      ...(before ? [{ label: `Remove pause after ${before.name}`, on: () => gapAfter(before.id, -999) }] : []),
    ]);
  };

  // ---- tempo spans ----------------------------------------------------------------------------------

  const tempoDown = (e: React.MouseEvent, id: string | null, part: 'body' | 'start' | 'end') => {
    if (e.button !== 0) return;
    const base = clone(sheet());
    const start = beatAt(e.clientY);
    if (!id) {
      // draw a new span
      const a = snap(start, e);
      const nid = sid('tp');
      lx.set({ selTempo: nid, selBlock: null, selSpan: null });
      drag(e, (ev) => {
        const b = snap(beatAt(ev.clientY), ev);
        fromBase(base, `tp-new-${nid}`, (t) => {
          const lo = Math.min(a, b), hi = Math.max(a, b);
          t.tempo = t.tempo.filter((x) => x.at + x.len <= lo || x.at >= hi);
          if (hi - lo >= 1) t.tempo.push({ id: nid, at: lo, len: hi - lo, bpm: base.bpm });
        });
      }, (ev, moved) => {
        if (!moved) { lx.set({ selTempo: null }); return; }
        const sp = sheet().tempo.find((x) => x.id === nid);
        if (sp) editTempo(ev.clientX, ev.clientY, nid);
      });
      return;
    }
    lx.set({ selTempo: id, selBlock: null, selSpan: null });
    const t0 = base.tempo.find((x) => x.id === id)!;
    drag(e, (ev) => {
      const d = snap(beatAt(ev.clientY) - start, ev);
      fromBase(base, `tp-${part}-${id}`, (t) => {
        const sp = t.tempo.find((x) => x.id === id)!;
        if (part === 'body') sp.at = Math.max(0, t0.at + d);
        else if (part === 'start') { const na = Math.min(t0.at + t0.len - 1, Math.max(0, t0.at + d)); sp.len = t0.at + t0.len - na; sp.at = na; }
        else sp.len = Math.max(1, t0.len + d);
        t.tempo = t.tempo.filter((x) => x === sp || x.at + x.len <= sp.at || x.at >= sp.at + sp.len);
      });
    });
  };
  const editTempo = (x: number, y: number, id: string) => {
    const sp = sheet().tempo.find((q) => q.id === id);
    if (!sp) return;
    askText(x, y, `BPM for bars ${sp.at / bpb + 1}–${(sp.at + sp.len) / bpb + 1}`, String(sp.bpm), (v) => {
      const n = Number(v);
      if (n > 20 && n < 400) editSheet((d) => { const q = d.tempo.find((z) => z.id === id); if (q) q.bpm = +n.toFixed(2); });
    }, { type: 'number', chips: [String(Math.round(s.bpm / 2)), String(Math.round(s.bpm * 0.9)), String(Math.round(s.bpm * 1.1)), String(s.bpm * 2)] });
  };

  // ---- tracks ------------------------------------------------------------------------------------

  const labelOf = (id: string) => s.labels.find((l) => l.id === id);
  const pickLabel = (x: number, y: number, then: (id: string) => void) =>
    openMenu(x, y, [{ head: 'Paint which label?' }, ...s.labels.map((l) => ({ label: l.name, color: l.color, on: () => { lx.set({ brush: l.id }); then(l.id); } })), '-', { label: 'New label…', on: () => newLabel(x, y, then) }]);

  const trackDown = (e: React.MouseEvent, tr: SheetTrack, span: SheetSpan | null, part: 'body' | 'start' | 'end' | 'empty') => {
    if (e.button !== 0) return;
    const base = clone(sheet());
    const start = beatAt(e.clientY);
    const erase = e.altKey;
    const paint = part === 'empty' || e.ctrlKey || e.metaKey || erase;
    if (tr.kind === 'energy') {
      const r = (e.currentTarget as HTMLElement).closest('.vt-col')!.getBoundingClientRect();
      const val = (cx: number) => Math.max(0, Math.min(1, (cx - r.left - 6) / (r.width - 12)));
      let last = { b: Math.round(start), v: val(e.clientX) };
      let pts = base.tracks.find((x) => x.id === tr.id)!.points ?? [];
      if (!erase) pts = paintEnergy(pts, last.b, last.v, last.b, last.v);
      const apply = () => fromBase(base, `en-${tr.id}`, (t) => { t.tracks.find((x) => x.id === tr.id)!.points = pts; });
      apply();
      drag(e, (ev) => {
        const b = Math.round(beatAt(ev.clientY)), v = val(ev.clientX);
        if (erase) { const lo = Math.min(start, b), hi = Math.max(start, b); pts = (base.tracks.find((x) => x.id === tr.id)!.points ?? []).filter((p) => p.at < lo || p.at > hi); }
        else { pts = paintEnergy(pts, last.b, last.v, b, v); last = { b, v }; }
        apply();
      });
      return;
    }
    if (paint) {
      const label = tr.kind === 'channel' ? tr.label! : brush;
      const run = (lab: string, a: number, b: number, ev: { altKey: boolean; shiftKey: boolean }) =>
        fromBase(base, `paint-${tr.id}`, (t) => {
          const x = t.tracks.find((q) => q.id === tr.id)!;
          const lo = snapSpan(t, Math.min(a, b), ev, 'floor'), hi = snapSpan(t, Math.max(a, b), ev, 'ceil');
          x.spans = paintSpans(x.spans, lo, hi, lab, !erase);
        });
      if (!label) {
        // mixed track without a brush: drag the range, then pick the label
        let last = start;
        drag(e, (ev) => { last = beatAt(ev.clientY); }, (ev) => pickLabel(ev.clientX, ev.clientY, (lab) => run(lab, start, last === start ? start + bpb : last, ev)));
        return;
      }
      run(label, start, start + 0.01, e);
      drag(e, (ev) => run(label, start, beatAt(ev.clientY), ev), (ev, moved) => { if (!moved) run(label, start, start + bpb * 0.99, ev); });
      return;
    }
    // move / trim an existing span: lift its labels out, paint them back at the new range
    const sp0 = span!;
    lx.set({ selSpan: { track: tr.id, span: sp0.id }, selBlock: null, selTempo: null });
    drag(e, (ev) => {
      const d = snap(beatAt(ev.clientY) - start, ev);
      fromBase(base, `span-${part}-${sp0.id}`, (t) => {
        const x = t.tracks.find((q) => q.id === tr.id)!;
        let a = sp0.at, b = sp0.at + sp0.len;
        if (part === 'body') { a = Math.max(0, a + d); b = a + sp0.len; }
        else if (part === 'start') a = Math.min(b - 0.25, Math.max(0, a + d));
        else b = Math.max(a + 0.25, b + d);
        let spans = x.spans;
        for (const l of sp0.labels) spans = paintSpans(spans, sp0.at, sp0.at + sp0.len, l, false);
        for (const l of sp0.labels) spans = paintSpans(spans, a, b, l, true);
        x.spans = spans;
        const moved = spans.find((q) => Math.abs(q.at - a) < 1e-6);
        if (moved) lx.set({ selSpan: { track: tr.id, span: moved.id } });
      });
    });
  };

  /** spans snap to bars, or to a block edge within a beat */
  const snapSpan = (t: LyricSheet, b: number, ev: { altKey: boolean; shiftKey: boolean }, dir: 'floor' | 'ceil') => {
    if (ev.shiftKey) return dir === 'floor' ? Math.floor(b) : Math.ceil(b);
    for (const bl of t.blocks) for (const edge of [bl.at, bl.at + bl.len]) if (Math.abs(edge - b) < 1) return edge;
    return (dir === 'floor' ? Math.floor(b / bpb) : Math.ceil(b / bpb)) * bpb;
  };

  const spanCtx = (e: React.MouseEvent, tr: SheetTrack, sp: SheetSpan) => {
    e.preventDefault();
    e.stopPropagation();
    lx.set({ selSpan: { track: tr.id, span: sp.id } });
    const toggle = (lab: string, on: boolean) => editSheet((d) => { const x = d.tracks.find((q) => q.id === tr.id)!; x.spans = paintSpans(x.spans as SheetSpan[], sp.at, sp.at + sp.len, lab, on); });
    openMenu(e.clientX, e.clientY, [
      { head: `bars ${+(sp.at / bpb + 1).toFixed(2)}–${+((sp.at + sp.len) / bpb + 1).toFixed(2)}` },
      ...(tr.kind === 'mixed' ? s.labels.map((l) => ({ label: l.name, checked: sp.labels.includes(l.id), on: () => toggle(l.id, !sp.labels.includes(l.id)) })) : []),
      '-',
      { label: 'Delete span', hint: 'Del', on: () => editSheet((d) => { const x = d.tracks.find((q) => q.id === tr.id)!; x.spans = x.spans.filter((q) => q.id !== sp.id); }) },
    ]);
  };

  const trackMenu = (e: React.MouseEvent, tr: SheetTrack) => {
    e.preventDefault();
    const i = s.tracks.findIndex((x) => x.id === tr.id);
    const next = s.tracks[i + 1];
    const items: MenuItem[] = [
      { head: tr.name },
      { label: 'Rename…', on: () => askText(e.clientX, e.clientY, 'Track name', tr.name, (v) => v.trim() && editSheet((d) => { d.tracks[i].name = v.trim(); })) },
    ];
    if (tr.kind === 'mixed') items.push({ label: 'Split by label → channels', disabled: !tr.spans.length, on: () => editSheet((d) => {
      const used = [...new Set(tr.spans.flatMap((x) => x.labels))];
      const chans: SheetTrack[] = used.map((l) => ({ id: sid('tr'), name: labelOf(l)?.name ?? l, kind: 'channel', label: l, spans: tr.spans.filter((x) => x.labels.includes(l)).reduce<SheetSpan[]>((acc, x) => paintSpans(acc, x.at, x.at + x.len, l, true), []) }));
      d.tracks.splice(i, 1, ...chans);
    }) });
    if (tr.kind === 'channel') {
      items.push({ head: 'Label' }, ...s.labels.map((l) => ({ label: l.name, color: l.color, checked: tr.label === l.id, on: () => editSheet((d) => { const x = d.tracks[i]; const old = x.label!; x.label = l.id; x.spans = x.spans.map((q) => ({ ...q, labels: q.labels.map((z) => (z === old ? l.id : z)) })); }) })));
      if (next && next.kind !== 'energy') items.push({ label: `Merge with ${next.name}`, on: () => editSheet((d) => {
        let spans: SheetSpan[] = [];
        for (const src of [tr, next]) for (const x of src.spans) for (const l of x.labels) spans = paintSpans(spans, x.at, x.at + x.len, l, true);
        d.tracks.splice(i, 2, { id: sid('tr'), name: `${tr.name} + ${next.name}`, kind: 'mixed', spans });
      }) });
    }
    if (tr.kind === 'energy') items.push({ label: 'Clear curve', on: () => editSheet((d) => { d.tracks[i].points = []; }) });
    items.push('-',
      { label: 'Move left', disabled: i === 0, on: () => editSheet((d) => { const [x] = d.tracks.splice(i, 1); d.tracks.splice(i - 1, 0, x); }) },
      { label: 'Move right', disabled: i === s.tracks.length - 1, on: () => editSheet((d) => { const [x] = d.tracks.splice(i, 1); d.tracks.splice(i + 1, 0, x); }) },
      '-', { label: 'Delete track', on: () => editSheet((d) => { d.tracks.splice(i, 1); }) });
    openMenu(e.clientX, e.clientY, items);
  };

  const toggleLane = (id: Lane) => lx.set({ lanes: lanes.includes(id) ? lanes.filter((x) => x !== id) : LANES.map((l) => l.id).filter((x) => x === id || lanes.includes(x)) });
  const laneMenu = (e: React.MouseEvent, id: Lane) => {
    e.preventDefault();
    const l = LANES.find((x) => x.id === id)!;
    openMenu(e.clientX, e.clientY, [
      { head: l.label },
      ...(id === 'emotion' ? [{ label: meaningBusy ? 'Analysing…' : 'Analyse meaning (AI)', disabled: meaningBusy, on: () => runMeaning(llm.provider) }] : []),
      { label: 'Hide lane', on: () => toggleLane(id) },
    ]);
  };
  const addTrackMenu = (e: React.MouseEvent) => openMenu(e.clientX, e.clientY, [
    { head: 'Analysis lanes' },
    ...LANES.map((l) => ({ label: l.label, checked: lanes.includes(l.id), on: () => toggleLane(l.id) })),
    { head: 'Tracks' },
    { label: 'Mixed track (several labels per span)', on: () => editSheet((d) => { d.tracks.push({ id: sid('tr'), name: `Layer ${d.tracks.length + 1}`, kind: 'mixed', spans: [] }); }) },
    { label: 'Energy curve', on: () => editSheet((d) => { d.tracks.push({ id: sid('tr'), name: 'Energy', kind: 'energy', spans: [], points: [] }); }) },
    { head: 'Channel track for…' },
    ...s.labels.map((l) => ({ label: l.name, color: l.color, on: () => editSheet((d) => { d.tracks.push({ id: sid('tr'), name: l.name, kind: 'channel', label: l.id, spans: [] }); }) })),
  ]);

  // ---- render ------------------------------------------------------------------------------------

  const z = zoom;
  const barPx = bpb * z;
  const grid = { height: end * z, backgroundImage: `repeating-linear-gradient(to bottom, var(--lx-bar) 0 1px, transparent 1px ${barPx}px)${z >= 7 ? `, repeating-linear-gradient(to bottom, var(--lx-beat) 0 1px, transparent 1px ${z}px)` : ''}` } as React.CSSProperties;
  const step = [1, 2, 4, 8, 16, 32].find((n) => n * barPx >= 18) ?? 64;
  const nBars = Math.ceil(end / bpb);
  const spanBg = (labels: string[]) => {
    const cs = labels.map((l) => labelOf(l)?.color ?? '#888');
    if (cs.length <= 1) return cs[0] ?? '#888';
    return `linear-gradient(90deg, ${cs.map((c, i) => `${c} ${(i / cs.length) * 100}% ${((i + 1) / cs.length) * 100}%`).join(', ')})`;
  };
  const showSong = hasSong && aligned.length > 0;
  const blockById = new Map(s.blocks.map((b) => [b.id, b]));

  return (
    <div className="vt">
      <Palette />
      <div className="vt-head" ref={headRef}>
        <div style={{ width: W.link }} />
        <div style={{ width: W.ruler }} className="vt-h">bar</div>
        <div style={{ width: BLOCKS_W }} className="vt-h">blocks</div>
        <div style={{ width: W.bpm }} className="vt-h" title={`base ${s.bpm} bpm — drag in the column to change the tempo over a range`}>bpm</div>
        {showSong ? <div style={{ width: W.song }} className="vt-h" title="where the song actually sings each block (aligned)">♪</div> : null}
        {LANES.filter((l) => lanes.includes(l.id)).map((l) => (
          <div key={l.id} style={{ width: laneW(l.id) }} className="vt-h lane" title={`${l.label}: ${l.help} — click for options`} onClick={(e) => laneMenu(e, l.id)} onContextMenu={(e) => laneMenu(e, l.id)}>{l.head}</div>
        ))}
        {s.tracks.map((t) => (
          <div key={t.id} style={{ width: t.kind === 'energy' ? W.energy : W.track }} className={`vt-h trk ${t.kind}`} onClick={(e) => trackMenu(e, t)} onContextMenu={(e) => trackMenu(e, t)} title={`${t.name} (${t.kind}${t.label ? `: ${labelOf(t.label)?.name}` : ''}) — click for options`}>
            {t.kind === 'channel' ? <span className="sw" style={{ background: labelOf(t.label!)?.color }} /> : t.kind === 'energy' ? '∿ ' : '≡ '}{t.name}
          </div>
        ))}
        <div style={{ width: W.add }} className="vt-h add" onClick={addTrackMenu} title="add a track">＋</div>
      </div>
      <div className="vt-vp" ref={vpRef} onWheel={onWheel}>
        <div className="vt-cols">
          <div className="vt-col link" style={{ width: W.link }}><svg ref={svgRef} width={W.link} height={H} /></div>

          <div className="vt-col ruler" style={{ width: W.ruler }} onMouseDown={(e) => {
            const bt = beatAt(e.clientY);
            if (store.state.project.audio) store.seek(clock.sec(bt));
            lx.set({ center: bt, driver: 'timeline' });
          }} title="click: jump here (seeks the song)">
            <div className="vt-layer" style={{ height: end * z }}>
              {Array.from({ length: Math.ceil(nBars / step) }, (_, k) => {
                const i = k * step;
                return <div key={i} className="vt-bar" style={{ top: i * barPx }}><b>{i + 1}</b>{k % 4 === 0 ? <span>{fmt(clock.sec(i * bpb))}</span> : null}</div>;
              })}
            </div>
          </div>

          <div className="vt-col blocks" style={{ width: BLOCKS_W }} onMouseDown={blocksBgDown} onDoubleClick={(e) => newBlockAt(snap(beatAt(e.clientY), e))} onContextMenu={blocksCtx}>
            <div className="vt-layer" style={grid}>
              {sorted(s).map((b, i, arr) => {
                const prev = arr[i - 1];
                const gap = prev ? b.at - (prev.at + prev.len) : b.at;
                const times = lineTimes(b);
                const color = b.color ?? BLOCK_COLORS[b.kind];
                const h = b.len * z;
                return (
                  <React.Fragment key={b.id}>
                    {gap > 0.01 && gap * z > 12 ? <div className="vt-gap" style={{ top: (b.at - gap) * z, height: gap * z }}><span>{+(gap / bpb).toFixed(2)} bar{gap === bpb ? '' : 's'}</span></div> : null}
                    <div className={`vt-block ${selBlock === b.id ? 'sel' : ''} ${b.link ? 'linked' : ''}`} style={{ top: b.at * z, height: h, '--c': color } as React.CSSProperties}
                      onMouseDown={(e) => blockDown(e, b.id, 'body')}
                      onDoubleClick={(e) => { e.stopPropagation(); lx.set({ editing: { block: b.id, caret: 0 }, selBlock: b.id }); }}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); lx.set({ selBlock: b.id }); blockMenu(e.clientX, e.clientY, b.id); }}
                      title={`${b.name} — drag: move (later blocks follow; Alt: only this) · bottom edge: length · ⠿: reorder · dbl-click: edit lyrics`}>
                      <div className="grip" onMouseDown={(e) => blockDown(e, b.id, 'grip')}>⠿</div>
                      {h > 14 ? <div className="nm">{b.name}{b.link ? ' ⛓' : ''}</div> : null}
                      {h > 28 ? <div className="bars">{+(b.len / bpb).toFixed(2)} bars · {fmt(clock.sec(b.at))}</div> : null}
                      {h > b.lines.length * 7 ? times.slice(1).map((t, k) => (
                        <div key={k} className="div" style={{ top: (t.at - b.at) * z }} onMouseDown={(e) => dividerDown(e, b.id, k + 1)} title="drag: give the line above more or less time" />
                      )) : null}
                      <div className="end" onMouseDown={(e) => blockDown(e, b.id, 'end')} />
                    </div>
                  </React.Fragment>
                );
              })}
              {drop !== null ? <div className="vt-drop" style={{ top: drop * z }} /> : null}
            </div>
          </div>

          <div className="vt-col bpm" style={{ width: W.bpm }} onMouseDown={(e) => tempoDown(e, null, 'body')} title="drag: tempo change over a range">
            <div className="vt-layer" style={grid}>
              <div className="vt-basebpm">{s.bpm}</div>
              {s.tempo.map((t) => (
                <div key={t.id} className={`vt-tempo ${selTempo === t.id ? 'sel' : ''}`} style={{ top: t.at * z, height: t.len * z }}
                  onMouseDown={(e) => tempoDown(e, t.id, 'body')} onDoubleClick={(e) => { e.stopPropagation(); editTempo(e.clientX, e.clientY, t.id); }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, [{ label: 'Set BPM…', on: () => editTempo(e.clientX, e.clientY, t.id) }, { label: 'Delete', on: () => editSheet((d) => { d.tempo = d.tempo.filter((q) => q.id !== t.id); }) }]); }}>
                  <div className="h top" onMouseDown={(e) => tempoDown(e, t.id, 'start')} />
                  <span>{t.bpm}</span>
                  <div className="h bot" onMouseDown={(e) => tempoDown(e, t.id, 'end')} />
                </div>
              ))}
            </div>
          </div>

          {showSong ? (
            <div className="vt-col song" style={{ width: W.song }}>
              <div className="vt-layer" style={grid}>
                {aligned.map((l) => {
                  const a = clock.beat(l.words[0].t), e2 = clock.beat(l.words[l.words.length - 1].e);
                  const b = blockById.get(l.sheet!.block);
                  const off = b ? a < b.at - 1 || e2 > b.at + b.len + 1 : true;
                  return <div key={l.id} className={`vt-sung ${off ? 'off' : ''}`} style={{ top: a * z, height: Math.max(2, (e2 - a) * z) }} title={`${l.words.map((w) => w.w).join(' ')}${off ? ' — outside its planned block (Song ▸ Adopt song timing)' : ''}`} />;
                })}
              </div>
            </div>
          ) : null}

          {lanes.includes('wave') ? (
            <div className="vt-col lane" style={{ width: W.wave }}>
              <div className="vt-layer" style={grid}>
                {audio ? <WaveLane audio={audio} z={z} end={end} w={W.wave} tempoKey={`${s.bpm}|${s.offset ?? 0}|${JSON.stringify(s.tempo)}`} /> : <span className="vt-nowave">no song</span>}
              </div>
            </div>
          ) : null}
          {lanes.includes('density') ? (
            <div className="vt-col lane" style={{ width: W.lane }}>
              <div className="vt-layer" style={grid}>
                {an.blocks.flatMap((b) => b.sung).map((m) => (
                  <div key={m.key} className="vt-heat" style={{ top: m.at * z, height: Math.max(1, m.len * z - 1), background: densityColor(m.sps, ruleTh(s, 'dense')) }} title={`${m.t.syl} syllables · ${m.sps.toFixed(1)} syl/s · ${m.density.toFixed(1)} syl/beat\n${m.text}`} />
                ))}
              </div>
            </div>
          ) : null}
          {lanes.includes('breath') ? (
            <div className="vt-col lane" style={{ width: W.lane }}>
              <div className="vt-layer" style={grid}>
                {an.breaths.map((br, i) => (
                  <div key={i} className={`vt-breath ${br.sec > ruleTh(s, 'breath') ? 'over' : ''}`} style={{ top: br.from * z, height: Math.max(2, (br.to - br.from) * z) }} title={`${br.sec.toFixed(1)} s sung without a rest (${br.keys.length} line${br.keys.length > 1 ? 's' : ''})`} />
                ))}
              </div>
            </div>
          ) : null}
          {lanes.includes('hooks') ? (
            <div className="vt-col lane" style={{ width: W.lane }}>
              <div className="vt-layer" style={grid}>
                {an.hooks.slice(0, 3).flatMap((h, i) => h.at.map((p, k) => (
                  <div key={`${i}-${k}`} className={`vt-hook h${i}`} style={{ top: p.beat * z }} title={`${i === 0 ? 'hook' : 'recurring'}: “${h.text}” ×${h.count}`} />
                )))}
              </div>
            </div>
          ) : null}
          {lanes.includes('emotion') ? (
            <div className="vt-col lane" style={{ width: W.emotion }}>
              <div className="vt-layer" style={grid}>
                {an.blocks.some((b) => b.sem) ? an.blocks.flatMap((b) => (b.sem?.lines ?? []).map((sl) => {
                  const m = b.lines[sl.i];
                  if (!m) return null;
                  const w = 4 + Math.max(0, Math.min(1, sl.intensity)) * (W.emotion - 10);
                  return <div key={`${b.id}-${sl.i}`} className="vt-emo" style={{ top: m.at * z, height: Math.max(2, m.len * z - 1), width: w, left: (W.emotion - w) / 2, background: valenceColor(sl.valence) }} title={`${b.sem!.emotions.join(', ')} · valence ${sl.valence.toFixed(2)} · intensity ${sl.intensity.toFixed(2)}\n${m.text}`} />;
                })) : null}
              </div>
              {!an.blocks.some((b) => b.sem) ? <button className="vt-analyse" disabled={meaningBusy} onClick={() => runMeaning(llm.provider)} title="AI meaning analysis: emotion, imagery, narrative, clichés (cached per block)">{meaningBusy ? '…' : 'analyse'}</button> : null}
            </div>
          ) : null}

          {s.tracks.map((t) => (
            <div key={t.id} className={`vt-col trk ${t.kind}`} style={{ width: t.kind === 'energy' ? W.energy : W.track }} onMouseDown={(e) => trackDown(e, t, null, 'empty')}
              title={t.kind === 'energy' ? 'drag: draw the energy curve (left = low, right = high) · Alt+drag: erase' : `drag: paint ${t.kind === 'channel' ? labelOf(t.label!)?.name : brush ? labelOf(brush)?.name : 'a label'} · Alt+drag: erase · Ctrl+drag over spans: paint over them`}>
              <div className="vt-layer" style={grid}>
                {t.kind === 'energy' ? <EnergyCurve t={t} z={z} w={W.energy} /> : t.spans.map((sp) => {
                  const sel = selSpan?.span === sp.id;
                  const h = sp.len * z;
                  return (
                    <div key={sp.id} className={`vt-span ${sel ? 'sel' : ''}`} style={{ top: sp.at * z, height: h, background: spanBg(sp.labels) }}
                      onMouseDown={(e) => trackDown(e, t, sp, 'body')} onContextMenu={(e) => spanCtx(e, t, sp)}
                      title={`${sp.labels.map((l) => labelOf(l)?.name).join(' + ')} · bars ${+(sp.at / bpb + 1).toFixed(2)}–${+((sp.at + sp.len) / bpb + 1).toFixed(2)} — drag: move · edges: trim · right-click: labels`}>
                      <div className="h top" onMouseDown={(e) => trackDown(e, t, sp, 'start')} />
                      {h > 13 ? <span>{sp.labels.map((l) => labelOf(l)?.name).join(' + ')}</span> : null}
                      <div className="h bot" onMouseDown={(e) => trackDown(e, t, sp, 'end')} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="vt-col pad" style={{ width: W.add }} />
        </div>
        <div className="vt-center" />
        <div className="vt-play" ref={playRef} />
      </div>
    </div>
  );
};

const WaveLane: React.FC<{ audio: AudioData; z: number; end: number; w: number; tempoKey: string }> = ({ audio, z, end, w, tempoKey }) => {
  const d = useMemo(() => {
    const last = Math.min(end, clockOf(sheet()).beat(audio.duration));
    const step = Math.max(0.125, 2 / z);
    const v = loudness(audio, 0, last, step, 'peak');
    const mid = w / 2, amp = mid - 2;
    const pts = v.map((x, i) => [i * step * z, x * amp] as const);
    if (!pts.length) return '';
    return `M${mid} 0 ` + pts.map(([y, a]) => `L${(mid + a).toFixed(1)} ${y.toFixed(1)}`).join(' ') + ` L${mid} ${(last * z).toFixed(1)} ` + [...pts].reverse().map(([y, a]) => `L${(mid - a).toFixed(1)} ${y.toFixed(1)}`).join(' ') + ' Z';
  }, [audio, z, end, w, tempoKey]);
  return <svg className="vt-wave" width={w} height={end * z}><path d={d} /></svg>;
};

const EnergyCurve: React.FC<{ t: SheetTrack; z: number; w: number }> = ({ t, z, w }) => {
  const pts = t.points ?? [];
  if (!pts.length) return <div className="vt-empty">drag to draw</div>;
  const x = (v: number) => 6 + v * (w - 12);
  const last = pts[pts.length - 1];
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.v).toFixed(1)} ${(p.at * z).toFixed(1)}`).join(' ');
  return (
    <svg className="vt-energy" width={w} height={last.at * z + 2} style={{ top: 0 }}>
      <path d={`M6 ${pts[0].at * z} ${d.replace(/^M/, 'L')} L6 ${last.at * z} Z`} className="fill" />
      <path d={d} className="line" />
    </svg>
  );
};

function newLabel(x: number, y: number, then?: (id: string) => void) {
  askText(x, y, 'New label', '', (v) => {
    const name = v.trim();
    if (!name) return;
    const id = sid('lb');
    editSheet((d) => { d.labels.push({ id, name, color: LABEL_COLORS[d.labels.length % LABEL_COLORS.length] }); });
    lx.set({ brush: id });
    then?.(id);
  }, { placeholder: 'e.g. female, intense piano, 808s' });
}

/** rename / colour / delete a label */
function labelMenu(x: number, y: number, id: string) {
  const s = sheet();
  const l = s.labels.find((q) => q.id === id);
  if (!l) return;
  const used = s.tracks.some((t) => t.label === id || t.spans.some((sp) => sp.labels.includes(id)));
  openMenu(x, y, [
    { head: l.name },
    { label: 'Rename…', on: () => askText(x, y, 'Label name', l.name, (v) => v.trim() && editSheet((d) => { d.labels.find((q) => q.id === id)!.name = v.trim(); })) },
    { head: 'Colour' },
    ...LABEL_COLORS.map((c) => ({ label: c, color: c, checked: l.color === c, on: () => editSheet((d) => { d.labels.find((q) => q.id === id)!.color = c; }) })),
    '-',
    { label: used ? 'Delete (removes it from all tracks)' : 'Delete', on: () => editSheet((d) => {
      d.labels = d.labels.filter((q) => q.id !== id);
      d.tracks = d.tracks.filter((t) => t.label !== id);
      d.tracks.forEach((t) => { t.spans = t.spans.map((sp) => ({ ...sp, labels: sp.labels.filter((q) => q !== id) })).filter((sp) => sp.labels.length); });
      if (lx.get().brush === id) lx.set({ brush: null });
    }) },
  ]);
}

/** brush dropdown: the label painted on mixed tracks, plus label management */
const Palette: React.FC = () => {
  const s = useSheet();
  const brush = useLx((x) => x.brush);
  const cur = s.labels.find((l) => l.id === brush);
  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = r.left, y = r.bottom + 2;
    openMenu(x, y, [
      { head: 'Paint label' },
      { label: 'none', checked: !brush, on: () => lx.set({ brush: null }) },
      ...s.labels.map((l) => ({ label: l.name, color: l.color, hint: brush === l.id ? '✓' : undefined, on: () => lx.set({ brush: l.id }) })),
      '-',
      { label: 'New label…', on: () => newLabel(x, y) },
      { label: 'Edit labels…', disabled: !s.labels.length, on: () => openMenu(x, y, [{ head: 'Edit which label?' }, ...s.labels.map((l) => ({ label: l.name, color: l.color, on: () => labelMenu(x, y, l.id) }))]) },
    ]);
  };
  return (
    <div className="vt-palette">
      <span className="dim">paint</span>
      <button className="brush" onClick={open} onContextMenu={(e) => { e.preventDefault(); if (cur) labelMenu(e.clientX, e.clientY, cur.id); }}
        title="label painted when you drag down a mixed track — right-click to edit it">
        {cur ? <><span className="sw" style={{ background: cur.color }} />{cur.name}</> : <span className="dim">pick a label</span>} ▾
      </button>
      {cur ? <button className="clr" onClick={() => lx.set({ brush: null })} title="clear the brush">✕</button> : null}
    </div>
  );
};

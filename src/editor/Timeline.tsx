import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { allKeyTimes, isAnimated, shiftKeys } from '../core/params';
import { pickOf } from '../core/storyboard';
import type { Tempo } from '../core/tempo';
import type { Cue, Group, Layer, LyricLine, MediaItem, ParamMap, Shot } from '../core/types';
import { getGen } from '../gen/registry';
import { AddMenu } from './AddMenu';
import { applyToShot } from './Board';
import { addCue, moveCue, removeCue, renameCue } from './lyricsActions';
import { editGroup, groupLayers, groupOf, groupSpan, selectedLayerIds, setMembersEnabled, shiftGroup, ungroup } from './groups';
import { VResize } from './Resizer';
import { refThumb } from './StoryPanel';
import { fmtTime, store, useStore, useTempo } from './store';

/** Seconds of real footage a video layer has on the timeline (clip length after the in-point, at its speed); null when unknown or not a video. */
function footageLen(l: Layer, media: MediaItem[]): number | null {
  if (l.kind !== 'video' || !l.media) return null;
  const it = media.find((m) => m.id === l.media);
  if (!it || !(it.duration > 0)) return null;
  const off = typeof l.params.offset === 'number' ? l.params.offset : 0;
  const sp = typeof l.params.speed === 'number' ? Math.max(0.05, l.params.speed) : 1;
  return Math.max(0.05, (it.duration - off) / sp);
}
const loops = (l: Layer) => l.params.loop !== false;

const HEAD_W = 210;
const RULER_H = 22;
const TEMPO_H = 26;
const WAVE_H = 46;
const TOP_H = RULER_H + TEMPO_H + WAVE_H;
const ROW_H = 30;
const STORY_H = 56;
const LYR_LINE_H = 24;
const LYR_WORD_H = 26;
const CUE_COLOR = '#4dd4ff';
const NO_CUES: Cue[] = [];
const NO_GROUPS: Group[] = [];

const KIND_COLORS: Record<string, string> = { video: '#3b6ea8', image: '#3b8a8a', visualizer: '#8a4fd0', shader: '#c0508a', shape: '#7a7a3a', text: '#b07a2a', fill: '#555', particles: '#2f8a6a' };

function layerColor(l: Layer) {
  if (l.color) return l.color;
  if (l.kind !== 'gen') return KIND_COLORS[l.kind];
  return KIND_COLORS[getGen(l.gen)?.category ?? 'fill'];
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

let tempoRef: Tempo | null = null;

/** Collect snap targets (in seconds). */
function snapTargets(exclude?: string | Set<string>): number[] {
  const ex = typeof exclude === 'string' ? new Set([exclude]) : exclude ?? new Set<string>();
  const s = store.state;
  const tempo = tempoRef;
  const pts: number[] = [store.time, 0, s.project.duration];
  s.project.tempo.forEach((x) => pts.push(x.start, x.end));
  s.project.markers.forEach((m) => pts.push(m.t));
  s.project.cues?.forEach((c) => pts.push(c.t));
  s.project.layers.forEach((l) => !ex.has(l.id) && pts.push(l.start, l.end));
  if (tempo) {
    const W = 3000 / s.zoom;
    tempo.beatsBetween(s.scroll - 5, s.scroll + W).forEach((b) => pts.push(b.t));
  }
  return pts;
}

function snap(t: number, exclude?: string | Set<string>, alt = false): number {
  const s = store.state;
  if (!s.snap || alt) return t;
  const thr = 8 / s.zoom;
  let best = t, bd = thr;
  for (const p of snapTargets(exclude)) {
    const d = Math.abs(p - t);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function shiftLayerKeys(l: { params: ParamMap; masks: { params: ParamMap }[] }, dt: number) {
  l.params = shiftKeys(l.params, dt);
  l.masks.forEach((m) => (m.params = shiftKeys(m.params, dt)));
}

export const Timeline: React.FC = () => {
  const project = useStore((s) => s.project);
  const zoom = useStore((s) => s.zoom);
  const scroll = useStore((s) => s.scroll);
  const audio = useStore((s) => s.audio);
  const sel = useStore((s) => s.sel);
  const inP = useStore((s) => s.inPoint);
  const outP = useStore((s) => s.outPoint);
  const snapOn = useStore((s) => s.snap);
  const loopOn = useStore((s) => s.loop);
  const shots = useStore((s) => s.project.storyboard?.shots);
  const localMedia = useStore((s) => s.media);
  // layers whose media isn't local stream from a CDN (storyboard picks not downloaded yet)
  const streamedIds = useMemo(() => {
    const have = new Set(localMedia.map((m) => m.id));
    return new Set(project.layers.flatMap((l) => (l.media && !have.has(l.media) ? [l.media] : [])));
  }, [project.layers, localMedia]);
  const mode = useStore((s) => s.mode);
  const tempo = useTempo();
  tempoRef = tempo;

  const mainRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const playheadRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const [width, setWidth] = useState(800);
  const groups = project.groups ?? NO_GROUPS;
  const focusGroup = useStore((s) => s.focusGroup);
  const focus = groups.find((g) => g.id === focusGroup);
  const groupRows = groups.length ? Math.max(...groups.map((g) => g.row ?? 0)) + 1 : 0;
  const memberOf = useMemo(() => new Map(groups.flatMap((g) => g.layerIds.map((id) => [id, g] as const))), [groups]);
  // focus = only that group's layers; otherwise collapsed groups hide their members
  const layersTopDown = useMemo(
    () => [...project.layers].reverse().filter((l) => (focus ? focus.layerIds.includes(l.id) : !memberOf.get(l.id)?.collapsed)),
    [project.layers, focus, memberOf],
  );
  const GTOP = groupRows * ROW_H;
  const lanesH = Math.max(GTOP + layersTopDown.length * ROW_H, 120);
  const isSelLayer = (id: string) => sel.layerId === id || !!sel.layerIds?.includes(id);

  useLayoutEffect(() => {
    const el = mainRef.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const X = (t: number) => (t - scroll) * zoom;
  const T = (x: number) => x / zoom + scroll;

  // ---- top canvas: ruler, tempo sections, waveform ---------------------------------
  useEffect(() => {
    const c = topRef.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = TOP_H * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, TOP_H);
    const fg = cssVar('--fg-dim');
    const t0 = scroll, t1 = T(width);

    // ruler ticks
    ctx.fillStyle = cssVar('--bg-2');
    ctx.fillRect(0, 0, width, RULER_H);
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const major = steps.find((s) => s * zoom >= 70) ?? 60;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = fg;
    ctx.strokeStyle = fg;
    for (let t = Math.floor(t0 / major) * major; t <= t1; t += major) {
      const x = Math.round(X(t)) + 0.5;
      ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 8); ctx.lineTo(x, RULER_H); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(fmtTime(t).replace(/\.00$/, ''), x + 3, 11);
    }
    if (inP !== null || outP !== null) {
      const a = X(inP ?? 0), b = X(outP ?? project.duration);
      ctx.fillStyle = loopOn ? 'rgba(255,176,59,0.32)' : 'rgba(255,200,60,0.18)';
      ctx.fillRect(a, 0, b - a, RULER_H);
      // draggable A / B flags
      ctx.font = 'bold 9px system-ui, sans-serif';
      ([['A', inP], ['B', outP]] as const).forEach(([lbl, v]) => {
        if (v === null) return;
        const x = Math.round(X(v)) + 0.5;
        if (x < -20 || x > width + 20) return;
        ctx.fillStyle = '#ffb03b';
        ctx.fillRect(x - 0.5, 0, 1.5, RULER_H);
        const w = 12;
        ctx.fillRect(lbl === 'A' ? x : x - w, RULER_H - 11, w, 11);
        ctx.fillStyle = '#111';
        ctx.fillText(lbl, lbl === 'A' ? x + 3 : x - w + 3, RULER_H - 2);
      });
      ctx.font = '10px ui-monospace, monospace';
    }
    // markers
    project.markers.forEach((m) => {
      const x = X(m.t);
      if (x < -50 || x > width) return;
      ctx.fillStyle = '#ffcf40';
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x - 5, RULER_H - 7); ctx.lineTo(x + 5, RULER_H - 7); ctx.fill();
      ctx.fillText(m.label, x + 6, RULER_H - 2);
    });

    // cues: cyan flags hanging from the top of the ruler
    (project.cues ?? []).forEach((c) => {
      const x = Math.round(X(c.t)) + 0.5;
      if (x < -60 || x > width + 4) return;
      ctx.fillStyle = CUE_COLOR;
      ctx.fillRect(x - 0.5, 0, 1, RULER_H);
      ctx.beginPath(); ctx.moveTo(x, 9); ctx.lineTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.fill();
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(c.label, x + 5, 9);
    });

    // tempo sections
    const ty = RULER_H;
    project.tempo.forEach((s, i) => {
      const a = X(s.start), b = X(s.end);
      if (b < 0 || a > width) return;
      ctx.fillStyle = s.color ?? '#5b8cff';
      ctx.globalAlpha = sel.section === i ? 0.75 : 0.4;
      ctx.fillRect(a, ty + 1, b - a - 1, TEMPO_H - 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.font = '11px system-ui, sans-serif';
      ctx.save();
      ctx.beginPath(); ctx.rect(a, ty, b - a - 2, TEMPO_H); ctx.clip();
      ctx.fillText(`${s.label}  ${s.bpm.toFixed(1)}`, Math.max(a, 0) + 4, ty + 17);
      ctx.restore();
    });
    if (!project.tempo.length) {
      ctx.fillStyle = fg;
      ctx.font = '11px system-ui';
      ctx.fillText('no tempo map — using detected beats (Seed from analysis in the toolbar)', 6, ty + 17);
    }

    // waveform (rms) + bass overlay
    const wy = RULER_H + TEMPO_H;
    ctx.fillStyle = cssVar('--bg-1');
    ctx.fillRect(0, wy, width, WAVE_H);
    if (audio) {
      const mid = wy + WAVE_H / 2;
      for (const [name, color, scale] of [['rms', cssVar('--wave'), 1], ['bass', cssVar('--wave-bass'), 0.6]] as const) {
        ctx.fillStyle = color;
        for (let x = 0; x < width; x++) {
          const ta = T(x), tb = T(x + 1);
          if (ta < 0 || ta > audio.duration) continue;
          let v = 0;
          for (let f = Math.floor(ta * audio.rate); f <= Math.ceil(tb * audio.rate); f++) v = Math.max(v, audio.scalarAtFrame(name, f));
          const h = v * (WAVE_H / 2 - 2) * scale;
          ctx.fillRect(x, mid - h, 1, h * 2);
        }
      }
    }
  }, [width, zoom, scroll, project.tempo, project.markers, project.cues, project.duration, audio, sel.section, inP, outP, loopOn]);

  // ---- lanes background: beat grid ---------------------------------------------
  useEffect(() => {
    const c = gridRef.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = lanesH * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, lanesH);
    const beats = tempo.beatsBetween(scroll, T(width));
    const showBeats = beats.length < width / 4;
    const grid = cssVar('--grid');
    let lastX = -1e9;
    for (const b of beats) {
      if (!b.bar && !showBeats) continue;
      const x = Math.round(X(b.t)) + 0.5;
      if (x - lastX < 9) continue; // keep the grid readable when zoomed out
      lastX = x;
      ctx.strokeStyle = grid;
      ctx.globalAlpha = b.bar ? 0.9 : 0.35;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, lanesH); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    project.tempo.forEach((s) => {
      const x = Math.round(X(s.start)) + 0.5;
      ctx.strokeStyle = s.color ?? '#5b8cff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, lanesH); ctx.stroke();
      ctx.lineWidth = 1;
    });
    if (GTOP) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(0, 0, width, GTOP);
    }
    for (let i = 1; i <= groupRows + layersTopDown.length; i++) {
      ctx.fillStyle = cssVar('--line');
      ctx.fillRect(0, i * ROW_H - 1, width, i === groupRows ? 2 : 1);
    }
    if (inP !== null || outP !== null) {
      const a = X(inP ?? 0), b = X(outP ?? project.duration);
      ctx.fillStyle = loopOn ? 'rgba(255,176,59,0.07)' : 'rgba(255,200,60,0.035)';
      ctx.fillRect(a, 0, b - a, lanesH);
      ctx.fillStyle = 'rgba(255,176,59,0.6)';
      if (inP !== null) ctx.fillRect(Math.round(a), 0, 1, lanesH);
      if (outP !== null) ctx.fillRect(Math.round(b), 0, 1, lanesH);
    }
    ctx.strokeStyle = CUE_COLOR;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([3, 3]);
    (project.cues ?? []).forEach((c) => {
      const x = Math.round(X(c.t)) + 0.5;
      if (x < 0 || x > width) return;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, lanesH); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }, [width, zoom, scroll, tempo, lanesH, layersTopDown.length, groupRows, project.tempo, project.cues, inP, outP, loopOn, project.duration]);

  // ---- focus a group: zoom to it (and back when leaving) -----------------------------
  const preFocus = useRef<{ zoom: number; scroll: number } | null>(null);
  useEffect(() => {
    const st = store.state;
    if (focus) {
      const sp = groupSpan(project, focus);
      if (!sp) return;
      if (!preFocus.current) preFocus.current = { zoom: st.zoom, scroll: st.scroll };
      const z = Math.max(1, Math.min(600, (width - 80) / Math.max(0.5, sp.b - sp.a)));
      store.set({ zoom: z, scroll: Math.max(0, sp.a - 40 / z) });
      if (store.time < sp.a || store.time >= sp.b) store.seek(sp.a);
    } else if (preFocus.current) {
      store.set(preFocus.current);
      preFocus.current = null;
    }
  }, [focusGroup]);

  // ---- playhead (imperative, no re-render) ----------------------------------------
  useEffect(() => {
    const upd = () => {
      const s = store.state;
      const x = (store.time - s.scroll) * s.zoom;
      playheadRefs.forEach((r) => { if (r.current) r.current.style.transform = `translateX(${x}px)`; });
      // follow during playback
      if (s.playing && (x > width - 40 || x < 0)) store.set({ scroll: Math.max(0, store.time - 20 / s.zoom) });
    };
    upd();
    return store.subscribeTime(upd);
  }, [zoom, scroll, width]);

  // ---- wheel: zoom / scroll ---------------------------------------------------------
  useEffect(() => {
    const el = mainRef.current!.parentElement!.parentElement!;
    const onWheel = (e: WheelEvent) => {
      const s = store.state;
      const rect = mainRef.current!.getBoundingClientRect();
      if (e.clientX < rect.left) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const mx = e.clientX - rect.left;
        const tm = mx / s.zoom + s.scroll;
        const z = Math.max(1, Math.min(600, s.zoom * Math.exp(-e.deltaY * 0.0015)));
        store.set({ zoom: z, scroll: Math.max(0, tm - mx / z) });
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.clientY - rect.top < TOP_H || (e.target as HTMLElement).closest?.('.tl-story, .tl-lyrics')) {
        e.preventDefault();
        const d = (e.deltaX || e.deltaY) / s.zoom;
        store.set({ scroll: Math.max(0, Math.min(s.project.duration - 2, s.scroll + d)) });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- top interactions ---------------------------------------------------------------
  const onTopDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const rect = topRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const t = T(x);
    const inTempo = y >= RULER_H && y < RULER_H + TEMPO_H;
    const abHit = y < RULER_H ? ((inP !== null && Math.abs(X(inP) - x) < 6) ? 'inPoint' : (outP !== null && Math.abs(X(outP) - x) < 6) ? 'outPoint' : null) : null;
    if (abHit && e.button === 0) {
      let which: 'inPoint' | 'outPoint' = abHit;
      const move = (ev: MouseEvent) => {
        const nt = +Math.max(0, Math.min(project.duration, snap(T(ev.clientX - rect.left), undefined, ev.altKey))).toFixed(3);
        const s = store.state;
        // dragging A past B (or B past A) swaps them
        const other = which === 'inPoint' ? s.outPoint : s.inPoint;
        if (other !== null && (which === 'inPoint' ? nt > other : nt < other)) which = which === 'inPoint' ? 'outPoint' : 'inPoint';
        store.set({ [which]: nt } as any);
        store.seek(nt);
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
    const cue = y < RULER_H ? (project.cues ?? []).find((c) => Math.abs(X(c.t) - x) < 5) : undefined;
    if (cue && e.button === 0) {
      store.seek(cue.t);
      const move = (ev: MouseEvent) => {
        const nt = Math.max(0, T(ev.clientX - rect.left));
        moveCue(cue.id, ev.shiftKey ? snap(nt, undefined, false) : nt);
        store.seek(ev.shiftKey ? snap(nt, undefined, false) : nt);
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
    if (inTempo && project.tempo.length) {
      // boundary drag?
      const bi = project.tempo.findIndex((s, i) => i > 0 && Math.abs(X(s.start) - x) < 5);
      if (bi > 0) {
        const move = (ev: MouseEvent) => {
          const nt = snap(T(ev.clientX - rect.left), undefined, ev.altKey);
          store.edit((p) => {
            const lo = p.tempo[bi - 1].start + 0.1, hi = p.tempo[bi].end - 0.1;
            const v = +Math.max(lo, Math.min(hi, nt)).toFixed(3);
            p.tempo[bi].start = v;
            p.tempo[bi - 1].end = v;
          }, `tempo-boundary-${bi}`);
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return;
      }
      const i = project.tempo.findIndex((s) => t >= s.start && t < s.end);
      if (i >= 0) store.set({ sel: { section: i } });
      if (e.detail === 2 && i >= 0) {
        store.edit((p) => {
          const cur = p.tempo[i];
          const at = +snap(t).toFixed(3);
          if (at <= cur.start + 0.1 || at >= cur.end - 0.1) return;
          p.tempo.splice(i + 1, 0, { ...cur, start: at, label: `${cur.label}b` });
          cur.end = at;
        });
      }
      return;
    }
    // scrub
    store.seek(snap(t, undefined, e.altKey));
    const move = (ev: MouseEvent) => store.seek(Math.max(0, T(ev.clientX - rect.left)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onTopMove = (e: React.MouseEvent) => {
    const rect = topRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const onCue = y < RULER_H && ((project.cues ?? []).some((c) => Math.abs(X(c.t) - x) < 5) || (inP !== null && Math.abs(X(inP) - x) < 6) || (outP !== null && Math.abs(X(outP) - x) < 6));
    if (onCue) { topRef.current!.style.cursor = 'ew-resize'; return; }
    const onBoundary = y >= RULER_H && y < RULER_H + TEMPO_H && project.tempo.some((s, i) => i > 0 && Math.abs(X(s.start) - x) < 5);
    topRef.current!.style.cursor = onBoundary ? 'col-resize' : y >= RULER_H && y < RULER_H + TEMPO_H ? 'pointer' : 'text';
  };

  // ---- clip drag ----------------------------------------------------------------------
  const onClipDown = (e: React.MouseEvent, l: Layer, mode: 'move' | 'l' | 'r') => {
    e.stopPropagation();
    if (e.button !== 0) return; // right-click opens the menu, never drags
    if (e.ctrlKey || e.metaKey || e.shiftKey) { toggleLayerSel(l.id); return; }
    const multi = selectedLayerIds();
    const together = mode === 'move' && multi.length > 1 && multi.includes(l.id);
    if (!together) store.set({ sel: { layerId: l.id } });
    if (l.locked) return;
    const sx = e.clientX;
    const orig = { start: l.start, end: l.end };
    let lastDt = 0;
    if (together) {
      // several selected clips move as one (snapping on the grabbed clip, keys follow)
      const ids = new Set(multi);
      const minStart = Math.min(...project.layers.filter((x) => ids.has(x.id)).map((x) => x.start));
      const move = (ev: MouseEvent) => {
        let dt = (ev.clientX - sx) / zoom;
        dt = snap(orig.start + dt, ids, ev.altKey) - orig.start;
        dt = Math.max(-minStart, dt);
        const shift = dt - lastDt;
        lastDt = dt;
        store.edit((p) => p.layers.forEach((x) => {
          if (!ids.has(x.id) || x.locked) return;
          x.start = +(x.start + shift).toFixed(4);
          x.end = +(x.end + shift).toFixed(4);
          shiftLayerKeys(x as any, shift);
        }), `move-multi-${multi.join(',').slice(0, 60)}`);
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
    const move = (ev: MouseEvent) => {
      let dt = (ev.clientX - sx) / zoom;
      if (mode === 'move') {
        let ns = snap(orig.start + dt, l.id, ev.altKey);
        const ne = snap(orig.end + dt, l.id, ev.altKey);
        if (ne !== orig.end + dt && ns === orig.start + dt) ns = ne - (orig.end - orig.start);
        dt = Math.max(-orig.start, ns - orig.start);
        const shift = dt - lastDt;
        lastDt = dt;
        store.edit((p) => {
          const x = p.layers.find((y) => y.id === l.id)!;
          x.start = +(orig.start + dt).toFixed(4);
          x.end = +(orig.end + dt).toFixed(4);
          shiftLayerKeys(x as any, shift);
        }, `move-${l.id}`);
      } else {
        store.edit((p) => {
          const x = p.layers.find((y) => y.id === l.id)!;
          const cap = loops(x) ? null : footageLen(x, store.state.media); // no loop: the layer can't outgrow its footage
          if (mode === 'l') x.start = +Math.max(0, cap !== null ? orig.end - cap : 0, Math.min(orig.end - 0.05, snap(orig.start + dt, l.id, ev.altKey))).toFixed(4);
          else x.end = +Math.min(cap !== null ? orig.start + cap : Infinity, Math.max(orig.start + 0.05, snap(orig.end + dt, l.id, ev.altKey))).toFixed(4);
        }, `trim-${l.id}`);
      }
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const toggleLayerSel = (id: string) => {
    const cur = selectedLayerIds();
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    store.set({ sel: next.length ? { layerId: next[next.length - 1], layerIds: next } : {} });
  };

  // ---- group clips: drag = move members (and keys) in time; vertical = change group row; dbl-click = focus ----
  const onGroupDown = (e: React.MouseEvent, g: Group) => {
    e.stopPropagation();
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    store.set({ sel: { groupId: g.id } });
    if (e.detail === 2) { store.set({ focusGroup: focusGroup === g.id ? null : g.id }); return; }
    const sp = groupSpan(project, g);
    if (!sp) return;
    const sx = e.clientX, sy = e.clientY, row0 = g.row ?? 0;
    const ids = new Set(g.layerIds);
    let lastDt = 0;
    const move = (ev: MouseEvent) => {
      let dt = (ev.clientX - sx) / zoom;
      let ns = snap(sp.a + dt, ids, ev.altKey);
      const ne = snap(sp.b + dt, ids, ev.altKey);
      if (ne !== sp.b + dt && ns === sp.a + dt) ns = ne - (sp.b - sp.a);
      dt = Math.max(-sp.a, ns - sp.a);
      const shift = dt - lastDt;
      lastDt = dt;
      const row = Math.max(0, Math.min(groupRows, row0 + Math.round((ev.clientY - sy) / ROW_H)));
      store.edit((p) => shiftGroup(p, g.id, shift, row), `group-move-${g.id}`);
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onKeyDown = (e: React.MouseEvent, l: Layer, kt: number) => {
    e.stopPropagation();
    store.seek(kt);
    const sx = e.clientX;
    let last = kt;
    const move = (ev: MouseEvent) => {
      const nt = +snap(kt + (ev.clientX - sx) / zoom, l.id, ev.altKey).toFixed(4);
      if (nt === last) return;
      const from = last;
      last = nt;
      store.edit((p) => {
        const x = p.layers.find((y) => y.id === l.id)!;
        const moveKeys = (m: ParamMap) => {
          for (const v of Object.values(m)) if (isAnimated(v) && v.$k) {
            v.$k.forEach((k) => { if (Math.abs(k.t - from) < 1e-3) k.t = nt; });
            v.$k.sort((a, b) => a.t - b.t);
          }
        };
        moveKeys(x.params as ParamMap);
        x.masks.forEach((m) => moveKeys(m.params as ParamMap));
      }, `key-${l.id}-${kt}`);
      store.seek(nt);
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onLaneDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const rect = mainRef.current!.getBoundingClientRect();
    store.set({ sel: {} });
    store.seek(snap(T(e.clientX - rect.left), undefined, e.altKey));
  };

  // ---- reorder via heads -----------------------------------------------------------------
  const [dragId, setDragId] = useState<string | null>(null);
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    store.edit((p) => {
      const from = p.layers.findIndex((l) => l.id === dragId);
      const [l] = p.layers.splice(from, 1);
      const to = p.layers.findIndex((x) => x.id === targetId);
      p.layers.splice(to + (from > to ? 1 : 0), 0, l);
    });
    setDragId(null);
  };
  const toggle = (id: string, key: 'enabled' | 'solo' | 'locked') =>
    store.edit((p) => { const l = p.layers.find((x) => x.id === id)!; (l as any)[key] = !l[key]; });

  const visible = (l: Layer) => X(l.end) > 0 && X(l.start) < width;

  // ---- right-click: cues at the exact time under the pointer --------------------------------------
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; t: number; target?: MenuTarget } | null>(null);
  const onContext = (e: React.MouseEvent) => {
    const rect = mainRef.current!.getBoundingClientRect();
    if (e.clientX < rect.left || (e.target as HTMLElement).closest('input, textarea')) return;
    e.preventDefault();
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-layer], [data-group], [data-shot], [data-line]');
    const target: MenuTarget | undefined = el?.dataset.layer ? { kind: 'layer', id: el.dataset.layer } : el?.dataset.group ? { kind: 'group', id: el.dataset.group }
      : el?.dataset.shot ? { kind: 'shot', id: el.dataset.shot } : el?.dataset.line ? { kind: 'line', id: el.dataset.line } : undefined;
    // keep a multi-selection when right-clicking one of its clips
    if (target?.kind === 'layer' && !isSelLayer(target.id)) store.set({ sel: { layerId: target.id } });
    if (target?.kind === 'group') store.set({ sel: { groupId: target.id } });
    setCtxMenu({ x: e.clientX, y: e.clientY, t: Math.max(0, Math.min(project.duration, T(e.clientX - rect.left))), target });
  };

  return (
    <div className="timeline" onContextMenu={onContext}>
      <div className="tl-toolbar">
        <AddMenu />
        <span className="sep" />
        <label className="chk"><input type="checkbox" checked={snapOn} onChange={(e) => store.set({ snap: e.target.checked })} /> snap (Alt = off)</label>
        <button onClick={() => store.set({ zoom: Math.max(1, (width - 20) / project.duration), scroll: 0 })}>fit</button>
        <button onClick={() => store.set({ zoom: zoom * 1.5 })}>＋</button>
        <button onClick={() => store.set({ zoom: Math.max(1, zoom / 1.5) })}>－</button>
        {!project.tempo.length && audio ? (
          <button className="accent" onClick={() => import('../core/project').then(({ tempoFromAnalysis }) => store.edit((p) => { p.tempo = tempoFromAnalysis(audio.meta); }))}>
            Seed tempo map from analysis
          </button>
        ) : null}
        <span className="sep" />
        <button disabled={!sel.layerId && !sel.layerIds?.length} onClick={() => groupLayers(selectedLayerIds())} title="group the selected layers (Ctrl+G) — Ctrl/Shift+click to select several">⧉ Group</button>
        {focus ? (
          <span className="crumb" style={{ borderColor: focus.color }}>
            <button onClick={() => store.set({ focusGroup: null })} title="show all layers (Esc)">◀ All layers</button>
            <span>›</span>
            <b style={{ color: focus.color }}>{focus.name}</b>
            <span className="dim">{focus.layerIds.length} layers · timeline filter only — everything still plays</span>
          </span>
        ) : null}
        <span className="grow" />
        <span className="dim">ctrl+wheel zoom · shift+wheel scroll · dbl-click a group to focus</span>
      </div>
      <div className="tl-top">
        <div className="tl-heads-top" style={{ width: HEAD_W }}>
          <div style={{ height: RULER_H }} />
          <div className="rowlabel" style={{ height: TEMPO_H }}>Tempo map</div>
          <div className="rowlabel" style={{ height: WAVE_H }}>Audio</div>
        </div>
        <div className="tl-canvas-wrap" ref={mainRef}>
          <canvas ref={topRef} style={{ width, height: TOP_H, display: 'block' }} onMouseDown={onTopDown} onMouseMove={onTopMove} />
          <div className="playhead" ref={playheadRefs[0]} style={{ height: TOP_H }} />
        </div>
      </div>
      {shots?.length || mode === 'story' ? <StoryLane shots={shots ?? []} width={width} zoom={zoom} scroll={scroll} selId={sel.shotId} /> : <div />}
      {project.lyrics?.lines.length ? <LyricsLane lines={project.lyrics.lines} width={width} zoom={zoom} scroll={scroll} sel={sel.lyric} /> : <div />}
      {ctxMenu ? <TimelineMenu {...ctxMenu} zoom={zoom} close={() => setCtxMenu(null)} /> : null}
      <div className="tl-scroll">
        <div className="tl-rows" style={{ height: lanesH }}>
          <div className="tl-heads" ref={headRef} style={{ width: HEAD_W }}>
            {Array.from({ length: groupRows }, (_, r) => (
              <div key={`gr${r}`} className="head grouprow" style={{ height: ROW_H }}>
                <span className="lname">▣ Groups{groupRows > 1 ? ` · row ${r + 1}` : ''}</span>
                <span className="lblend">{groups.filter((g) => (g.row ?? 0) === r).length}</span>
              </div>
            ))}
            {layersTopDown.map((l) => (
              <div
                key={l.id}
                className={`head ${isSelLayer(l.id) ? 'sel' : ''} ${l.enabled ? '' : 'off'}`}
                style={{ height: ROW_H, borderLeftColor: layerColor(l) }}
                draggable
                onDragStart={() => setDragId(l.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => dropOn(l.id)}
                onClick={(e) => ((e.ctrlKey || e.metaKey || e.shiftKey) ? toggleLayerSel(l.id) : store.set({ sel: { layerId: l.id } }))}
              >
                <button className={`ico ${l.enabled ? 'on' : ''}`} title="visible" onClick={(e) => { e.stopPropagation(); toggle(l.id, 'enabled'); }}>{l.enabled ? '●' : '○'}</button>
                <button className={`ico ${l.solo ? 'solo' : ''}`} title="solo" onClick={(e) => { e.stopPropagation(); toggle(l.id, 'solo'); }}>S</button>
                {memberOf.get(l.id) ? <span className="gdot" style={{ background: memberOf.get(l.id)!.color }} title={`in group “${memberOf.get(l.id)!.name}”`} /> : null}
                <span className="lname" title={l.name}>{l.name}</span>
                <span className="lblend">{l.blend !== 'normal' ? l.blend : ''}{l.clipBelow ? ' ⤓' : ''}{l.masks.length ? ` ◐${l.masks.length}` : ''}</span>
              </div>
            ))}
          </div>
          <div className="tl-lanes" style={{ width, height: lanesH }} onMouseDown={onLaneDown}>
            <canvas ref={gridRef} style={{ width, height: lanesH, position: 'absolute', left: 0, top: 0 }} />
            {groups.map((g) => {
              const sp = groupSpan(project, g);
              if (!sp || X(sp.b) < 0 || X(sp.a) > width) return null;
              const allOff = project.layers.filter((l) => g.layerIds.includes(l.id)).every((l) => !l.enabled);
              return (
                <div key={g.id} data-group={g.id}
                  className={`gclip ${sel.groupId === g.id ? 'sel' : ''} ${focus && focus.id !== g.id ? 'dimmed' : ''} ${focus?.id === g.id ? 'focused' : ''} ${allOff ? 'off' : ''}`}
                  style={{ left: X(sp.a), width: Math.max(8, (sp.b - sp.a) * zoom), top: (g.row ?? 0) * ROW_H + 3, height: ROW_H - 7, ['--gc' as any]: g.color ?? '#e0a040' }}
                  onMouseDown={(e) => onGroupDown(e, g)}
                  title={`${g.name} · ${g.layerIds.length} layers · ${fmtTime(sp.a)} → ${fmtTime(sp.b)}\ndrag = move all · drag up/down = group row · dbl-click = focus`}>
                  <button className="gtog" onClick={(e) => { e.stopPropagation(); editGroup(g.id, (x) => { x.collapsed = !x.collapsed; }); }} title={g.collapsed ? 'expand: show the layers' : 'collapse: hide the layers'}>{g.collapsed ? '▸' : '▾'}</button>
                  <button className="gtog" onClick={(e) => { e.stopPropagation(); setMembersEnabled(g.id, allOff); }} title="toggle all members visible">{allOff ? '○' : '●'}</button>
                  <span className="clabel">{g.name} <span className="dim">· {g.layerIds.length}</span></span>
                </div>
              );
            })}
            {layersTopDown.map((l, row) => {
              if (!visible(l)) return null;
              const a = X(l.start), b = X(l.end);
              const isSel = isSelLayer(l.id);
              const gm = memberOf.get(l.id);
              const fl = footageLen(l, localMedia);
              const beyond = fl !== null && l.end - l.start > fl + 0.02;
              const keys = isSel ? [...new Set([...allKeyTimes(l.params), ...l.masks.flatMap((m) => allKeyTimes(m.params))])] : [];
              return (
                <div
                  key={l.id}
                  data-layer={l.id}
                  className={`clip ${isSel ? 'sel' : ''} ${l.enabled ? '' : 'off'}`}
                  style={{ left: a, width: Math.max(4, b - a), top: GTOP + row * ROW_H + 3, height: ROW_H - 7, background: layerColor(l), boxShadow: gm && !isSel ? `inset 0 -2px 0 ${gm.color}` : undefined }}
                  onMouseDown={(e) => onClipDown(e, l, 'move')}
                  title={`${l.name}  ${fmtTime(l.start)} → ${fmtTime(l.end)}${fl !== null ? `
footage ${fl.toFixed(2)} s${beyond ? (loops(l) ? ' - loops after the dashed line' : ' - no footage after the dashed line (loop is off)') : ''}` : ''}`}
                >
                  <div className="grip l" onMouseDown={(e) => onClipDown(e, l, 'l')} />
                  {l.fadeIn > 0 ? <div className="fade in" style={{ width: l.fadeIn * zoom }} /> : null}
                  {l.fadeOut > 0 ? <div className="fade out" style={{ width: l.fadeOut * zoom }} /> : null}
                  {beyond ? <div className={`beyond ${loops(l) ? 'loop' : 'empty'}`} style={{ left: fl! * zoom }} /> : null}
                  {beyond && loops(l) ? Array.from({ length: Math.min(40, Math.ceil((l.end - l.start) / fl!) - 1) }, (_, i) => i + 2).filter((n) => n * fl! < l.end - l.start - 0.02).map((n) => <div key={n} className="loopmark" style={{ left: n * fl! * zoom }} />) : null}
                  <span className="clabel">{l.media && streamedIds.has(l.media) ? '☁ ' : ''}{l.name}</span>
                  {keys.map((kt) => (
                    <div key={kt} className="key" style={{ left: (kt - l.start) * zoom - 5 }} onMouseDown={(e) => onKeyDown(e, l, kt)} title={`key @ ${fmtTime(kt)}`} />
                  ))}
                  <div className="grip r" onMouseDown={(e) => onClipDown(e, l, 'r')} />
                </div>
              );
            })}
            <div className="playhead" ref={playheadRefs[1]} style={{ height: lanesH }} />
          </div>
        </div>
      </div>
    </div>
  );
};

// ---- storyboard lane --------------------------------------------------------------------------

const StoryLane: React.FC<{ shots: Shot[]; width: number; zoom: number; scroll: number; selId?: string }> = ({ shots, width, zoom, scroll, selId }) => {
  const laneRef = useRef<HTMLDivElement>(null);
  const phRef = useRef<HTMLDivElement>(null);
  const media = useStore((s) => s.media); // re-render thumbs when downloads land
  const X = (t: number) => (t - scroll) * zoom;
  const T = (x: number) => x / zoom + scroll;
  const [over, setOver] = useState<string | null>(null);

  useEffect(() => {
    const upd = () => { if (phRef.current) phRef.current.style.transform = `translateX(${(store.time - store.state.scroll) * store.state.zoom}px)`; };
    upd();
    return store.subscribeTime(upd);
  }, [zoom, scroll]);

  const sorted = useMemo(() => [...shots].sort((a, b) => a.start - b.start), [shots]);

  const onDown = (e: React.MouseEvent, s: Shot) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const rect = laneRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = sorted.indexOf(s);
    const prev = sorted[i - 1];
    const edgeL = Math.abs(x - X(s.start)) < 6;
    const edgeR = Math.abs(x - X(s.end)) < 6;
    store.set({ sel: { shotId: s.id }, sideTab: 'shot' });
    if ((edgeL && i > 0) || edgeR) {
      // drag the boundary; the neighbour that shares it follows
      const left = edgeL ? prev : s;
      const right = edgeL ? s : sorted[i + 1];
      const joined = right && Math.abs(left.end - right.start) < 1e-3;
      const move = (ev: MouseEvent) => {
        const t = snap(T(ev.clientX - rect.left), undefined, ev.altKey);
        store.editSB((d) => {
          const L = d.shots.find((y) => y.id === left.id)!;
          const R = right ? d.shots.find((y) => y.id === right.id) : undefined;
          const lo = L.start + 0.2, hi = R ? R.end - 0.2 : store.state.project.duration;
          const v = +Math.max(lo, Math.min(hi, t)).toFixed(3);
          L.end = v;
          if (R && joined) R.start = v;
        }, `shot-edge-${left.id}`);
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
    store.seek(snap(T(x), undefined, e.altKey));
    if (e.detail === 2) {
      // double-click: split the shot here
      const at = +snap(T(x)).toFixed(3);
      if (at > s.start + 0.2 && at < s.end - 0.2) {
        store.editSB((d) => {
          const k = d.shots.findIndex((y) => y.id === s.id);
          const c = JSON.parse(JSON.stringify(d.shots[k])) as Shot;
          c.id = `sh${Math.random().toString(36).slice(2, 8)}`;
          c.start = at;
          c.transition = 'cut';
          c.fade = 0;
          d.shots[k].end = at;
          d.shots.splice(k + 1, 0, c);
        });
      }
    }
  };
  const onMove = (e: React.MouseEvent) => {
    const rect = laneRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const edge = sorted.some((s) => Math.abs(X(s.start) - x) < 6 || Math.abs(X(s.end) - x) < 6);
    laneRef.current!.style.cursor = edge ? 'col-resize' : 'pointer';
  };
  const onDrop = (e: React.DragEvent, s: Shot) => {
    const c = e.dataTransfer.getData('application/x-mv-card');
    const r = e.dataTransfer.getData('application/x-mv-ref');
    setOver(null);
    if (!c && !r) return;
    e.preventDefault();
    applyToShot(s.id, c ? JSON.parse(c) : { kind: 'stock', tags: [], stock: JSON.parse(r) });
    store.set({ sel: { shotId: s.id }, sideTab: 'shot' });
  };

  return (
    <VResize id="tl.story" def={STORY_H} min={28} max={240} className="flat"><div className="tl-story">
      <div className="rowlabel" style={{ width: HEAD_W }}>
        Storyboard <span className="dim">&nbsp;{shots.length ? `${shots.length} shots` : ''}</span>
      </div>
      <div className="story-lane" ref={laneRef} style={{ width }} onMouseMove={onMove}
        onMouseDown={(e) => { if (e.button !== 0) return; const r = laneRef.current!.getBoundingClientRect(); store.seek(T(e.clientX - r.left)); }}>
        {sorted.map((s) => {
          const a = X(s.start), b = X(s.end);
          if (b < 0 || a > width) return null;
          const ref = pickOf(s);
          const th = s.source === 'footage' ? refThumb(ref) : undefined;
          const local = !!ref && media.some((m) => m.id === ref.media);
          return (
            <div key={s.id}
              data-shot={s.id}
              className={`shot-clip ${s.id === selId ? 'sel' : ''} ${s.source === 'gen' ? 'gen' : ''} ${over === s.id ? 'over' : ''} ${s.source === 'footage' && !ref ? 'empty' : ''}`}
              style={{ left: a, width: Math.max(3, b - a), backgroundImage: th ? `url("${th}")` : undefined }}
              onMouseDown={(e) => onDown(e, s)}
              onDragOver={(e) => { e.preventDefault(); setOver(s.id); }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => onDrop(e, s)}
              title={`${fmtTime(s.start)}–${fmtTime(s.end)}  ${s.section ?? ''}
${s.description}
query: ${s.query}${s.lyric ? `
♪ ${s.lyric}` : ''}`}
            >
              {s.transition !== 'cut' && s.fade > 0 ? <div className={`sh-fade ${s.transition}`} style={{ width: Math.min(b - a, s.fade * zoom) }} /> : null}
              <span className="sh-label">{s.source === 'gen' ? `⚡ ${s.gen ?? 'gen'} · ` : ''}{s.description || s.query}</span>
              {local ? <span className="sh-badge" title="downloaded">✓</span> : null}
            </div>
          );
        })}
        {!shots.length ? <div className="hint" style={{ padding: '18px 10px' }}>No storyboard yet — Brief &amp; AI → “Plan storyboard”.</div> : null}
        <div className="playhead" ref={phRef} style={{ height: '100%' }} />
      </div>
    </div></VResize>
  );
};

// ---- cue context menu -------------------------------------------------------------------------------

type MenuTarget = { kind: 'layer' | 'group' | 'shot' | 'line'; id: string };

/** what a right-clicked item spans, for "loop this" */
function targetSpan(tg: MenuTarget): { name: string; a: number; b: number } | null {
  const p = store.state.project;
  if (tg.kind === 'layer') { const l = p.layers.find((x) => x.id === tg.id); return l ? { name: `layer “${l.name}”`, a: l.start, b: l.end } : null; }
  if (tg.kind === 'group') { const g = p.groups?.find((x) => x.id === tg.id); const sp = g && groupSpan(p, g); return g && sp ? { name: `group “${g.name}”`, a: sp.a, b: sp.b } : null; }
  if (tg.kind === 'shot') { const s = p.storyboard?.shots.find((x) => x.id === tg.id); return s ? { name: 'this shot', a: s.start, b: s.end } : null; }
  const l = p.lyrics?.lines.find((x) => x.id === tg.id);
  // a little air around a sung line
  return l?.words.length ? { name: 'this lyric line', a: Math.max(0, l.words[0].t - 0.25), b: Math.min(p.duration, l.words[l.words.length - 1].e + 0.25) } : null;
}

/** Right-click menu: loop the clicked layer/shot/line, A/B points, cues — all at the exact time under the pointer. */
const TimelineMenu: React.FC<{ x: number; y: number; t: number; zoom: number; close: () => void; target?: MenuTarget }> = ({ x, y, t, zoom, close, target }) => {
  const inP = useStore((s) => s.inPoint);
  const outP = useStore((s) => s.outPoint);
  const span = target ? targetSpan(target) : null;
  const section = store.state.project.tempo.find((s) => t >= s.start && t < s.end);
  const ref = useRef<HTMLDivElement>(null);
  const cues = useStore((s) => s.project.cues) ?? NO_CUES;
  const near = cues.filter((c) => Math.abs(c.t - t) * zoom < 6).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0] as Cue | undefined;
  const [label, setLabel] = useState(near?.label ?? '');
  useEffect(() => {
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    window.addEventListener('wheel', close, { passive: true });
    return () => { window.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); window.removeEventListener('wheel', close); };
  }, []);
  const tempo = tempoRef;
  const beat = tempo ? tempo.beatsBetween(t - 2, t + 2).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0]?.t : undefined;
  const ph = store.time;
  const fmt3 = (v: number) => { const m = Math.floor(v / 60); return `${m}:${(v - m * 60).toFixed(3).padStart(6, '0')}`; };
  const act = (fn: () => void) => () => { fn(); close(); };
  // keep the menu on screen
  const left = Math.min(x, window.innerWidth - 250), top = Math.max(8, Math.min(y, window.innerHeight - (near ? 440 : 330)));
  return (
    <div className="popover ctxmenu" ref={ref} style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      <GroupItems target={target} act={act} />
      <div className="cat">Loop</div>
      {span ? (
        <>
          <button onClick={act(() => store.loopRange(span.a, span.b))}>⟳ Loop {span.name} <i>{(span.b - span.a).toFixed(2)}s</i></button>
          <button onClick={act(() => store.loopRange(span.a, span.b, true))}>⟳ Loop {span.name} + play</button>
        </>
      ) : null}
      {section ? <button onClick={act(() => store.loopRange(section.start, section.end))}>⟳ Loop section “{section.label}” <i>{(section.end - section.start).toFixed(1)}s</i></button> : null}
      <button onClick={act(() => store.set({ inPoint: +t.toFixed(3), ...(outP !== null && outP <= t ? { outPoint: null } : {}) }))}>Set A here <i>{fmt3(t)}</i></button>
      <button onClick={act(() => store.set({ outPoint: +t.toFixed(3), ...(inP !== null && inP >= t ? { inPoint: null } : {}) }))}>Set B here <i>{fmt3(t)}</i></button>
      {inP !== null || outP !== null ? <button className="danger" onClick={act(() => store.clearLoopRange())}>Clear A/B</button> : null}
      <div className="sep" />
      {near ? (
        <>
          <div className="cat">Cue “{near.label}” · {fmt3(near.t)}</div>
          <div className="row">
            <input value={label} autoFocus onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { renameCue(near.id, label || near.label); close(); } }} />
            <button onClick={act(() => renameCue(near.id, label || near.label))}>Rename</button>
          </div>
          <button onClick={act(() => store.seek(near.t))}>Go to cue</button>
          <button onClick={act(() => moveCue(near.id, ph))}>Move cue to playhead <i>{fmt3(ph)}</i></button>
          <button className="danger" onClick={act(() => removeCue(near.id))}>Remove cue</button>
          <div className="sep" />
        </>
      ) : null}
      <button onClick={act(() => addCue(t))}>Add cue here <i>{fmt3(t)}</i></button>
      {beat !== undefined && Math.abs(beat - t) > 0.0005 ? <button onClick={act(() => addCue(beat))}>Add cue on nearest beat <i>{fmt3(beat)}</i></button> : null}
      <button onClick={act(() => addCue(ph))}>Add cue at playhead <i>{fmt3(ph)}</i></button>
      <button onClick={act(() => store.seek(t))}>Move playhead here</button>
      {cues.length ? <button className="danger" onClick={act(() => store.edit((p) => { p.cues = []; }))}>Clear all cues <i>{cues.length}</i></button> : null}
    </div>
  );
};

// ---- lyrics lane: lines, expanding to per-word timing ------------------------------------------------

const lsGet = (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
const lsSet = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ } };

/** Edit one word (by line id + index) as a draft; times are kept ordered and non-overlapping by the caller. */
function editWord(lineId: string, wi: number, fn: (w: { w: string; t: number; e: number; src?: string; p?: number }) => void, merge?: string) {
  store.edit((p) => {
    const l = p.lyrics?.lines.find((x) => x.id === lineId);
    const w = l?.words[wi];
    if (w) { fn(w); w.src = 'manual'; }
  }, merge);
}

const LyricsLane: React.FC<{ lines: LyricLine[]; width: number; zoom: number; scroll: number; sel?: { line: string; word?: number } }> = ({ lines, width, zoom, scroll, sel }) => {
  const [open, setOpen] = useState(() => lsGet('mv.tl.lyricsWords', true));
  const laneRef = useRef<HTMLDivElement>(null);
  const phRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ line: string; word: number } | null>(null);
  const X = (t: number) => (t - scroll) * zoom;
  const T = (x: number) => x / zoom + scroll;
  const H = LYR_LINE_H + (open ? LYR_WORD_H : 0);

  useEffect(() => {
    const upd = () => { if (phRef.current) phRef.current.style.transform = `translateX(${(store.time - store.state.scroll) * store.state.zoom}px)`; };
    upd();
    return store.subscribeTime(upd);
  }, [zoom, scroll]);

  // flat word list for neighbour limits across line boundaries
  const flat = useMemo(() => lines.flatMap((l) => l.words.map((w, i) => ({ line: l.id, i, w }))), [lines]);
  const neighbours = (lineId: string, wi: number) => {
    const k = flat.findIndex((f) => f.line === lineId && f.i === wi);
    return { prevEnd: k > 0 ? flat[k - 1].w.e : 0, nextStart: k < flat.length - 1 ? flat[k + 1].w.t : store.state.project.duration };
  };
  const timeAt = (ev: MouseEvent) => {
    const t = T(ev.clientX - laneRef.current!.getBoundingClientRect().left);
    return ev.shiftKey ? snap(t, undefined, false) : t; // lyrics are precise by default; Shift snaps to beats/cues
  };
  const drag = (move: (ev: MouseEvent) => void) => {
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onWordDown = (e: React.MouseEvent, line: LyricLine, wi: number) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const w = line.words[wi];
    const x = e.clientX - laneRef.current!.getBoundingClientRect().left;
    const mode = Math.abs(x - X(w.t)) < 5 ? 'l' : Math.abs(x - X(w.e)) < 5 ? 'r' : 'move';
    store.set({ sel: { lyric: { line: line.id, word: wi } } });
    store.seek(mode === 'r' ? w.e : w.t);
    const { prevEnd, nextStart } = neighbours(line.id, wi);
    const t0 = timeAt(e.nativeEvent), o = { t: w.t, e: w.e };
    const key = `lyr-${line.id}-${wi}-${mode}`;
    drag((ev) => {
      const t = timeAt(ev);
      editWord(line.id, wi, (x) => {
        if (mode === 'l') x.t = +Math.max(prevEnd, Math.min(x.e - 0.03, t)).toFixed(3);
        else if (mode === 'r') x.e = +Math.min(nextStart, Math.max(x.t + 0.03, t)).toFixed(3);
        else {
          const d = Math.max(prevEnd - o.t, Math.min(nextStart - o.e, t - t0));
          x.t = +(o.t + d).toFixed(3);
          x.e = +(o.e + d).toFixed(3);
        }
      }, key);
      store.seek(mode === 'r' ? store.state.project.lyrics!.lines.find((l) => l.id === line.id)!.words[wi].e : store.state.project.lyrics!.lines.find((l) => l.id === line.id)!.words[wi].t);
    });
  };

  /** Which edge of the line (start a / end b) the pointer is on; none for lines too narrow to have grab handles. */
  const lineEdge = (clientX: number, a: number, b: number): 'l' | 'r' | null => {
    if ((b - a) * zoom < 24) return null;
    const x = clientX - laneRef.current!.getBoundingClientRect().left;
    return Math.abs(x - X(a)) < 6 ? 'l' : Math.abs(x - X(b)) < 6 ? 'r' : null;
  };

  const onLineDown = (e: React.MouseEvent, line: LyricLine) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    store.set({ sel: { lyric: { line: line.id } } });
    const a = line.words[0].t, b = line.words[line.words.length - 1].e;
    store.seek(a);
    if (e.detail === 2) { setOpen(true); lsSet('mv.tl.lyricsWords', true); return; }
    // drag the whole line (all its words), kept between the neighbouring lines
    const li = lines.findIndex((l) => l.id === line.id);
    const lo = li > 0 ? lines[li - 1].words[lines[li - 1].words.length - 1].e : 0;
    const hi = li < lines.length - 1 ? lines[li + 1].words[0].t : store.state.project.duration;
    const orig = line.words.map((w) => ({ t: w.t, e: w.e }));
    const t0 = timeAt(e.nativeEvent);
    const edge = lineEdge(e.clientX, a, b);
    if (edge) {
      // resize: the opposite edge stays put, every word's start/end (and the gaps between them) scales proportionally
      const minLen = 0.05 * line.words.length;
      drag((ev) => {
        const t = timeAt(ev);
        const anchor = edge === 'l' ? b : a;
        const moved = edge === 'l' ? Math.max(lo, Math.min(b - minLen, t)) : Math.min(hi, Math.max(a + minLen, t));
        const k = Math.abs(moved - anchor) / (b - a);
        store.edit((p) => {
          const l = p.lyrics?.lines.find((x) => x.id === line.id);
          l?.words.forEach((w, i) => {
            w.t = +(anchor + (orig[i].t - anchor) * k).toFixed(3);
            w.e = +(anchor + (orig[i].e - anchor) * k).toFixed(3);
            w.src = 'manual';
          });
        }, `lyr-line-resize-${line.id}-${edge}`);
        store.seek(moved);
      });
      return;
    }
    drag((ev) => {
      const d = Math.max(lo - a, Math.min(hi - b, timeAt(ev) - t0));
      store.edit((p) => {
        const l = p.lyrics?.lines.find((x) => x.id === line.id);
        l?.words.forEach((w, i) => { w.t = +(orig[i].t + d).toFixed(3); w.e = +(orig[i].e + d).toFixed(3); w.src = 'manual'; });
      }, `lyr-line-${line.id}`);
      store.seek(a + d);
    });
  };

  const commitEdit = (v: string) => {
    if (!editing) return;
    const { line, word } = editing;
    setEditing(null);
    const parts = v.trim().split(/\s+/).filter(Boolean);
    store.edit((p) => {
      const l = p.lyrics?.lines.find((x) => x.id === line);
      const w = l?.words[word];
      if (!l || !w) return;
      if (!parts.length) { l.words.splice(word, 1); if (!l.words.length) p.lyrics!.lines = p.lyrics!.lines.filter((x) => x.id !== line); return; }
      // typing several words splits the slot evenly
      const d = (w.e - w.t) / parts.length;
      l.words.splice(word, 1, ...parts.map((x, i) => ({ w: x, t: +(w.t + i * d).toFixed(3), e: +(w.t + (i + 1) * d).toFixed(3), src: 'manual' as const, p: 1 })));
    });
  };

  const vis = (a: number, b: number) => X(b) > 0 && X(a) < width;
  return (
    <div className="tl-lyrics" style={{ height: H }}>
      <div className="rowlabel" style={{ width: HEAD_W, height: H }}>
        <button className="ico" onClick={() => { setOpen(!open); lsSet('mv.tl.lyricsWords', !open); }} title={open ? 'collapse words' : 'show per-word timing'}>{open ? '▾' : '▸'}</button>
        Lyrics <span className="dim">&nbsp;{lines.length} lines{open ? ' · words' : ''}</span>
      </div>
      <div className="lyr-lane" ref={laneRef} style={{ width, height: H }}
        onMouseDown={(e) => { if (e.button === 0) store.seek(T(e.clientX - laneRef.current!.getBoundingClientRect().left)); }}>
        {lines.map((l) => {
          if (!l.words.length) return null;
          const a = l.words[0].t, b = l.words[l.words.length - 1].e;
          if (!vis(a, b)) return null;
          const on = sel?.line === l.id;
          return (
            <div key={l.id} data-line={l.id} className={`lyr-line ${on && sel?.word === undefined ? 'sel' : on ? 'part' : ''}`}
              style={{ left: X(a), width: Math.max(3, (b - a) * zoom), height: LYR_LINE_H - 4 }}
              onMouseDown={(e) => onLineDown(e, l)}
              onMouseMove={(e) => { e.currentTarget.style.cursor = lineEdge(e.clientX, a, b) ? 'ew-resize' : 'grab'; }}
              title={`${fmtTime(a)}–${fmtTime(b)}${l.section ? ` · ${l.section}` : ''}\n${l.words.map((w) => w.w).join(' ')}\ndrag = move the line · drag an edge = resize, scaling all words proportionally · dbl-click = show words`}>
              <span>{l.words.map((w) => w.w).join(' ')}</span>
            </div>
          );
        })}
        {open ? lines.flatMap((l) => l.words.map((w, wi) => {
          if (!vis(w.t, w.e)) return null;
          const on = sel?.line === l.id && sel.word === wi;
          const isEd = editing?.line === l.id && editing.word === wi;
          return (
            <div key={`${l.id}-${wi}`} className={`lyr-word src-${w.src ?? 'asr'} ${on ? 'sel' : ''}`}
              style={{ left: X(w.t), width: Math.max(2, (w.e - w.t) * zoom), top: LYR_LINE_H, height: LYR_WORD_H - 4, opacity: w.src === 'asr' && (w.p ?? 1) < 0.8 ? 0.75 : 1 }}
              onMouseDown={(e) => onWordDown(e, l, wi)}
              onMouseMove={(e) => {
                const x = e.clientX - laneRef.current!.getBoundingClientRect().left;
                e.currentTarget.style.cursor = Math.abs(x - X(w.t)) < 5 || Math.abs(x - X(w.e)) < 5 ? 'ew-resize' : 'grab';
              }}
              onDoubleClick={(e) => { e.stopPropagation(); setEditing({ line: l.id, word: wi }); }}
              title={`“${w.w}”  ${fmtTime(w.t)} → ${fmtTime(w.e)}  (${w.src ?? 'asr'}${w.p !== undefined ? `, ${Math.round(w.p * 100)}%` : ''})\ndrag = move · edges = trim · dbl-click = edit text · Alt+←/→ nudges 10 ms`}>
              {isEd ? (
                <input autoFocus defaultValue={w.w} onMouseDown={(e) => e.stopPropagation()}
                  onBlur={(e) => commitEdit(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitEdit((e.target as HTMLInputElement).value); if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }} />
              ) : <span>{w.w}</span>}
            </div>
          );
        })) : null}
        <div className="playhead" ref={phRef} style={{ height: H }} />
      </div>
    </div>
  );
};

/** group-related right-click items for a layer or group target */
const GroupItems: React.FC<{ target?: MenuTarget; act: (fn: () => void) => () => void }> = ({ target, act }) => {
  const p = store.state.project;
  if (!target || (target.kind !== 'layer' && target.kind !== 'group')) return null;
  const sel = selectedLayerIds();
  const g = target.kind === 'group' ? p.groups?.find((x) => x.id === target.id) : groupOf(p, target.id);
  const focused = store.state.focusGroup;
  return (
    <>
      <div className="cat">Group</div>
      {target.kind === 'layer' ? (
        <button onClick={act(() => groupLayers(sel.length ? sel : [target.id]))}>⧉ Group {sel.length > 1 ? `${sel.length} selected layers` : 'this layer'} <i>Ctrl+G</i></button>
      ) : null}
      {g ? (
        <>
          <button onClick={act(() => store.set({ focusGroup: focused === g.id ? null : g.id }))}>{focused === g.id ? '◀ Leave focus' : `◎ Focus “${g.name}”`} <i>dbl-click</i></button>
          <button onClick={act(() => editGroup(g.id, (x) => { x.collapsed = !x.collapsed; }))}>{g.collapsed ? '▸ Expand' : '▾ Collapse'} “{g.name}”</button>
          {target.kind === 'layer' ? <button onClick={act(() => store.edit((d) => { const x = d.groups?.find((y) => y.id === g.id); if (x) x.layerIds = x.layerIds.filter((id) => id !== target.id); d.groups = d.groups?.filter((y) => y.layerIds.length); }))}>Remove layer from group</button> : null}
          <button className="danger" onClick={act(() => ungroup(g.id))}>Ungroup “{g.name}” <i>Ctrl+Shift+G</i></button>
        </>
      ) : null}
      <div className="sep" />
    </>
  );
};

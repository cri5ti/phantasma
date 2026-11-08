// Lyrics stage UI state (view, selection, editing) in a small store of its own, plus the sheet edit entry point.
import type { Draft } from 'immer';
import { useRef, useSyncExternalStore } from 'react';
import { emptySheet, sheetDuration, sheetToText, SheetClock } from '../../core/sheet';
import { emptyStoryboard } from '../../core/storyboard';
import type { LyricSheet } from '../../core/types';
import { store, useStore } from '../store';

export interface WordSel {
  lines: { block: string; line: string; from: number; to: number; text: string }[];
  text: string;
  /** screen rect of the selection (toolbar anchor) */
  rect: { x: number; y: number; w: number; h: number };
}

export interface LxState {
  /** px per beat */
  zoom: number;
  /** beat at the vertical centre of both panes */
  center: number;
  /** which pane last drove the scroll */
  driver: 'lyrics' | 'timeline' | 'play' | null;
  selBlock: string | null;
  selSpan: { track: string; span: string } | null;
  selTempo: string | null;
  /** keyboard focus line */
  focus: { block: string; line: string } | null;
  editing: { block: string; caret: number } | null;
  wsel: WordSel | null;
  /** active label brush for painting layers */
  brush: string | null;
  raw: boolean;
  chat: boolean;
  panel: 'library' | 'export' | 'keys' | 'analysis' | null;
  /** tab of the analysis drawer */
  atab: 'findings' | 'profile' | 'shape' | 'targets' | 'song';
  showStyle: boolean;
  meter: boolean;
  /** sound view: words tinted by rhyme family */
  sound: boolean;
  /** analysis lanes shown on the timeline */
  lanes: Lane[];
  /** block profile card (hovering a block header) */
  profile: { block: string; x: number; y: number } | null;
  /** read-along click track */
  click: { playing: boolean; beat: number } | null;
  toast: string | null;
  /** lock/flow blend 0..1 published by the lyrics pane */
  lock: number;
}

export type Lane = 'wave' | 'density' | 'breath' | 'hooks' | 'emotion';

let st: LxState = {
  zoom: 6, center: 8, driver: null, selBlock: null, selSpan: null, selTempo: null, focus: null, editing: null, wsel: null,
  brush: null, raw: false, chat: true, panel: null, atab: 'findings', showStyle: true, meter: true, sound: false, lanes: ['density', 'breath'],
  profile: null, click: null, toast: null, lock: 0,
};
// per-viewer view preferences
const PERSIST: (keyof LxState)[] = ['zoom', 'chat', 'sound', 'lanes', 'meter'];
try {
  for (const k of PERSIST) { const v = localStorage.getItem(`mv.lx.${k}`); if (v !== null) (st as any)[k] = JSON.parse(v); }
} catch { /* ignore */ }

const subs = new Set<() => void>();
export const lx = {
  get: () => st,
  set(p: Partial<LxState>) {
    st = { ...st, ...p };
    for (const k of PERSIST) if (p[k] !== undefined) try { localStorage.setItem(`mv.lx.${k}`, JSON.stringify(p[k])); } catch { /* ignore */ }
    subs.forEach((f) => f());
  },
  subscribe: (f: () => void) => { subs.add(f); return () => void subs.delete(f); },
};

export function useLx<T>(sel: (s: LxState) => T): T {
  const last = useRef<{ v: T } | null>(null);
  return useSyncExternalStore(lx.subscribe, () => {
    const v = sel(st);
    if (last.current && Object.is(last.current.v, v)) return last.current.v;
    last.current = { v };
    return v;
  });
}

let toastTimer: any;
export function toast(msg: string) {
  clearTimeout(toastTimer);
  lx.set({ toast: msg });
  toastTimer = setTimeout(() => lx.set({ toast: null }), 2600);
}

export const ZOOM_MIN = 0.4, ZOOM_MAX = 48;

// ---- the sheet ------------------------------------------------------------------------------------

const FALLBACK = emptySheet();
export const sheet = (): LyricSheet => store.state.project.sheet ?? FALLBACK;
export const useSheet = () => useStore((s) => s.project.sheet ?? FALLBACK);

let clockCache: { key: unknown; c: SheetClock } | null = null;
export function clockOf(s: LyricSheet) {
  const key = `${s.bpm}|${s.offset ?? 0}|${JSON.stringify(s.tempo)}`;
  if (!clockCache || clockCache.key !== key) clockCache = { key, c: new SheetClock(s) };
  return clockCache.c;
}

/**
 * Mutate the sheet (one undo step; `merge` coalesces drags). The storyboard brief's lyrics follow the sheet, and a
 * project without a song gets its duration from the sheet.
 */
export function editSheet(fn: (d: Draft<LyricSheet>) => void, merge?: string) {
  store.edit((p) => {
    if (!p.sheet) {
      const bpm = p.tempo[0]?.bpm;
      p.sheet = emptySheet(bpm && bpm > 0 ? bpm : 90, p.tempo[0]?.beatsPerBar ?? 4);
    }
    fn(p.sheet);
    const text = sheetToText(p.sheet as LyricSheet);
    if (p.sheet.blocks.length) {
      p.storyboard ??= emptyStoryboard();
      if (p.storyboard.brief.lyrics !== text) p.storyboard.brief.lyrics = text;
    }
    if (!p.audio) {
      const d = Math.max(30, Math.ceil(sheetDuration(p.sheet as LyricSheet).total + 4));
      if (Math.abs(d - p.duration) > 0.5) p.duration = d;
    }
  }, merge);
}

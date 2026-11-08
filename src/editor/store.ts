// Tiny external store: project document with undo/redo + UI state.
import { produce, type Draft } from 'immer';
import { useRef, useSyncExternalStore } from 'react';
import type { AudioData } from '../core/audio';
import { Tempo } from '../core/tempo';
import { emptyStoryboard } from '../core/storyboard';
import type { MediaItem, Project, StockRef, Storyboard } from '../core/types';

export interface Selection {
  layerId?: string;
  maskId?: string;
  section?: number;
  shotId?: string;
  /** lyrics lane: a line, or one word of it */
  lyric?: { line: string; word?: number };
  /** extra selected layers (Ctrl/Shift+click) — layerId stays the primary one */
  layerIds?: string[];
  groupId?: string;
}

/** a keyframe in the dopesheet: layer + param path ("p.<key>" | "m.<maskId>.<key>") + time */
export interface KeyRef {
  layer: string;
  path: string;
  t: number;
}

export type Mode = 'lyrics' | 'edit' | 'story' | 'find' | 'render';
export type SideTab = 'brief' | 'shot' | 'board' | 'ai';

export interface UIState {
  project: Project;
  media: MediaItem[];
  audio: AudioData | null;
  sel: Selection;
  playing: boolean;
  /** px per second */
  zoom: number;
  /** seconds at left edge of the timeline */
  scroll: number;
  snap: boolean;
  autoKey: boolean;
  useProxies: boolean;
  previewScale: number;
  inPoint: number | null;
  outPoint: number | null;
  loop: boolean;
  saveState: 'saved' | 'dirty' | 'saving' | 'error';
  canUndo: boolean;
  canRedo: boolean;
  taps: number[];
  /** editor stage: storyboard (pre-production) or full timeline editing */
  mode: Mode;
  sideTab: SideTab;
  /** draw the storyboard thumbs over the preview */
  sbOverlay: boolean;
  /** play candidate preview clips instead of stills in the overlay */
  sbMotion: boolean;
  /** long-running storyboard action (AI, search, download) */
  busy: string | null;
  /** run shown in the AI log tab (null = newest) */
  aiRun: string | null;
  /** thumbnail being hovered (enlarged floating preview) */
  hoverRef: { ref: StockRef; x: number; y: number; w: number; h: number } | null;
  /** clip shown big over the player */
  peek: StockRef | null;
  /** timeline shows only this group's layers (playback unchanged) */
  focusGroup: string | null;
  /** right-click menu on a footage thumbnail */
  footMenu: { x: number; y: number; ref: StockRef } | null;
  /** layers expanded into dopesheet tracks */
  dope: string[];
  /** selected keyframes (dopesheet) */
  keySel: KeyRef[];
}

type Listener = () => void;

class Store {
  state: UIState;
  private listeners = new Set<Listener>();
  private undo: Project[] = [];
  private redo: Project[] = [];
  private lastMerge: { key: string; at: number } | null = null;
  private saveTimer: any = null;
  /** time is kept outside the main state so playback doesn't re-render the world */
  time = 0;
  private timeListeners = new Set<Listener>();
  seekHandler: ((t: number) => void) | null = null;

  constructor(project: Project) {
    this.state = {
      project,
      media: [],
      audio: null,
      sel: {},
      playing: false,
      zoom: 12,
      scroll: 0,
      snap: true,
      autoKey: false,
      useProxies: true,
      previewScale: 0.5,
      inPoint: null,
      outPoint: null,
      loop: false,
      saveState: 'saved',
      canUndo: false,
      canRedo: false,
      taps: [],
      mode: !project.audio ? 'lyrics' : project.storyboard?.shots.length && !project.layers.some((l) => l.shot) ? 'story' : 'edit',
      sideTab: 'brief',
      sbOverlay: true,
      sbMotion: false,
      busy: null,
      aiRun: null,
      hoverRef: null,
      peek: null,
      focusGroup: null,
      footMenu: null,
      dope: [],
      keySel: [],
    };
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  subscribeTime = (l: Listener) => {
    this.timeListeners.add(l);
    return () => void this.timeListeners.delete(l);
  };
  private emit() {
    this.listeners.forEach((l) => l());
  }

  set(patch: Partial<UIState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  setTime(t: number) {
    if (t === this.time) return;
    this.time = t;
    this.timeListeners.forEach((l) => l());
  }

  /** seek the player (and the store) */
  seek(t: number) {
    const p = this.state.project;
    t = Math.max(0, Math.min(p.duration - 1 / p.fps, t));
    this.setTime(t);
    this.seekHandler?.(t);
  }

  /** Loop playback over [a, b] (A/B points), jump to A, optionally start playing. */
  loopRange(a: number, b: number, play = false) {
    const d = this.state.project.duration;
    const lo = Math.max(0, Math.min(a, b)), hi = Math.min(d, Math.max(a, b));
    if (hi - lo < 1 / this.state.project.fps) return;
    this.set({ inPoint: +lo.toFixed(3), outPoint: +hi.toFixed(3), loop: true });
    this.seek(lo);
    if (play) setTimeout(() => (window as any).__player?.play(), 50);
  }

  clearLoopRange() {
    this.set({ inPoint: null, outPoint: null });
  }

  /**
   * Mutate the project. `merge` coalesces rapid edits with the same key (slider drags) into one undo step.
   */
  edit(fn: (d: Draft<Project>) => void, merge?: string) {
    const before = this.state.project;
    const after = produce(before, fn);
    if (after === before) return;
    const now = Date.now();
    const coalesce = merge && this.lastMerge && this.lastMerge.key === merge && now - this.lastMerge.at < 1200;
    if (!coalesce) {
      this.undo.push(before);
      if (this.undo.length > 300) this.undo.shift();
    }
    this.lastMerge = merge ? { key: merge, at: now } : null;
    this.redo = [];
    this.state = { ...this.state, project: after, canUndo: true, canRedo: false, saveState: 'dirty' };
    this.emit();
    this.scheduleSave();
  }

  /** Mutate the storyboard (created on first use). */
  editSB(fn: (d: Draft<Storyboard>) => void, merge?: string) {
    this.edit((p) => {
      p.storyboard ??= emptyStoryboard();
      fn(p.storyboard);
    }, merge);
  }

  doUndo() {
    const p = this.undo.pop();
    if (!p) return;
    this.redo.push(this.state.project);
    this.lastMerge = null;
    this.state = { ...this.state, project: p, canUndo: this.undo.length > 0, canRedo: true, saveState: 'dirty' };
    this.emit();
    this.scheduleSave();
  }

  doRedo() {
    const p = this.redo.pop();
    if (!p) return;
    this.undo.push(this.state.project);
    this.state = { ...this.state, project: p, canUndo: true, canRedo: this.redo.length > 0, saveState: 'dirty' };
    this.emit();
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 700);
  }

  async save() {
    clearTimeout(this.saveTimer);
    this.set({ saveState: 'saving' });
    try {
      const r = await fetch('/api/project', { method: 'PUT', body: JSON.stringify(this.state.project, null, 1) });
      if (!r.ok) throw new Error(await r.text());
      if (this.state.saveState === 'saving') this.set({ saveState: 'saved' });
    } catch (e) {
      console.error(e);
      this.set({ saveState: 'error' });
    }
  }
}

export let store: Store;
export function initStore(p: Project) {
  store = new Store(p);
  return store;
}

/** shallow equality for selector results (arrays element-wise, plain objects key-wise) */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is((a as any)[k], (b as any)[k]));
}

/**
 * Subscribe to a slice of the UI state. A selector that builds a fresh value each call (`?? []`, `.filter`, `{…}`)
 * would make useSyncExternalStore re-render forever; results that are shallow-equal to the last one keep the old
 * reference, so that can't happen.
 */
export function useStore<T>(sel: (s: UIState) => T): T {
  const last = useRef<{ v: T } | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const v = sel(store.state);
    if (last.current && shallowEqual(last.current.v, v)) return last.current.v;
    last.current = { v };
    return v;
  });
}

export function useTime(): number {
  return useSyncExternalStore(store.subscribeTime, () => store.time);
}

let tempoCache: { key: unknown; audio: unknown; tempo: Tempo } | null = null;
export function useTempo(): Tempo {
  const sections = useStore((s) => s.project.tempo);
  const audio = useStore((s) => s.audio);
  const duration = useStore((s) => s.project.duration);
  if (!tempoCache || tempoCache.key !== sections || tempoCache.audio !== audio) {
    tempoCache = { key: sections, audio, tempo: new Tempo(sections, audio?.meta.beats ?? [], duration) };
  }
  return tempoCache.tempo;
}

export const fmtTime = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

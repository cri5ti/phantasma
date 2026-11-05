// Project factories and helpers shared by the editor and the render scripts.
import { COMMON_PARAMS, VIDEO_PARAMS, MEDIA_PARAMS } from '../comp/common';
import { getGen } from '../gen/registry';
import type { AnalysisMeta } from './audio';
import { defaults } from './params';
import type { Layer, Mask, MediaItem, Project, TempoSection } from './types';

export const uid = (p = 'l') => `${p}${Math.random().toString(36).slice(2, 8)}`;

const SECTION_COLORS = ['#5b8cff', '#ff6b9a', '#ffc14d', '#3ddc97', '#b48cff', '#4dd4ff', '#ff8a4d', '#9be15d'];

export function emptyProject(name: string, audio: string, duration = 60): Project {
  return {
    version: 1,
    name,
    audio,
    width: 1920,
    height: 1080,
    fps: 30,
    duration,
    background: '#000000',
    tempo: [],
    markers: [],
    layers: [],
  };
}

export function tempoFromAnalysis(a: AnalysisMeta): TempoSection[] {
  return a.sections.map((s, i) => {
    const spb = 60 / s.bpm;
    // anchor the grid on a detected downbeat inside the section when available
    const db = a.downbeats.find((t) => t >= s.start - 0.05 && t < s.end) ?? s.beatOffset;
    const off = db - Math.floor((db - s.start) / (spb * 4)) * spb * 4;
    return {
      start: s.start,
      end: s.end,
      bpm: s.bpm,
      beatOffset: +off.toFixed(4),
      beatsPerBar: 4,
      label: `S${i + 1}`,
      color: SECTION_COLORS[i % SECTION_COLORS.length],
    };
  });
}

export function newGenLayer(gen: string, start: number, end: number, name?: string): Layer {
  const g = getGen(gen)!;
  return {
    id: uid(),
    name: name ?? g.name,
    kind: 'gen',
    gen,
    enabled: true,
    start,
    end,
    fadeIn: 0,
    fadeOut: 0,
    blend: g.category === 'visualizer' || g.category === 'shader' ? 'screen' : 'normal',
    params: { ...defaults(COMMON_PARAMS), ...defaults(g.params) },
    masks: [],
  };
}

export function newMediaLayer(item: MediaItem, start: number, end: number): Layer {
  return {
    id: uid(),
    name: item.id,
    kind: item.kind,
    media: item.id,
    enabled: true,
    start,
    end,
    fadeIn: 0,
    fadeOut: 0,
    blend: 'normal',
    params: { ...defaults(COMMON_PARAMS), ...defaults(item.kind === 'video' ? VIDEO_PARAMS : MEDIA_PARAMS) },
    masks: [],
  };
}

export function newMask(gen = 'shape'): Mask {
  const g = getGen(gen)!;
  return { id: uid('m'), enabled: true, gen, params: defaults(g.params), op: 'add', mode: 'alpha', invert: false, feather: 0 };
}

export function cloneLayer(l: Layer): Layer {
  const c: Layer = JSON.parse(JSON.stringify(l));
  c.id = uid();
  c.name = `${l.name} copy`;
  c.masks.forEach((m) => (m.id = uid('m')));
  return c;
}

import type { AudioData } from '../core/audio';
import type { ParamDef, Values } from '../core/params';
import type { BeatInfo, Tempo } from '../core/tempo';
import type { Lyrics } from '../core/types';

export interface FrameCtx {
  /** song time (s) */
  t: number;
  /** time since the layer started (s) */
  layerT: number;
  fps: number;
  /** logical stage size — draw in these units, the context is pre-scaled */
  W: number;
  H: number;
  audio: AudioData | null;
  tempo: Tempo;
  beat: BeatInfo;
  /** stable per-layer seed */
  seed: number;
  /** word-timed lyrics of the project (lyrics generator) */
  lyrics?: Lyrics;
}

export type GenCategory = 'visualizer' | 'shader' | 'shape' | 'text' | 'fill' | 'particles' | 'scene';

export interface GenDef {
  id: string;
  name: string;
  category: GenCategory;
  params: ParamDef[];
  draw(ctx: CanvasRenderingContext2D, p: Values, f: FrameCtx): void;
  /** named parameter sets (Inspector preset menu, Add menu entries) */
  presets?: Record<string, Partial<Values>>;
}

export function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

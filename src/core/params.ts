// Parameter evaluation: keyframes + easing + audio/tempo modulation.
import type { AudioData, ScalarName } from './audio';
import type { Tempo } from './tempo';
import type { Animated, Easing, Keyframe, Modulation, ParamMap, ParamValue, Prim } from './types';

export interface ParamDef {
  key: string;
  label?: string;
  type: 'number' | 'color' | 'bool' | 'select' | 'text';
  default: Prim;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  group?: string;
  /** shown in the inspector as a hint */
  hint?: string;
  /** not keyframeable (e.g. text content, structural choices) */
  static?: boolean;
}

export interface EvalCtx {
  t: number;
  audio: AudioData | null;
  tempo: Tempo;
  layerStart: number;
  layerEnd: number;
}

export const EASINGS: Easing[] = ['linear', 'easeInOut', 'easeIn', 'easeOut', 'expoOut', 'backOut', 'hold'];

export function ease(e: Easing | undefined, x: number): number {
  switch (e) {
    case 'hold': return 0;
    case 'easeIn': return x * x * x;
    case 'easeOut': return 1 - (1 - x) ** 3;
    case 'easeInOut': return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    case 'expoOut': return x >= 1 ? 1 : 1 - 2 ** (-10 * x);
    case 'backOut': { const c = 1.70158; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; }
    default: return x;
  }
}

export function isAnimated(v: ParamValue | undefined): v is Animated {
  return typeof v === 'object' && v !== null;
}

// ---- colour helpers -------------------------------------------------------

export type RGBA = [number, number, number, number];

export function parseColor(c: string): RGBA {
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return [255, 255, 255, 1];
}

export function rgba([r, g, b, a]: RGBA): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;
}

export function withAlpha(c: string, a: number): string {
  const p = parseColor(c);
  return rgba([p[0], p[1], p[2], p[3] * a]);
}

export function mixColor(a: string, b: string, x: number): string {
  const pa = parseColor(a);
  const pb = parseColor(b);
  return rgba(pa.map((v, i) => v + (pb[i] - v) * x) as RGBA);
}

const isColor = (v: unknown) => typeof v === 'string' && (v.startsWith('#') || v.startsWith('rgb'));

// ---- keyframes ------------------------------------------------------------

export function sortedKeys(a: Animated): Keyframe[] {
  return (a.$k ?? []).slice().sort((x, y) => x.t - y.t);
}

/** Value from keyframes (or static base) at time t, before modulation. */
export function baseAt(raw: ParamValue | undefined, t: number, fallback: Prim): Prim {
  if (raw === undefined) return fallback;
  if (!isAnimated(raw)) return raw;
  const ks = raw.$k;
  if (!ks || ks.length === 0) return raw.v ?? fallback;
  const k = ks.length > 1 ? sortedKeys(raw) : ks;
  if (t <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < k.length - 1 && k[i + 1].t <= t) i++;
  const a = k[i];
  const b = k[i + 1];
  const x = ease(a.e, (t - a.t) / Math.max(1e-9, b.t - a.t));
  if (typeof a.v === 'number' && typeof b.v === 'number') return a.v + (b.v - a.v) * x;
  if (isColor(a.v) && isColor(b.v)) return mixColor(a.v as string, b.v as string, x);
  return x >= 1 ? b.v : a.v;
}

export function modSource(m: Modulation, ctx: EvalCtx): number {
  const { t, audio, tempo } = ctx;
  let v = 0;
  switch (m.src) {
    case 'beat': v = Math.exp(-tempo.at(t).sinceBeat / Math.max(0.01, m.release ?? 0.15)); break;
    case 'bar': v = Math.exp(-tempo.at(t).sinceBar / Math.max(0.01, m.release ?? 0.4)); break;
    case 'lfo': v = 0.5 - 0.5 * Math.cos((2 * Math.PI * tempo.at(t).beat) / Math.max(0.25, m.release ?? 4)); break;
    case 'sectionProgress': v = Math.max(0, Math.min(1, tempo.at(t).sectionProgress)); break;
    case 'layerProgress': v = Math.max(0, Math.min(1, (t - ctx.layerStart) / Math.max(1e-6, ctx.layerEnd - ctx.layerStart))); break;
    default: v = audio ? audio.scalar(m.src as ScalarName, t, m.release ?? 0.08) : 0;
  }
  if (m.gate) v = Math.max(0, v - m.gate) / Math.max(1e-6, 1 - m.gate);
  if (m.curve && m.curve !== 1) v = Math.pow(v, m.curve);
  return v;
}

export function evalParam(raw: ParamValue | undefined, def: ParamDef | undefined, ctx: EvalCtx): Prim {
  const fallback = def?.default ?? 0;
  let v = baseAt(raw, ctx.t, fallback);
  if (isAnimated(raw) && raw.$mod?.length && typeof v === 'number') {
    for (const m of raw.$mod) v = (v as number) + m.amount * modSource(m, ctx);
    if (def?.type === 'number' && def.min !== undefined && def.max !== undefined) {
      // allow modulation to overshoot the UI range a bit but not explode
      const span = def.max - def.min;
      v = Math.max(def.min - span, Math.min(def.max + span, v as number));
    }
  }
  if (def?.type === 'number' && typeof v !== 'number') v = Number(v) || 0;
  return v;
}

export type Values = Record<string, any>;

export function evalParams(map: ParamMap, defs: ParamDef[], ctx: EvalCtx): Values {
  const out: Values = {};
  for (const d of defs) out[d.key] = evalParam(map[d.key], d, ctx);
  return out;
}

export function defaults(defs: ParamDef[]): ParamMap {
  const o: ParamMap = {};
  for (const d of defs) o[d.key] = d.default;
  return o;
}

// ---- editing helpers (used by the editor) ------------------------------------

const EPS = 1e-3;

export function keyAt(raw: ParamValue | undefined, t: number): Keyframe | undefined {
  return isAnimated(raw) ? raw.$k?.find((k) => Math.abs(k.t - t) < EPS) : undefined;
}

export function setKey(raw: ParamValue | undefined, t: number, v: Prim, e?: Easing): Animated {
  const a: Animated = isAnimated(raw) ? { ...raw } : { v: raw };
  const ks = (a.$k ?? []).filter((k) => Math.abs(k.t - t) >= EPS);
  const prev = a.$k?.find((k) => Math.abs(k.t - t) < EPS);
  ks.push({ t, v, e: e ?? prev?.e ?? 'easeInOut' });
  a.$k = ks.sort((x, y) => x.t - y.t);
  return a;
}

export function removeKey(raw: ParamValue | undefined, t: number): ParamValue | undefined {
  if (!isAnimated(raw) || !raw.$k) return raw;
  const ks = raw.$k.filter((k) => Math.abs(k.t - t) >= EPS);
  return simplify({ ...raw, $k: ks, v: ks.length ? raw.v : raw.$k.find((k) => Math.abs(k.t - t) < EPS)?.v ?? raw.v });
}

/** Set the value at time t: updates the key under the playhead if animated, else the static value. */
export function setValue(raw: ParamValue | undefined, t: number, v: Prim, autoKey: boolean): ParamValue {
  if (isAnimated(raw)) {
    if (raw.$k?.length) return setKey(raw, t, v);
    return { ...raw, v };
  }
  return autoKey ? setKey(raw, t, v) : v;
}

/** Collapse an Animated with no keys and no mods back to a primitive. */
export function simplify(a: Animated): ParamValue {
  const hasK = !!a.$k?.length;
  const hasM = !!a.$mod?.length;
  if (!hasK && !hasM) return a.v ?? 0;
  const o: Animated = {};
  if (hasK) o.$k = a.$k;
  if (hasM) o.$mod = a.$mod;
  if (!hasK) o.v = a.v;
  return o;
}

export function setMods(raw: ParamValue | undefined, mods: Modulation[], current: Prim): ParamValue {
  const a: Animated = isAnimated(raw) ? { ...raw } : { v: raw ?? current };
  a.$mod = mods;
  return simplify(a);
}

export function allKeyTimes(map: ParamMap): number[] {
  const s = new Set<number>();
  for (const v of Object.values(map)) if (isAnimated(v)) v.$k?.forEach((k) => s.add(k.t));
  return [...s].sort((a, b) => a - b);
}

export function shiftKeys(map: ParamMap, dt: number): ParamMap {
  const o: ParamMap = {};
  for (const [k, v] of Object.entries(map)) {
    o[k] = isAnimated(v) && v.$k ? { ...v, $k: v.$k.map((kf) => ({ ...kf, t: kf.t + dt })) } : v;
  }
  return o;
}

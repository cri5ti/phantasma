// Precomputed audio features (see analyze/analyze.py), sampled at meta.rate Hz.

export interface AnalysisSection {
  start: number;
  end: number;
  bpm: number;
  alt?: number[];
  beatOffset: number;
  energy: number;
}

export interface AnalysisMeta {
  version: number;
  audio: string;
  duration: number;
  rate: number;
  frames: number;
  nBands: number;
  waveN: number;
  scalars: string[];
  files: { bands: string; scalars: string; wave: string };
  tempo: number;
  beats: number[];
  downbeats: number[];
  sections: AnalysisSection[];
  novelty?: { times: number[]; values: number[] };
}

export type ScalarName = 'rms' | 'bass' | 'mid' | 'high' | 'onset' | 'centroid';
export const SCALARS: ScalarName[] = ['rms', 'bass', 'mid', 'high', 'onset', 'centroid'];

export class AudioData {
  readonly rate: number;
  readonly frames: number;
  readonly nBands: number;
  readonly waveN: number;
  private scalarIndex: Record<string, number> = {};
  private prefix: Record<string, Float64Array> = {};
  private bandBuf: Float32Array;
  private waveBuf: Float32Array;

  constructor(
    readonly meta: AnalysisMeta,
    private bandsU8: Uint8Array,
    private scalarsU8: Uint8Array,
    private waveI8: Int8Array,
  ) {
    this.rate = meta.rate;
    this.frames = meta.frames;
    this.nBands = meta.nBands;
    this.waveN = meta.waveN;
    meta.scalars.forEach((n, i) => (this.scalarIndex[n] = i));
    this.bandBuf = new Float32Array(this.nBands);
    this.waveBuf = new Float32Array(this.waveN);
  }

  get duration() {
    return this.meta.duration;
  }

  private fi(t: number) {
    return Math.max(0, Math.min(this.frames - 1, t * this.rate));
  }

  /** raw scalar at integer feature frame */
  scalarAtFrame(name: ScalarName, f: number) {
    const ns = this.meta.scalars.length;
    const i = Math.max(0, Math.min(this.frames - 1, f | 0));
    return this.scalarsU8[i * ns + this.scalarIndex[name]] / 255;
  }

  /** Scalar feature 0..1, linearly interpolated; `release` (s) adds peak-hold with exponential decay. */
  scalar(name: ScalarName, t: number, release = 0): number {
    const x = this.fi(t);
    const f0 = Math.floor(x);
    const fr = x - f0;
    let v = this.scalarAtFrame(name, f0) * (1 - fr) + this.scalarAtFrame(name, f0 + 1) * fr;
    if (release > 0) {
      const tau = release * this.rate;
      const K = Math.min(Math.ceil(tau * 4), 600);
      for (let k = 1; k <= K; k++) {
        const w = Math.exp(-k / tau);
        if (w < 0.02) break;
        const pv = this.scalarAtFrame(name, f0 - k) * w;
        if (pv > v) v = pv;
      }
    }
    return v;
  }

  /** Cumulative integral of a scalar from 0..t (seconds·level) — for audio-driven motion ("travel further when loud"). */
  integral(name: ScalarName, t: number): number {
    let p = this.prefix[name];
    if (!p) {
      p = new Float64Array(this.frames + 1);
      for (let i = 0; i < this.frames; i++) p[i + 1] = p[i] + this.scalarAtFrame(name, i) / this.rate;
      this.prefix[name] = p;
    }
    const x = this.fi(t);
    const f0 = Math.floor(x);
    return p[f0] + (p[Math.min(f0 + 1, this.frames)] - p[f0]) * (x - f0);
  }

  /**
   * Spectrum bands 0..1 (log-mel, low→high). Returns a shared buffer (copy if you need to keep it).
   * `release` adds per-band peak-hold decay like classic analyser "falloff".
   */
  bands(t: number, release = 0): Float32Array {
    const out = this.bandBuf;
    const n = this.nBands;
    const x = this.fi(t);
    const f0 = Math.floor(x);
    const fr = x - f0;
    const f1 = Math.min(f0 + 1, this.frames - 1);
    for (let b = 0; b < n; b++) out[b] = (this.bandsU8[f0 * n + b] * (1 - fr) + this.bandsU8[f1 * n + b] * fr) / 255;
    if (release > 0) {
      const tau = release * this.rate;
      const K = Math.min(Math.ceil(tau * 4), 300);
      for (let k = 1; k <= K; k++) {
        const w = Math.exp(-k / tau);
        if (w < 0.02) break;
        const fk = f0 - k;
        if (fk < 0) break;
        for (let b = 0; b < n; b++) {
          const pv = (this.bandsU8[fk * n + b] / 255) * w;
          if (pv > out[b]) out[b] = pv;
        }
      }
    }
    return out;
  }

  /** Resample bands to `count` bars spanning [lo, hi] (fractions of the band range). */
  bars(t: number, count: number, release = 0, lo = 0, hi = 1, out?: Float32Array): Float32Array {
    const src = this.bands(t, release);
    const res = out && out.length === count ? out : new Float32Array(count);
    const n = this.nBands;
    for (let i = 0; i < count; i++) {
      const p = lo + (hi - lo) * (count === 1 ? 0.5 : i / (count - 1));
      const x = p * (n - 1);
      const b0 = Math.floor(x);
      const b1 = Math.min(b0 + 1, n - 1);
      res[i] = src[b0] + (src[b1] - src[b0]) * (x - b0);
    }
    return res;
  }

  /** Oscilloscope window (-1..1) centred on t. Shared buffer. */
  wave(t: number): Float32Array {
    const f = Math.round(this.fi(t));
    const n = this.waveN;
    for (let i = 0; i < n; i++) this.waveBuf[i] = this.waveI8[f * n + i] / 127;
    return this.waveBuf;
  }
}

const cache = new Map<string, Promise<AudioData>>();

/** Load analysis given a resolver for files in the analysis dir. Cached per URL. */
export function loadAnalysis(resolve: (file: string) => string): Promise<AudioData> {
  const key = resolve('analysis.json');
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const meta: AnalysisMeta = await (await fetch(key)).json();
      const get = async (f: string) => (await fetch(resolve(f))).arrayBuffer();
      const [b, s, w] = await Promise.all([get(meta.files.bands), get(meta.files.scalars), get(meta.files.wave)]);
      return new AudioData(meta, new Uint8Array(b), new Uint8Array(s), new Int8Array(w));
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

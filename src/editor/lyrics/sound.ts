// The song's loudness laid out on the sheet's beat grid (for the wave column and "energy from the sound").
import type { AudioData } from '../../core/audio';
import { clockOf, editSheet, sheet } from './state';
import { sid } from '../../core/sheet';
import { store } from '../store';


/** loudness (0..1) per bin of `step` beats from beat `from`; `mode` picks the loudest frame or the average in each bin */
export function loudness(audio: AudioData, from: number, to: number, step: number, mode: 'peak' | 'mean' = 'peak', name: 'rms' | 'bass' = 'rms'): number[] {
  const clock = clockOf(sheet());
  const out: number[] = [];
  for (let b = from; b < to - 1e-6; b += step) {
    const t0 = clock.sec(b), t1 = clock.sec(Math.min(to, b + step));
    if (t0 > audio.duration) { out.push(0); continue; }
    const f0 = Math.max(0, Math.floor(t0 * audio.rate)), f1 = Math.max(f0, Math.ceil(t1 * audio.rate));
    let m = 0, n = 0;
    for (let f = f0; f <= f1; f++) { const v = audio.scalarAtFrame(name, f); m = mode === 'peak' ? Math.max(m, v) : m + v; n++; }
    out.push(mode === 'peak' ? m : n ? m / n : 0);
  }
  return out;
}

/** replace the energy curve with the song's loudness (one point per beat, smoothed over about a beat and normalised to the loud parts) */
export function energyFromSound(): string {
  const audio = store.state.audio;
  if (!audio) throw new Error('no song loaded');
  const s = sheet();
  const clock = clockOf(s);
  const end = Math.max(1, Math.floor(clock.beat(audio.duration)));
  const raw = loudness(audio, 0, end, 1, 'mean');
  const sm = raw.map((v, i) => (raw[i - 1] ?? v) * 0.25 + v * 0.5 + (raw[i + 1] ?? v) * 0.25);
  const sorted = [...sm].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.05)] ?? 0, hi = sorted[Math.floor(sorted.length * 0.97)] ?? 1;
  const span = Math.max(1e-3, hi - lo);
  const points = sm.map((v, i) => ({ at: i, v: +Math.max(0, Math.min(1, (v - lo) / span)).toFixed(3) }));
  editSheet((d) => {
    let t = d.tracks.find((x) => x.kind === 'energy');
    if (!t) { t = { id: sid('tr'), name: 'Energy', kind: 'energy', spans: [], points: [] }; d.tracks.push(t); }
    t.points = points;
  });
  return `energy set from the song (${points.length} beats)`;
}

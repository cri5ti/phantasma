// Beat grid from the project tempo map (user-editable), falling back to detected beats.
import type { TempoSection } from './types';

export interface BeatInfo {
  /** continuous beat position in the section grid */
  beat: number;
  /** 0..1 phase inside the current beat */
  phase: number;
  /** seconds since the last beat (clamped to the section start) */
  sinceBeat: number;
  /** seconds since the last bar downbeat (clamped to the section start) */
  sinceBar: number;
  barIndex: number;
  beatInBar: number;
  bpm: number;
  section: TempoSection | null;
  sectionIndex: number;
  /** 0..1 progress through the current section */
  sectionProgress: number;
}

export class Tempo {
  constructor(readonly sections: TempoSection[], private fallbackBeats: number[] = [], private duration = 0) {}

  sectionIndexAt(t: number): number {
    const s = this.sections;
    for (let i = 0; i < s.length; i++) if (t >= s[i].start && t < s[i].end) return i;
    if (s.length && t >= s[s.length - 1].end) return s.length - 1;
    return s.length ? 0 : -1;
  }

  sectionAt(t: number): TempoSection | null {
    const i = this.sectionIndexAt(t);
    return i >= 0 ? this.sections[i] : null;
  }

  at(t: number): BeatInfo {
    const si = this.sectionIndexAt(t);
    const s = si >= 0 ? this.sections[si] : null;
    if (s && s.bpm > 0) {
      const spb = 60 / s.bpm;
      const bpb = s.beatsPerBar || 4;
      const beat = (t - s.beatOffset) / spb;
      const bi = Math.floor(beat);
      const phase = beat - bi;
      const barF = beat / bpb;
      const bar = Math.floor(barF);
      const intoSection = Math.max(0, t - s.start);
      return {
        beat,
        phase,
        sinceBeat: Math.min(phase * spb, intoSection),
        sinceBar: Math.min((barF - bar) * bpb * spb, intoSection),
        barIndex: bar,
        beatInBar: ((bi % bpb) + bpb) % bpb,
        bpm: s.bpm,
        section: s,
        sectionIndex: si,
        sectionProgress: (t - s.start) / Math.max(1e-6, s.end - s.start),
      };
    }
    // fallback: detected beats (assume 4/4)
    const b = this.fallbackBeats;
    const prog = this.duration ? t / this.duration : 0;
    if (!b.length || t < b[0]) {
      return { beat: 0, phase: 0, sinceBeat: 1e9, sinceBar: 1e9, barIndex: 0, beatInBar: 0, bpm: 120, section: null, sectionIndex: -1, sectionProgress: prog };
    }
    let lo = 0, hi = b.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (b[m] <= t) lo = m;
      else hi = m - 1;
    }
    const next = Math.min(lo + 1, b.length - 1);
    const spb = next > lo ? b[next] - b[lo] : 0.5;
    const phase = Math.min(1, (t - b[lo]) / spb);
    return {
      beat: lo + phase,
      phase,
      sinceBeat: t - b[lo],
      sinceBar: t - b[lo - (lo % 4)],
      barIndex: Math.floor(lo / 4),
      beatInBar: lo % 4,
      bpm: 60 / spb,
      section: null,
      sectionIndex: -1,
      sectionProgress: prog,
    };
  }

  /** All grid beats in [from, to] with bar flag — for the timeline and snapping. */
  beatsBetween(from: number, to: number): { t: number; bar: boolean }[] {
    const out: { t: number; bar: boolean }[] = [];
    if (!this.sections.length) {
      this.fallbackBeats.forEach((t, i) => t >= from && t <= to && out.push({ t, bar: i % 4 === 0 }));
      return out;
    }
    for (const s of this.sections) {
      if (s.end < from || s.start > to || s.bpm <= 0) continue;
      const spb = 60 / s.bpm;
      const bpb = s.beatsPerBar || 4;
      const a = Math.max(from, s.start);
      const b = Math.min(to, s.end);
      for (let k = Math.ceil((a - s.beatOffset) / spb - 1e-6); ; k++) {
        const t = s.beatOffset + k * spb;
        if (t >= b - 1e-6) break;
        out.push({ t, bar: ((k % bpb) + bpb) % bpb === 0 });
      }
    }
    return out;
  }
}

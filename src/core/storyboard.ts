// Storyboard helpers shared by the editor: normalising AI shot lists, bar snapping, and turning shots into layers.
import { getGen } from '../gen/registry';
import { newGenLayer, newMediaLayer, uid } from './project';
import type { Tempo } from './tempo';
import type { Layer, MediaItem, Project, Shot, StockRef, Storyboard } from './types';

export function emptyStoryboard(): Storyboard {
  return { brief: { prompt: '', lyrics: '', style: '' }, shots: [], board: [], log: [] };
}

export const refKey = (r: Pick<StockRef, 'provider' | 'id'>) => `${r.provider}-${r.id}`;
/** media id the downloaded file gets from scripts/media.mjs (slug of the basename) */
export const refMediaId = (r: Pick<StockRef, 'provider' | 'id'>) => refKey(r).replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();

/** A local media item as a shot candidate. */
export function mediaRef(m: MediaItem): StockRef {
  return { provider: 'local', id: m.id, kind: m.kind, thumb: m.thumb ? '/' + m.thumb.split('/').map(encodeURIComponent).join('/') : '', page: '', width: m.width, height: m.height, duration: m.duration || undefined, media: m.id };
}

/**
 * Picks that aren't in the project folder yet, as remote MediaItems with the same id the downloaded file will get —
 * so layers built from them switch to the local file (and its proxy) automatically once it lands.
 */
export function streamedMedia(sb: Storyboard | undefined, local: MediaItem[]): MediaItem[] {
  if (!sb) return [];
  const have = new Set(local.map((m) => m.id));
  const out = new Map<string, MediaItem>();
  for (const s of sb.shots) {
    const r = s.pick !== undefined ? s.candidates[s.pick] : undefined;
    if (!r || r.provider === 'local') continue;
    const id = r.media ?? refMediaId(r);
    if (have.has(id) || out.has(id)) continue;
    const src = r.kind === 'video' ? r.previewHd ?? r.preview : r.thumb;
    if (!src) continue;
    out.set(id, { id, kind: r.kind, src, proxy: r.kind === 'video' ? r.preview ?? src : undefined, thumb: undefined, duration: r.duration ?? 0, width: r.width, height: r.height, fps: 30, remote: true });
  }
  return [...out.values()];
}

/** local media + streamed stand-ins (local wins) */
export const withStreamed = (sb: Storyboard | undefined, local: MediaItem[]) => {
  const extra = streamedMedia(sb, local);
  return extra.length ? [...local, ...extra] : local;
};

export const pickOf = (s: Shot): StockRef | undefined => (s.pick !== undefined ? s.candidates[s.pick] : undefined);

/** [mm:ss.xx] / [m:ss] LRC lines → timed lyrics; null when the text has no timestamps. */
export function parseLRC(text: string): { t: number; text: string }[] | null {
  const out: { t: number; text: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const words = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: words });
  }
  return out.length ? out.sort((a, b) => a.t - b.t) : null;
}

/** Bar lines across the song (section starts included). */
export function barLines(tempo: Tempo, duration: number): number[] {
  const bars = tempo.beatsBetween(0, duration).filter((b) => b.bar).map((b) => b.t);
  tempo.sections.forEach((s) => bars.push(s.start));
  return [...new Set(bars.map((t) => +t.toFixed(3)))].sort((a, b) => a - b);
}

function nearest(sorted: number[], t: number) {
  let best = t, bd = Infinity;
  for (const x of sorted) {
    const d = Math.abs(x - t);
    if (d < bd) { bd = d; best = x; }
    if (x > t + bd) break;
  }
  return { t: best, d: bd };
}

/** Raw AI shots → clean, contiguous, bar-snapped Shots covering [a, b]. */
export function normalizeShots(raw: any[], a: number, b: number, tempo: Tempo, duration: number): Shot[] {
  const bars = barLines(tempo, duration);
  const sorted = [...raw].filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end)).sort((x, y) => x.start - y.start);
  const shots: Shot[] = [];
  for (const s of sorted) {
    const prev = shots[shots.length - 1];
    const start = prev ? prev.end : a;
    let end = Math.max(start, Math.min(b, s.end));
    const sn = nearest(bars, end);
    if (sn.d < 1.2 && sn.t > start + 0.4 && sn.t < b) end = sn.t;
    if (end - start < 0.4) continue;
    const gen = s.source === 'gen' && getGen(s.gen) ? s.gen : undefined;
    shots.push({
      id: uid('sh'),
      start: +start.toFixed(3),
      end: +end.toFixed(3),
      section: s.section || undefined,
      description: String(s.description ?? ''),
      query: String(s.query ?? ''),
      mood: s.mood || undefined,
      lyric: s.lyric || undefined,
      tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
      source: gen ? 'gen' : 'footage',
      gen,
      candidates: [],
      transition: ['cut', 'crossfade', 'dip'].includes(s.transition) ? s.transition : 'cut',
      fade: s.transition === 'cut' ? 0 : Math.max(0, Math.min(4, Number(s.fade) || 1)),
    });
  }
  if (shots.length) shots[shots.length - 1].end = +b.toFixed(3);
  return shots;
}

/** Replace shots overlapping [a, b] with `fresh`, trimming neighbours that straddle the edges. */
export function spliceShots(all: Shot[], fresh: Shot[], a: number, b: number): Shot[] {
  const out: Shot[] = [];
  for (const s of all) {
    if (s.end <= a + 1e-3 || s.start >= b - 1e-3) out.push(s);
    else if (s.start < a) out.push({ ...s, end: a });
    else if (s.end > b) out.push({ ...s, start: b });
  }
  return [...out, ...fresh].sort((x, y) => x.start - y.start);
}

export const shotAt = (shots: Shot[], t: number) => shots.find((s) => t >= s.start && t < s.end);

/** Shots → timeline layers (bottom → top in time order so incoming shots fade in over the outgoing one). */
export function buildLayers(p: Project, media: MediaItem[]): { layers: Layer[]; missing: Shot[] } {
  const sb = p.storyboard;
  if (!sb) return { layers: [], missing: [] };
  const byId = new Map(media.map((m) => [m.id, m]));
  const layers: Layer[] = [];
  const missing: Shot[] = [];
  const shots = [...sb.shots].sort((a, b) => a.start - b.start);
  shots.forEach((s, i) => {
    const next = shots[i + 1];
    // the outgoing shot runs under the incoming crossfade
    const tail = next && next.transition === 'crossfade' ? next.fade / 2 : 0;
    const head = s.transition === 'crossfade' ? s.fade / 2 : 0;
    const start = Math.max(0, s.start - head);
    const end = Math.min(p.duration, s.end + tail);
    let l: Layer | null = null;
    if (s.source === 'gen' && s.gen && getGen(s.gen)) {
      l = newGenLayer(s.gen, start, end);
    } else {
      const ref = pickOf(s);
      const item = ref?.media ? byId.get(ref.media) : ref ? byId.get(refMediaId(ref)) : undefined;
      if (!item) { missing.push(s); return; }
      l = newMediaLayer(item, start, end);
      if (item.kind === 'video' && item.duration > 0) {
        const span = end - start;
        // slow a short clip down to fill the shot (not below half speed — it loops beyond that)
        if (item.duration < span) l.params.speed = +Math.max(0.5, item.duration / span).toFixed(3);
      }
    }
    l.id = uid();
    l.name = `${s.section ? s.section + ' · ' : ''}${s.description.slice(0, 40) || s.query}`;
    l.shot = s.id;
    if (s.transition === 'crossfade') l.fadeIn = +s.fade.toFixed(3);
    if (s.transition === 'dip') l.fadeIn = +(s.fade / 2).toFixed(3);
    if (next?.transition === 'dip') l.fadeOut = +(next.fade / 2).toFixed(3);
    layers.push(l);
  });
  return { layers, missing };
}

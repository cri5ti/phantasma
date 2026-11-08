// Storyboard actions: talk to /api/story + /api/stock and fold results into the project (undoable).
import { uid } from '../core/project';
import { buildLayers, emptyStoryboard, withStreamed, normalizeShots, parseLRC, pickOf, refKey, refMediaId, spliceShots } from '../core/storyboard';
import { Tempo } from '../core/tempo';
import type { BoardItem, MediaItem, Shot, StockProvider, StockRef, Storyboard } from '../core/types';
import { GENERATORS } from '../gen/registry';
import { pruneGroups } from './groups';
import { store } from './store';

export interface ServiceStatus {
  llm: Record<'claude' | 'openai', { available: boolean; model: string; why?: string }>;
  stock: Record<StockProvider, { available: boolean; why?: string }>;
}

export const sb = (): Storyboard => store.state.project.storyboard ?? emptyStoryboard();

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) {
    if (j.runId) store.set({ aiRun: j.runId });
    throw Object.assign(new Error(j.error ?? r.statusText), { runId: j.runId });
  }
  return j;
}

/** append a client-side step to an AI run's event log */
const note = (runId: string | undefined, msg: string) =>
  runId ? fetch(`/api/ai/runs/${runId}/note`, { method: 'POST', body: JSON.stringify({ msg }) }).catch(() => {}) : undefined;

/** Run a labelled long action; surfaces errors in the busy bar instead of throwing. */
export async function task<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  store.set({ busy: label });
  try {
    const r = await fn();
    store.set({ busy: null });
    return r;
  } catch (e: any) {
    console.error(e);
    store.set({ busy: `⚠ ${label}: ${e?.message ?? e}` });
    return undefined;
  }
}

let statusP: Promise<ServiceStatus> | null = null;
/** cached; pass refresh to re-read keys after editing .env (server restart) */
export const status = (refresh = false): Promise<ServiceStatus> => {
  if (!statusP || refresh) statusP = fetch('/api/story/status').then((r) => r.json()).catch((e) => { statusP = null; throw e; });
  return statusP;
};

export const STOCK_ORDER: StockProvider[] = ['pexels', 'pixabay', 'mixkit'];

/** Providers that have a key, preferred one first. */
export async function stockProviders(preferred?: StockProvider): Promise<StockProvider[]> {
  const st = await status();
  const ok = STOCK_ORDER.filter((p) => st.stock[p]?.available);
  if (!ok.length) throw new Error('no stock provider configured - set PIXABAY_API_KEY (or PEXELS_API_KEY) in phantasma/.env and restart the editor');
  return preferred && ok.includes(preferred) ? [preferred, ...ok.filter((p) => p !== preferred)] : ok;
}

/** Search the preferred provider (if it has a key), falling through to the others until something comes back. */
export async function searchAny(preferred: StockProvider | undefined, q: string, kind: 'video' | 'image' = 'video', page = 1, perPage = 15) {
  let lastErr: unknown = null;
  for (const p of await stockProviders(preferred)) {
    try {
      const r = await searchStock(p, q, kind, page, perPage);
      if (r.items.length) return { ...r, provider: p };
    } catch (e) {
      lastErr = e;
      console.warn(`[stock] ${p}:`, e);
      // a rate-limited provider is skipped for the rest of this search; other keyed providers still get a go
    }
  }
  if (lastErr) throw lastErr;
  return { items: [] as StockRef[], total: 0, provider: preferred };
}

const tempoNow = () => {
  const s = store.state;
  return new Tempo(s.project.tempo, s.audio?.meta.beats ?? [], s.project.duration);
};

/** Song + brief + board → the context object the director prompt is built from. */
function context(range: { start: number; end: number } | null, instruction = '') {
  const s = store.state;
  const p = s.project;
  const b = sb();
  const audio = s.audio;
  const energy = (a: number, z: number) => {
    if (!audio) return 0.5;
    let sum = 0, n = 0;
    for (let f = Math.floor(a * audio.rate); f < z * audio.rate; f += 4) { sum += audio.scalarAtFrame('rms', f); n++; }
    return n ? sum / n : 0;
  };
  const raw = p.tempo.map((x) => ({ label: x.label, start: x.start, end: x.end, bpm: x.bpm, barSec: (60 / x.bpm) * (x.beatsPerBar || 4), energy: energy(x.start, x.end) }));
  const maxE = Math.max(1e-6, ...raw.map((x) => x.energy));
  return {
    name: p.name,
    duration: p.duration,
    sections: raw.map((x) => ({ ...x, energy: x.energy / maxE })),
    markers: p.markers,
    brief: b.brief,
    timedLyrics: parseLRC(b.brief.lyrics),
    ideas: b.board.filter((i) => (i.kind === 'idea' || i.kind === 'note') && i.text?.trim()).map((i) => ({ text: i.text!, tags: i.tags })),
    generators: GENERATORS.map((g) => ({ id: g.id, name: g.name, category: g.category })),
    localMedia: s.media.filter((m) => !/^(pexels|pixabay|mixkit)-/.test(m.id)).map((m) => ({ id: m.id, kind: m.kind, duration: m.duration })),
    range,
    keep: range ? b.shots.filter((x) => x.end <= range.start + 1e-3 || x.start >= range.end - 1e-3).filter((x) => Math.abs(x.end - range.start) < 20 || Math.abs(x.start - range.end) < 20).map((x) => ({ start: x.start, end: x.end, description: x.description })) : [],
    instruction,
  };
}

export interface LLMChoice { provider: 'claude' | 'openai'; model?: string }

export async function generateStoryboard(llm: LLMChoice, range: { start: number; end: number } | null, instruction = '') {
  const label = range ? 'Re-planning range' : 'Planning storyboard';
  return task(label, async () => {
    const ctx = context(range, instruction);
    const r = await post<{ data: { concept: string; shots: any[] }; model: string; runId: string }>('/api/story/shots', { ...llm, context: ctx });
    store.set({ aiRun: r.runId });
    const a = range?.start ?? 0, b = range?.end ?? store.state.project.duration;
    const fresh = normalizeShots(r.data.shots, a, b, tempoNow(), store.state.project.duration);
    note(r.runId, `editor: ${r.data.shots.length} shot(s) from the model → ${fresh.length} after clamping to ${a.toFixed(2)}–${b.toFixed(2)} s, closing gaps and snapping cuts to bars`);
    if (!fresh.length) throw new Error('model returned no usable shots');
    const at = new Date().toISOString();
    store.editSB((d) => {
      d.shots = range ? spliceShots(d.shots as Shot[], fresh, a, b) : fresh;
      d.log.push({ at, model: r.model, kind: range ? 'shots-range' : 'shots', prompt: instruction || d.brief.prompt.slice(0, 200) });
      if (!range && r.data.concept) d.board.push(card('note', r.data.concept, ['concept'], { model: r.model, at }, d.board));
    });
    note(r.runId, range ? `editor: replaced the shots in ${a.toFixed(2)}–${b.toFixed(2)} s` : `editor: storyboard replaced (${fresh.length} shots)${r.data.concept ? ', concept pinned to the board' : ''}`);
    store.set({ sel: { shotId: fresh[0].id }, sideTab: 'shot' });
    return fresh;
  });
}

/** place new cards in a column to the right of what's on the board */
function slot(board: { x: number; y: number }[], i = 0) {
  const x0 = board.length ? Math.max(...board.map((c) => c.x)) + 240 : 20;
  return { x: x0 + Math.floor(i / 8) * 240, y: 20 + (i % 8) * 130 };
}

export function card(kind: BoardItem['kind'], text: string, tags: string[], source?: BoardItem['source'], board = sb().board, i = 0, extra: Partial<BoardItem> = {}): BoardItem {
  return { id: uid('b'), kind, text, tags, source, ...slot(board, i), ...extra };
}

/** Run an AI operation over selected board cards; returns the new cards' text + tags (placement is the board's job). */
export async function aiCards(llm: LLMChoice, cards: BoardItem[], prompt: string, mode: string) {
  const label = mode === 'split' ? 'AI: splitting cards' : mode === 'merge' ? 'AI: merging cards' : 'AI: working on the selection';
  return task(label, async () => {
    const ctx = { ...context(null, ''), ideas: [] }; // the selection is the subject; don't repeat the whole board
    const payload = cards.map((b) => ({
      kind: b.kind,
      text: b.kind === 'stock' && b.stock ? `stock clip ${b.stock.provider} ${b.stock.id} (${b.stock.kind}${b.stock.duration ? `, ${b.stock.duration}s` : ''})${b.text ? `: ${b.text}` : ''}${b.stock.tags?.length ? ` — ${b.stock.tags.join(', ')}` : ''}`
        : b.kind === 'media' ? `project footage ${b.media}` : b.text ?? '',
      tags: b.tags,
    }));
    const r = await post<{ data: { ideas: { text: string; tags: string[] }[] }; model: string; runId: string }>('/api/story/cards', { ...llm, context: ctx, cards: payload, task: prompt, mode });
    store.set({ aiRun: r.runId });
    note(r.runId, `editor: ${cards.length} card(s) in → ${r.data.ideas.length} card(s) out`);
    return { ...r.data, model: r.model, at: new Date().toISOString() };
  });
}

export async function suggestIdeas(llm: LLMChoice, focus = '') {
  return task('Brainstorming ideas', async () => {
    const r = await post<{ data: { ideas: { text: string; tags: string[] }[] }; model: string; runId: string }>('/api/story/ideas', { ...llm, context: context(null, focus), count: 12 });
    store.set({ aiRun: r.runId });
    note(r.runId, `editor: added ${r.data.ideas.length} idea card(s) to the board`);
    const at = new Date().toISOString();
    store.editSB((d) => {
      const base = [...d.board];
      const x0 = slot(base).x;
      r.data.ideas.forEach((idea, i) => d.board.push({ id: uid('b'), kind: 'idea', text: idea.text, tags: idea.tags, source: { model: r.model, at, prompt: focus || undefined }, x: x0 + Math.floor(i / 6) * 240, y: 20 + (i % 6) * 130 }));
      d.log.push({ at, model: r.model, kind: 'ideas', prompt: focus });
    });
  });
}

export async function searchStock(provider: StockProvider, q: string, kind: 'video' | 'image' = 'video', page = 1, perPage = 15) {
  const qs = new URLSearchParams({ provider, q, kind, page: String(page), perPage: String(perPage), orientation: store.state.project.width >= store.state.project.height ? 'landscape' : 'portrait' });
  const r = await fetch(`/api/stock/search?${qs}`);
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { rateLimited: !!j.rateLimited });
  return j as { items: StockRef[]; total: number; cached?: boolean };
}

/** Search every footage shot that has no candidates yet; pick the first hit not already used elsewhere. */
export async function fillThumbnails(provider: StockProvider | undefined, onlyEmpty = true) {
  const todo = sb().shots.filter((s) => s.source === 'footage' && s.query && (!onlyEmpty || !s.candidates.length));
  let done = 0;
  return task(`Fetching thumbnails (0/${todo.length})`, async () => {
    await stockProviders(provider); // fail fast with a clear message when no key is set
    const used = new Set(sb().shots.flatMap((s) => (pickOf(s) ? [refKey(pickOf(s)!)] : [])));
    const queue = [...todo];
    let stopped: string | null = null;
    const worker = async () => {
      for (let s = queue.shift(); s && !stopped; s = queue.shift()) {
        const shot = s;
        const r = await searchAny(provider, shot.query, 'video', 1, 8).catch((e) => {
          console.warn(shot.query, e);
          if (e?.rateLimited) { stopped = e.message; queue.unshift(shot); }
          return { items: [] as StockRef[] };
        });
        let pick = r.items.findIndex((x) => !used.has(refKey(x)));
        if (pick < 0 && r.items.length) pick = 0;
        if (pick >= 0) used.add(refKey(r.items[pick]));
        store.editSB((d) => {
          const x = d.shots.find((y) => y.id === shot.id);
          if (!x) return;
          const have = new Set(x.candidates.map(refKey));
          x.candidates.push(...r.items.filter((i) => !have.has(refKey(i))));
          if (x.pick === undefined && pick >= 0) x.pick = x.candidates.findIndex((c) => refKey(c) === refKey(r.items[pick]));
        }, 'fill-thumbs');
        store.set({ busy: `Fetching thumbnails (${++done}/${todo.length})` });
      }
    };
    // 2 workers: the server limiter serialises calls anyway, this just keeps a few in flight
    await Promise.all([worker(), worker()]);
    if (stopped) throw new Error(`stopped after ${done}/${todo.length} shots — ${stopped}. Run “Fetch thumbnails” again later; finished shots are kept.`);
  });
}

/** Mark candidates whose files are now in the project folder. */
export function linkDownloaded(media: MediaItem[]) {
  const ids = new Set(media.map((m) => m.id));
  const sbNow = store.state.project.storyboard;
  if (!sbNow) return;
  const needs = sbNow.shots.some((s) => s.candidates.some((c) => !c.media && ids.has(refMediaId(c)))) || sbNow.board.some((b) => b.stock && !b.stock.media && ids.has(refMediaId(b.stock)));
  if (!needs) return;
  store.editSB((d) => {
    d.shots.forEach((s) => s.candidates.forEach((c) => { if (!c.media && ids.has(refMediaId(c))) c.media = refMediaId(c); }));
    d.board.forEach((b) => { if (b.stock && !b.stock.media && ids.has(refMediaId(b.stock))) b.stock.media = refMediaId(b.stock); });
  }, 'link-media');
}

export async function reloadMedia() {
  const media: MediaItem[] = (await (await fetch('/api/media')).json()).media;
  store.set({ media });
  linkDownloaded(media);
  return media;
}

/** Pick up footage dropped into the project folder: scan, probe, thumbnails + proxies. */
export async function scanFootage() {
  const before = store.state.media.length;
  await task('Scanning footage folder (new clips get proxies)…', async () => {
    await post('/api/media/scan', {});
    await reloadMedia();
  });
  return store.state.media.length - before;
}

/** On returning to the editor: scan only when files appeared that media.json doesn't know. */
let checking = false;
export async function checkNewFootage() {
  if (checking || store.state.busy) return;
  checking = true;
  try {
    const j = await (await fetch('/api/media/stale')).json();
    if (j.fresh > 0) await scanFootage();
  } catch { /* server restarting */ } finally { checking = false; }
}

/** Download the picked candidate of every footage shot (or the given refs), wait for the media scan. */
/** picks used by enabled timeline layers that still stream from a CDN */
export function streamedInTimeline(): StockRef[] {
  const p = store.state.project;
  const local = new Set(store.state.media.map((m) => m.id));
  const used = new Set(p.layers.filter((l) => l.enabled && l.media && !local.has(l.media)).map((l) => l.media!));
  return (p.storyboard?.shots ?? []).flatMap((s) => {
    const r = pickOf(s);
    return r && r.provider !== 'local' && used.has(r.media ?? refMediaId(r)) ? [r] : [];
  });
}

export async function downloadPicks(refs?: StockRef[]) {
  const have = new Set(store.state.media.map((m) => m.id));
  const list = (refs ?? sb().shots.flatMap((s) => (s.source === 'footage' && pickOf(s) ? [pickOf(s)!] : []))).filter((r) => r.provider !== 'local' && !have.has(r.media ?? refMediaId(r)));
  const uniq = [...new Map(list.map((r) => [refKey(r), r])).values()];
  if (!uniq.length) { await reloadMedia(); return; }
  return task(`Downloading ${uniq.length} clip(s)`, async () => {
    await post('/api/stock/download', { refs: uniq });
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await (await fetch('/api/stock/jobs')).json();
      const mine = st.jobs.filter((j: any) => uniq.some((u) => refKey(u) === j.key));
      const done = mine.filter((j: any) => j.state === 'done').length;
      const err = mine.filter((j: any) => j.state === 'error');
      store.set({ busy: st.scanning ? 'Scanning media + building proxies…' : `Downloading ${done}/${uniq.length}${err.length ? ` (${err.length} failed)` : ''}` });
      if (!st.busy) {
        await reloadMedia();
        if (err.length) throw new Error(`${err.length} download(s) failed: ${err[0].error}`);
        return;
      }
    }
  });
}

/** Every not-yet-downloaded candidate of every footage shot (deduplicated). */
export function undownloadedCandidates(): StockRef[] {
  const have = new Set(store.state.media.map((m) => m.id));
  const all = sb().shots.filter((s) => s.source === 'footage').flatMap((s) => s.candidates);
  return [...new Map(all.filter((r) => r.provider !== 'local' && !have.has(r.media ?? refMediaId(r))).map((r) => [refKey(r), r])).values()];
}

/**
 * Turn the storyboard into ordinary layers: build the timeline, download whatever still streams, then drop the
 * storyboard tag so a later "Build timeline" no longer replaces these layers. The shots stay in the storyboard.
 */
export async function commitToLayers() {
  const r = buildTimeline();
  const streamed = streamedInTimeline();
  if (streamed.length) {
    await downloadPicks(streamed);
    if (streamedInTimeline().length) return { ...r, committed: false as const }; // a download failed - keep them tagged
  }
  store.edit((p) => { for (const l of p.layers) delete l.shot; });
  return { ...r, committed: true as const };
}

/** Replace previously built storyboard layers with fresh ones from the current shots. */
export function buildTimeline() {
  const all = withStreamed(store.state.project.storyboard, store.state.media);
  const { layers, missing } = buildLayers(store.state.project, all);
  const remote = new Set(all.filter((m) => m.remote).map((m) => m.id));
  const streamed = layers.filter((l) => l.media && remote.has(l.media)).length;
  store.edit((p) => {
    p.layers = [...layers, ...p.layers.filter((l) => !l.shot)];
    pruneGroups(p);
  });
  store.set({ mode: 'edit', sel: {} });
  return { built: layers.length, missing, streamed };
}

// Lyrics timing actions: transcribe → align to the user's lyrics → (optional) isolate vocals + refine word timing.
import { alignLyrics, applyRefined, fromTranscript, lineEnd, lineStart, toLRC, type AsrSegment, type AsrWord } from '../core/lyrics';
import { uid } from '../core/project';
import type { Cue, Lyrics } from '../core/types';
import { sb, task } from './storyActions';
import { store } from './store';

export interface LyricsTools {
  openai: boolean; transcribeModel: string; python: boolean; demucs: boolean; torchaudio: boolean;
  install: string; vocals: boolean; transcript: boolean; busy: string | null;
}
interface Transcript { model: string; at: string; source: string; language?: string; text: string; words: AsrWord[]; segments: AsrSegment[] }

export const lyricsTools = async (): Promise<LyricsTools> => (await fetch('/api/lyrics/tools')).json();

async function post(url: string, body: unknown): Promise<{ runId: string }> {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

/** wait for a background job (an AI-log run) to finish */
async function waitRun(id: string) {
  store.set({ aiRun: id });
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await (await fetch(`/api/ai/runs/${id}`)).json();
    if (r.status === 'done') return r;
    if (r.status === 'error') throw new Error(r.error ?? 'job failed');
  }
}

const userLyrics = () => sb().brief.lyrics;

function setLyrics(l: Lyrics, model?: string) {
  store.edit((p) => { p.lyrics = { ...l, source: { ...(l.source ?? { kind: '', at: '' }), model } }; });
}

/** Align the stored transcript to the lyrics text (no API call) — rerun after fixing the lyrics. */
export async function alignStored() {
  return task('Aligning lyrics', async () => {
    const r = await fetch('/api/lyrics/transcript');
    if (!r.ok) throw new Error('no transcript yet — run “Transcribe” first');
    const tr: Transcript = await r.json();
    const text = userLyrics();
    const dur = store.state.project.duration;
    const l = text.trim() ? alignLyrics(text, tr.words, dur) : fromTranscript(tr.words, tr.segments);
    setLyrics(l, tr.model);
    return l;
  });
}

export async function transcribe(opts: { useVocals: boolean; language?: string }) {
  return task('Transcribing vocals', async () => {
    const { runId } = await post('/api/lyrics/transcribe', { ...opts, prompt: userLyrics().replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim() });
    await waitRun(runId);
  }).then(() => alignStored());
}

export async function separateVocals() {
  return task('Isolating vocals', async () => {
    const { runId } = await post('/api/lyrics/separate', {});
    await waitRun(runId);
  });
}

/** Local forced alignment of every line (inside its current window) → precise word boundaries. */
export async function refineTiming() {
  const l = store.state.project.lyrics;
  if (!l?.lines.length) return;
  return task('Refining word timing', async () => {
    const lines = l.lines.map((line) => ({ words: line.words.map((w) => w.w), t0: lineStart(line), t1: lineEnd(line) }));
    const { runId } = await post('/api/lyrics/refine', { lines });
    await waitRun(runId);
    const out = await (await fetch('/api/lyrics/refined')).json();
    const cur = store.state.project.lyrics;
    if (!cur) return;
    setLyrics(applyRefined(cur, out.words), 'torchaudio MMS_FA');
  });
}

/** Timed lines → the storyboard brief (LRC), so the AI plans against real timings. */
export function lyricsToBrief() {
  const l = store.state.project.lyrics;
  if (!l?.lines.length) return;
  store.editSB((d) => { d.brief.lyrics = toLRC(l); });
}

// ---- cues -------------------------------------------------------------------------------------------

export function addCue(t: number, label?: string) {
  const p = store.state.project;
  const n = (p.cues?.length ?? 0) + 1;
  const cue: Cue = { id: uid('c'), t: +Math.max(0, Math.min(p.duration, t)).toFixed(3), label: label ?? `C${n}` };
  store.edit((d) => { d.cues = [...(d.cues ?? []), cue].sort((a, b) => a.t - b.t); });
  return cue;
}
export const removeCue = (id: string) => store.edit((d) => { d.cues = (d.cues ?? []).filter((c) => c.id !== id); });
export const renameCue = (id: string, label: string) => store.edit((d) => { const c = d.cues?.find((x) => x.id === id); if (c) c.label = label; }, `cue-label-${id}`);
export const moveCue = (id: string, t: number) =>
  store.edit((d) => { const c = d.cues?.find((x) => x.id === id); if (c) c.t = +Math.max(0, Math.min(d.duration, t)).toFixed(3); d.cues?.sort((a, b) => a.t - b.t); }, `cue-move-${id}`);

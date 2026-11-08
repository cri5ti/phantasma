// Lyric metrics in the editor: the analysis of the working sheet (memoised per edit), the pronunciation dictionary
// (loaded once, lazily) and the AI meaning analysis (cached on the server by block text, mirrored here).
import { useEffect, useMemo, useState } from 'react';
import { setDict } from '../../core/phonetics';
import { analyzeSheet, blockHash, type BlockSemantic, type SheetAnalysis } from '../../core/lyricMetrics';
import type { LyricSheet } from '../../core/types';
import { store, useStore } from '../store';
import { sheet, toast, useSheet } from './state';

// ---- tiny observable values -------------------------------------------------------------------------

function observable<T>(v: T) {
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set: (n: T) => { v = n; subs.forEach((f) => f()); },
    use: (): T => { const [, f] = useState(0); useEffect(() => { const g = () => f((x) => x + 1); subs.add(g); return () => void subs.delete(g); }, []); return v; },
  };
}

// ---- pronunciation dictionary -----------------------------------------------------------------------

const dict = observable<'none' | 'loading' | 'loaded' | 'missing'>('none');
export const useDictState = dict.use;

/** fetch CMUdict once (served from data/cmudict.json when present); the rules fallback stays otherwise */
export async function loadDict() {
  if (dict.get() !== 'none') return;
  dict.set('loading');
  try {
    const r = await fetch('/api/sheet/cmudict');
    if (!r.ok) { dict.set('missing'); return; }
    setDict(await r.json());
    dict.set('loaded');
  } catch { dict.set('missing'); }
}

// ---- AI meaning analysis ----------------------------------------------------------------------------

const sem = observable<Record<string, BlockSemantic>>({});
export const useSem = sem.use;
const meaningBusy = observable(false);
export const useMeaningBusy = meaningBusy.use;

const asked = new Set<string>();
/** pull cached results for blocks we haven't asked about yet (no AI call) */
export async function syncSem(s: LyricSheet) {
  const hashes = [...new Set(s.blocks.map(blockHash))].filter((h) => !asked.has(h) && !sem.get()[h]);
  if (!hashes.length) return;
  hashes.forEach((h) => asked.add(h));
  try {
    const r = await (await fetch('/api/sheet/analysis', { method: 'POST', body: JSON.stringify({ hashes }) })).json();
    if (r.sem && Object.keys(r.sem).length) sem.set({ ...sem.get(), ...r.sem });
  } catch { /* offline: analyse later */ }
}

/** run the AI meaning analysis for changed blocks (cached ones are free) */
export async function runMeaning(provider: 'claude' | 'openai', force = false) {
  if (meaningBusy.get()) return;
  meaningBusy.set(true);
  toast('analysing meaning…');
  try {
    const r = await fetch('/api/sheet/analyze', { method: 'POST', body: JSON.stringify({ sheet: sheet(), provider, force }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    sem.set({ ...sem.get(), ...j.sem });
    toast(j.analysed ? `analysed ${j.analysed} block${j.analysed > 1 ? 's' : ''}` : 'meaning analysis is up to date');
  } catch (e: any) {
    toast(`⚠ ${e?.message ?? e}`);
  } finally {
    meaningBusy.set(false);
  }
}

/** the blocks whose text changed since their meaning was analysed */
export const staleMeaning = (s: LyricSheet, m: Record<string, BlockSemantic>) =>
  s.blocks.filter((b) => b.lines.some((l) => /\p{L}/u.test(l.text)) && !m[blockHash(b)]).length;

// ---- the analysis -----------------------------------------------------------------------------------

export function useAnalysis(): SheetAnalysis {
  const s = useSheet();
  const sung = useStore((x) => x.project.lyrics?.lines);
  const m = useSem();
  const d = useDictState();
  return useMemo(() => analyzeSheet(s, { sung, sem: m }), [s, sung, m, d]);
}

/** for non-React callers (keyboard, AI requests) */
export const currentAnalysis = () => analyzeSheet(sheet(), { sung: store.state.project.lyrics?.lines, sem: sem.get() });

/** heat colour for syllables per second (cool = sparse, hot = dense) */
export function densityColor(sps: number, th = 6) {
  const x = Math.max(0, Math.min(1, sps / th));
  const hue = 210 - x * 210;
  return `hsl(${hue} ${45 + x * 40}% ${38 + x * 14}%)`;
}

/** valence -1..1 → blue … amber */
export const valenceColor = (v: number) => `hsl(${220 - ((v + 1) / 2) * 180} 70% 58%)`;

export const FAM_COLORS = ['#ff8a4d', '#4dd4ff', '#b48cff', '#9be15d', '#ff6b9a', '#ffd84d', '#6be3c8', '#f06bff'];

// Lyrics timing: parse the user's lyrics, align them to a word-timed transcript, fill gaps, export LRC.
// The user's text is the truth for words and line breaks; the transcript only supplies timing.
import { uid } from './project';
import type { LyricLine, LyricWord, Lyrics } from './types';

export interface AsrWord { word: string; start: number; end: number }
export interface AsrSegment { start: number; end: number; text: string }

/** comparison form of a word: lowercase ascii letters/digits, no accents or punctuation */
export const norm = (w: string) =>
  w.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

export const lineStart = (l: LyricLine) => l.words[0]?.t ?? 0;
export const lineEnd = (l: LyricLine) => l.words[l.words.length - 1]?.e ?? 0;
export const lineText = (l: LyricLine) => l.words.map((w) => w.w).join(' ');

/**
 * Lyrics text → lines of words. Strips LRC tags, treats "[Chorus]" / "Verse 2:" style lines as section labels
 * for the lines that follow, skips blank lines.
 */
export function parseLyricsText(text: string): { section?: string; words: string[] }[] {
  const out: { section?: string; words: string[] }[] = [];
  let section: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
    if (!line) continue;
    const head = line.match(/^\[([^\]]+)\]$/) ?? line.match(/^\(?((?:intro|verse|pre-?chorus|chorus|bridge|outro|hook|refrain|interlude|break)[^)]*)\)?:?$/i);
    if (head) { section = head[1].trim(); continue; }
    const words = line.split(/\s+/).filter((w) => norm(w));
    if (words.length) out.push({ section, words });
  }
  return out;
}

/** similarity 0..1 of two normalised words (1 - edit distance / max length) */
function sim(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/**
 * Global alignment (Needleman–Wunsch) of lyric tokens against transcript tokens. Returns for each lyric token the
 * index of the matched transcript word (or -1) and the match similarity.
 */
function alignTokens(lyr: string[], asr: string[]): { j: number; s: number }[] {
  const m = lyr.length, n = asr.length;
  const GAP = 0.6;
  // cost of pairing: near-free for exact/close matches, more than two gaps for unrelated words
  const pairCost = (s: number) => (s >= 0.8 ? 1 - s : s >= 0.5 ? 0.9 - s * 0.6 : 1.6);
  const D = new Float32Array((m + 1) * (n + 1));
  const B = new Uint8Array((m + 1) * (n + 1)); // 0 diag, 1 up (skip lyric), 2 left (skip asr)
  const at = (i: number, j: number) => i * (n + 1) + j;
  for (let i = 1; i <= m; i++) { D[at(i, 0)] = i * GAP; B[at(i, 0)] = 1; }
  for (let j = 1; j <= n; j++) { D[at(0, j)] = j * GAP; B[at(0, j)] = 2; }
  const S = new Float32Array((m + 1) * (n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const s = sim(lyr[i - 1], asr[j - 1]);
      S[at(i, j)] = s;
      const d = D[at(i - 1, j - 1)] + pairCost(s);
      const u = D[at(i - 1, j)] + GAP;
      const l = D[at(i, j - 1)] + GAP;
      if (d <= u && d <= l) { D[at(i, j)] = d; B[at(i, j)] = 0; }
      else if (u <= l) { D[at(i, j)] = u; B[at(i, j)] = 1; }
      else { D[at(i, j)] = l; B[at(i, j)] = 2; }
    }
  }
  const res: { j: number; s: number }[] = Array.from({ length: m }, () => ({ j: -1, s: 0 }));
  let i = m, j = n;
  while (i > 0 || j > 0) {
    const b = B[at(i, j)];
    if (i > 0 && j > 0 && b === 0) {
      const s = S[at(i, j)];
      if (s >= 0.5) res[i - 1] = { j: j - 1, s };
      i--; j--;
    } else if (i > 0 && (j === 0 || b === 1)) i--;
    else j--;
  }
  return res;
}

const AVG_WORD = 0.32; // s, used when placing words the transcript missed

/**
 * Align the user's lyrics to a transcript: matched words take the transcript's timing, the rest are interpolated
 * between their neighbours (kept with their own line when the gap is an instrumental break).
 */
export function alignLyrics(text: string | { section?: string; words: string[] }[], asr: AsrWord[], duration: number): Lyrics {
  const parsed = typeof text === 'string' ? parseLyricsText(text) : text;
  const flat: { li: number; w: string }[] = [];
  parsed.forEach((l, li) => l.words.forEach((w) => flat.push({ li, w })));
  const asrN = asr.map((a) => norm(a.word));
  const match = alignTokens(flat.map((f) => norm(f.w)), asrN);

  const words: LyricWord[] = flat.map((f, k) => {
    const m = match[k];
    if (m.j >= 0) { const a = asr[m.j]; return { w: f.w, t: a.start, e: Math.max(a.end, a.start + 0.05), src: 'asr', p: +m.s.toFixed(2) }; }
    return { w: f.w, t: NaN, e: NaN, src: 'interp', p: 0 };
  });

  // fill runs of unmatched words
  for (let k = 0; k < words.length; ) {
    if (!Number.isNaN(words[k].t)) { k++; continue; }
    let r = k;
    while (r < words.length && Number.isNaN(words[r].t)) r++;
    const prevEnd = k > 0 ? words[k - 1].e : 0;
    const nextStart = r < words.length ? words[r].t : duration;
    const run = words.slice(k, r);
    const need = run.length * AVG_WORD;
    const gap = nextStart - prevEnd;
    if (gap < run.length * 0.15) {
      // the transcript's neighbours swallowed the missed word(s): re-share prev + run + next by word length
      const span = [...(k > 0 ? [words[k - 1]] : []), ...run, ...(r < words.length ? [words[r]] : [])];
      const a = span[0].src === 'interp' ? prevEnd : span[0].t;
      const b = r < words.length ? words[r].e : nextStart;
      const weights = span.map((w) => norm(w.w).length + 2);
      const total = weights.reduce((x, y) => x + y, 0);
      let t = a;
      span.forEach((w, i) => { const d = ((b - a) * weights[i]) / total; w.t = t; w.e = t + d * 0.92; t += d; });
    } else if (gap <= need * 2.5 || gap <= 1.5) {
      // tight gap: share it out by word length
      const weights = run.map((w) => norm(w.w).length + 2);
      const total = weights.reduce((a, b) => a + b, 0);
      let t = prevEnd;
      run.forEach((w, i) => { const d = (gap * weights[i]) / total; w.t = t; w.e = t + d * 0.9; t += d; });
    } else {
      // long gap (instrumental): words of the previous word's line follow it, the rest lead into the next word
      const prevLine = k > 0 ? flat[k - 1].li : -1;
      const head = run.filter((_, i) => flat[k + i].li === prevLine);
      const tail = run.slice(head.length);
      head.forEach((w, i) => { w.t = prevEnd + i * AVG_WORD; w.e = w.t + AVG_WORD * 0.9; });
      tail.forEach((w, i) => { w.t = nextStart - (tail.length - i) * AVG_WORD; w.e = w.t + AVG_WORD * 0.9; });
    }
    k = r;
  }
  // monotonic, non-overlapping, inside the song
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    w.t = Math.max(0, Math.min(duration - 0.05, k > 0 ? Math.max(w.t, words[k - 1].e) : w.t));
    w.e = Math.max(w.t + 0.05, Math.min(duration, w.e));
    w.t = +w.t.toFixed(3); w.e = +w.e.toFixed(3);
  }
  const lines: LyricLine[] = [];
  let k = 0;
  parsed.forEach((l) => { lines.push({ id: uid('ly'), section: l.section, words: words.slice(k, k + l.words.length) }); k += l.words.length; });
  const matched = words.filter((w) => w.src === 'asr').length;
  return { lines, source: { kind: 'aligned', at: new Date().toISOString(), matched, total: words.length } };
}

/**
 * No lyrics text: lines from the transcript. Whisper segments often span several sung lines, so a line also breaks
 * at punctuation in the segment text, at pauses over 0.7 s, and after 10 words.
 */
export function fromTranscript(asr: AsrWord[], segments: AsrSegment[]): Lyrics {
  const lines: LyricLine[] = [];
  const segs = segments.length ? segments : [{ start: 0, end: Infinity, text: '' }];
  let k = 0;
  for (const s of segs) {
    const segWords: AsrWord[] = [];
    while (k < asr.length && asr[k].start < s.end - 0.01) segWords.push(asr[k++]);
    // punctuation from the segment text, matched to the words in order
    const toks = s.text.split(/\s+/).filter((x) => norm(x));
    let ti = 0;
    let cur: LyricWord[] = [];
    const flush = () => { if (cur.length) lines.push({ id: uid('ly'), words: cur }); cur = []; };
    segWords.forEach((a, i) => {
      const prev = cur[cur.length - 1];
      if (prev && (a.start - prev.e > 0.7 || cur.length >= 10)) flush();
      cur.push({ w: a.word.trim(), t: +a.start.toFixed(3), e: +Math.max(a.end, a.start + 0.05).toFixed(3), src: 'asr', p: 1 });
      // advance to this word's token in the text and break after it when it ends a phrase
      while (ti < toks.length && norm(toks[ti]) !== norm(a.word) && ti < i + 3) ti++;
      if (ti < toks.length && norm(toks[ti]) === norm(a.word)) { if (/[,.!?;:]$/.test(toks[ti])) flush(); ti++; }
    });
    flush();
  }
  // keep times ordered (whisper occasionally overlaps)
  const flat = lines.flatMap((l) => l.words);
  for (let i = 1; i < flat.length; i++) if (flat[i].t < flat[i - 1].e) flat[i - 1].e = Math.max(flat[i - 1].t + 0.03, flat[i].t);
  return { lines, source: { kind: 'transcript', at: new Date().toISOString(), matched: k, total: k } };
}

/** Lines → LRC text ([mm:ss.xx] per line), e.g. to feed the storyboard brief. */
export function toLRC(l: Lyrics): string {
  const ts = (t: number) => { const m = Math.floor(t / 60); return `[${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(2).padStart(5, '0')}]`; };
  const out: string[] = [];
  let section: string | undefined;
  for (const line of l.lines) {
    if (line.section && line.section !== section) { out.push(`[${line.section}]`); section = line.section; }
    out.push(`${ts(lineStart(line))} ${lineText(line)}`);
  }
  return out.join('\n');
}

/** Apply refined word timings (same order as the flattened words) from the local forced aligner. */
export function applyRefined(l: Lyrics, refined: ({ t: number; e: number; p: number } | null)[]): Lyrics {
  let k = 0;
  const lines = l.lines.map((line) => ({
    ...line,
    words: line.words.map((w) => {
      const r = refined[k++];
      return r && w.src !== 'manual' ? { ...w, t: +r.t.toFixed(3), e: +r.e.toFixed(3), src: 'aligned' as const, p: +r.p.toFixed(2) } : w;
    }),
  }));
  return { ...l, lines, source: { ...(l.source ?? { kind: 'aligned', at: '' }), kind: 'refined', at: new Date().toISOString() } };
}

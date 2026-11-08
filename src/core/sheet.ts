// Lyric sheet: the writing stage. Structure (blocks) and arrangement layers live in beats; the sheet tempo
// (base bpm + BPM-layer overrides) turns beats into seconds. Pure functions only — shared by editor and server.
import type {
  BlockKind, LyricSheet, SheetBlock, SheetLabel, SheetLine, SheetSpan, SheetTrack, TempoSection, TempoSpan, WordTag,
} from './types';
import { rhymeQuality, rhymeTailKey, syllableCount } from './phonetics';

export const sid = (p = 'x') => `${p}${Math.random().toString(36).slice(2, 8)}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ---- labels / defaults -----------------------------------------------------------------------------

export const LABEL_COLORS = ['#5b8cff', '#ff6b9a', '#ffc14d', '#3ddc97', '#b48cff', '#4dd4ff', '#ff8a4d', '#9be15d', '#f06bff', '#ffd84d', '#6be3c8', '#ff6b6b'];

const DEFAULT_LABELS: [string, SheetLabel['group']][] = [
  ['male', 'voice'], ['female', 'voice'], ['choir', 'voice'], ['harmonies', 'voice'],
  ['piano', 'instrument'], ['guitar', 'instrument'], ['drums', 'instrument'], ['bass', 'instrument'], ['synth', 'instrument'], ['strings', 'instrument'],
  ['soft', 'dynamics'], ['intense', 'dynamics'],
];

export const BLOCK_COLORS: Record<BlockKind, string> = {
  intro: '#6b7a99', verse: '#5b8cff', prechorus: '#b48cff', chorus: '#ff6b9a', bridge: '#ffc14d', outro: '#6b7a99',
  break: '#4b5568', hook: '#ff8a4d', drop: '#ff6b6b', custom: '#3ddc97',
};

export function emptySheet(bpm = 90, beatsPerBar = 4): LyricSheet {
  const labels: SheetLabel[] = DEFAULT_LABELS.map(([name, group], i) => ({ id: sid('lb'), name, group, color: LABEL_COLORS[i % LABEL_COLORS.length] }));
  return {
    style: '', bpm: Math.round(bpm), beatsPerBar, tempo: [], blocks: [], labels, tags: [],
    tracks: [
      { id: sid('tr'), name: 'Vocals', kind: 'mixed', spans: [] },
      { id: sid('tr'), name: 'Instruments', kind: 'mixed', spans: [] },
      { id: sid('tr'), name: 'Energy', kind: 'energy', spans: [], points: [] },
    ],
  };
}

export const EXPORT_DEFAULTS = { layers: 'header' as const, gaps: true, energy: true, styleLimit: 1000, lyricsLimit: 5000 };

// ---- text: segments, directions, headers ----------------------------------------------------------

export type DirCat = 'performance' | 'dynamics' | 'instrument' | 'section' | 'other';
export interface Seg { text: string; kind: 'word' | 'space' | 'dir' | 'adlib' | 'punct'; cat?: DirCat; from: number; to: number }

const SECTION_RE = /^(intro|verse|pre-?chorus|post-?chorus|chorus|bridge|outro|hook|refrain|interlude|break|instrumental|drop|build(?:-?up)?|solo|coda|tag)\b/i;
const CAT_RES: [DirCat, RegExp][] = [
  ['performance', /\b(whisper\w*|spoken|speak\w*|belt\w*|falsetto|rap\w*|shout\w*|scream\w*|harmon\w*|ad-?libs?|hum\w*|chant\w*|breath\w*|vocals?|choir|duet|male|female|sing\w*|croon\w*|growl\w*|layered|call|response|echo)\b/i],
  ['dynamics', /\b(build\w*|intens\w*|drop\w*|quiet\w*|loud\w*|crescendo|fade\w*|swell\w*|ris\w*|soft\w*|explo\w*|climax|calm\w*|half-?time|double-?time|stop\w*|silen\w*|pause|tension|energy|slow\w*|fast\w*|big|huge|minimal|stripped)\b/i],
  ['instrument', /\b(piano|guitar\w*|drums?|bass\w*|synth\w*|strings?|violin|cello|horns?|brass|sax\w*|organ|beat|808s?|percussion|solo|riff|instrumental|pads?|orchestra\w*|bells?|flute|kick|snare|claps?|acoustic|electric)\b/i],
];

export function dirCategory(inner: string): DirCat {
  if (SECTION_RE.test(inner.trim())) return 'section';
  for (const [c, re] of CAT_RES) if (re.test(inner)) return c;
  return 'other';
}

/** Split a line into words, spaces, [directions] and (adlibs), with char offsets. */
export function segments(text: string): Seg[] {
  const out: Seg[] = [];
  const re = /\[[^\]]*\]?|\([^)]*\)?|\s+|[^\s[(]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m[0];
    const from = m.index, to = m.index + s.length;
    if (s[0] === '[') out.push({ text: s, kind: 'dir', cat: dirCategory(s.slice(1, -1)), from, to });
    else if (s[0] === '(') out.push({ text: s, kind: 'adlib', from, to });
    else if (/^\s+$/.test(s)) out.push({ text: s, kind: 'space', from, to });
    else out.push({ text: s, kind: /[\p{L}\p{N}]/u.test(s) ? 'word' : 'punct', from, to });
  }
  return out;
}

export type LineKind = 'lyric' | 'direction' | 'adlib' | 'blank';
export function lineKind(text: string): LineKind {
  const segs = segments(text).filter((s) => s.kind !== 'space');
  if (!segs.length) return 'blank';
  if (segs.some((s) => s.kind === 'word')) return 'lyric';
  if (segs.some((s) => s.kind === 'adlib')) return 'adlib';
  return 'direction';
}

/** the sung words of a line (no directions / adlibs / punctuation) */
export const lyricWords = (text: string) => segments(text).filter((s) => s.kind === 'word').map((s) => s.text);
export const singText = (text: string) => lyricWords(text).join(' ');

export function kindOf(name: string): BlockKind {
  const n = name.toLowerCase();
  if (/^pre-?chorus/.test(n)) return 'prechorus';
  if (/^(post-?chorus|chorus|refrain)/.test(n)) return 'chorus';
  if (/^verse/.test(n)) return 'verse';
  if (/^intro/.test(n)) return 'intro';
  if (/^(outro|coda|tag)/.test(n)) return 'outro';
  if (/^bridge/.test(n)) return 'bridge';
  if (/^hook/.test(n)) return 'hook';
  if (/^drop/.test(n)) return 'drop';
  if (/^(interlude|break|instrumental|solo)/.test(n)) return 'break';
  return 'custom';
}

/** "[Verse 1]", "[Chorus: male, piano]", "Verse 2:", "(Chorus)", "## Bridge" → header; null for a normal line. */
export function parseHeader(line: string): { name: string; kind: BlockKind; extra?: string } | null {
  const t = line.trim();
  let inner: string | null = null;
  let m = t.match(/^\[([^\]]+)\]$/);
  if (m && SECTION_RE.test(m[1].trim())) inner = m[1];
  if (!inner && (m = t.match(/^#{1,3}\s*(.+)$/))) inner = m[1];
  if (!inner && (m = t.match(/^\(?((?:intro|verse|pre-?chorus|post-?chorus|chorus|bridge|outro|hook|refrain|interlude|break|instrumental|drop|build(?:-?up)?)(?:\s*\d+)?)\)?:?$/i))) inner = m[1];
  if (!inner) return null;
  const [head, ...rest] = inner.split(/\s*[:|]\s*|\s+[-–]\s+/);
  const name = head.trim().replace(/\s+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return { name, kind: kindOf(name), extra: rest.join(', ').trim() || undefined };
}

const LRC = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

export interface ParsedBlock { name?: string; kind?: BlockKind; lines: string[]; hint?: number }

/**
 * Pasted lyrics → blocks of lines. A header starts a block, so does a blank line after some lines.
 * LRC stamps are removed (the first one in a block is kept as a timing hint).
 */
export function parseSheetText(text: string): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  let cur: ParsedBlock | null = null;
  const push = () => { if (cur && (cur.lines.length || cur.name)) out.push(cur); cur = null; };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    let hint: number | undefined;
    const line = raw.replace(LRC, (_, mm, ss) => { hint ??= Number(mm) * 60 + Number(ss); return ''; }).trim();
    if (!line) { if (cur?.lines.length) push(); continue; }
    const h = parseHeader(line);
    if (h) {
      push();
      cur = { name: h.name, kind: h.kind, lines: h.extra ? [`[${h.extra}]`] : [], hint };
      continue;
    }
    cur ??= { lines: [], hint };
    if (cur.hint === undefined) cur.hint = hint;
    cur.lines.push(line.replace(/\s+/g, ' '));
  }
  push();
  return out;
}

export const blockText = (b: SheetBlock) => b.lines.map((l) => l.text).join('\n');

/** Plain lyrics with section headers (no layer descriptors) — the storyboard brief / alignment text. */
export function sheetToText(s: LyricSheet): string {
  return sorted(s).map((b) => [`[${b.name}]`, ...b.lines.map((l) => l.text)].join('\n')).join('\n\n');
}

// ---- syllables & rhyme (by sound: CMUdict when loaded, else letter-to-sound rules — see phonetics.ts) -----

/** English syllable count of a word */
export const syllables = (word: string) => syllableCount(word);

export const lineSyllables = (text: string) => lyricWords(text).reduce((a, w) => a + syllables(w), 0);

/** rhyme key of a word: its phones from the last stressed vowel (night → "AY T", fire → "AY ER") */
export const rhymeKey = (word: string) => rhymeTailKey(word);

/** do two line-end words rhyme well enough to share a letter (perfect or slant) */
const rhymes = (a: string, b: string) => { const q = rhymeQuality(a, b); return q === 'perfect' || q === 'slant' || q === 'identity'; };

/** A/B/C letters per lyric line of a block, grouping end words that rhyme (·: no partner in the block) */
export function rhymeLetters(lines: string[]): (string | null)[] {
  const ends = lines.map((t) => { const ws = lyricWords(t); return ws.length ? ws[ws.length - 1] : ''; });
  const group = ends.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
    if (ends[i] && ends[j] && find(i) !== find(j) && rhymes(ends[i], ends[j])) group[find(j)] = find(i);
  }
  const size = new Map<number, number>();
  ends.forEach((e, i) => { if (e) size.set(find(i), (size.get(find(i)) ?? 0) + 1); });
  const letter = new Map<number, string>();
  return ends.map((e, i) => {
    if (!e) return null;
    const r = find(i);
    if (!letter.has(r)) letter.set(r, String.fromCharCode(65 + (letter.size % 26)));
    return letter.get(r)! + ((size.get(r) ?? 0) < 2 ? '·' : '');
  });
}

// ---- clock: beats ↔ seconds ------------------------------------------------------------------------

interface Seg2 { b0: number; b1: number; bpm: number; s0: number }

export class SheetClock {
  private segs: Seg2[] = [];
  readonly offset: number;
  constructor(readonly sheet: Pick<LyricSheet, 'bpm' | 'tempo' | 'offset'>) {
    this.offset = sheet.offset ?? 0;
    const base = sheet.bpm > 0 ? sheet.bpm : 120;
    const spans = [...sheet.tempo].filter((s) => s.len > 0 && s.bpm > 0).sort((a, b) => a.at - b.at);
    let b = 0, s = this.offset;
    const add = (b1: number, bpm: number) => { if (b1 <= b) return; this.segs.push({ b0: b, b1, bpm, s0: s }); s += ((b1 - b) * 60) / bpm; b = b1; };
    for (const sp of spans) {
      const a = Math.max(b, sp.at);
      add(a, base);
      add(sp.at + sp.len, sp.bpm);
    }
    this.segs.push({ b0: b, b1: Infinity, bpm: base, s0: s });
  }
  private segAtBeat(beat: number) {
    if (beat < 0) return this.segs[0];
    return this.segs.find((g) => beat < g.b1) ?? this.segs[this.segs.length - 1];
  }
  bpmAt(beat: number) { return this.segAtBeat(beat).bpm; }
  sec(beat: number) { const g = this.segAtBeat(beat); return g.s0 + ((beat - g.b0) * 60) / g.bpm; }
  beat(sec: number) {
    let g = this.segs[0];
    for (const x of this.segs) { if (sec >= x.s0) g = x; else break; }
    return g.b0 + ((sec - g.s0) * g.bpm) / 60;
  }
}

export const sorted = (s: Pick<LyricSheet, 'blocks'>) => [...s.blocks].sort((a, b) => a.at - b.at);
export const sheetEnd = (s: Pick<LyricSheet, 'blocks'>) => s.blocks.reduce((m, b) => Math.max(m, b.at + b.len), 0);

export function sheetDuration(s: LyricSheet) {
  const c = new SheetClock(s);
  const bs = sorted(s);
  const end = sheetEnd(s);
  let gaps = 0, prev = 0;
  for (const b of bs) { if (b.at > prev) gaps += c.sec(b.at) - c.sec(prev); prev = Math.max(prev, b.at + b.len); }
  return { total: Math.max(0, c.sec(end)), gaps, end };
}

// ---- line timing inside a block -----------------------------------------------------------------

/** start / length (beats) of every line: explicit `beats` win, sung lines share the rest, directions take 0. */
export function lineTimes(b: SheetBlock): { at: number; len: number }[] {
  const kinds = b.lines.map((l) => lineKind(l.text));
  const fixed = b.lines.reduce((a, l) => a + (l.beats ?? 0), 0);
  const share = b.lines.filter((l, i) => l.beats === undefined && (kinds[i] === 'lyric' || kinds[i] === 'adlib')).length;
  const each = share ? Math.max(0, b.len - fixed) / share : 0;
  let t = b.at;
  return b.lines.map((l, i) => {
    const len = l.beats ?? (kinds[i] === 'lyric' || kinds[i] === 'adlib' ? each : 0);
    const r = { at: t, len };
    t += len;
    return r;
  });
}

// ---- editing a block's text -------------------------------------------------------------------------

/** LCS over exact text; unmatched new lines inherit the id of an unmatched old line in the same gap. */
export function matchLines(old: SheetLine[], texts: string[]): SheetLine[] {
  const m = old.length, n = texts.length;
  const L = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = old[i].text === texts[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < m && j < n; ) {
    if (old[i].text === texts[j]) { pairs.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  const out: SheetLine[] = new Array(n);
  let pi = -1, pj = -1;
  const fill = (i0: number, i1: number, j0: number, j1: number) => {
    for (let j = j0, i = i0; j < j1; j++, i++) {
      const o = i < i1 ? old[i] : undefined;
      out[j] = o ? { ...o, text: texts[j] } : { id: sid('l'), text: texts[j] };
    }
  };
  for (const [i, j] of pairs) { fill(pi + 1, i, pj + 1, j); out[j] = { ...old[i] }; pi = i; pj = j; }
  fill(pi + 1, m, pj + 1, n);
  return out;
}

/** Move a tag through an edit of its line (common prefix/suffix diff); null when its text was deleted. */
export function rebaseTag(t: WordTag, oldText: string, newText: string): WordTag | null {
  if (oldText === newText) return t;
  let p = 0;
  while (p < oldText.length && p < newText.length && oldText[p] === newText[p]) p++;
  let s = 0;
  while (s < oldText.length - p && s < newText.length - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++;
  const oldEnd = oldText.length - s, newEnd = newText.length - s, d = newText.length - oldText.length;
  if (t.to <= p) return t;
  if (t.from >= oldEnd) return { ...t, from: t.from + d, to: t.to + d };
  const from = t.from < p ? t.from : p;
  const to = t.to > oldEnd ? t.to + d : newEnd;
  if (to <= from || !newText.slice(from, to).trim()) return null;
  return { ...t, from, to };
}

/** Make every block of a link group carry the lines of `fromId`. */
export function syncLinks(s: LyricSheet, fromId: string) {
  const src = s.blocks.find((b) => b.id === fromId);
  if (!src?.link) return;
  for (const b of s.blocks) if (b !== src && b.link === src.link) b.lines = clone(src.lines);
}

function autoName(s: LyricSheet, kind: BlockKind): string {
  const base = { intro: 'Intro', verse: 'Verse', prechorus: 'Pre-Chorus', chorus: 'Chorus', bridge: 'Bridge', outro: 'Outro', break: 'Break', hook: 'Hook', drop: 'Drop', custom: 'Part' }[kind];
  if (kind !== 'verse' && kind !== 'custom') return base;
  const n = s.blocks.filter((b) => b.kind === kind).length + 1;
  return `${base} ${n}`;
}

/** default length for parsed lines: 2 bars per sung line (min 2 bars), 4 bars for an empty block */
export function defaultLen(lines: string[], bpb: number, kind?: BlockKind) {
  const sung = lines.filter((t) => { const k = lineKind(t); return k === 'lyric' || k === 'adlib'; }).length;
  if (!sung) return (kind === 'intro' || kind === 'outro' || kind === 'break' ? 4 : 4) * bpb;
  return Math.min(32, Math.max(2, sung * 2)) * bpb;
}

/** shift every block starting at/after `from` by `d` beats (and the spans/tempo under them) */
export function ripple(s: LyricSheet, from: number, d: number, except?: string) {
  if (!d) return;
  for (const b of s.blocks) if (b.id !== except && b.at >= from - 1e-6) b.at = Math.max(0, b.at + d);
}

/** blocks sorted, never overlapping (a later block is pushed down) */
export function normalize(s: LyricSheet) {
  s.blocks.sort((a, b) => a.at - b.at);
  let end = 0;
  for (const b of s.blocks) { b.at = Math.max(+b.at.toFixed(4), end); b.len = Math.max(1, +b.len.toFixed(4)); end = b.at + b.len; }
}

export interface ApplyResult { blocks: string[]; map: (off: number) => { block: string; line: string; off: number } | null }

/**
 * Replace a block's text. Headers / blank lines inside split it into new blocks after it (later blocks
 * ripple down). Line ids survive edits, tags are rebased, linked copies follow.
 */
export function applyBlockText(s: LyricSheet, blockId: string, text: string): ApplyResult {
  const b = s.blocks.find((x) => x.id === blockId);
  if (!b) return { blocks: [], map: () => null };
  // keep source offsets per line for mapping editor selections
  const rawLines = text.replace(/\r/g, '').split('\n');
  const offs: number[] = [];
  let acc = 0;
  for (const r of rawLines) { offs.push(acc); acc += r.length + 1; }
  const groups: { header?: ReturnType<typeof parseHeader>; lines: { text: string; off: number }[] }[] = [{ lines: [] }];
  rawLines.forEach((raw, i) => {
    const t = raw.replace(/\s+$/, '');
    const g = groups[groups.length - 1];
    if (!t.trim()) { if (g.lines.length) groups.push({ lines: [] }); return; }
    const h = parseHeader(t);
    if (h) {
      if (g.lines.length || g.header || groups.length > 1) groups.push({ header: h, lines: [] });
      else g.header = h;
      if (h.extra) groups[groups.length - 1].lines.push({ text: `[${h.extra}]`, off: -1 });
      return;
    }
    const lead = raw.length - raw.trimStart().length;
    g.lines.push({ text: t.trim(), off: offs[i] + lead });
  });
  const live = groups.filter((g, i) => i === 0 || g.lines.length || g.header);
  const oldLines = b.lines;
  const first = live[0];
  b.lines = matchLines(oldLines, first.lines.map((l) => l.text));
  if (first.header) { b.name = first.header.name; b.kind = first.header.kind; }
  // tags follow their line
  const byId = new Map(oldLines.map((l) => [l.id, l.text]));
  s.tags = s.tags.flatMap((t) => {
    const nl = b.lines.find((l) => l.id === t.line);
    const ol = byId.get(t.line);
    if (ol === undefined) return [t];
    if (!nl) return s.blocks.some((x) => x !== b && x.lines.some((l) => l.id === t.line)) ? [t] : [];
    const r = rebaseTag(t, ol, nl.text);
    return r ? [r] : [];
  });
  const made: { id: string; lines: SheetLine[]; src: { text: string; off: number }[] }[] = [{ id: b.id, lines: b.lines, src: first.lines }];
  // extra groups → new blocks right after this one
  let at = b.at + b.len;
  const extra = live.slice(1);
  if (extra.length) {
    const lens = extra.map((g) => defaultLen(g.lines.map((l) => l.text), s.beatsPerBar, g.header?.kind));
    ripple(s, at, lens.reduce((a, x) => a + x, 0), b.id);
    extra.forEach((g, i) => {
      const kind = g.header?.kind ?? b.kind;
      const nb: SheetBlock = { id: sid('b'), kind, name: g.header?.name ?? autoName(s, kind), at, len: lens[i], lines: g.lines.map((l) => ({ id: sid('l'), text: l.text })) };
      s.blocks.push(nb);
      made.push({ id: nb.id, lines: nb.lines, src: g.lines });
      at += lens[i];
    });
  }
  if (b.link) {
    if (extra.length) delete b.link; // structure changed: unlink rather than duplicating new blocks
    else syncLinks(s, b.id);
  }
  pruneTags(s);
  normalize(s);
  return {
    blocks: made.map((m) => m.id),
    map: (off) => {
      for (const m of made) for (let i = 0; i < m.src.length; i++) {
        const sl = m.src[i];
        if (sl.off >= 0 && off >= sl.off && off <= sl.off + sl.text.length) return { block: m.id, line: m.lines[i].id, off: off - sl.off };
      }
      return null;
    },
  };
}

/** Parsed blocks → sheet blocks from `at` on. Repeated identical stanzas become linked choruses. */
export function blocksFromParsed(s: LyricSheet, parsed: ParsedBlock[], at: number): SheetBlock[] {
  const out: SheetBlock[] = [];
  const key = (ls: string[]) => ls.map((l) => singText(l).toLowerCase()).join('\n');
  // "[Chorus]" with no lines repeats the last block of that name
  const byName = new Map<string, SheetBlock>();
  const counts = new Map<string, number>();
  for (const p of parsed) if (!p.name && p.lines.length) counts.set(key(p.lines), (counts.get(key(p.lines)) ?? 0) + 1);
  const links = new Map<string, string>();
  for (const p of parsed) {
    let lines = p.lines;
    let name = p.name;
    let kind = p.kind ?? (name ? kindOf(name) : 'verse');
    let link: string | undefined;
    if (name && !lines.length && byName.has(name.toLowerCase())) {
      const src = byName.get(name.toLowerCase())!;
      src.link ??= sid('k');
      link = src.link;
      lines = src.lines.map((l) => l.text);
    } else if (!name && (counts.get(key(lines)) ?? 0) > 1) {
      kind = 'chorus';
      name = 'Chorus';
      const k = key(lines);
      if (!links.has(k)) links.set(k, sid('k'));
      link = links.get(k);
    } else if (name) {
      const prev = byName.get(name.toLowerCase());
      if (prev && key(prev.lines.map((l) => l.text)) === key(lines)) { prev.link ??= sid('k'); link = prev.link; }
    }
    const tmp = { ...s, blocks: [...s.blocks, ...out] };
    const b: SheetBlock = {
      id: sid('b'), kind, name: name ?? autoName(tmp, kind), at, len: defaultLen(lines, s.beatsPerBar, kind),
      lines: [], link,
    };
    const linkedSrc = link ? [...out].reverse().find((x) => x.link === link) : undefined;
    b.lines = linkedSrc ? clone(linkedSrc.lines) : lines.map((t) => ({ id: sid('l'), text: t }));
    if (linkedSrc) b.len = linkedSrc.len;
    out.push(b);
    byName.set(b.name.toLowerCase(), b);
    at += b.len;
  }
  return out;
}

/** Replace the whole sheet's lyrics from pasted text (keeps style, tempo, tracks, labels). */
export function replaceAllText(s: LyricSheet, text: string) {
  const parsed = parseSheetText(text);
  s.blocks = blocksFromParsed({ ...s, blocks: [] }, parsed, 0);
  const ids = new Set(s.blocks.flatMap((b) => b.lines.map((l) => l.id)));
  s.tags = s.tags.filter((t) => ids.has(t.line));
}

// ---- block operations ---------------------------------------------------------------------------

export function addBlock(s: LyricSheet, at: number, kind: BlockKind = 'verse', lenBars = 8, name?: string): SheetBlock {
  const b: SheetBlock = { id: sid('b'), kind, name: name ?? autoName(s, kind), at: Math.max(0, at), len: lenBars * s.beatsPerBar, lines: [] };
  const next = sorted(s).find((x) => x.at >= at);
  if (next && next.at < b.at + b.len) ripple(s, next.at, b.at + b.len - next.at);
  s.blocks.push(b);
  normalize(s);
  return b;
}

export function removeBlock(s: LyricSheet, id: string, closeGap = true) {
  const b = s.blocks.find((x) => x.id === id);
  if (!b) return;
  s.blocks = s.blocks.filter((x) => x !== b);
  const ids = new Set(s.blocks.flatMap((x) => x.lines.map((l) => l.id)));
  s.tags = s.tags.filter((t) => ids.has(t.line));
  if (closeGap) ripple(s, b.at + b.len, -b.len);
  normalize(s);
}

/** Copy of a block inserted after `afterId` (linked: shares lines with the original). */
export function insertCopy(s: LyricSheet, src: SheetBlock, afterId: string | null, linked: boolean): SheetBlock {
  const after = afterId ? s.blocks.find((x) => x.id === afterId) : sorted(s)[s.blocks.length - 1];
  const at = after ? after.at + after.len : 0;
  const c: SheetBlock = clone(src);
  c.id = sid('b');
  c.at = at;
  if (linked) {
    const orig = s.blocks.find((x) => x.id === src.id);
    const link = src.link ?? sid('k');
    if (orig) orig.link = link;
    c.link = link;
  } else {
    delete c.link;
    const idMap = new Map<string, string>();
    c.lines = c.lines.map((l) => { const n = sid('l'); idMap.set(l.id, n); return { ...l, id: n }; });
    s.tags.push(...s.tags.filter((t) => idMap.has(t.line)).map((t) => ({ ...t, id: sid('t'), line: idMap.get(t.line)! })));
  }
  ripple(s, at, c.len);
  s.blocks.push(c);
  normalize(s);
  return c;
}

/** Move block `id` to position `index` in the order; gap sizes stay attached to the slots. */
export function reorderBlock(s: LyricSheet, id: string, index: number) {
  const bs = sorted(s);
  const i = bs.findIndex((b) => b.id === id);
  if (i < 0) return;
  const gaps: number[] = [];
  let prev = 0;
  for (const b of bs) { gaps.push(Math.max(0, b.at - prev)); prev = b.at + b.len; }
  const [b] = bs.splice(i, 1);
  bs.splice(Math.max(0, Math.min(bs.length, index)), 0, b);
  let t = 0;
  bs.forEach((x, k) => { x.at = t + gaps[k]; t = x.at + x.len; });
  s.blocks = bs;
}

/** Unlink a block from its link group (its lines become its own). */
export function unlinkBlock(s: LyricSheet, id: string) {
  const b = s.blocks.find((x) => x.id === id);
  if (!b?.link) return;
  const others = s.blocks.filter((x) => x !== b && x.link === b.link);
  delete b.link;
  if (others.length === 1) delete others[0].link;
  const idMap = new Map<string, string>();
  b.lines = b.lines.map((l) => { const n = sid('l'); idMap.set(l.id, n); return { ...l, id: n }; });
  s.tags.push(...s.tags.filter((t) => idMap.has(t.line)).map((t) => ({ ...t, id: sid('t'), line: idMap.get(t.line)! })));
}

// ---- spans (layers) --------------------------------------------------------------------------------

/** Add / remove a label over [a, b) on a track's spans; spans never overlap, equal neighbours merge. */
export function paintSpans(spans: SheetSpan[], a: number, b: number, label: string, add: boolean): SheetSpan[] {
  if (b < a) [a, b] = [b, a];
  if (b - a < 1e-6) return spans;
  const cuts = new Set<number>([a, b]);
  for (const s of spans) { cuts.add(s.at); cuts.add(s.at + s.len); }
  const pts = [...cuts].sort((x, y) => x - y);
  const segs: { at: number; end: number; labels: string[] }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const x0 = pts[i], x1 = pts[i + 1];
    if (x1 - x0 < 1e-6) continue;
    const mid = (x0 + x1) / 2;
    const set = new Set(spans.filter((s) => mid > s.at && mid < s.at + s.len).flatMap((s) => s.labels));
    if (mid > a && mid < b) { if (add) set.add(label); else set.delete(label); }
    if (set.size) segs.push({ at: x0, end: x1, labels: [...set].sort() });
  }
  const out: SheetSpan[] = [];
  for (const g of segs) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.at + last.len - g.at) < 1e-6 && last.labels.join('|') === g.labels.join('|')) last.len = g.end - last.at;
    else out.push({ id: sid('s'), at: g.at, len: g.end - g.at, labels: g.labels });
  }
  // keep ids of spans that didn't change
  for (const o of out) { const same = spans.find((s) => Math.abs(s.at - o.at) < 1e-6 && Math.abs(s.len - o.len) < 1e-6 && s.labels.join('|') === o.labels.join('|')); if (same) o.id = same.id; }
  return out;
}

export function energyAt(t: SheetTrack, beat: number): number | null {
  const p = t.points ?? [];
  if (!p.length) return null;
  if (beat <= p[0].at) return p[0].v;
  for (let i = 1; i < p.length; i++) if (beat <= p[i].at) { const a = p[i - 1], b = p[i]; return a.v + ((b.v - a.v) * (beat - a.at)) / Math.max(1e-6, b.at - a.at); }
  return p[p.length - 1].v;
}

/** draw the energy curve from (a, va) to (b, vb): points inside are replaced, one point per beat */
export function paintEnergy(points: { at: number; v: number }[], a: number, va: number, b: number, vb: number) {
  if (b < a) { [a, b] = [b, a]; [va, vb] = [vb, va]; }
  const keep = points.filter((p) => p.at < a - 1e-6 || p.at > b + 1e-6);
  const fresh: { at: number; v: number }[] = [];
  const n = Math.max(1, Math.round(b - a));
  for (let i = 0; i <= n; i++) { const t = a + ((b - a) * i) / n; fresh.push({ at: +t.toFixed(3), v: +Math.max(0, Math.min(1, va + ((vb - va) * i) / n)).toFixed(3) }); }
  return [...keep, ...fresh].sort((x, y) => x.at - y.at);
}

/** labels of all tracks that cover ≥ `minShare` of [a, b), in track order */
export function layersIn(s: LyricSheet, a: number, b: number, minShare = 0.25): { track: SheetTrack; labels: { id: string; share: number; from: number; to: number }[] }[] {
  const span = Math.max(1e-6, b - a);
  return s.tracks.filter((t) => t.kind !== 'energy').map((track) => {
    const acc = new Map<string, { cover: number; from: number; to: number }>();
    for (const sp of track.spans) {
      const x0 = Math.max(a, sp.at), x1 = Math.min(b, sp.at + sp.len);
      if (x1 <= x0) continue;
      for (const l of sp.labels) {
        const e = acc.get(l) ?? { cover: 0, from: Infinity, to: -Infinity };
        e.cover += x1 - x0; e.from = Math.min(e.from, sp.at); e.to = Math.max(e.to, sp.at + sp.len);
        acc.set(l, e);
      }
    }
    return { track, labels: [...acc].filter(([, e]) => e.cover / span >= minShare).map(([id, e]) => ({ id, share: e.cover / span, from: e.from, to: e.to })) };
  });
}

export const labelName = (s: LyricSheet, id: string) => s.labels.find((l) => l.id === id)?.name ?? id;

// ---- structure templates -------------------------------------------------------------------------

export interface Template { id: string; name: string; parts: [string, number][] }
export const TEMPLATES: Template[] = [
  { id: 'pop', name: 'Pop — V · PC · C ×2, Bridge, C', parts: [['Intro', 4], ['Verse 1', 8], ['Pre-Chorus', 4], ['Chorus', 8], ['Verse 2', 8], ['Pre-Chorus', 4], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]] },
  { id: 'vc', name: 'Verse / Chorus', parts: [['Intro', 4], ['Verse 1', 16], ['Chorus', 8], ['Verse 2', 16], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]] },
  { id: 'ballad', name: 'Ballad — V V C V C', parts: [['Intro', 4], ['Verse 1', 8], ['Verse 2', 8], ['Chorus', 8], ['Verse 3', 8], ['Chorus', 8], ['Outro', 8]] },
  { id: 'aaba', name: 'AABA (32-bar)', parts: [['Verse 1', 8], ['Verse 2', 8], ['Bridge', 8], ['Verse 3', 8]] },
  { id: 'hiphop', name: 'Hip-hop — Hook / 16s', parts: [['Intro', 4], ['Hook', 8], ['Verse 1', 16], ['Hook', 8], ['Verse 2', 16], ['Hook', 8], ['Outro', 4]] },
  { id: 'edm', name: 'EDM — build / drop', parts: [['Intro', 8], ['Verse 1', 16], ['Build', 8], ['Drop', 16], ['Break', 8], ['Build', 8], ['Drop', 16], ['Outro', 8]] },
];

const KIND_ENERGY: Record<BlockKind, [number, number]> = {
  intro: [0.25, 0.35], verse: [0.4, 0.5], prechorus: [0.5, 0.75], chorus: [0.8, 0.85], bridge: [0.45, 0.6], outro: [0.4, 0.2],
  break: [0.3, 0.3], hook: [0.8, 0.8], drop: [1, 0.95], custom: [0.5, 0.5],
};

/** Append (or, on an empty sheet, lay out) a template. Repeated part names are linked. Seeds the energy curve. */
export function applyTemplate(s: LyricSheet, t: Template) {
  const empty = !s.blocks.some((b) => b.lines.length);
  if (empty) s.blocks = [];
  let at = sheetEnd(s);
  const links = new Map<string, string>();
  const counts = new Map<string, number>();
  t.parts.forEach(([n]) => counts.set(n, (counts.get(n) ?? 0) + 1));
  const made: SheetBlock[] = [];
  for (const [name, bars] of t.parts) {
    const kind = name === 'Build' ? 'prechorus' : kindOf(name);
    let link: string | undefined;
    if ((counts.get(name) ?? 0) > 1) { if (!links.has(name)) links.set(name, sid('k')); link = links.get(name); }
    const b: SheetBlock = { id: sid('b'), kind, name, at, len: bars * s.beatsPerBar, lines: [], link };
    s.blocks.push(b);
    made.push(b);
    at += b.len;
  }
  let en = s.tracks.find((x) => x.kind === 'energy');
  if (!en) { en = { id: sid('tr'), name: 'Energy', kind: 'energy', spans: [], points: [] }; s.tracks.push(en); }
  for (const b of made) {
    const [v0, v1] = KIND_ENERGY[b.kind];
    en.points = paintEnergy(en.points ?? [], b.at, v0, b.at + b.len - 1, v1);
  }
  normalize(s);
}

// ---- export (song generator prompt) ----------------------------------------------------------------

function energyWords(s: LyricSheet, b: SheetBlock): string | null {
  const en = s.tracks.find((t) => t.kind === 'energy' && t.points?.length);
  if (!en) return null;
  const v0 = energyAt(en, b.at) ?? 0, v1 = energyAt(en, b.at + b.len - 1) ?? v0;
  let sum = 0, n = 0;
  for (let x = b.at; x < b.at + b.len; x += 1) { sum += energyAt(en, x) ?? 0; n++; }
  const avg = n ? sum / n : v0;
  const lvl = avg < 0.33 ? 'low energy' : avg < 0.66 ? 'mid energy' : avg < 0.9 ? 'high energy' : 'peak energy';
  if (v1 - v0 > 0.2) return `building, ${lvl}`;
  if (v0 - v1 > 0.2) return `winding down, ${lvl}`;
  return lvl;
}

export function compileExport(s: LyricSheet) {
  const o = { ...EXPORT_DEFAULTS, ...s.exportOpts };
  const bpb = s.beatsPerBar;
  const out: string[] = [];
  let prev = 0;
  for (const b of sorted(s)) {
    const gap = b.at - prev;
    if (o.gaps && gap >= bpb - 1e-6) out.push(`[Instrumental break, ${Math.round(gap / bpb)} bar${Math.round(gap / bpb) === 1 ? '' : 's'}]`, '');
    const lay = layersIn(s, b.at, b.at + b.len).flatMap((x) => x.labels.filter((l) => l.from <= b.at + bpb).map((l) => labelName(s, l.id)));
    const desc = [...new Set(lay)];
    if (o.energy) { const e = energyWords(s, b); if (e) desc.push(e); }
    const d = desc.join(', ');
    if (o.layers === 'header' && d) out.push(`[${b.name}: ${d}]`);
    else { out.push(`[${b.name}]`); if (o.layers === 'line' && d) out.push(`[${d}]`); }
    // labels entering / leaving mid-block become direction lines before the nearest line
    const times = lineTimes(b);
    const events: { at: number; text: string }[] = [];
    if (o.layers !== 'off') for (const tr of s.tracks) for (const sp of tr.spans) {
      for (const l of sp.labels) {
        const name = labelName(s, l);
        const startsHere = sp.at > b.at + bpb - 1e-6 && sp.at < b.at + b.len - 1e-6;
        const endsHere = sp.at + sp.len > b.at + bpb && sp.at + sp.len < b.at + b.len - 1e-6;
        const contBefore = tr.spans.some((x) => x !== sp && x.labels.includes(l) && Math.abs(x.at + x.len - sp.at) < 1e-6);
        const contAfter = tr.spans.some((x) => x !== sp && x.labels.includes(l) && Math.abs(sp.at + sp.len - x.at) < 1e-6);
        if (startsHere && !contBefore) events.push({ at: sp.at, text: `${name} in` });
        if (endsHere && !contAfter) events.push({ at: sp.at + sp.len, text: `${name} out` });
      }
    }
    b.lines.forEach((l, i) => {
      const ev = events.filter((e) => e.at <= times[i].at + 0.5 && e.at > (i ? times[i - 1].at + 0.5 : -Infinity));
      if (ev.length && i > 0) out.push(`[${ev.map((e) => e.text).join(', ')}]`);
      out.push(l.text);
    });
    out.push('');
    prev = b.at + b.len;
  }
  const lyrics = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  let style = s.style.trim();
  if (style && !/\bbpm\b/i.test(style)) style += `, ${Math.round(s.bpm)} bpm`;
  return { style, lyrics, all: `Style:\n${style}\n\nLyrics:\n${lyrics}`, limits: { style: o.styleLimit, lyrics: o.lyricsLimit } };
}

// ---- song link: tempo from analysis, seeding from timed lines ------------------------------------

/** project tempo sections → sheet tempo (base bpm = longest section, beat 0 on a downbeat ≤ 0 s) */
export function tempoFromSections(sections: TempoSection[], bpb = 4): Pick<LyricSheet, 'bpm' | 'offset' | 'tempo' | 'beatsPerBar'> | null {
  const secs = sections.filter((x) => x.bpm > 0);
  if (!secs.length) return null;
  const base = [...secs].sort((a, b) => b.end - b.start - (a.end - a.start))[0].bpm;
  const s0 = secs[0];
  const bars = s0.beatsPerBar || bpb;
  const barSec = (60 / s0.bpm) * bars;
  let offset = ((s0.beatOffset % barSec) + barSec) % barSec;
  if (offset > 1e-3) offset -= barSec;
  const r: Pick<LyricSheet, 'bpm' | 'offset' | 'tempo' | 'beatsPerBar'> = { bpm: +base.toFixed(2), offset: +offset.toFixed(3), tempo: [], beatsPerBar: bars };
  for (const sec of secs) {
    if (Math.abs(sec.bpm - base) < 0.05) continue;
    const c = new SheetClock(r);
    const at = Math.round(c.beat(sec.start));
    const tmp: Pick<LyricSheet, 'bpm' | 'offset' | 'tempo'> = { ...r, tempo: [...r.tempo, { id: 'tmp', at, len: 1e9, bpm: sec.bpm }] };
    const end = Math.round(new SheetClock(tmp).beat(sec.end));
    if (end > at) r.tempo.push({ id: sid('tp'), at, len: end - at, bpm: +sec.bpm.toFixed(2) });
  }
  return r;
}

export interface TimedLine { text: string; t: number; e: number }

/** Lines with real timing (transcript / aligned lyrics) → blocks: split at instrumental gaps, repeats linked. */
export function blocksFromTimed(s: LyricSheet, lines: TimedLine[]): SheetBlock[] {
  const c = new SheetClock(s);
  const bpb = s.beatsPerBar;
  const groups: TimedLine[][] = [];
  for (const l of lines) {
    const g = groups[groups.length - 1];
    const last = g?.[g.length - 1];
    const barSec = (60 / c.bpmAt(c.beat(l.t))) * bpb;
    if (!g || l.t - last!.e > Math.max(barSec * 0.9, 2) || g.length >= 8) groups.push([l]);
    else g.push(l);
  }
  const parsed: ParsedBlock[] = groups.map((g) => ({ lines: g.map((l) => l.text) }));
  const blocks = blocksFromParsed({ ...s, blocks: [] }, parsed, 0);
  blocks.forEach((b, i) => {
    const g = groups[i];
    const a = c.beat(g[0].t), e = c.beat(g[g.length - 1].e);
    const barA = Math.floor(a / bpb) * bpb;
    b.at = a - barA < 1.01 ? barA : Math.floor(a);
    b.len = Math.max(bpb, Math.ceil((e - b.at) / bpb) * bpb);
    b.lines.forEach((l, k) => {
      const nextT = k < g.length - 1 ? c.beat(g[k + 1].t) : b.at + b.len;
      const startB = k === 0 ? b.at : c.beat(g[k].t);
      l.beats = +Math.max(0.5, nextT - startB).toFixed(2);
    });
  });
  // re-sync linked copies (the chorus timings differ slightly; keep the first one's lines)
  const seen = new Set<string>();
  for (const b of blocks) if (b.link) { if (seen.has(b.link)) { const src = blocks.find((x) => x.link === b.link)!; b.lines = clone(src.lines); } seen.add(b.link); }
  const tmp = { ...s, blocks };
  normalize(tmp);
  return tmp.blocks;
}

// ---- diff (library compare) ------------------------------------------------------------------------

export type DiffOp = { op: '=' | '-' | '+'; text: string };
export function diffLines(a: string[], b: string[]): DiffOp[] {
  const m = a.length, n = b.length;
  const L = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ op: '=', text: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < m) out.push({ op: '-', text: a[i++] });
  while (j < n) out.push({ op: '+', text: b[j++] });
  return out;
}

// ---- AI views ------------------------------------------------------------------------------------

const fmtS = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
export const barOf = (s: Pick<LyricSheet, 'beatsPerBar'>, beat: number) => +(beat / s.beatsPerBar + 1).toFixed(2);

export function structureText(s: LyricSheet): string {
  const c = new SheetClock(s);
  const d = sheetDuration(s);
  const lines = [`${s.bpm} bpm base, ${s.beatsPerBar}/4, ${s.tempo.length ? `tempo changes: ${s.tempo.map((t) => `${t.bpm} bpm bars ${barOf(s, t.at)}–${barOf(s, t.at + t.len)}`).join('; ')}, ` : ''}estimated ${fmtS(d.total)} (${fmtS(d.gaps)} of gaps)`];
  let prev = 0;
  for (const b of sorted(s)) {
    if (b.at > prev + 1e-6) lines.push(`  (gap ${+((b.at - prev) / s.beatsPerBar).toFixed(2)} bars)`);
    lines.push(`- ${b.name} [${b.id}] ${b.kind}${b.link ? ` linked:${b.link}` : ''} · bars ${barOf(s, b.at)}–${barOf(s, b.at + b.len)} (${+(b.len / s.beatsPerBar).toFixed(2)} bars, ${fmtS(c.sec(b.at))}–${fmtS(c.sec(b.at + b.len))}) · ${b.lines.length} lines`);
    prev = b.at + b.len;
  }
  return lines.join('\n');
}

export function lyricsText(s: LyricSheet, blockIds?: string[]): string {
  const out: string[] = [];
  for (const b of sorted(s)) {
    if (blockIds && !blockIds.includes(b.id)) continue;
    out.push(`## ${b.name} [${b.id}]${b.link ? ` (linked repeat ${b.link})` : ''}`);
    const letters = rhymeLetters(b.lines.map((l) => l.text));
    b.lines.forEach((l, i) => {
      const k = lineKind(l.text);
      const meta = k === 'lyric' ? ` {${lineSyllables(l.text)} syl${letters[i] ? `, rhyme ${letters[i]![0]}` : ''}}` : '';
      const tags = s.tags.filter((t) => t.line === l.id).map((t) => `${t.kind}${t.label ? `:${t.label}` : ''} "${l.text.slice(t.from, t.to)}"${t.note ? ` (${t.note})` : ''}`);
      out.push(`[${l.id}] ${l.text}${meta}${tags.length ? `  <tags: ${tags.join('; ')}>` : ''}`);
    });
    out.push('');
  }
  return out.join('\n').trim();
}

export function layersText(s: LyricSheet, a = 0, b = Infinity): string {
  const out: string[] = [];
  for (const t of s.tracks) {
    if (t.kind === 'energy') {
      const pts = (t.points ?? []).filter((p) => p.at >= a && p.at <= b);
      if (!pts.length) continue;
      const step = Math.max(1, Math.round(pts.length / 24));
      out.push(`${t.name} (energy 0..1): ${pts.filter((_, i) => i % step === 0).map((p) => `bar ${barOf(s, p.at)}=${p.v.toFixed(2)}`).join(', ')}`);
      continue;
    }
    const spans = t.spans.filter((sp) => sp.at < b && sp.at + sp.len > a);
    out.push(`${t.name} (${t.kind}${t.label ? ` ${labelName(s, t.label)}` : ''}): ${spans.length ? spans.map((sp) => `${sp.labels.map((l) => labelName(s, l)).join('+')} bars ${barOf(s, sp.at)}–${barOf(s, sp.at + sp.len)}`).join('; ') : '(empty)'}`);
  }
  return out.join('\n') || '(no layers)';
}

// ---- more edits: raw text, line moves, splits ------------------------------------------------------

/** drop tags whose line no longer exists or whose range fell outside the text */
export function pruneTags(s: LyricSheet) {
  const lines = new Map(s.blocks.flatMap((b) => b.lines.map((l) => [l.id, l.text] as const)));
  s.tags = s.tags.filter((t) => { const tx = lines.get(t.line); return tx !== undefined && t.from < t.to && t.to <= tx.length; });
}

/** Set a block's lines from texts: ids kept where text matches, tags rebased, linked copies follow. */
export function setLines(s: LyricSheet, b: SheetBlock, texts: string[]) {
  const old = b.lines;
  b.lines = matchLines(old, texts);
  const byId = new Map(old.map((l) => [l.id, l.text]));
  s.tags = s.tags.flatMap((t) => {
    const ol = byId.get(t.line);
    if (ol === undefined) return [t];
    const nl = b.lines.find((l) => l.id === t.line);
    if (!nl) return [];
    const r = rebaseTag(t, ol, nl.text);
    return r ? [r] : [];
  });
  if (b.link) syncLinks(s, b.id);
}

/**
 * Whole-sheet text edit (Raw view). Blocks are matched to the existing ones by name sequence, so inserting or
 * removing a section keeps the ids, tags and positions of everything else.
 */
export function applyRawText(s: LyricSheet, text: string) {
  const parsed = parseSheetText(text);
  const ex = sorted(s);
  const names = parsed.map((p, i) => (p.name ?? `\u0000${i}`).toLowerCase());
  const ops = diffLines(ex.map((b) => b.name.toLowerCase()), names);
  let ei = 0, pi = 0, cursor = 0;
  for (const op of ops) {
    if (op.op === '=') {
      const b = ex[ei++], p = parsed[pi++];
      if (p.kind) b.kind = p.kind;
      if (p.lines.length || !b.link) setLines(s, b, p.lines);
      cursor = b.at + b.len;
    } else if (op.op === '-') {
      const b = ex[ei++];
      s.blocks = s.blocks.filter((x) => x !== b);
      ripple(s, b.at + b.len, -b.len);
      cursor = Math.min(cursor, b.at);
    } else {
      const p = parsed[pi++];
      const src = !p.lines.length && p.name ? s.blocks.find((x) => x.name.toLowerCase() === p.name!.toLowerCase() && x.lines.length) : undefined;
      const nb: SheetBlock = src
        ? { ...clone(src), id: sid('b'), at: cursor, link: src.link ?? (src.link = sid('k')) }
        : blocksFromParsed(s, [p], cursor)[0];
      ripple(s, cursor, nb.len);
      s.blocks.push(nb);
      cursor += nb.len;
    }
  }
  pruneTags(s);
  normalize(s);
}

/** Move a line up / down; past the block edge it moves into the neighbouring block. */
export function moveLine(s: LyricSheet, blockId: string, lineId: string, dir: -1 | 1): { block: string; line: string } | null {
  const bs = sorted(s);
  const bi = bs.findIndex((b) => b.id === blockId);
  const b = bs[bi];
  const i = b?.lines.findIndex((l) => l.id === lineId) ?? -1;
  if (!b || i < 0) return null;
  const j = i + dir;
  if (j >= 0 && j < b.lines.length) {
    [b.lines[i], b.lines[j]] = [b.lines[j], b.lines[i]];
    if (b.link) syncLinks(s, b.id);
    return { block: b.id, line: lineId };
  }
  const nb = bs[bi + dir];
  if (!nb) return null;
  const [l] = b.lines.splice(i, 1);
  if (dir < 0) nb.lines.push(l); else nb.lines.unshift(l);
  if (b.link) syncLinks(s, b.id);
  if (nb.link) syncLinks(s, nb.id);
  return { block: nb.id, line: lineId };
}

/** Split a block before line `index` (that line starts a new block); lengths split at the line's planned start. */
export function splitBlock(s: LyricSheet, blockId: string, index: number): SheetBlock | null {
  const b = s.blocks.find((x) => x.id === blockId);
  if (!b || index <= 0 || index >= b.lines.length) return null;
  if (b.link) unlinkBlock(s, b.id);
  const t = lineTimes(b)[index].at - b.at;
  const bpb = s.beatsPerBar;
  const first = Math.min(b.len - 1, Math.max(bpb, Math.round(t / bpb) * bpb));
  const nb: SheetBlock = { id: sid('b'), kind: b.kind, name: autoName(s, b.kind), at: b.at + first, len: Math.max(1, b.len - first), lines: b.lines.slice(index) };
  b.lines = b.lines.slice(0, index);
  b.len = first;
  s.blocks.push(nb);
  normalize(s);
  return nb;
}

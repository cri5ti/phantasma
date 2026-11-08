// Lyric metrics: a profile of the sheet (structure, rhythm against the tempo, rhyme by sound, repetition and hooks,
// singability, perspective), findings with switchable rules, the lyrical fingerprint, checks for AI proposals and
// measurements of what the produced song actually sang. Pure functions, shared by the editor and the server.
// Every number is an amount ("how much"), never a grade; findings flag mismatches only.
import {
  lineKind, lineTimes, lyricWords, rhymeLetters, segments, sorted, SheetClock, parseSheetText, defaultLen, kindOf,
  type LineKind,
} from './sheet';
import {
  normWord, onset, phoneticsVersion, pron, rhymeQuality, rhymeTail, stressedVowel, sustainOf, FUNCTION_WORDS, OPENNESS,
  PLOSIVE, SIBILANT, VOWELS, type Pron, type RhymeQuality,
} from './phonetics';
import type { BlockKind, BlockShape, LyricLine, LyricSheet, SheetBlock } from './types';

// ---- per line text (cached by text) ---------------------------------------------------------------

export interface WordInfo { w: string; n: string; from: number; to: number; p: Pron; func: boolean }
export interface LineText {
  words: WordInfo[];
  syl: number;
  /** x = unstressed, / = stressed, per syllable */
  stress: string;
  /** words whose pronunciation was estimated by rules */
  est: string[];
  end: WordInfo | null;
  /** rhyme tail of the end word ("AY T") */
  tail: string;
  /** vowel per syllable */
  vowels: string[];
  consonants: number; plosives: number; sibilants: number; phones: number;
  /** mean openness of the stressed vowels, 0..1 */
  openness: number;
  sustain: { vowel: string; open: boolean } | null;
  /** unstressed syllables before the first stress (a pickup) */
  pickup: number;
  pronouns: Pronouns;
  tense: 'past' | 'present' | 'future' | null;
  /** ends on a word that wants a continuation (the, and, of, my…) */
  enjambed: boolean;
  /** pairs of neighbouring content words sharing their first sound */
  alliteration: number;
}
export interface Pronouns { i: number; you: number; we: number; they: number; third: number }

const P_I = new Set(['i', 'me', 'my', 'mine', 'myself', 'im', 'ive', 'id']);
const P_YOU = new Set(['you', 'your', 'yours', 'yourself', 'youre', 'youve', 'youll', 'ya', 'yall']);
const P_WE = new Set(['we', 'us', 'our', 'ours', 'ourselves']);
const P_THEY = new Set(['they', 'them', 'their', 'theirs', 'theyre']);
const P_3 = new Set(['he', 'him', 'his', 'she', 'her', 'hers', 'hes', 'shes']);
const FUTURE = new Set(['will', 'gonna', 'shall', 'wont', 'ill', 'youll', 'well', 'theyll', 'someday', 'tomorrow']);
const PAST = new Set(('was were had did didnt wasnt werent used went came saw said told knew felt left lost found gave took made ' +
  'thought fell ran held kept broke wrote spoke stood sang began became heard met brought caught taught chose drove flew grew ' +
  'threw wore tore woke shook hid slept swore yesterday ago once').split(' '));
const PRESENT = new Set(['am', 'is', 'are', 'im', 'youre', 'were', 'theyre', 'its', 'do', 'does', 'dont', 'doesnt', 'have', 'has', 'now', 'today', 'tonight']);
const ENJAMB = new Set(('the a an and or but of to in on at for from with my your our their his her its this that these those as if ' +
  'when where while than into through like').split(' '));

let textCache = new Map<string, LineText>();
let cacheVer = -1;

export function lineText(text: string): LineText {
  if (cacheVer !== phoneticsVersion()) { textCache = new Map(); cacheVer = phoneticsVersion(); }
  const hit = textCache.get(text);
  if (hit) return hit;
  if (textCache.size > 6000) textCache = new Map();
  const words: WordInfo[] = segments(text).filter((s) => s.kind === 'word').map((s) => {
    const n = normWord(s.text);
    return { w: s.text, n, from: s.from, to: s.to, p: pron(s.text), func: FUNCTION_WORDS.has(n) };
  }).filter((w) => w.n);
  let stress = '', consonants = 0, plosives = 0, sibilants = 0, phones = 0, openSum = 0, openN = 0;
  const vowels: string[] = [];
  const pr: Pronouns = { i: 0, you: 0, we: 0, they: 0, third: 0 };
  let fut = 0, past = 0, pres = 0;
  for (const w of words) {
    w.p.st.forEach((st) => { stress += st > 0 && !(w.func && w.p.st.length === 1) ? '/' : 'x'; });
    for (const ph of w.p.ph) {
      phones++;
      if (VOWELS.has(ph)) vowels.push(ph);
      else { consonants++; if (PLOSIVE.has(ph)) plosives++; if (SIBILANT.has(ph)) sibilants++; }
    }
    const sv = stressedVowel(w.p);
    if (sv && !w.func) { openSum += OPENNESS[sv] ?? 0.5; openN++; }
    if (P_I.has(w.n)) pr.i++; else if (P_YOU.has(w.n)) pr.you++; else if (P_WE.has(w.n)) pr.we++; else if (P_THEY.has(w.n)) pr.they++; else if (P_3.has(w.n)) pr.third++;
    if (FUTURE.has(w.n)) fut++;
    else if (PAST.has(w.n) || (w.n.length >= 5 && /[^e]ed$/.test(w.n))) past++;
    else if (PRESENT.has(w.n)) pres++;
  }
  const end = words[words.length - 1] ?? null;
  let allit = 0;
  const content = words.filter((w) => !w.func);
  for (let k = 1; k < content.length; k++) { const a = onset(content[k - 1].p), b = onset(content[k].p); if (a && a === b) allit++; }
  const trimmed = text.replace(/\s*(\[[^\]]*\]|\([^)]*\))\s*$/g, '').trim();
  const r: LineText = {
    words, syl: stress.length, stress, est: words.filter((w) => w.p.est).map((w) => w.w),
    end, tail: end ? rhymeTail(end.p).join(' ') : '', vowels, consonants, plosives, sibilants, phones,
    openness: openN ? openSum / openN : 0.5,
    sustain: end ? sustainOf(end.p) : null,
    pickup: stress.indexOf('/') < 0 ? 0 : stress.indexOf('/'),
    pronouns: pr,
    tense: fut ? 'future' : past > pres ? 'past' : pres ? 'present' : past ? 'past' : null,
    enjambed: !!end && ENJAMB.has(end.n) && !/[.!?,;:—–-]$/.test(trimmed),
    alliteration: allit,
  };
  textCache.set(text, r);
  return r;
}

// ---- rules ------------------------------------------------------------------------------------------

export type Category = 'rhythm' | 'rhyme' | 'repetition' | 'sound' | 'language' | 'targets' | 'meaning' | 'sung';
export interface RuleDef { id: string; cat: Category; label: string; on: boolean; th?: number; unit?: string; help: string }

export const RULES: RuleDef[] = [
  { id: 'dense', cat: 'rhythm', label: 'Too dense for the tempo', on: true, th: 6, unit: 'syl/s', help: 'more syllables per second than the tempo leaves room for (planned line length)' },
  { id: 'breath', cat: 'rhythm', label: 'No room to breathe', on: true, th: 5, unit: 's', help: 'a sung stretch with no rest longer than this' },
  { id: 'meter-drift', cat: 'rhythm', label: 'Syllables drift from the sibling section', on: true, th: 3, unit: 'syl', help: 'a line differs from the same line of the first section of its kind by this many syllables' },
  { id: 'stress-drift', cat: 'rhythm', label: 'Stress pattern differs from the sibling line', on: false, th: 0.6, unit: 'match', help: 'stress pattern similarity with the matching sibling line below this' },
  { id: 'near-dup', cat: 'repetition', label: 'Unlinked copies and near-copies', on: true, help: 'identical sections that are not linked, sections that are variants of each other' },
  { id: 'rhyme-break', cat: 'rhyme', label: 'Rhyme scheme differs from the sibling section', on: false, help: 'e.g. verse 1 is AABB, verse 2 ABAB' },
  { id: 'sustain', cat: 'sound', label: 'Closed vowel on a long note', on: false, help: 'a short vowel closed by a consonant (it, stuck) where the line leaves time to hold the last note' },
  { id: 'articulation', cat: 'sound', label: 'Hard to articulate at the tempo', on: false, th: 14, unit: 'consonants/s', help: 'consonant sounds per sung second' },
  { id: 'sibilance', cat: 'sound', label: 'Sibilant-heavy line', on: false, th: 0.22, unit: 'share', help: 's / z / sh / ch sounds as a share of all sounds (harsh in the mix)' },
  { id: 'perspective', cat: 'language', label: 'Perspective shift', on: false, help: 'a section speaks from another person (I / you / we / they) than the previous one of its kind' },
  { id: 'tense', cat: 'language', label: 'Tense shift', on: false, help: 'a section moves to another tense than the previous one of its kind' },
  { id: 'shape', cat: 'targets', label: 'Off the reference shape', on: true, th: 2, unit: 'syl', help: 'line syllables differ from the block’s target shape by this many' },
  { id: 'target', cat: 'targets', label: 'Section targets', on: true, help: 'density, repetition and open line endings against the targets set per section kind' },
  { id: 'cliche', cat: 'meaning', label: 'Cliché / predictable phrase (AI)', on: true, help: 'from the AI meaning analysis' },
  { id: 'sung', cat: 'sung', label: 'Sung differently than planned', on: true, help: 'lines the song rushed, stretched or didn’t sing as written (after alignment)' },
  { id: 'sung-stress', cat: 'sung', label: 'Stresses off the beat (song)', on: false, th: 0.4, unit: 'share on beat', help: 'stressed syllables landing on the beat grid, from the aligned song' },
];
export const RULE = Object.fromEntries(RULES.map((r) => [r.id, r])) as Record<string, RuleDef>;
export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'rhythm', label: 'Rhythm' }, { id: 'rhyme', label: 'Rhyme' }, { id: 'repetition', label: 'Repetition' }, { id: 'sound', label: 'Sound' },
  { id: 'language', label: 'Language' }, { id: 'targets', label: 'Targets' }, { id: 'meaning', label: 'Meaning' }, { id: 'sung', label: 'Song' },
];

export const ruleOn = (s: Pick<LyricSheet, 'lint'>, id: string) => s.lint?.rules?.[id]?.on ?? RULE[id]?.on ?? false;
export const ruleTh = (s: Pick<LyricSheet, 'lint'>, id: string) => s.lint?.rules?.[id]?.th ?? RULE[id]?.th ?? 0;

// ---- analysis types ---------------------------------------------------------------------------------

export interface LineM {
  key: string; block: string; line: string; idx: number; kind: LineKind; text: string; t: LineText;
  /** planned position / length in beats, seconds */
  at: number; len: number; sec: number; dur: number;
  /** syllables per beat / per second */
  density: number; sps: number;
  /** estimated sung seconds (eighth-note pace, capped by the line) and the rest after them */
  sung: number; rest: number;
  letter: string | null; rq: RhymeQuality | null; partner: number | null;
  /** trailing syllables whose vowels match the partner (2+ = multisyllabic rhyme) */
  multi: number;
  /** content words inside the line rhyming with another word nearby */
  internal: number;
  /** the last note can be held (room left in the line, or a rest after) */
  sustained: boolean;
  /** matching line of the first section of the same kind */
  ref?: { block: string; name: string; idx: number; syl: number; stress: string };
  /** shape target syllables */
  target?: number;
  /** sound-view marks: word ranges sharing a rhyme family within the block */
  marks: { from: number; to: number; fam: number }[];
}

export type Meter = 'iambic' | 'trochaic' | 'anapestic' | 'dactylic' | 'mixed';
export interface Dims { consistency: number; rhyme: number; repetition: number; flow: number; imagery: number | null; narrative: number | null }
export const DIM_LABELS: [keyof Dims, string][] = [
  ['consistency', 'syllable consistency'], ['rhyme', 'rhyme density'], ['repetition', 'repetition'], ['flow', 'phonetic flow'], ['imagery', 'imagery'], ['narrative', 'narrative progression'],
];

export interface BlockM {
  id: string; name: string; kind: BlockKind; link?: string; at: number; len: number; bars: number; sec: number; dur: number;
  lines: LineM[]; sung: LineM[];
  syllables: number[]; stress: string[]; rhyme: string; density: number[]; sustain: ('open' | 'closed' | null)[];
  repetition: number; lexical: number; breathMax: number; restShare: number;
  meter: Meter | null; meterFit: number; openness: number; rhymeDensity: number; internal: number; multi: number;
  alliteration: number; anaphora: number; epistrophe: number; enjambment: number;
  pronouns: Pronouns; perspective: keyof Pronouns | null; tense: LineText['tense'];
  articulation: number; sibilance: number; plosive: number;
  hash: string; sem?: BlockSemantic; dims: Dims;
  shape?: BlockShape;
  /** plan vs sung (after alignment) */
  song?: { lines: number; rushed: number; stretched: number; dropped: number; onBeat: number | null };
}

export interface HookPos { block: string; line: string; beat: number; sec: number }
export interface Hook { text: string; n: number; count: number; at: HookPos[]; firstSec: number; chorusShare: number }
export interface Breath { from: number; to: number; sec: number; block: string; keys: string[] }
export interface NearDup { kind: 'identical' | 'variant'; a: string; b: string; changed: number[]; total: number }
export interface LineDup { a: string; b: string; from: string; to: string }

export interface SongSung { key: string; block: string; line: string; t0: number; t1: number; planned: [number, number]; sps: number; plannedSps: number; flag: 'rushed' | 'stretched' | 'dropped' | null; matched: number; words: number; onBeat: number | null; stressed: number }

export interface SongM {
  sections: string[]; sectionText: string;
  sec: number; firstChorus: number | null; firstHook: number | null;
  repetition: number; lexical: number; rhymeFamilies: number; chorusConsistency: number | null;
  density: number; sps: number; dims: Dims;
}

export type FindingFix = { kind: 'link'; a: string; b: string };
export interface Finding { id: string; rule: string; cat: Category; level: 'warn' | 'info'; block: string; line?: string; key?: string; msg: string; detail?: string; fix?: FindingFix }

export interface SheetAnalysis {
  blocks: BlockM[];
  byKey: Map<string, LineM>;
  hooks: Hook[];
  hook: Hook | null;
  breaths: Breath[];
  dups: NearDup[];
  lineDups: LineDup[];
  song: SongM;
  sung: SongSung[];
  /** all findings (enabled rules) and how many each disabled rule would add */
  findings: Finding[];
  hidden: Record<string, number>;
}

/** AI meaning analysis of one block (cached server-side by block hash) */
export interface BlockSemantic {
  summary: string;
  /** 0..1: how much new information / story movement */
  advances: number;
  valence: number;
  intensity: number;
  emotions: string[];
  concreteness: number;
  imagery: number;
  metaphor: number;
  imageWords: string[];
  cliches: { text: string; why: string }[];
  coherence: number;
  lines: { i: number; valence: number; intensity: number }[];
}

// ---- helpers ------------------------------------------------------------------------------------

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmtS = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0')}`;
export const normLine = (text: string) => lyricWords(text).map(normWord).filter(Boolean).join(' ');
const sungKind = (k: LineKind) => k === 'lyric';

/** FNV-1a of the block's text (the semantic cache key) */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
export const blockHash = (b: SheetBlock) => textHash(b.lines.map((l) => l.text).join('\n'));

const FEET: [Meter, string][] = [['iambic', 'x/'], ['trochaic', '/x'], ['anapestic', 'xx/'], ['dactylic', '/xx']];
function footFit(stress: string, foot: string): number {
  if (stress.length < 3) return 0;
  let best = 0;
  for (let ph = 0; ph < foot.length; ph++) {
    let ok = 0;
    for (let i = 0; i < stress.length; i++) if (stress[i] === foot[(i + ph) % foot.length]) ok++;
    best = Math.max(best, ok / stress.length);
  }
  return best;
}

/** similarity of two stress patterns, 0..1 (aligned on the end — lines land on the downbeat) */
export function stressSimilarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const n = Math.max(a.length, b.length);
  let ok = 0;
  for (let i = 1; i <= Math.min(a.length, b.length); i++) if (a[a.length - i] === b[b.length - i]) ok++;
  return ok / n;
}

function wordEdit(a: string[], b: string[]): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

const CODE: Record<BlockKind, string> = { intro: 'I', verse: 'V', prechorus: 'PC', chorus: 'C', bridge: 'B', outro: 'O', break: 'Br', hook: 'H', drop: 'D', custom: 'X' };

// ---- the analysis -------------------------------------------------------------------------------

export interface AnalyzeOpts {
  /** aligned song lines (project.lyrics.lines with `sheet` back-refs) */
  sung?: LyricLine[];
  /** AI meaning analysis by block hash */
  sem?: Record<string, BlockSemantic>;
}

const memo = new WeakMap<LyricSheet, { key: unknown[]; a: SheetAnalysis }>();

export function analyzeSheet(s: LyricSheet, opts: AnalyzeOpts = {}): SheetAnalysis {
  const key = [phoneticsVersion(), opts.sung, opts.sem];
  const hit = memo.get(s);
  if (hit && hit.key.every((k, i) => k === key[i])) return hit.a;
  const a = compute(s, opts);
  memo.set(s, { key, a });
  return a;
}

function compute(s: LyricSheet, opts: AnalyzeOpts): SheetAnalysis {
  const clock = new SheetClock(s);
  const bs = sorted(s);
  const byKey = new Map<string, LineM>();
  const firstOfKind = new Map<BlockKind, SheetBlock>();
  for (const b of bs) if (b.lines.some((l) => lineKind(l.text) === 'lyric') && !firstOfKind.has(b.kind)) firstOfKind.set(b.kind, b);

  // song-wide repetition counts (per instance: linked copies count each time they're sung)
  const occ = new Map<string, number>();
  for (const b of bs) for (const l of b.lines) if (sungKind(lineKind(l.text))) { const n = normLine(l.text); if (n) occ.set(n, (occ.get(n) ?? 0) + 1); }

  const blocks: BlockM[] = bs.map((b, bi) => {
    const times = lineTimes(b);
    const texts = b.lines.map((l) => l.text);
    const letters = rhymeLetters(texts);
    const ref = firstOfKind.get(b.kind);
    const sameGroup = !ref || ref.id === b.id || (!!ref.link && ref.link === b.link);
    const refLyric = ref && !sameGroup ? ref.lines.filter((l) => sungKind(lineKind(l.text))) : [];
    const next = bs[bi + 1];
    const blockEnd = b.at + b.len;
    const restAfterBlock = next ? clock.sec(next.at) - clock.sec(blockEnd) : 4;
    let sungIdx = 0;
    const lines: LineM[] = b.lines.map((l, i) => {
      const kind = lineKind(l.text);
      const t = lineText(l.text);
      const tm = times[i];
      const sec = clock.sec(tm.at), dur = clock.sec(tm.at + tm.len) - sec;
      const eighth = 30 / clock.bpmAt(tm.at);
      const isSung = sungKind(kind);
      const sung = isSung ? Math.min(dur, t.syl * eighth) : 0;
      const lastSung = !b.lines.slice(i + 1).some((x) => sungKind(lineKind(x.text)));
      const rest = isSung ? dur - sung + (lastSung ? restAfterBlock : 0) : 0;
      const m: LineM = {
        key: `${b.id}:${l.id}`, block: b.id, line: l.id, idx: i, kind, text: l.text, t,
        at: tm.at, len: tm.len, sec, dur,
        density: isSung && tm.len > 0 ? t.syl / tm.len : 0, sps: isSung && dur > 0 ? t.syl / dur : 0,
        sung, rest, letter: letters[i], rq: null, partner: null, multi: 0, internal: 0,
        sustained: isSung && rest >= Math.max(0.5, eighth * 2),
        marks: [],
      };
      if (isSung) {
        const r = refLyric[sungIdx];
        if (r) { const rt = lineText(r.text); m.ref = { block: ref!.id, name: ref!.name, idx: ref!.lines.indexOf(r), syl: rt.syl, stress: rt.stress }; }
        if (b.shape?.syl[sungIdx] !== undefined) m.target = b.shape.syl[sungIdx];
        sungIdx++;
      }
      byKey.set(m.key, m);
      return m;
    });
    const sung = lines.filter((x) => sungKind(x.kind));

    // rhyme partners + quality, multisyllabic matches
    sung.forEach((m, k) => {
      if (!m.letter || m.letter.endsWith('·') || !m.t.end) return;
      const L = m.letter[0];
      const before = [...sung.slice(0, k)].reverse().find((x) => x.letter?.[0] === L);
      const p = before ?? sung.slice(k + 1).find((x) => x.letter?.[0] === L);
      if (!p?.t.end) return;
      m.partner = p.idx;
      m.rq = rhymeQuality(m.t.end.w, p.t.end.w);
      const va = m.t.vowels, vb = p.t.vowels;
      let n = 0;
      while (n < Math.min(va.length, vb.length, 4) && va[va.length - 1 - n] === vb[vb.length - 1 - n]) n++;
      m.multi = n;
    });
    // rhyme families inside the block (sound view + internal rhymes): stressed tails shared by 2+ distinct words
    const famWords = new Map<string, Set<string>>();
    for (const m of sung) for (const w of m.t.words) {
      if (w.func && w !== m.t.end) continue;
      const tail = rhymeTail(w.p).join(' ');
      if (!tail || tail.split(' ').length < 2 && !VOWELS.has(tail)) continue;
      if (!famWords.has(tail)) famWords.set(tail, new Set());
      famWords.get(tail)!.add(w.n);
    }
    const fams = [...famWords].filter(([, ws]) => ws.size >= 2).map(([t]) => t);
    const famIdx = new Map(fams.map((t, i) => [t, i]));
    for (const m of sung) {
      const ends = new Set([m.t.tail, ...sung.filter((x) => Math.abs(x.idx - m.idx) <= 2 && x !== m).map((x) => x.t.tail)]);
      for (const w of m.t.words) {
        if (w.func && w !== m.t.end) continue;
        const tail = rhymeTail(w.p).join(' ');
        const f = famIdx.get(tail);
        if (f !== undefined) m.marks.push({ from: w.from, to: w.to, fam: f });
        if (w !== m.t.end && f !== undefined && (ends.has(tail) || m.t.words.some((o) => o !== w && o.n !== w.n && !o.func && rhymeTail(o.p).join(' ') === tail))) m.internal++;
      }
    }

    const syl = sung.map((x) => x.t.syl);
    const words = sung.flatMap((x) => x.t.words.map((w) => w.n));
    const breathRuns: number[] = [];
    let run = 0;
    for (const m of sung) { run += m.sung; if (m.rest > 0.4) { breathRuns.push(run); run = 0; } else run += Math.max(0, m.rest); }
    if (run) breathRuns.push(run);
    const fit = FEET.map(([name, foot]) => [name, mean(sung.filter((x) => x.t.syl >= 3).map((x) => footFit(x.t.stress, foot)))] as const).sort((p, q) => q[1] - p[1])[0];
    const firsts = sung.map((x) => x.t.words.slice(0, x.t.words[0]?.func ? 2 : 1).map((w) => w.n).join(' '));
    const lasts = sung.map((x) => x.t.end?.n ?? '');
    const dupCount = (xs: string[]) => { const c = new Map<string, number>(); xs.filter(Boolean).forEach((x) => c.set(x, (c.get(x) ?? 0) + 1)); return [...c.values()].filter((v) => v > 1).reduce((acc, v) => acc + v, 0); };
    const pr: Pronouns = { i: 0, you: 0, we: 0, they: 0, third: 0 };
    sung.forEach((x) => (Object.keys(pr) as (keyof Pronouns)[]).forEach((k) => { pr[k] += x.t.pronouns[k]; }));
    const persp = (Object.keys(pr) as (keyof Pronouns)[]).sort((p, q) => pr[q] - pr[p])[0];
    const tenses = sung.map((x) => x.t.tense).filter(Boolean) as string[];
    const tense = (['past', 'present', 'future'] as const).map((t) => [t, tenses.filter((x) => x === t).length] as const).sort((p, q) => q[1] - p[1])[0];
    const sungSec = sung.reduce((acc, x) => acc + x.sung, 0);
    const cons = sung.reduce((acc, x) => acc + x.t.consonants, 0), phones = sung.reduce((acc, x) => acc + x.t.phones, 0);
    const sylMean = mean(syl);
    const cv = syl.length > 1 && sylMean ? Math.sqrt(mean(syl.map((v) => (v - sylMean) ** 2))) / sylMean : 0;
    const rep = sung.length ? sung.filter((x) => (occ.get(normLine(x.text)) ?? 0) > 1).length / sung.length : 0;
    const rhymeDensity = sung.length ? clamp01((sung.filter((x) => x.partner !== null).length + sung.reduce((acc, x) => acc + x.internal, 0) * 0.5) / sung.length) : 0;
    const flow = mean(sung.map((x) => clamp01(0.5 * x.t.openness + 0.5 * (1 - (x.t.consonants / Math.max(1, x.t.phones) - 0.45) / 0.3))));
    const hash = blockHash(b);
    const sem = opts.sem?.[hash];
    const sec = clock.sec(b.at);
    return {
      id: b.id, name: b.name, kind: b.kind, link: b.link, at: b.at, len: b.len, bars: b.len / s.beatsPerBar, sec, dur: clock.sec(b.at + b.len) - sec,
      lines, sung,
      syllables: syl, stress: sung.map((x) => x.t.stress), rhyme: sung.map((x) => (x.letter ? x.letter[0] : '-')).join(''),
      density: sung.map((x) => +x.density.toFixed(2)), sustain: sung.map((x) => (x.sustained && x.t.sustain ? (x.t.sustain.open ? 'open' : 'closed') : null)),
      repetition: rep, lexical: words.length ? new Set(words).size / words.length : 0,
      breathMax: Math.max(0, ...breathRuns), restShare: b.len > 0 ? clamp01(1 - sungSec / Math.max(1e-6, clock.sec(b.at + b.len) - sec)) : 0,
      meter: sung.length && fit[1] > 0 ? (fit[1] >= 0.75 ? fit[0] : 'mixed') : null, meterFit: fit[1],
      openness: mean(sung.map((x) => x.t.openness)), rhymeDensity, internal: sung.reduce((acc, x) => acc + x.internal, 0), multi: sung.filter((x) => x.multi >= 2).length,
      alliteration: sung.reduce((acc, x) => acc + x.t.alliteration, 0), anaphora: dupCount(firsts), epistrophe: dupCount(lasts), enjambment: sung.filter((x) => x.t.enjambed).length,
      pronouns: pr, perspective: pr[persp] > 0 ? persp : null, tense: tense[1] ? tense[0] : null,
      articulation: sungSec ? cons / sungSec : 0, sibilance: phones ? sung.reduce((acc, x) => acc + x.t.sibilants, 0) / phones : 0, plosive: phones ? sung.reduce((acc, x) => acc + x.t.plosives, 0) / phones : 0,
      hash, sem, shape: b.shape,
      dims: { consistency: clamp01(1 - cv * 2.5), rhyme: rhymeDensity, repetition: rep, flow, imagery: sem ? clamp01(sem.imagery) : null, narrative: sem ? clamp01(sem.advances) : null },
    };
  });

  // ---- song level ---------------------------------------------------------------------------------
  const sungAll = blocks.flatMap((b) => b.sung);
  const kindCount = new Map<BlockKind, number>();
  const sections = blocks.map((b) => {
    const n = (kindCount.get(b.kind) ?? 0) + 1;
    kindCount.set(b.kind, n);
    return CODE[b.kind] + (b.kind === 'verse' || b.kind === 'custom' ? n : '');
  });

  // hooks: recurring 2–8 word phrases (content words required), longest wins at equal counts
  const grams = new Map<string, { n: number; at: HookPos[] }>();
  for (const m of sungAll) {
    const ws = m.t.words.map((w) => w.n);
    const seen = new Set<string>();
    for (let n = 2; n <= 8; n++) for (let i = 0; i + n <= ws.length; i++) {
      const g = ws.slice(i, i + n);
      if (g.every((w) => FUNCTION_WORDS.has(w))) continue;
      const k = g.join(' ');
      if (seen.has(k)) continue;
      seen.add(k);
      const e = grams.get(k) ?? { n, at: [] };
      e.at.push({ block: m.block, line: m.line, beat: m.at, sec: m.sec });
      grams.set(k, e);
    }
  }
  const choruses = blocks.filter((b) => b.kind === 'chorus' || b.kind === 'hook');
  let hooks: Hook[] = [...grams].filter(([, e]) => e.at.length >= 3 || (e.at.length >= 2 && e.at.some((p) => choruses.some((c) => c.id === p.block))))
    .map(([text, e]) => ({ text, n: e.n, count: e.at.length, at: e.at, firstSec: Math.min(...e.at.map((p) => p.sec)), chorusShare: choruses.length ? choruses.filter((c) => e.at.some((p) => p.block === c.id)).length / choruses.length : 0 }));
  // drop phrases contained in a longer one that recurs as often, and overlapping windows over the same lines
  hooks = hooks.filter((h) => !hooks.some((o) => o !== h && o.n > h.n && o.count >= h.count && ` ${o.text} `.includes(` ${h.text} `)));
  hooks.sort((p, q) => q.count * q.n ** 1.3 * (0.5 + q.chorusShare) - p.count * p.n ** 1.3 * (0.5 + p.chorusShare));
  const lineSet = (h: Hook) => h.at.map((p) => `${p.block}:${p.line}`).sort().join('|');
  const kept: Hook[] = [];
  for (const h of hooks) {
    const hw = h.text.split(' ');
    const overlaps = kept.some((o) => o.count === h.count && lineSet(o) === lineSet(h) && hw.filter((w) => o.text.split(' ').includes(w)).length / Math.min(hw.length, o.n) >= 0.6);
    if (!overlaps) kept.push(h);
    if (kept.length >= 8) break;
  }
  hooks = kept;
  const hook = hooks[0] ?? null;

  // breaths across the song (rests between blocks break a run)
  const breaths: Breath[] = [];
  let cur: Breath | null = null;
  for (const b of blocks) {
    for (const m of b.sung) {
      if (!cur) cur = { from: m.at, to: m.at, sec: 0, block: b.id, keys: [] };
      cur.sec += m.sung;
      cur.to = m.at + (m.sung / Math.max(1e-6, m.dur)) * m.len;
      cur.keys.push(m.key);
      if (m.rest > 0.4) { breaths.push(cur); cur = null; } else cur.sec += Math.max(0, m.rest);
    }
  }
  if (cur) breaths.push(cur);

  // near-duplicate blocks and lines
  const dups: NearDup[] = [];
  const sungNorm = (b: BlockM) => b.sung.map((x) => normLine(x.text));
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
    const a = blocks[i], b = blocks[j];
    if ((a.link && a.link === b.link) || a.sung.length < 2 || b.sung.length < 2) continue;
    // a link group is compared once, through its first copy
    if (a.link && blocks.slice(0, i).some((x) => x.link === a.link)) continue;
    if (b.link && blocks.slice(0, j).some((x) => x.link === b.link && x !== a)) continue;
    const na = sungNorm(a), nb = sungNorm(b);
    if (na.join('\n') === nb.join('\n')) { dups.push({ kind: 'identical', a: a.id, b: b.id, changed: [], total: na.length }); continue; }
    if (a.kind !== b.kind || Math.abs(na.length - nb.length) > 2) continue;
    const changed = nb.map((x, k) => (x === na[k] ? -1 : k)).filter((k) => k >= 0);
    if (changed.length / Math.max(na.length, nb.length) <= 0.4) dups.push({ kind: 'variant', a: a.id, b: b.id, changed, total: nb.length });
  }
  const lineDups: LineDup[] = [];
  const uniq = new Map<string, LineM>();
  for (const m of sungAll) if (!uniq.has(m.line)) uniq.set(m.line, m);
  const ul = [...uniq.values()].filter((m) => m.t.words.length >= 4);
  for (let i = 0; i < ul.length && lineDups.length < 40; i++) for (let j = i + 1; j < ul.length; j++) {
    const a = ul[i].t.words.map((w) => w.n), b = ul[j].t.words.map((w) => w.n);
    if (a.join(' ') === b.join(' ') || Math.abs(a.length - b.length) > 2) continue;
    const d = wordEdit(a, b);
    if (d <= 2 && d / Math.max(a.length, b.length) <= 0.4) lineDups.push({ a: ul[i].key, b: ul[j].key, from: ul[i].text, to: ul[j].text });
  }

  const allWords = sungAll.flatMap((m) => m.t.words.map((w) => w.n));
  const instances = [...occ.values()].reduce((acc, v) => acc + v, 0);
  const tails = new Map<string, number>();
  for (const m of uniq.values()) if (m.t.tail) tails.set(m.t.tail, (tails.get(m.t.tail) ?? 0) + 1);
  let chorusConsistency: number | null = null;
  if (choruses.length > 1) {
    const c0 = sungNorm(choruses[0]);
    chorusConsistency = mean(choruses.slice(1).map((c) => { const n = sungNorm(c); return n.length ? n.filter((x, k) => x === c0[k]).length / Math.max(n.length, c0.length) : 0; }));
  }
  const firstChorus = choruses[0]?.sec ?? null;
  const sems = blocks.map((b) => b.sem).filter(Boolean) as BlockSemantic[];
  const song: SongM = {
    sections, sectionText: sections.join(' '),
    sec: blocks.length ? blocks[blocks.length - 1].sec + blocks[blocks.length - 1].dur : 0,
    firstChorus, firstHook: hook?.firstSec ?? null,
    repetition: instances ? (instances - occ.size) / instances : 0,
    lexical: allWords.length ? new Set(allWords).size / allWords.length : 0,
    rhymeFamilies: [...tails.values()].filter((v) => v > 1).length,
    chorusConsistency,
    density: mean(sungAll.map((m) => m.density)), sps: mean(sungAll.map((m) => m.sps)),
    dims: {
      consistency: mean(blocks.filter((b) => b.sung.length > 1).map((b) => b.dims.consistency)),
      rhyme: mean(blocks.filter((b) => b.sung.length).map((b) => b.rhymeDensity)),
      repetition: instances ? (instances - occ.size) / instances : 0,
      flow: mean(blocks.filter((b) => b.sung.length).map((b) => b.dims.flow)),
      imagery: sems.length ? mean(sems.map((x) => clamp01(x.imagery))) : null,
      narrative: sems.length ? mean(sems.map((x) => clamp01(x.advances))) : null,
    },
  };

  const sung = opts.sung?.length ? sungLines(s, blocks, byKey, opts.sung, clock) : [];
  const all = findingsFor(s, blocks, byKey, breaths, dups, lineDups, sung);
  const findings = all.filter((f) => ruleOn(s, f.rule));
  const hidden: Record<string, number> = {};
  for (const f of all) if (!ruleOn(s, f.rule)) hidden[f.rule] = (hidden[f.rule] ?? 0) + 1;
  return { blocks, byKey, hooks, hook, breaths, dups, lineDups, song, sung, findings, hidden };
}

// ---- after the song exists: plan vs sung ----------------------------------------------------------

function sungLines(s: LyricSheet, blocks: BlockM[], byKey: Map<string, LineM>, lines: LyricLine[], clock: SheetClock): SongSung[] {
  const out: SongSung[] = [];
  for (const ll of lines) {
    if (!ll.sheet || !ll.words.length) continue;
    const key = `${ll.sheet.block}:${ll.sheet.line}`;
    const m = byKey.get(key);
    if (!m) continue;
    const t0 = ll.words[0].t, t1 = ll.words[ll.words.length - 1].e;
    const planned: [number, number] = [m.sec, m.sec + m.dur];
    const sungDur = Math.max(0.05, t1 - t0);
    const matched = ll.words.filter((w) => w.src !== 'interp').length;
    const sps = m.t.syl / sungDur;
    let onBeat: number | null = null, stressed = 0;
    if (s.songTempo) {
      // onset of each stressed syllable, interpolated inside its word, against the beat grid
      let on = 0;
      ll.words.forEach((w) => {
        const p = pron(w.w);
        const n = p.st.length || 1;
        p.st.forEach((st, k) => {
          if (st === 0 || (FUNCTION_WORDS.has(normWord(w.w)) && n === 1)) return;
          const at = w.t + ((w.e - w.t) * k) / n;
          const b = clock.beat(at);
          const off = Math.abs(b - Math.round(b));
          stressed++;
          if (off <= 0.2) on++;
        });
      });
      onBeat = stressed ? on / stressed : null;
    }
    const ratio = sungDur / Math.max(0.05, m.sung || m.dur);
    const flag = matched / ll.words.length < 0.5 ? 'dropped' : ratio < 0.6 && sps > 4 ? 'rushed' : ratio > 1.8 && m.dur > 1 ? 'stretched' : null;
    out.push({ key, block: m.block, line: m.line, t0, t1, planned, sps, plannedSps: m.sps, flag, matched, words: ll.words.length, onBeat, stressed });
  }
  for (const b of blocks) {
    const rows = out.filter((r) => r.block === b.id);
    if (!rows.length) continue;
    const ob = rows.filter((r) => r.onBeat !== null);
    b.song = { lines: rows.length, rushed: rows.filter((r) => r.flag === 'rushed').length, stretched: rows.filter((r) => r.flag === 'stretched').length, dropped: rows.filter((r) => r.flag === 'dropped').length, onBeat: ob.length ? mean(ob.map((r) => r.onBeat!)) : null };
  }
  return out;
}

// ---- findings -------------------------------------------------------------------------------------

function findingsFor(s: LyricSheet, blocks: BlockM[], byKey: Map<string, LineM>, breaths: Breath[], dups: NearDup[], lineDups: LineDup[], sung: SongSung[]): Finding[] {
  const out: Finding[] = [];
  const th = (id: string) => ruleTh(s, id);
  const add = (f: Omit<Finding, 'id' | 'cat'>) => out.push({ ...f, id: `${f.rule}:${f.key ?? f.block}:${out.length}`, cat: RULE[f.rule].cat });
  const name = (id: string) => blocks.find((b) => b.id === id)?.name ?? id;
  const seenLine = new Set<string>();
  const prevOfKind = new Map<BlockKind, BlockM>();
  for (const b of blocks) {
    const prev = prevOfKind.get(b.kind);
    for (const m of b.sung) {
      // linked copies share lines: report a line once
      const once = !seenLine.has(m.line);
      seenLine.add(m.line);
      if (!once) continue;
      const k = { block: b.id, line: m.line, key: m.key };
      if (m.sps > th('dense')) add({ ...k, rule: 'dense', level: 'warn', msg: `${m.t.syl} syllables in ${m.dur.toFixed(1)} s (${m.sps.toFixed(1)} syl/s)`, detail: `${m.density.toFixed(1)} syllables per beat at ${Math.round(new SheetClock(s).bpmAt(m.at))} bpm — give the line more beats, or cut words` });
      if (m.ref && Math.abs(m.ref.syl - m.t.syl) >= th('meter-drift')) add({ ...k, rule: 'meter-drift', level: 'warn', msg: `${m.t.syl} syllables, ${m.ref.name} line ${m.ref.idx + 1} has ${m.ref.syl}` });
      if (m.ref && m.t.syl >= 4) { const sim = stressSimilarity(m.t.stress, m.ref.stress); if (sim < th('stress-drift')) add({ ...k, rule: 'stress-drift', level: 'info', msg: `stress ${m.t.stress} vs ${m.ref.stress} in ${m.ref.name}`, detail: `${Math.round(sim * 100)}% alike` }); }
      if (m.sustained && m.t.sustain && !m.t.sustain.open) add({ ...k, rule: 'sustain', level: 'info', msg: `closed vowel on a long note: “${m.t.end?.w}”`, detail: 'a short vowel stopped by a consonant is hard to hold — an open vowel (oh, ay, ee, igh) sings better here' });
      const art = m.sung > 0 ? m.t.consonants / m.sung : 0;
      if (art > th('articulation')) add({ ...k, rule: 'articulation', level: 'info', msg: `${Math.round(art)} consonant sounds per second`, detail: 'fine for clipped, percussive delivery — a mouthful for a sung line' });
      const sib = m.t.phones ? m.t.sibilants / m.t.phones : 0;
      if (sib > th('sibilance') && m.t.sibilants >= 3) add({ ...k, rule: 'sibilance', level: 'info', msg: `sibilant-heavy (${Math.round(sib * 100)}% s/z/sh/ch sounds)` });
      if (m.target !== undefined && Math.abs(m.target - m.t.syl) >= th('shape')) add({ ...k, rule: 'shape', level: 'warn', msg: `${m.t.syl} syllables, the shape wants ${m.target}` });
      const tg = s.targets?.[b.kind];
      if (tg?.maxDensity && m.density > tg.maxDensity) add({ ...k, rule: 'target', level: 'warn', msg: `${m.density.toFixed(1)} syl/beat — ${b.kind} target ≤ ${tg.maxDensity}` });
      if (tg?.openEnds && m.t.sustain && !m.t.sustain.open) add({ ...k, rule: 'target', level: 'warn', msg: `ends on a closed vowel (“${m.t.end?.w}”) — ${b.kind} target: open line endings` });
    }
    const tg = s.targets?.[b.kind];
    if (tg?.minRepetition && b.sung.length && b.repetition < tg.minRepetition) add({ block: b.id, rule: 'target', level: 'info', msg: `${Math.round(b.repetition * 100)}% repeated lines — ${b.kind} target ≥ ${Math.round(tg.minRepetition * 100)}%` });
    if (b.shape?.rhyme && b.rhyme.length && b.shape.rhyme.slice(0, b.rhyme.length) !== b.rhyme && b.sung.length >= 2) add({ block: b.id, rule: 'shape', level: 'info', msg: `rhyme ${b.rhyme}, the shape wants ${b.shape.rhyme}` });
    if (prev && prev.sung.length >= 2 && b.sung.length >= 2 && !(b.link && b.link === prev.link)) {
      if (prev.rhyme !== b.rhyme && prev.rhyme.length === b.rhyme.length) add({ block: b.id, rule: 'rhyme-break', level: 'info', msg: `rhyme ${b.rhyme}, ${prev.name} is ${prev.rhyme}` });
      if (b.perspective && prev.perspective && b.perspective !== prev.perspective) add({ block: b.id, rule: 'perspective', level: 'info', msg: `speaks as “${PERSON[b.perspective]}”, ${prev.name} as “${PERSON[prev.perspective]}”` });
      if (b.tense && prev.tense && b.tense !== prev.tense) add({ block: b.id, rule: 'tense', level: 'info', msg: `${b.tense} tense, ${prev.name} is ${prev.tense}` });
    }
    if (b.sem) for (const c of b.sem.cliches) {
      const m = b.sung.find((x) => x.text.toLowerCase().includes(c.text.toLowerCase())) ?? b.sung[0];
      add({ block: b.id, line: m?.line, key: m?.key, rule: 'cliche', level: 'info', msg: `“${c.text}”`, detail: c.why });
    }
    if (b.sung.length) prevOfKind.set(b.kind, b);
  }
  for (const br of breaths) if (br.sec > th('breath')) {
    const last = byKey.get(br.keys[br.keys.length - 1])!;
    add({ block: last.block, line: last.line, key: last.key, rule: 'breath', level: 'warn', msg: `${br.sec.toFixed(1)} s sung without a breath (${br.keys.length} line${br.keys.length > 1 ? 's' : ''})`, detail: 'leave a rest: shorter lines, a line with more beats, or a pause' });
  }
  for (const d of dups) {
    if (d.kind === 'identical') add({ block: d.b, rule: 'near-dup', level: 'warn', msg: `identical to ${name(d.a)} but not linked`, detail: 'link them so an edit to one changes every copy', fix: { kind: 'link', a: d.a, b: d.b } });
    else add({ block: d.b, rule: 'near-dup', level: 'info', msg: `variant of ${name(d.a)} (${d.changed.length} of ${d.total} lines changed)`, detail: `changed: line ${d.changed.map((k) => k + 1).join(', ')}` });
  }
  for (const d of lineDups.slice(0, 12)) {
    const b = byKey.get(d.b)!;
    if (dups.some((x) => (x.a === byKey.get(d.a)?.block && x.b === b.block) || (x.b === byKey.get(d.a)?.block && x.a === b.block))) continue;
    add({ block: b.block, line: b.line, key: d.b, rule: 'near-dup', level: 'info', msg: `near-copy of “${d.from}” (${name(byKey.get(d.a)!.block)})`, detail: 'repetition with variation — intended?' });
  }
  for (const r of sung) {
    const m = byKey.get(r.key)!;
    const k = { block: r.block, line: r.line, key: r.key };
    if (r.flag === 'rushed') add({ ...k, rule: 'sung', level: 'warn', msg: `rushed: ${m.t.syl} syllables sung in ${(r.t1 - r.t0).toFixed(1)} s (${r.sps.toFixed(1)} syl/s)`, detail: 'cut syllables or give the line more time in the next version' });
    else if (r.flag === 'stretched') add({ ...k, rule: 'sung', level: 'info', msg: `stretched: sung over ${(r.t1 - r.t0).toFixed(1)} s, planned ${m.dur.toFixed(1)} s` });
    else if (r.flag === 'dropped') add({ ...k, rule: 'sung', level: 'warn', msg: `probably not sung as written (${r.words - r.matched} of ${r.words} words unmatched)` });
    if (r.onBeat !== null && r.stressed >= 3 && r.onBeat < th('sung-stress')) add({ ...k, rule: 'sung-stress', level: 'info', msg: `${Math.round(r.onBeat * 100)}% of stresses on the beat` });
  }
  return out;
}
const PERSON: Record<keyof Pronouns, string> = { i: 'I', you: 'you', we: 'we', they: 'they', third: 'he / she' };

// ---- fingerprint ----------------------------------------------------------------------------------

export interface Fingerprint {
  sections: string[];
  blocks: { name: string; kind: BlockKind; bars: number; syllables: number[]; stress: string[]; rhyme: string; density: number[]; sustain: ('open' | 'closed' | null)[]; repetition: number; lexical: number; emotion?: { valence: number; intensity: number } }[];
  hook?: { text: string; count: number; firstAt: number };
}

export function fingerprint(a: SheetAnalysis): Fingerprint {
  return {
    sections: a.song.sections,
    blocks: a.blocks.map((b) => ({
      name: b.name, kind: b.kind, bars: +b.bars.toFixed(2), syllables: b.syllables, stress: b.stress, rhyme: b.rhyme, density: b.density, sustain: b.sustain,
      repetition: +b.repetition.toFixed(2), lexical: +b.lexical.toFixed(2), ...(b.sem ? { emotion: { valence: b.sem.valence, intensity: b.sem.intensity } } : {}),
    })),
    ...(a.hook ? { hook: { text: a.hook.text, count: a.hook.count, firstAt: +a.hook.firstSec.toFixed(1) } } : {}),
  };
}

/** compact profile saved with library versions */
export interface ProfileSummary {
  sections: string; dims: Dims; density: number; sps: number; repetition: number; lexical: number; rhymeFamilies: number;
  hook: { text: string; firstSec: number; count: number } | null; firstChorus: number | null; findings: number; sec: number;
}
export function profileSummary(a: SheetAnalysis): ProfileSummary {
  return {
    sections: a.song.sectionText, dims: a.song.dims, density: +a.song.density.toFixed(2), sps: +a.song.sps.toFixed(2), repetition: +a.song.repetition.toFixed(3),
    lexical: +a.song.lexical.toFixed(3), rhymeFamilies: a.song.rhymeFamilies, hook: a.hook ? { text: a.hook.text, firstSec: +a.hook.firstSec.toFixed(1), count: a.hook.count } : null,
    firstChorus: a.song.firstChorus === null ? null : +a.song.firstChorus.toFixed(1), findings: a.findings.filter((f) => f.level === 'warn').length, sec: +a.song.sec.toFixed(1),
  };
}

/** "v4 is denser, less repetitive, the hook appears later" — what changed from a to b */
export function profileDelta(a: ProfileSummary, b: ProfileSummary): string[] {
  const out: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (a.sections !== b.sections) out.push(`structure: ${a.sections} → ${b.sections}`);
  if (Math.abs(a.sec - b.sec) >= 3) out.push(`length ${fmtS(a.sec)} → ${fmtS(b.sec)}`);
  if (Math.abs(a.density - b.density) >= 0.1) out.push(`${b.density > a.density ? 'denser' : 'sparser'}: ${a.density} → ${b.density} syl/beat`);
  if (Math.abs(a.repetition - b.repetition) >= 0.04) out.push(`${b.repetition > a.repetition ? 'more' : 'less'} repetitive: ${pct(a.repetition)} → ${pct(b.repetition)} repeated lines`);
  if (Math.abs(a.lexical - b.lexical) >= 0.04) out.push(`vocabulary ${b.lexical > a.lexical ? 'more varied' : 'narrower'}: ${pct(a.lexical)} → ${pct(b.lexical)} unique words`);
  if (Math.abs(a.dims.rhyme - b.dims.rhyme) >= 0.08) out.push(`rhyme density ${pct(a.dims.rhyme)} → ${pct(b.dims.rhyme)}`);
  if (Math.abs(a.dims.consistency - b.dims.consistency) >= 0.08) out.push(`syllable consistency ${pct(a.dims.consistency)} → ${pct(b.dims.consistency)}`);
  if ((a.hook?.text ?? '') !== (b.hook?.text ?? '')) out.push(`hook: ${a.hook ? `“${a.hook.text}”` : 'none'} → ${b.hook ? `“${b.hook.text}”` : 'none'}`);
  else if (a.hook && b.hook && Math.abs(a.hook.firstSec - b.hook.firstSec) >= 3) out.push(`the hook appears ${b.hook.firstSec > a.hook.firstSec ? 'later' : 'earlier'}: ${fmtS(a.hook.firstSec)} → ${fmtS(b.hook.firstSec)}`);
  if (a.firstChorus !== null && b.firstChorus !== null && Math.abs(a.firstChorus - b.firstChorus) >= 3) out.push(`first chorus ${fmtS(a.firstChorus)} → ${fmtS(b.firstChorus)}`);
  if (a.findings !== b.findings) out.push(`warnings ${a.findings} → ${b.findings}`);
  return out;
}

// ---- checks for candidate lines (AI tools, proposal validation) ------------------------------------

export interface LineCheck { text: string; syl: number; stress: string; end: string; tail: string; sps: number | null; density: number | null; sustain: 'open' | 'closed' | null; est: string[] }

/** measure candidate lines; `beats` (optional) is the planned length of each line */
export function checkLine(s: LyricSheet, text: string, at?: number, beats?: number): LineCheck {
  const t = lineText(text);
  const c = new SheetClock(s);
  const dur = at !== undefined && beats !== undefined ? c.sec(at + beats) - c.sec(at) : null;
  return {
    text, syl: t.syl, stress: t.stress, end: t.end?.w ?? '', tail: t.tail,
    sps: dur ? +(t.syl / dur).toFixed(2) : null, density: beats ? +(t.syl / beats).toFixed(2) : null,
    sustain: t.sustain ? (t.sustain.open ? 'open' : 'closed') : null, est: t.est,
  };
}

export interface EditCheck { line: string; badges: string[]; errors: string[] }

/**
 * Check line edits against the shape of the lines they replace: syllables (or the block's shape target), rhyme with
 * the partner line (after the other edits), an open vowel where the note is held, density. `strict`: syllable drift is
 * an error instead of a badge.
 */
export function checkEdits(s: LyricSheet, a: SheetAnalysis, edits: { op: string; line_id: string; text?: string }[], strict = false): EditCheck[] {
  const inst = (id: string) => [...a.byKey.values()].find((m) => m.line === id);
  const newText = new Map<string, string>();
  for (const e of edits) if (e.op === 'replace' && e.text !== undefined) newText.set(e.line_id, e.text);
  const out: EditCheck[] = [];
  for (const e of edits) {
    if (e.op !== 'replace' || e.text === undefined) continue;
    const m = inst(e.line_id);
    if (!m || !sungKind(m.kind)) continue;
    const t = lineText(e.text);
    const badges: string[] = [], errors: string[] = [];
    const want = m.target ?? m.t.syl;
    if (Math.abs(t.syl - want) > 1) (strict ? errors : badges).push(`${want} → ${t.syl} syl`);
    if (m.partner !== null && m.letter && t.end) {
      const b = a.blocks.find((x) => x.id === m.block)!;
      const p = b.lines[m.partner];
      const pText = newText.get(p.line) ?? p.text;
      const pEnd = lineText(pText).end;
      const q = pEnd ? rhymeQuality(t.end.w, pEnd.w) : null;
      if (!q || q === 'assonance' || q === 'consonance') badges.push(`rhyme ${m.letter[0]} ✗ (${t.end.w} / ${pEnd?.w ?? '—'})`);
      else if (q === 'slant' && m.rq === 'perfect') badges.push(`rhyme ${m.letter[0]} slant`);
    }
    if (m.sustained && t.sustain && !t.sustain.open && m.t.sustain?.open) badges.push('closed vowel on long note');
    const sps = m.dur > 0 ? t.syl / m.dur : 0;
    if (sps > ruleTh(s, 'dense') && sps > m.sps) badges.push(`too dense (${sps.toFixed(1)} syl/s)`);
    out.push({ line: e.line_id, badges, errors });
  }
  return out;
}

// ---- reference shape ------------------------------------------------------------------------------

export interface RefShape { blocks: { name: string; kind: BlockKind; bars: number; shape: BlockShape }[] }

/** extract only the shape of a pasted lyric (its words are not kept) */
export function shapeFromText(text: string, beatsPerBar: number): RefShape {
  const parsed = parseSheetText(text);
  const counts = new Map<BlockKind, number>();
  return {
    blocks: parsed.map((p, i) => {
      const kind = p.kind ?? (p.name ? kindOf(p.name) : 'verse');
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      const sung = p.lines.filter((l) => lineKind(l) === 'lyric');
      const letters = rhymeLetters(sung).map((x) => (x ? x[0] : '-')).join('');
      return {
        name: p.name ?? `${kind === 'verse' ? 'Verse' : kind[0].toUpperCase() + kind.slice(1)} ${n}`,
        kind, bars: defaultLen(p.lines, beatsPerBar, kind) / beatsPerBar,
        shape: { syl: sung.map((l) => lineText(l).syl), rhyme: letters, stress: sung.map((l) => lineText(l).stress), from: `reference ${p.name ?? `block ${i + 1}`}` },
      };
    }),
  };
}

// ---- AI-facing text views ---------------------------------------------------------------------------

export function blockReport(a: SheetAnalysis, blockId: string): string {
  const b = a.blocks.find((x) => x.id === blockId);
  if (!b) return '(no such block)';
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    `${b.name} [${b.id}] ${b.kind} · ${+b.bars.toFixed(2)} bars · ${b.sung.length} sung lines`,
    `syllables ${JSON.stringify(b.syllables)} · rhyme ${b.rhyme || '-'} · meter ${b.meter ?? '-'} (${pct(b.meterFit)} fit)`,
    `density (syl/beat) ${JSON.stringify(b.density)} · breath max ${b.breathMax.toFixed(1)} s · rest ${pct(b.restShare)}`,
    `repetition ${pct(b.repetition)} · unique words ${pct(b.lexical)} · internal rhymes ${b.internal} · multisyllabic ${b.multi} · vowel openness ${pct(b.openness)}`,
    `perspective ${b.perspective ?? '-'} · tense ${b.tense ?? '-'}${b.sem ? ` · emotion ${b.sem.emotions.join(', ')} (valence ${b.sem.valence}, intensity ${b.sem.intensity})` : ''}`,
    ...(b.shape ? [`target shape: syllables ${JSON.stringify(b.shape.syl)}${b.shape.rhyme ? ` rhyme ${b.shape.rhyme}` : ''}`] : []),
    'lines:',
    ...b.sung.map((m) => `  [${m.line}] ${m.t.syl} syl ${m.t.stress} · ${m.density.toFixed(1)} syl/beat · end "${m.t.end?.w ?? ''}"${m.letter ? ` rhyme ${m.letter[0]}${m.rq ? ` (${m.rq})` : ''}` : ''}${m.sustained ? ` · held note, ${m.t.sustain?.open ? 'open' : 'closed'} vowel` : ''}${m.target !== undefined ? ` · target ${m.target} syl` : ''}`),
  ];
  const f = a.findings.filter((x) => x.block === b.id);
  if (f.length) lines.push('findings:', ...f.map((x) => `  - ${x.rule}${x.line ? ` [${x.line}]` : ''}: ${x.msg}`));
  return lines.join('\n');
}

export function findingsText(a: SheetAnalysis, cat?: string): string {
  const fs = a.findings.filter((f) => !cat || f.cat === cat);
  if (!fs.length) return '(no findings)';
  const name = (id: string) => a.blocks.find((b) => b.id === id)?.name ?? id;
  return fs.map((f) => `- [${f.cat}/${f.rule}] ${name(f.block)}${f.line ? ` [${f.line}]` : ''}: ${f.msg}${f.detail ? ` — ${f.detail}` : ''}`).join('\n');
}

export function hookText(a: SheetAnalysis): string {
  if (!a.hooks.length) return '(no recurring phrase yet)';
  return a.hooks.map((h, i) => `${i === 0 ? 'HOOK ' : '     '}"${h.text}" ×${h.count} · first at ${fmtS(h.firstSec)} · in ${Math.round(h.chorusShare * 100)}% of choruses · ${[...new Set(h.at.map((p) => a.blocks.find((b) => b.id === p.block)?.name))].join(', ')}`).join('\n')
    + `\ntime to first chorus: ${a.song.firstChorus === null ? '-' : fmtS(a.song.firstChorus)} · repetition ${Math.round(a.song.repetition * 100)}% · sections ${a.song.sectionText}`;
}


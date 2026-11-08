// Lyrics stage actions: library (versions), AI proposals, block clipboard, song alignment, read-along click track.
import { alignLyrics, type AsrWord } from '../../core/lyrics';
import {
  addBlock, blocksFromTimed, insertCopy, kindOf, lyricWords, normalize, paintEnergy, paintSpans, pruneTags,
  rebaseTag, removeBlock, reorderBlock, ripple, sheetToText, sid, singText, sorted, syncLinks,
  tempoFromSections, LABEL_COLORS, SheetClock,
} from '../../core/sheet';
import type { BlockKind, LyricSheet, SheetBlock } from '../../core/types';
import type { ProfileSummary } from '../../core/lyricMetrics';
import { store } from '../store';
import { clockOf, editSheet, lx, sheet, toast } from './state';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ---- library ------------------------------------------------------------------------------------

export interface VersionInfo { id: string; name: string; at: string; source: string; note?: string; blocks: number; lines: number; duration: number; profile?: ProfileSummary }

async function j<T>(r: Promise<Response>): Promise<T> {
  const res = await r;
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

export const listVersions = () => j<{ versions: VersionInfo[] }>(fetch('/api/sheet/versions')).then((r) => r.versions);
export const getVersion = (id: string) => j<{ id: string; name: string; sheet: LyricSheet; profile?: ProfileSummary }>(fetch(`/api/sheet/versions/${id}`));
export const renameVersion = (id: string, name: string) => j(fetch(`/api/sheet/versions/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }));
export const deleteVersion = (id: string) => j(fetch(`/api/sheet/versions/${id}`, { method: 'DELETE' }));

/** content fingerprint (ignores the version pointer) */
const fp = (s: LyricSheet) => JSON.stringify({ ...s, version: undefined });
let savedFp: string | null = null;
export const isDirtySinceVersion = () => {
  const s = store.state.project.sheet;
  return !!s && s.blocks.length > 0 && fp(s) !== savedFp;
};
export const markSaved = () => { const s = store.state.project.sheet; savedFp = s ? fp(s) : null; };

export async function saveVersion(name: string, source = 'manual', note?: string) {
  const s = sheet();
  const r = await j<{ id: string; name: string }>(fetch('/api/sheet/versions', { method: 'POST', body: JSON.stringify({ name, source, note, sheet: { ...s, version: undefined } }) }));
  if (source === 'manual') {
    editSheet((d) => { d.version = { id: r.id, name: r.name }; });
    markSaved();
  }
  window.dispatchEvent(new Event('mv-versions'));
  return r;
}

/** keep the working copy before something replaces it (switch version, seed, align) */
export async function snapshot(reason: string) {
  const s = store.state.project.sheet;
  if (!s?.blocks.length) return;
  await saveVersion(reason, 'auto').catch((e) => console.warn('snapshot failed', e));
}

export async function loadVersion(id: string) {
  if (isDirtySinceVersion()) await snapshot(`autosave before switching${sheet().version ? ` (from ${sheet().version!.name})` : ''}`);
  const v = await getVersion(id);
  editSheet((d) => { Object.assign(d, clone(v.sheet), { version: { id: v.id, name: v.name } }); });
  markSaved();
  lx.set({ editing: null, wsel: null, focus: null, selBlock: null });
  toast(`loaded “${v.name}”`);
}

export const nextVersionName = async () => {
  const vs = await listVersions().catch(() => []);
  const n = vs.filter((v) => v.source === 'manual').length + 1;
  return `v${n}`;
};

// ---- block clipboard ----------------------------------------------------------------------------

let clip: SheetBlock | null = null;
export function copyBlock(id: string) {
  const b = sheet().blocks.find((x) => x.id === id);
  if (!b) return;
  clip = clone(b);
  try { navigator.clipboard?.writeText([`[${b.name}]`, ...b.lines.map((l) => l.text)].join('\n')); } catch { /* ignore */ }
  toast(`copied ${b.name} — Ctrl+V pastes, Ctrl+Shift+V pastes linked`);
}
export function pasteBlock(afterId: string | null, linked: boolean) {
  if (!clip) return toast('nothing copied');
  const src = clip;
  let made: SheetBlock | null = null;
  editSheet((d) => {
    const orig = d.blocks.find((x) => x.id === src.id);
    if (linked && !orig) { made = insertCopy(d as LyricSheet, src, afterId, false); return; }
    made = insertCopy(d as LyricSheet, orig ? clone(orig) : src, afterId, linked);
  });
  if (made) lx.set({ selBlock: (made as SheetBlock).id });
  if (linked && !sheet().blocks.some((x) => x.id === src.id)) toast('original is gone — pasted unlinked');
}
export function duplicateBlock(id: string, linked: boolean) {
  const b = sheet().blocks.find((x) => x.id === id);
  if (!b) return;
  let made: SheetBlock | null = null;
  editSheet((d) => { made = insertCopy(d as LyricSheet, clone(b), id, linked); });
  if (made) lx.set({ selBlock: (made as SheetBlock).id });
}

export function newBlockAt(beat: number, kind: BlockKind = 'verse', bars = 8) {
  let id = '';
  editSheet((d) => { id = addBlock(d as LyricSheet, beat, kind, bars).id; });
  lx.set({ selBlock: id });
  return id;
}

export function deleteBlock(id: string) {
  editSheet((d) => removeBlock(d as LyricSheet, id, true));
  lx.set({ selBlock: null, editing: null });
}

/** insert (bars > 0) or remove (bars < 0) pause after block `id` */
export function gapAfter(id: string, bars: number) {
  editSheet((d) => {
    const b = d.blocks.find((x) => x.id === id);
    if (!b) return;
    const end = b.at + b.len;
    const next = sorted(d as LyricSheet).find((x) => x.at >= end - 1e-6 && x.id !== id);
    const delta = bars * d.beatsPerBar;
    const room = next ? next.at - end : 0;
    ripple(d as LyricSheet, end, delta < 0 ? -Math.min(room, -delta) : delta, id);
  });
}

// ---- AI proposals -------------------------------------------------------------------------------

export interface Proposal { id: string; tool: string; input: any; before?: any; checks?: any; supersedes?: string }

const findLine = (s: LyricSheet, lineId: string) => {
  for (const b of sorted(s)) { const i = b.lines.findIndex((l) => l.id === lineId); if (i >= 0) return { b, i }; }
  return null;
};

/** line edits (replace / insert_after / delete); `only` restricts to some edit indices */
export function applyLineEdits(edits: { op: string; line_id: string; text?: string }[]) {
  editSheet((d) => {
    const s = d as LyricSheet;
    const touched = new Set<SheetBlock>();
    for (const e of edits) {
      const f = findLine(s, e.line_id);
      if (!f) continue;
      const { b, i } = f;
      if (e.op === 'replace' && e.text !== undefined) {
        const old = b.lines[i].text;
        b.lines[i].text = e.text.trim();
        s.tags = s.tags.flatMap((t) => (t.line === e.line_id ? (rebaseTag(t, old, b.lines[i].text) ?? []) : [t]));
      } else if (e.op === 'insert_after' && e.text !== undefined) {
        b.lines.splice(i + 1, 0, { id: sid('l'), text: e.text.trim() });
      } else if (e.op === 'delete') b.lines.splice(i, 1);
      touched.add(b);
    }
    for (const b of touched) if (b.link) syncLinks(s, b.id);
    pruneTags(s);
  });
}

/** replace consecutive lines with one alternative (several lines separated by \n); `merge` lets Alt+[ ] cycle */
export function applyAlternative(lineIds: string[], option: string, merge?: string) {
  editSheet((d) => {
    const s = d as LyricSheet;
    // the block of any of the ids (an earlier option may have removed some of them)
    let f: ReturnType<typeof findLine> = null;
    for (const id of lineIds) { f = findLine(s, id); if (f) break; }
    if (!f) return;
    const { b } = f;
    const idx = b.lines.map((l, i) => (lineIds.includes(l.id) ? i : -1)).filter((i) => i >= 0);
    const i0 = Math.min(...idx), i1 = Math.max(...idx);
    const sub = b.lines.slice(i0, i1 + 1);
    const texts = option.split('\n').map((t) => t.trim()).filter(Boolean);
    // ids stay with their position, so cycling options keeps tags and references stable
    const fresh = texts.map((t, k) => (k < sub.length ? { ...sub[k], text: t } : { id: sid('l'), text: t }));
    const old = new Map(sub.map((l) => [l.id, l.text]));
    s.tags = s.tags.flatMap((t) => {
      const ot = old.get(t.line);
      if (ot === undefined) return [t];
      const nl = fresh.find((l) => l.id === t.line);
      return nl ? (rebaseTag(t, ot, nl.text) ?? []) : [];
    });
    b.lines.splice(i0, sub.length, ...fresh);
    if (b.link) syncLinks(s, b.id);
    pruneTags(s);
  }, merge);
}

export function applyBlockOps(ops: any[]) {
  editSheet((d) => {
    const s = d as LyricSheet;
    const bpb = s.beatsPerBar;
    for (const o of ops) {
      const b = o.block_id ? s.blocks.find((x) => x.id === o.block_id) : undefined;
      if (o.op === 'add') {
        const after = o.after_block_id ? s.blocks.find((x) => x.id === o.after_block_id) : sorted(s)[s.blocks.length - 1];
        const at = after ? after.at + after.len : 0;
        const len = Math.max(1, Math.round(o.bars)) * bpb;
        ripple(s, at, len);
        const kind: BlockKind = o.kind ?? kindOf(o.name);
        s.blocks.push({ id: sid('b'), kind, name: o.name, at, len, lines: (o.lines ?? []).map((t: string) => ({ id: sid('l'), text: t })) });
      } else if (!b) continue;
      else if (o.op === 'remove') removeBlock(s, b.id, true);
      else if (o.op === 'rename') { b.name = o.name; b.kind = o.kind ?? kindOf(o.name); }
      else if (o.op === 'resize') { const nl = Math.max(1, Math.round(o.bars * bpb)); ripple(s, b.at + b.len, nl - b.len, b.id); b.len = nl; }
      else if (o.op === 'move') {
        const order = sorted(s).filter((x) => x.id !== b.id);
        const ai = o.after_block_id ? order.findIndex((x) => x.id === o.after_block_id) : -1;
        reorderBlock(s, b.id, ai + 1);
      } else if (o.op === 'gap') {
        const prev = sorted(s).filter((x) => x.at < b.at).pop();
        const prevEnd = prev ? prev.at + prev.len : 0;
        ripple(s, b.at, prevEnd + o.bars * bpb - b.at);
      }
    }
    normalize(s);
    pruneTags(s);
  });
}

function labelId(s: LyricSheet, name: string) {
  const n = name.trim().toLowerCase();
  let l = s.labels.find((x) => x.name.toLowerCase() === n);
  if (!l) { l = { id: sid('lb'), name: name.trim(), color: LABEL_COLORS[s.labels.length % LABEL_COLORS.length] }; s.labels.push(l); }
  return l.id;
}

export function applyLayerOps(ops: any[]) {
  editSheet((d) => {
    const s = d as LyricSheet;
    const bpb = s.beatsPerBar;
    for (const o of ops) {
      const a = (o.from_bar - 1) * bpb, b = (o.to_bar - 1) * bpb;
      if (o.op === 'energy') {
        let t = s.tracks.find((x) => x.kind === 'energy');
        if (!t) { t = { id: sid('tr'), name: 'Energy', kind: 'energy', spans: [], points: [] }; s.tracks.push(t); }
        t.points = paintEnergy(t.points ?? [], a, o.from, b, o.to);
        continue;
      }
      const lid = labelId(s, o.label);
      let t = s.tracks.find((x) => x.name.toLowerCase() === String(o.track).toLowerCase() && x.kind !== 'energy');
      if (!t) { t = { id: sid('tr'), name: o.track, kind: 'mixed', spans: [] }; s.tracks.push(t); }
      if (t.kind === 'channel' && t.label !== lid) {
        // a channel track only carries its own label: put the others on a mixed track next to it
        let m = s.tracks.find((x) => x.kind === 'mixed' && x.name.toLowerCase() === `${t!.name} mix`.toLowerCase());
        if (!m) { m = { id: sid('tr'), name: `${t.name} mix`, kind: 'mixed', spans: [] }; s.tracks.splice(s.tracks.indexOf(t) + 1, 0, m); }
        t = m;
      }
      t.spans = paintSpans(t.spans, a, b, lid, o.op === 'add');
    }
  });
}

export function applyTagOps(ops: any[]) {
  editSheet((d) => {
    const s = d as LyricSheet;
    for (const o of ops) {
      const f = findLine(s, o.line_id);
      if (!f) continue;
      const text = f.b.lines[f.i].text;
      const from = text.indexOf(o.words);
      if (from < 0) continue;
      const to = from + o.words.length;
      if (o.op === 'remove') s.tags = s.tags.filter((t) => !(t.line === o.line_id && t.from < to && t.to > from));
      else s.tags.push({ id: sid('t'), line: o.line_id, from, to, kind: o.kind ?? 'note', note: o.note });
    }
  });
}

export const applyStyle = (style: string) => editSheet((d) => { d.style = style; });

/** apply a whole proposal (alternatives: option index) */
export function applyProposal(p: Proposal, opt?: { edits?: number[]; option?: number; merge?: string }) {
  const x = p.input;
  if (p.tool === 'propose_lines') applyLineEdits(opt?.edits ? x.edits.filter((_: any, i: number) => opt.edits!.includes(i)) : x.edits);
  else if (p.tool === 'propose_alternatives') applyAlternative(x.line_ids, x.options[opt?.option ?? 0], opt?.merge);
  else if (p.tool === 'propose_blocks') applyBlockOps(x.ops);
  else if (p.tool === 'propose_layers') applyLayerOps(x.ops);
  else if (p.tool === 'propose_tags') applyTagOps(x.ops);
  else if (p.tool === 'propose_style') applyStyle(x.style);
}

// ---- song link ----------------------------------------------------------------------------------

interface Transcript { model: string; words: AsrWord[]; segments: { start: number; end: number; text: string }[] }
export async function transcript(): Promise<Transcript | null> {
  const r = await fetch('/api/lyrics/transcript');
  return r.ok ? r.json() : null;
}

/** sheet tempo ← song tempo map (beats keep their bars; blocks are re-timed by alignment afterwards) */
export function useSongTempo(d: LyricSheet) {
  const t = tempoFromSections(store.state.project.tempo, d.beatsPerBar);
  if (!t) return false;
  Object.assign(d, t, { songTempo: true });
  return true;
}

/** Align the sheet's sung lines to the stored transcript → project.lyrics (with sheet back-refs) + adopt timing. */
export async function alignSheet(opts: { adopt: boolean } = { adopt: true }) {
  const tr = await transcript();
  if (!tr) throw new Error('no transcript yet — run “Transcribe + align” (needs OPENAI_API_KEY)');
  const s = sheet();
  const parsed: { section?: string; words: string[] }[] = [];
  const refs: { block: string; line: string }[] = [];
  for (const b of sorted(s)) for (const l of b.lines) {
    const ws = lyricWords(l.text);
    if (!ws.length) continue;
    parsed.push({ section: b.name, words: ws });
    refs.push({ block: b.id, line: l.id });
  }
  if (!parsed.length) throw new Error('the sheet has no sung lines to align');
  await snapshot('before aligning to the song');
  const aligned = alignLyrics(parsed, tr.words, store.state.project.duration);
  aligned.lines.forEach((l, i) => { l.sheet = refs[i]; });
  store.edit((p) => {
    p.lyrics = { ...aligned, source: { ...(aligned.source ?? { kind: 'aligned', at: '' }), model: tr.model } };
    p.sheet ??= clone(s);
    if (!p.sheet.songTempo) useSongTempo(p.sheet as LyricSheet);
    if (opts.adopt) adoptTiming(p.sheet as LyricSheet, p.lyrics);
    if (p.storyboard) p.storyboard.brief.lyrics = sheetToText(p.sheet as LyricSheet);
  });
  const m = aligned.source?.matched ?? 0, n = aligned.source?.total ?? 0;
  toast(`aligned ${m}/${n} words to the song`);
}

/** move blocks / line lengths to where the song actually sings them */
export function adoptTiming(d: LyricSheet, lyrics = store.state.project.lyrics) {
  if (!lyrics) return;
  const c = new SheetClock(d);
  const bpb = d.beatsPerBar;
  const byBlock = new Map<string, typeof lyrics.lines>();
  for (const l of lyrics.lines) if (l.sheet && l.words.length) { const a = byBlock.get(l.sheet.block) ?? []; a.push(l); byBlock.set(l.sheet.block, a); }
  const doneLinks = new Set<string>();
  for (const b of sorted(d)) {
    const ls = byBlock.get(b.id);
    if (!ls?.length) continue;
    const a = c.beat(ls[0].words[0].t);
    const e = c.beat(ls[ls.length - 1].words[ls[ls.length - 1].words.length - 1].e);
    const bar = Math.floor(a / bpb) * bpb;
    b.at = Math.max(0, a - bar < 1.01 ? bar : Math.floor(a));
    b.len = Math.max(bpb, Math.ceil((e - b.at) / bpb) * bpb);
    if (b.link && doneLinks.has(b.link)) continue;
    if (b.link) doneLinks.add(b.link);
    // sung lines get their real lengths (up to the next sung line)
    const starts = new Map(ls.map((l) => [l.sheet!.line, c.beat(l.words[0].t)]));
    const sungIdx = b.lines.map((l, i) => (starts.has(l.id) ? i : -1)).filter((i) => i >= 0);
    sungIdx.forEach((i, k) => {
      const t0 = k === 0 ? b.at : starts.get(b.lines[i].id)!;
      const t1 = k < sungIdx.length - 1 ? starts.get(b.lines[sungIdx[k + 1]].id)! : b.at + b.len;
      b.lines[i].beats = +Math.max(0.5, t1 - t0).toFixed(2);
    });
    if (b.link) syncLinks(d, b.id);
  }
  normalize(d);
}

export const adoptSongTiming = () => editSheet((d) => adoptTiming(d as LyricSheet));
export const takeSongTempo = () => editSheet((d) => { if (!useSongTempo(d as LyricSheet)) toast('the song has no tempo map yet'); });

/** New sheet lyrics from the transcript (or the aligned lyrics) — the current sheet is kept in the library. */
export async function seedFromSong(from: 'transcript' | 'aligned') {
  let lines: { text: string; t: number; e: number }[] = [];
  if (from === 'aligned') {
    lines = (store.state.project.lyrics?.lines ?? []).filter((l) => l.words.length).map((l) => ({ text: l.words.map((w) => w.w).join(' '), t: l.words[0].t, e: l.words[l.words.length - 1].e }));
  } else {
    const tr = await transcript();
    if (!tr) throw new Error('no transcript yet — transcribe the song first');
    const { fromTranscript } = await import('../../core/lyrics');
    lines = fromTranscript(tr.words, tr.segments).lines.map((l) => ({ text: l.words.map((w) => w.w).join(' '), t: l.words[0].t, e: l.words[l.words.length - 1].e }));
  }
  if (!lines.length) throw new Error('nothing to seed from');
  await snapshot('before seeding from the song');
  editSheet((d) => {
    const s = d as LyricSheet;
    useSongTempo(s);
    s.blocks = blocksFromTimed(s, lines);
    s.tags = [];
    delete s.version;
  });
  toast(`seeded ${lines.length} lines from the ${from === 'aligned' ? 'aligned lyrics' : 'transcript'}`);
}

// ---- read-along click track ---------------------------------------------------------------------

let ctx: AudioContext | null = null;
let clickTimer: any = null;
export function stopClick() {
  clearInterval(clickTimer);
  clickTimer = null;
  lx.set({ click: null });
}
export function startClick(fromBeat: number) {
  stopClick();
  ctx ??= new AudioContext();
  const ac = ctx;
  void ac.resume();
  const s = sheet();
  const c = clockOf(s);
  const t0 = ac.currentTime + 0.08;
  const s0 = c.sec(fromBeat);
  let next = Math.ceil(fromBeat - 1e-6);
  const tick = () => {
    const now = ac.currentTime;
    const beat = c.beat(s0 + (now - t0));
    // schedule clicks ~150 ms ahead
    while (t0 + (c.sec(next) - s0) < now + 0.15) {
      const when = t0 + (c.sec(next) - s0);
      if (when >= now - 0.01) {
        const o = ac.createOscillator(), g = ac.createGain();
        const down = ((next % s.beatsPerBar) + s.beatsPerBar) % s.beatsPerBar === 0;
        o.frequency.value = down ? 1500 : 1000;
        g.gain.setValueAtTime(down ? 0.35 : 0.18, when);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
        o.connect(g).connect(ac.destination);
        o.start(when); o.stop(when + 0.06);
      }
      next++;
    }
    lx.set({ click: { playing: true, beat }, center: beat, driver: 'play' });
  };
  tick();
  clickTimer = setInterval(tick, 30);
}

export { singText };

// Analysis drawer: findings (switchable rules), song profile + scorecard, reference shape, section targets, and what
// the produced song actually sang. Plus the block profile card shown when hovering a block header.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CATEGORIES, DIM_LABELS, RULES, ruleOn, ruleTh, shapeFromText, type BlockM, type Dims, type Finding, type RefShape,
} from '../../core/lyricMetrics';
import { sid, sheetEnd, normalize } from '../../core/sheet';
import type { BlockKind, LyricSheet, SectionTarget, SheetBlock } from '../../core/types';
import { useLLM } from '../StoryPanel';
import { useStore } from '../store';
import { useDismiss } from '../useDismiss';
import { runMeaning, staleMeaning, syncSem, useAnalysis, useDictState, useMeaningBusy, useSem, valenceColor } from './analysis';
import { centerOfLine } from './Panels';
import { editSheet, lx, sheet, toast, useLx, useSheet } from './state';

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0')}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

// ---- radar ------------------------------------------------------------------------------------------

export const Radar: React.FC<{ dims: Dims; size?: number; compare?: Dims }> = ({ dims, size = 150, compare }) => {
  const r = size / 2 - 22, c = size / 2;
  const n = DIM_LABELS.length;
  const pt = (i: number, v: number) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [c + Math.cos(a) * r * v, c + Math.sin(a) * r * v]; };
  const poly = (d: Dims) => DIM_LABELS.map(([k], i) => pt(i, d[k] ?? 0).map((x) => x.toFixed(1)).join(',')).join(' ');
  return (
    <svg className="lx-radar" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="profile radar">
      {[0.25, 0.5, 0.75, 1].map((v) => <polygon key={v} points={DIM_LABELS.map((_, i) => pt(i, v).join(',')).join(' ')} className="grid" />)}
      {DIM_LABELS.map(([k, label], i) => {
        const [x, y] = pt(i, 1.18);
        const missing = dims[k] === null;
        return <text key={k} x={x} y={y} className={`lbl ${missing ? 'na' : ''}`} textAnchor={x < c - 4 ? 'end' : x > c + 4 ? 'start' : 'middle'} dominantBaseline="middle">{label.split(' ')[0]}{missing ? ' ?' : ''}</text>;
      })}
      {compare ? <polygon points={poly(compare)} className="cmp" /> : null}
      <polygon points={poly(dims)} className="val" />
      <title>{DIM_LABELS.map(([k, l]) => `${l}: ${dims[k] === null ? 'needs the AI meaning analysis' : pct(dims[k]!)}`).join('\n')}</title>
    </svg>
  );
};

// ---- block profile card ---------------------------------------------------------------------------

export const ProfileCard: React.FC = () => {
  const p = useLx((x) => x.profile);
  const a = useAnalysis();
  const b = p ? a.blocks.find((x) => x.id === p.block) : undefined;
  if (!p || !b) return null;
  const x = Math.min(window.innerWidth - 380, p.x + 12), y = Math.min(window.innerHeight - 330, Math.max(84, p.y - 20));
  return (
    <div className="lx-pcard" style={{ left: x, top: y }}>
      <BlockProfile b={b} />
    </div>
  );
};

const BlockProfile: React.FC<{ b: BlockM }> = ({ b }) => (
  <>
    <div className="pc-h"><b>{b.name}</b><span className="dim"> {b.kind} · {+b.bars.toFixed(1)} bars · {fmt(b.sec)}</span></div>
    {!b.sung.length ? <div className="dim">no sung lines yet</div> : (
      <div className="pc-body">
        <table className="pc-seq"><tbody>
          <tr><td>syllables</td><td>{b.syllables.join(' ')}{b.shape ? <span className="dim"> · target {b.shape.syl.join(' ')}</span> : null}</td></tr>
          <tr><td>rhyme</td><td>{b.rhyme}{b.shape?.rhyme ? <span className="dim"> · target {b.shape.rhyme}</span> : null}</td></tr>
          <tr><td>stress</td><td className="mono">{b.stress.slice(0, 4).map((x, i) => <div key={i}>{x}</div>)}{b.stress.length > 4 ? <div className="dim">…</div> : null}</td></tr>
          <tr><td>syl / beat</td><td>{b.density.map((d) => d.toFixed(1)).join(' ')}</td></tr>
          <tr><td>held notes</td><td>{b.sustain.map((v) => (v === 'open' ? '○' : v === 'closed' ? '●' : '·')).join(' ')}</td></tr>
          <tr><td>meter</td><td>{b.meter ?? '—'} <span className="dim">({pct(b.meterFit)} fit)</span></td></tr>
          <tr><td>breath</td><td>{b.breathMax.toFixed(1)} s max · {pct(b.restShare)} rest</td></tr>
          <tr><td>repetition</td><td>{pct(b.repetition)} lines · {pct(b.lexical)} unique words</td></tr>
          <tr><td>sound</td><td>{b.internal} internal · {b.multi} multisyllabic · {b.alliteration} alliteration</td></tr>
          <tr><td>voice</td><td>{b.perspective ?? '—'} · {b.tense ?? '—'}</td></tr>
          {b.sem ? <tr><td>meaning</td><td><span style={{ color: valenceColor(b.sem.valence) }}>{b.sem.emotions.join(', ')}</span> <span className="dim">— {b.sem.summary}</span></td></tr> : null}
          {b.song ? <tr><td>in the song</td><td>{b.song.rushed} rushed · {b.song.stretched} stretched · {b.song.dropped} dropped{b.song.onBeat !== null ? ` · ${pct(b.song.onBeat)} stresses on beat` : ''}</td></tr> : null}
        </tbody></table>
        <Radar dims={b.dims} size={150} />
      </div>
    )}
    <div className="dim pc-note">amounts, not grades — ○ open / ● closed vowel on a held note</div>
  </>
);

// ---- the drawer -------------------------------------------------------------------------------------

export const AnalysisPanel: React.FC = () => {
  const tab = useLx((x) => x.atab);
  const a = useAnalysis();
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => lx.set({ panel: null }));
  const tabs: [typeof tab, string][] = [['findings', `Findings${a.findings.length ? ` ${a.findings.length}` : ''}`], ['profile', 'Profile'], ['shape', 'Shape'], ['targets', 'Targets'], ...(a.sung.length ? [['song', 'Song'] as [typeof tab, string]] : [])];
  return (
    <div className="lx-drawer wide" ref={ref}>
      <div className="lx-drawer-h">
        <b>Analysis</b>
        <span className="tabs">{tabs.map(([id, l]) => <button key={id} className={tab === id ? 'on' : ''} onClick={() => lx.set({ atab: id })}>{l}</button>)}</span>
        <span className="grow" />
        <DictBadge />
        <button onClick={() => lx.set({ panel: null })}>✕</button>
      </div>
      <div className="lx-an">
        {tab === 'findings' ? <FindingsTab /> : tab === 'profile' ? <ProfileTab /> : tab === 'shape' ? <ShapeTab /> : tab === 'targets' ? <TargetsTab /> : <SongTab />}
      </div>
    </div>
  );
};

const DictBadge: React.FC = () => {
  const d = useDictState();
  return d === 'loaded'
    ? <span className="dim small" title="pronunciations from the CMU Pronouncing Dictionary">CMUdict</span>
    : <span className="dim small" title="pronunciations from a built-in word list + spelling rules (words outside the list are estimated). Run `node scripts/cmudict.mjs` and restart the editor for the full dictionary.">estimated pronunciations</span>;
};

function jumpTo(f: Pick<Finding, 'block' | 'line'>) {
  const s = sheet();
  const b = s.blocks.find((x) => x.id === f.block);
  if (!b) return;
  if (f.line) lx.set({ focus: { block: b.id, line: f.line }, selBlock: b.id, center: centerOfLine(s, b.id, f.line), driver: null });
  else lx.set({ selBlock: b.id, focus: null, center: b.at + Math.min(b.len / 2, 8), driver: null });
}

function linkBlocks(aId: string, bId: string) {
  editSheet((d) => {
    const a = d.blocks.find((x) => x.id === aId), b = d.blocks.find((x) => x.id === bId);
    if (!a || !b) return;
    const link = a.link ?? b.link ?? sid('k');
    a.link = link;
    b.link = link;
    // the copy takes the original's lines (same text, shared ids), its tags go with the old ids
    const ids = new Set(b.lines.map((l) => l.id));
    b.lines = JSON.parse(JSON.stringify(a.lines));
    d.tags = d.tags.filter((t) => !ids.has(t.line));
  });
  toast('linked — edits now apply to both');
}

const FindingsTab: React.FC = () => {
  const a = useAnalysis();
  const s = useSheet();
  const [cat, setCat] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const name = (id: string) => s.blocks.find((b) => b.id === id)?.name ?? id;
  const list = a.findings.filter((f) => !cat || f.cat === cat);
  const hiddenN = Object.values(a.hidden).reduce((x, y) => x + y, 0);
  if (settings) return <RulesSettings onBack={() => setSettings(false)} />;
  return (
    <>
      <div className="row pad cats">
        <button className={!cat ? 'on' : ''} onClick={() => setCat(null)}>all {a.findings.length}</button>
        {CATEGORIES.map((c) => { const n = a.findings.filter((f) => f.cat === c.id).length; return n ? <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.label.toLowerCase()} {n}</button> : null; })}
        <span className="grow" />
        <button onClick={() => setSettings(true)} title="switch rules on / off, thresholds, strict meter">Rules…{hiddenN ? <span className="dim"> ({hiddenN} hidden)</span> : null}</button>
      </div>
      <div className="lx-flist">
        {!list.length ? <div className="hint pad">No findings{cat ? ' in this category' : ''}. Findings flag mismatches (with the tempo, a sibling section, a target) — not quality. {hiddenN ? `${hiddenN} more from rules that are off.` : ''}</div> : list.map((f) => (
          <div key={f.id} className={`lx-f lvl-${f.level}`} onClick={() => jumpTo(f)} title="click: jump to it">
            <span className="ic">{f.level === 'warn' ? '▲' : '●'}</span>
            <div className="info">
              <div><span className="blk">{name(f.block)}</span> {f.msg}</div>
              {f.detail ? <div className="dim">{f.detail}</div> : null}
            </div>
            {f.fix?.kind === 'link' ? <button onClick={(e) => { e.stopPropagation(); linkBlocks(f.fix!.a, f.fix!.b); }}>Link</button> : null}
            <span className="rule dim">{f.rule}</span>
          </div>
        ))}
      </div>
    </>
  );
};

const RulesSettings: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const s = useSheet();
  const a = useAnalysis();
  const set = (id: string, p: { on?: boolean; th?: number }) => editSheet((d) => {
    d.lint ??= {};
    d.lint.rules ??= {};
    d.lint.rules[id] = { ...d.lint.rules[id], ...p };
  });
  return (
    <div className="lx-rules">
      <div className="row pad"><button onClick={onBack}>‹ Findings</button><span className="grow" />
        <label className="chk" title="AI proposals that change a line's syllable count by more than one are rejected and the AI retries">
          <input type="checkbox" checked={!!s.lint?.strict} onChange={(e) => editSheet((d) => { d.lint = { ...d.lint, strict: e.target.checked }; })} /> strict meter for AI edits
        </label>
      </div>
      {CATEGORIES.map((c) => {
        const rs = RULES.filter((r) => r.cat === c.id);
        return (
          <div key={c.id} className="rgroup">
            <div className="rh">{c.label}</div>
            {rs.map((r) => (
              <div key={r.id} className="rr">
                <label className="chk" title={r.help}><input type="checkbox" checked={ruleOn(s, r.id)} onChange={(e) => set(r.id, { on: e.target.checked })} /> {r.label}</label>
                {r.th !== undefined ? <span className="th"><input type="number" step={r.th < 1 ? 0.05 : 1} value={ruleTh(s, r.id)} onChange={(e) => set(r.id, { th: Number(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} /> <span className="dim">{r.unit}</span></span> : null}
                {!ruleOn(s, r.id) && a.hidden[r.id] ? <span className="dim n">{a.hidden[r.id]}</span> : null}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};

const ProfileTab: React.FC = () => {
  const a = useAnalysis();
  const s = useSheet();
  const m = useSem();
  const busy = useMeaningBusy();
  const [llm] = useLLM();
  const stale = staleMeaning(s, m);
  const g = a.song;
  if (!a.blocks.some((b) => b.sung.length)) return <div className="hint pad">Write some lyrics first — the profile describes what the song is: structure, rhythm against the tempo, rhyme, repetition, sound and (with the AI) meaning.</div>;
  return (
    <div className="lx-prof">
      <div className="sec-seq" title="section sequence">{g.sections.map((x, i) => <span key={i} className={`k-${a.blocks[i].kind}`}>{x}</span>)}</div>
      <div className="prof-top">
        <table className="pc-seq"><tbody>
          <tr><td>length</td><td>{fmt(g.sec)} · first chorus {g.firstChorus === null ? '—' : fmt(g.firstChorus)}</td></tr>
          <tr><td>hook</td><td>{a.hook ? <>“{a.hook.text}” <span className="dim">×{a.hook.count} · first at {fmt(a.hook.firstSec)} · in {pct(a.hook.chorusShare)} of choruses</span></> : <span className="dim">no recurring phrase yet</span>}</td></tr>
          <tr><td>density</td><td>{g.density.toFixed(2)} syl/beat · {g.sps.toFixed(1)} syl/s average</td></tr>
          <tr><td>repetition</td><td>{pct(g.repetition)} repeated lines · {pct(g.lexical)} unique words · {g.rhymeFamilies} rhyme families</td></tr>
          {g.chorusConsistency !== null ? <tr><td>choruses</td><td>{pct(g.chorusConsistency)} identical across repeats</td></tr> : null}
        </tbody></table>
        <Radar dims={g.dims} size={170} />
      </div>
      <div className="row pad meaning">
        <button className="accent" disabled={busy} onClick={() => runMeaning(llm.provider)} title="one AI call for the changed blocks: emotion, imagery, narrative, clichés — cached by block text">
          {busy ? 'analysing…' : stale ? `Analyse meaning (${stale} block${stale > 1 ? 's' : ''})` : 'Meaning analysed ✓'}
        </button>
        {!stale && !busy ? <button onClick={() => runMeaning(llm.provider, true)} title="ask again, ignoring the cache">Re-analyse</button> : null}
        <span className="dim">imagery and narrative need it; the emotion lane shows it against the energy curve</span>
      </div>
      {a.hooks.length > 1 ? <div className="pad"><div className="rh">recurring phrases</div>{a.hooks.map((h) => <div key={h.text} className="hk">“{h.text}” <span className="dim">×{h.count} · {fmt(h.firstSec)}</span></div>)}</div> : null}
      <table className="lx-btable">
        <thead><tr><th>block</th><th>syllables</th><th>rhyme</th><th>syl/beat</th><th>rep</th><th>meter</th><th>voice</th><th>meaning</th></tr></thead>
        <tbody>{a.blocks.filter((b) => b.sung.length).map((b) => (
          <tr key={b.id} onClick={() => jumpTo({ block: b.id })}>
            <td className="nm">{b.name}</td><td className="mono">{b.syllables.join(' ')}</td><td className="mono">{b.rhyme}</td>
            <td>{(b.density.reduce((x, y) => x + y, 0) / Math.max(1, b.density.length)).toFixed(1)}</td><td>{pct(b.repetition)}</td><td>{b.meter ?? '—'}</td>
            <td>{b.perspective ?? '—'}{b.tense ? ` · ${b.tense}` : ''}</td>
            <td>{b.sem ? <span style={{ color: valenceColor(b.sem.valence) }} title={b.sem.summary}>{b.sem.emotions.join(', ')}</span> : <span className="dim">—</span>}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
};

/** paste a reference lyric: only its shape is kept (block kinds, bars, syllables per line, rhyme letters) */
const ShapeTab: React.FC = () => {
  const s = useSheet();
  const sel = useLx((x) => x.selBlock);
  const [text, setText] = useState('');
  const shape: RefShape | null = useMemo(() => (text.trim() ? shapeFromText(text, s.beatsPerBar) : null), [text, s.beatsPerBar]);
  const [pick, setPick] = useState(0);
  const selB = s.blocks.find((b) => b.id === sel);
  const layout = () => {
    if (!shape) return;
    editSheet((d) => {
      const empty = !d.blocks.some((b) => b.lines.length);
      if (empty) d.blocks = [];
      let at = sheetEnd(d as LyricSheet);
      for (const rb of shape.blocks) {
        const b: SheetBlock = { id: sid('b'), kind: rb.kind, name: rb.name, at, len: rb.bars * d.beatsPerBar, lines: [], shape: rb.shape };
        d.blocks.push(b);
        at += b.len;
      }
      normalize(d as LyricSheet);
    });
    setText('');
    toast('structure laid out from the reference shape — the reference text was not kept');
  };
  const applyTo = () => {
    if (!shape || !selB) return;
    const rb = shape.blocks[pick];
    editSheet((d) => { const b = d.blocks.find((x) => x.id === selB.id); if (b) b.shape = rb.shape; });
    toast(`${selB.name} now targets ${rb.shape.syl.join(' ')}`);
  };
  const withShape = s.blocks.filter((b) => b.shape);
  return (
    <div className="lx-shape">
      <p className="dim pad">Paste a lyric whose feel you like. Only its shape is extracted — blocks, bars, syllables per line, rhyme letters, stress — and the words are dropped. Lay it out as a structure to write into, or give one block its target. The gutter then shows actual / target syllables.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={'[Verse 1]\n…reference lyric…\n\n[Chorus]\n…'} onKeyDown={(e) => e.stopPropagation()} />
      {shape ? (
        <>
          <table className="lx-btable"><thead><tr><th /><th>block</th><th>bars</th><th>syllables</th><th>rhyme</th></tr></thead>
            <tbody>{shape.blocks.map((b, i) => (
              <tr key={i} className={pick === i ? 'on' : ''} onClick={() => setPick(i)}><td><input type="radio" checked={pick === i} onChange={() => setPick(i)} /></td><td>{b.name}</td><td>{b.bars}</td><td className="mono">{b.shape.syl.join(' ')}</td><td className="mono">{b.shape.rhyme}</td></tr>
            ))}</tbody></table>
          <div className="row pad">
            <button className="accent" onClick={layout}>{s.blocks.some((b) => b.lines.length) ? 'Append as structure' : 'Lay out as structure'}</button>
            <button disabled={!selB} onClick={applyTo} title="select a block on the timeline first">{selB ? `Use “${shape.blocks[pick]?.name}” as ${selB.name}’s shape` : 'select a block to give it a shape'}</button>
          </div>
        </>
      ) : null}
      {withShape.length ? (
        <div className="pad">
          <div className="rh">blocks with a target shape</div>
          {withShape.map((b) => (
            <div key={b.id} className="row">
              <span className="nm">{b.name}</span><span className="mono dim">{b.shape!.syl.join(' ')} {b.shape!.rhyme}</span><span className="grow" />
              <button onClick={() => editSheet((d) => { const x = d.blocks.find((q) => q.id === b.id); if (x) delete x.shape; })}>Clear</button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const KINDS: BlockKind[] = ['verse', 'prechorus', 'chorus', 'bridge', 'hook', 'intro', 'outro', 'drop'];
const POP: Partial<Record<BlockKind, SectionTarget>> = {
  verse: { maxDensity: 2.5 }, prechorus: { maxDensity: 2 }, chorus: { maxDensity: 1.5, minRepetition: 0.4, openEnds: true }, hook: { maxDensity: 1.5, minRepetition: 0.5, openEnds: true },
};

const TargetsTab: React.FC = () => {
  const s = useSheet();
  const present = new Set(s.blocks.map((b) => b.kind));
  const kinds = KINDS.filter((k) => present.has(k) || k === 'verse' || k === 'chorus');
  const set = (k: BlockKind, p: Partial<SectionTarget>) => editSheet((d) => {
    d.targets ??= {};
    const t = { ...d.targets[k], ...p };
    (Object.keys(t) as (keyof SectionTarget)[]).forEach((x) => { if (t[x] === undefined || t[x] === 0 || t[x] === false) delete t[x]; });
    if (Object.keys(t).length) d.targets[k] = t; else delete d.targets[k];
  });
  const num = (v: string) => (v === '' ? undefined : Number(v));
  return (
    <div className="lx-targets">
      <p className="dim pad">Optional targets per section kind. They feed the findings (rule “Section targets”) and the AI. Empty = no target.</p>
      <table className="lx-btable">
        <thead><tr><th>section</th><th title="syllables per beat, per line">max syl/beat</th><th title="share of repeated lines">min repetition %</th><th title="line endings on open, sustainable vowels">open endings</th></tr></thead>
        <tbody>{kinds.map((k) => {
          const t = s.targets?.[k] ?? {};
          return (
            <tr key={k}>
              <td>{k}</td>
              <td><input type="number" step={0.1} min={0} value={t.maxDensity ?? ''} onChange={(e) => set(k, { maxDensity: num(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} /></td>
              <td><input type="number" step={5} min={0} max={100} value={t.minRepetition !== undefined ? Math.round(t.minRepetition * 100) : ''} onChange={(e) => { const v = num(e.target.value); set(k, { minRepetition: v === undefined ? undefined : v / 100 }); }} onKeyDown={(e) => e.stopPropagation()} /></td>
              <td><input type="checkbox" checked={!!t.openEnds} onChange={(e) => set(k, { openEnds: e.target.checked })} /></td>
            </tr>
          );
        })}</tbody>
      </table>
      <div className="row pad">
        <button onClick={() => editSheet((d) => { d.targets = JSON.parse(JSON.stringify(POP)); })} title="verse ≤ 2.5 syl/beat · chorus ≤ 1.5, ≥ 40% repeated, open endings">Pop defaults</button>
        <button onClick={() => editSheet((d) => { delete d.targets; })}>Clear all</button>
      </div>
    </div>
  );
};

const SongTab: React.FC = () => {
  const a = useAnalysis();
  const songTempo = useSheet().songTempo;
  const hasSong = useStore((x) => !!x.project.audio);
  const flagged = a.sung.filter((r) => r.flag);
  const name = (id: string) => a.blocks.find((b) => b.id === id)?.name ?? id;
  return (
    <div className="lx-songtab">
      <p className="dim pad">What the produced song actually sang, from the alignment: lines the generator rushed, stretched or didn’t sing as written, and where the stressed syllables landed on the beat grid{songTempo ? '' : ' (needs Song ▸ Use song tempo)'}.</p>
      {!hasSong ? <div className="hint pad">No song yet.</div> : null}
      <table className="lx-btable">
        <thead><tr><th>block</th><th>lines</th><th>rushed</th><th>stretched</th><th>not as written</th><th>stresses on beat</th></tr></thead>
        <tbody>{a.blocks.filter((b) => b.song).map((b) => (
          <tr key={b.id} onClick={() => jumpTo({ block: b.id })}><td className="nm">{b.name}</td><td>{b.song!.lines}</td><td>{b.song!.rushed || ''}</td><td>{b.song!.stretched || ''}</td><td>{b.song!.dropped || ''}</td><td>{b.song!.onBeat === null ? '—' : pct(b.song!.onBeat)}</td></tr>
        ))}</tbody>
      </table>
      {flagged.length ? (
        <div className="lx-flist">{flagged.map((r) => {
          const m = a.byKey.get(r.key)!;
          return (
            <div key={r.key} className={`lx-f lvl-${r.flag === 'stretched' ? 'info' : 'warn'}`} onClick={() => jumpTo(r)}>
              <span className="ic">{r.flag === 'stretched' ? '●' : '▲'}</span>
              <div className="info"><div><span className="blk">{name(r.block)}</span> {r.flag}: {m.text}</div>
                <div className="dim">sung {fmt(r.t0)}–{fmt(r.t1)} ({(r.t1 - r.t0).toFixed(1)} s, {r.sps.toFixed(1)} syl/s) · planned {m.dur.toFixed(1)} s ({m.sps.toFixed(1)} syl/s)</div></div>
            </div>
          );
        })}</div>
      ) : a.sung.length ? <div className="hint pad">Every aligned line was sung close to the plan.</div> : null}
    </div>
  );
};

/** keep the meaning cache mirrored for the blocks on the sheet */
export function useSemSync() {
  const s = useSheet();
  useEffect(() => {
    const t = setTimeout(() => void syncSem(s), 800);
    return () => clearTimeout(t);
  }, [s]);
}

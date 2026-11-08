// Lyrics stage panels: word-tag toolbar, library (versions), export, keyboard help, template + song menus.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { applyTemplate, compileExport, diffLines, lineTimes, sheetToText, sid, structureText, TEMPLATES, EXPORT_DEFAULTS } from '../../core/sheet';
import type { LyricSheet, WordTag } from '../../core/types';
import { useStore } from '../store';
import { useDismiss } from '../useDismiss';
import {
  adoptSongTiming, alignSheet, deleteVersion, getVersion, isDirtySinceVersion, listVersions, loadVersion, nextVersionName,
  renameVersion, saveVersion, seedFromSong, takeSongTempo, transcript, type VersionInfo,
} from './actions';
import { focusChat } from './Chat';
import { analyzeSheet, profileDelta, profileSummary, type ProfileSummary } from '../../core/lyricMetrics';
import { currentAnalysis } from './analysis';
import { askText, openMenu } from './menus';
import { editSheet, lx, sheet, toast, useLx, useSheet } from './state';

// ---- word tags ----------------------------------------------------------------------------------

export const TagBar: React.FC = () => {
  const ws = useLx((x) => x.wsel);
  const s = useSheet();
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setNote(null), [ws]);
  if (!ws) return null;
  const labels = [...new Set(s.tags.filter((t) => t.label).map((t) => t.label!))].slice(0, 8);
  const tagged = s.tags.filter((t) => ws.lines.some((l) => l.line === t.line && t.from < l.to && t.to > l.from));
  const add = (kind: WordTag['kind'], label?: string, text?: string) => {
    editSheet((d) => {
      for (const l of ws.lines) {
        d.tags = d.tags.filter((t) => !(t.line === l.line && t.kind === kind && t.label === label && t.from < l.to && t.to > l.from));
        d.tags.push({ id: sid('t'), line: l.line, from: l.from, to: l.to, kind, label, note: text });
      }
    });
    lx.set({ wsel: null });
  };
  const untag = () => { editSheet((d) => { d.tags = d.tags.filter((t) => !tagged.some((x) => x.id === t.id)); }); lx.set({ wsel: null }); };
  const submitNote = () => {
    const v = (note ?? '').trim();
    if (!v) return;
    const m = v.match(/^([^:]{1,24}):\s*(.*)$/);
    if (m) add('note', m[1].trim(), m[2].trim() || undefined);
    else if (v.length <= 24 && !/\s{2,}/.test(v)) add('note', v);
    else add('note', undefined, v);
  };
  const x = Math.max(8, Math.min(window.innerWidth - 420, ws.rect.x));
  const y = ws.rect.y > 90 ? ws.rect.y - 40 : ws.rect.y + ws.rect.h + 8;
  return (
    <div className="lx-tagbar" ref={ref} style={{ left: x, top: y }} onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>
      {note === null ? (
        <>
          <span className="sel">“{ws.text.length > 28 ? ws.text.slice(0, 28) + '…' : ws.text}”</span>
          <button className="t-replace" onClick={() => add('replace')} title="mark for replacement — the AI should change these words">Replace</button>
          <button className="t-keep" onClick={() => add('keep')} title="keep verbatim — the AI must not change these words">Keep</button>
          <button onClick={() => setNote('')} title="annotate with a custom label (label: note)">Note…</button>
          {labels.map((l) => <button key={l} className="t-note" onClick={() => add('note', l)}>{l}</button>)}
          {tagged.length ? <button onClick={untag} title="remove the tags under the selection">Untag</button> : null}
          <button className="accent" onClick={() => focusChat()} title="ask the AI about the selection (/)">Ask AI</button>
          <button onClick={() => lx.set({ wsel: null })}>✕</button>
        </>
      ) : (
        <>
          <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="label  or  label: note  (e.g. rhyme: should rhyme with fire)"
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') submitNote(); if (e.key === 'Escape') setNote(null); }} />
          <button className="accent" onClick={submitNote}>Tag</button>
        </>
      )}
    </div>
  );
};

/** all tags, click to jump */
export function tagsMenu(x: number, y: number) {
  const s = sheet();
  const lines = new Map(s.blocks.flatMap((b) => b.lines.map((l) => [l.id, { b, l }] as const)));
  if (!s.tags.length) return toast('no tags yet — select words in the lyrics to tag them');
  openMenu(x, y, [
    { head: `${s.tags.length} tag${s.tags.length > 1 ? 's' : ''}` },
    ...s.tags.map((t) => {
      const e = lines.get(t.line);
      return {
        label: `${t.kind === 'note' ? t.label ?? 'note' : t.kind}: “${e?.l.text.slice(t.from, t.to)}”`, hint: e?.b.name,
        color: t.kind === 'replace' ? '#ff6b6b' : t.kind === 'keep' ? '#3ddc97' : '#b48cff',
        on: () => { if (e) lx.set({ focus: { block: e.b.id, line: e.l.id }, driver: null, center: centerOfLine(s, e.b.id, e.l.id) }); },
      };
    }),
  ]);
}

export function centerOfLine(s: LyricSheet, block: string, line: string) {
  const b = s.blocks.find((x) => x.id === block);
  if (!b) return lx.get().center;
  const i = b.lines.findIndex((l) => l.id === line);
  const t = lineTimes(b)[Math.max(0, i)];
  return t ? t.at + t.len / 2 : b.at;
}

// ---- library ------------------------------------------------------------------------------------

export const Library: React.FC = () => {
  const s = useSheet();
  const [vs, setVs] = useState<VersionInfo[] | null>(null);
  const [name, setName] = useState('');
  const [cmp, setCmp] = useState<string[]>([]);
  const [diff, setDiff] = useState<{ a: string; b: string; ops: ReturnType<typeof diffLines>; delta: string[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => lx.set({ panel: null }));
  const refresh = () => listVersions().then(setVs).catch((e) => toast(e.message));
  useEffect(() => { refresh(); nextVersionName().then(setName); const f = () => refresh(); window.addEventListener('mv-versions', f); return () => window.removeEventListener('mv-versions', f); }, []);
  const dirty = isDirtySinceVersion();
  const save = async () => { await saveVersion(name.trim() || 'untitled'); toast(`saved “${name}”`); setName(await nextVersionName()); };
  const compare = async (ids: string[]) => {
    const load = async (id: string): Promise<{ sheet: LyricSheet; profile: ProfileSummary }> => {
      if (id === 'current') return { sheet: sheet(), profile: profileSummary(currentAnalysis()) };
      const v = await getVersion(id);
      return { sheet: v.sheet, profile: v.profile ?? profileSummary(analyzeSheet(v.sheet)) };
    };
    // older first, so the delta reads "from → to"
    const [a, b] = await Promise.all(ids.map(load));
    const lines = (x: LyricSheet) => [`style: ${x.style}`, ...structureText(x).split('\n'), '', ...sheetToText(x).split('\n')];
    const nm = (id: string) => (id === 'current' ? 'working copy' : vs?.find((v) => v.id === id)?.name ?? id);
    setDiff({ a: nm(ids[0]), b: nm(ids[1]), ops: diffLines(lines(a.sheet), lines(b.sheet)), delta: profileDelta(a.profile, b.profile) });
  };
  const toggle = (id: string) => setCmp((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c.slice(-1), id]));
  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
  return (
    <div className="lx-drawer" ref={ref}>
      <div className="lx-drawer-h"><b>Library</b><span className="grow" /><button onClick={() => lx.set({ panel: null })}>✕</button></div>
      <div className="lx-cur">
        working copy{s.version ? <> of <b>{s.version.name}</b></> : null}{dirty ? <span className="mod"> · modified</span> : null}
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void save(); }} placeholder="version name" />
          <button className="accent" onClick={() => void save()} title="Ctrl+S">Save version</button>
        </div>
      </div>
      <div className="lx-vlist">
        {vs === null ? <div className="hint pad">loading…</div> : !vs.length ? <div className="hint pad">No versions yet. Save one to switch back and forth; AI edits, alignment and switching also keep automatic snapshots here.</div> : vs.map((v) => (
          <div key={v.id} className={`lx-v ${s.version?.id === v.id ? 'cur' : ''} ${v.source}`}>
            <input type="checkbox" checked={cmp.includes(v.id)} onChange={() => toggle(v.id)} title="pick two to compare" />
            <div className="info">
              <div className="nm" onDoubleClick={(e) => askText(e.clientX, e.clientY, 'Rename version', v.name, (n) => n.trim() && renameVersion(v.id, n.trim()).then(refresh))}>{v.name}</div>
              <div className="dim">{new Date(v.at).toLocaleString()} · {v.source} · {v.blocks} blocks · {v.lines} lines · {fmt(v.duration)}</div>
              {v.profile ? <div className="dim prof" title="profile: section sequence, syllables per beat, repeated lines, hook">{v.profile.sections} · {v.profile.density} syl/beat · {Math.round(v.profile.repetition * 100)}% rep{v.profile.hook ? ` · “${v.profile.hook.text}”` : ''}</div> : null}
            </div>
            <button onClick={() => loadVersion(v.id).then(refresh).catch((e) => toast(e.message))} title="load into the working copy (the current one is auto-saved if modified)">Load</button>
            <button onClick={() => compare([v.id, 'current'])} title="compare with the working copy (shape and text)">Diff</button>
            <button onClick={(e) => openMenu(e.clientX, e.clientY, [
              { label: 'Rename…', on: () => askText(e.clientX, e.clientY, 'Rename version', v.name, (n) => n.trim() && renameVersion(v.id, n.trim()).then(refresh)) },
              { label: 'Delete', on: () => deleteVersion(v.id).then(refresh) },
            ])}>⋯</button>
          </div>
        ))}
      </div>
      {cmp.length === 2 ? <div className="row pad"><button className="accent" onClick={() => compare(cmp)}>Compare the two selected</button></div> : null}
      {diff ? (
        <div className="lx-diff">
          <div className="lx-drawer-h"><span><span className="del">− {diff.a}</span>  <span className="ins">+ {diff.b}</span></span><span className="grow" /><button onClick={() => setDiff(null)}>✕</button></div>
          {diff.delta.length ? <ul className="lx-delta">{diff.delta.map((d) => <li key={d}>{d}</li>)}</ul> : <div className="dim pad">same profile</div>}
          <pre>{diff.ops.map((o, i) => <div key={i} className={o.op === '-' ? 'del' : o.op === '+' ? 'ins' : ''}>{o.op === '=' ? '  ' : o.op + ' '}{o.text}</div>)}</pre>
        </div>
      ) : null}
    </div>
  );
};

// ---- export -------------------------------------------------------------------------------------

async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast(`copied ${what}`); }
  catch { toast('clipboard blocked — select the text and copy it'); }
}

export const ExportPanel: React.FC = () => {
  const s = useSheet();
  const out = useMemo(() => compileExport(s), [s]);
  const o = { ...EXPORT_DEFAULTS, ...s.exportOpts };
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => lx.set({ panel: null }));
  const setO = (p: Partial<typeof o>) => editSheet((d) => { d.exportOpts = { ...o, ...p }; });
  const over = (n: number, lim: number) => (lim && n > lim ? 'over' : '');
  return (
    <div className="lx-modal-bg">
      <div className="lx-modal" ref={ref}>
        <div className="lx-drawer-h"><b>Export for the song generator</b><span className="grow" /><button className="accent" onClick={() => copy(out.all, 'style + lyrics')}>Copy all</button><button onClick={() => lx.set({ panel: null })}>✕</button></div>
        <div className="row pad opts">
          <label>layers <select value={o.layers} onChange={(e) => setO({ layers: e.target.value as any })}><option value="header">in the section header</option><option value="line">on their own line</option><option value="off">off</option></select></label>
          <label className="chk"><input type="checkbox" checked={o.gaps} onChange={(e) => setO({ gaps: e.target.checked })} /> pauses as [Instrumental break]</label>
          <label className="chk"><input type="checkbox" checked={o.energy} onChange={(e) => setO({ energy: e.target.checked })} /> energy words</label>
          <label>limits style <input type="number" value={o.styleLimit} onChange={(e) => setO({ styleLimit: Number(e.target.value) })} /> lyrics <input type="number" value={o.lyricsLimit} onChange={(e) => setO({ lyricsLimit: Number(e.target.value) })} /></label>
        </div>
        <div className="lx-exp">
          <div className="lx-exp-h">Style <span className={`cnt ${over(out.style.length, o.styleLimit)}`}>{out.style.length} / {o.styleLimit}</span><span className="grow" /><button onClick={() => copy(out.style, 'style')}>Copy</button></div>
          <textarea readOnly value={out.style || '(no style yet — write one in the Style strip)'} rows={3} />
          <div className="lx-exp-h">Lyrics <span className={`cnt ${over(out.lyrics.length, o.lyricsLimit)}`}>{out.lyrics.length} / {o.lyricsLimit}</span><span className="grow" /><button onClick={() => copy(out.lyrics, 'lyrics')}>Copy</button></div>
          <textarea readOnly value={out.lyrics} className="big" />
        </div>
      </div>
    </div>
  );
};

// ---- keyboard help ------------------------------------------------------------------------------

const KEYS: [string, string][] = [
  ['Space', 'play / pause (the song, or the click track before there is one)'], ['↑ ↓', 'move the focus line'], ['Enter', 'edit the focused line'],
  ['Esc', 'finish editing / clear the selection'], ['Alt+↑ ↓', 'move the focused line (across blocks too)'], ['B', 'split the block at the focused line'],
  ['G / Shift+G', 'add / remove a bar of pause after the block'], ['[ ]', 'previous / next block'], ['Ctrl+C / V', 'copy / paste block'],
  ['Ctrl+Shift+V', 'paste linked (shares lines with the original)'], ['Ctrl+D / Ctrl+Shift+D', 'duplicate / duplicate linked'], ['Del', 'delete the selected block, span or tempo change'],
  ['+ − 0', 'zoom in / out / fit'], ['Ctrl+wheel', 'zoom (timeline: around the pointer)'], ['/', 'ask the AI'], ['Alt+[ ]', 'cycle the AI’s alternatives'],
  ['R', 'raw text view'], ['E', 'export'], ['F', 'analysis: findings, profile, shape, targets'], ['S', 'sound view (rhyme families)'], ['Ctrl+S', 'save a version'], ['Ctrl+Z / Y', 'undo / redo'],
  ['drag block', 'move (later blocks follow) · Alt: only this one'], ['drag track', 'paint the brush label · Alt: erase · Ctrl: paint over spans'],
];
export const KeysPanel: React.FC = () => {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => lx.set({ panel: null }));
  return (
    <div className="lx-modal-bg"><div className="lx-modal keys" ref={ref}>
      <div className="lx-drawer-h"><b>Keyboard</b><span className="grow" /><button onClick={() => lx.set({ panel: null })}>✕</button></div>
      <table><tbody>{KEYS.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody></table>
    </div></div>
  );
};

// ---- menus --------------------------------------------------------------------------------------

export function templatesMenu(x: number, y: number) {
  const empty = !sheet().blocks.some((b) => b.lines.length);
  openMenu(x, y, [
    { head: empty ? 'Lay out a structure' : 'Append a structure' },
    ...TEMPLATES.map((t) => ({ label: t.name, hint: `${t.parts.reduce((a, [, b]) => a + b, 0)} bars`, on: () => editSheet((d) => applyTemplate(d as LyricSheet, t)) })),
  ]);
}

import { energyFromSound } from './sound';
export const SongMenuButton: React.FC = () => {
  const hasSong = useStore((x) => !!x.project.audio);
  const aligned = useStore((x) => !!x.project.lyrics?.lines.some((l) => l.sheet));
  const hasLyrics = useStore((x) => !!x.project.lyrics?.lines.length);
  const songTempo = useSheet().songTempo;
  const run = (label: string, f: () => Promise<unknown> | void) => async () => {
    toast(`${label}…`);
    try { await f(); } catch (e: any) { toast(`⚠ ${e?.message ?? e}`); }
  };
  const open = async (e: React.MouseEvent) => {
    const x = e.clientX, y = e.clientY;
    const tr = hasSong ? await transcript().catch(() => null) : null;
    openMenu(x, y, hasSong ? [
      { head: 'Produced song' },
      { label: 'Transcribe + align', hint: 'Whisper', on: run('Transcribing the song', async () => {
        const { transcribe } = await import('../lyricsActions');
        await transcribe({ useVocals: false });
        await alignSheet();
      }) },
      { label: 'Re-align (stored transcript)', disabled: !tr, on: run('Aligning', () => alignSheet()) },
      { label: 'Adopt song timing', hint: 'blocks → where they’re sung', disabled: !aligned, on: () => adoptSongTiming() },
      { label: 'Set energy from the sound', hint: 'loudness → energy curve', on: () => { try { toast(energyFromSound()); } catch (e: any) { toast(`⚠ ${e?.message ?? e}`); } } },
      { label: songTempo ? 'Song tempo ✓ (re-apply)' : 'Use song tempo', on: () => takeSongTempo() },
      '-',
      { label: 'New lyrics from the transcript', disabled: !tr, on: run('Seeding', () => seedFromSong('transcript')) },
      { label: 'New lyrics from aligned lyrics', disabled: !hasLyrics, on: run('Seeding', () => seedFromSong('aligned')) },
    ] : [
      { head: 'No song yet' },
      { label: 'Drop the produced song (wav/mp3) into the project folder and restart the editor — then align the sheet to it here.', disabled: true },
    ]);
  };
  return <button onClick={open} title="align the sheet to the produced song, or seed it from the Whisper transcript">Song ▾</button>;
};


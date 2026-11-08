// Lyrics stage: header (tempo, duration, style, tools) · lyrics column · vertical timeline · AI chat.
import React, { useEffect } from 'react';
import type { PlayerRef } from '@remotion/player';
import { lineKind, lineTimes, moveLine, sheetDuration, sorted, splitBlock } from '../../core/sheet';
import type { LyricSheet } from '../../core/types';
import { Splitter, usePersistedSize } from '../Resizer';
import { store, useStore } from '../store';
import { copyBlock, deleteBlock, duplicateBlock, gapAfter, markSaved, nextVersionName, pasteBlock, saveVersion, startClick, stopClick } from './actions';
import { Chat, cycleAlternative, focusChat } from './Chat';
import { MenuHost } from './menus';
import { ExportPanel, KeysPanel, Library, SongMenuButton, TagBar, tagsMenu, templatesMenu } from './Panels';
import { SheetView } from './SheetView';
import { clockOf, editSheet, lx, sheet, toast, useLx, useSheet, ZOOM_MAX, ZOOM_MIN } from './state';
import { VTimeline } from './VTimeline';
import { AnalysisPanel, ProfileCard, useSemSync } from './AnalysisPanel';
import { loadDict, useAnalysis } from './analysis';
import './lyrics.css';

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(Math.max(0, t) % 60)).padStart(2, '0')}`;

const Header: React.FC = () => {
  const s = useSheet();
  const lock = useLx((x) => x.lock);
  const click = useLx((x) => !!x.click);
  const raw = useLx((x) => x.raw);
  const chat = useLx((x) => x.chat);
  const showStyle = useLx((x) => x.showStyle);
  const meter = useLx((x) => x.meter);
  const sound = useLx((x) => x.sound);
  const panel = useLx((x) => x.panel);
  const an = useAnalysis();
  const warns = an.findings.filter((f) => f.level === 'warn').length;
  const playing = useStore((x) => x.playing);
  const hasSong = useStore((x) => !!x.project.audio);
  const d = sheetDuration(s);
  const diff = s.target ? d.total - s.target : 0;
  const setBpm = (v: number) => { if (v > 20 && v < 400) editSheet((x) => { x.bpm = +v.toFixed(2); x.songTempo = false; }, 'bpm'); };
  return (
    <div className="lx-header">
      <label className="bpm" title="planned tempo — sets the estimated song length; the BPM column changes it over ranges">
        <input type="number" value={s.bpm} min={30} max={300} step={1} onChange={(e) => setBpm(Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()} /> bpm
      </label>
      <select value={s.beatsPerBar} onChange={(e) => editSheet((x) => { x.beatsPerBar = Number(e.target.value); })} title="beats per bar">
        {[3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}/4</option>)}
      </select>
      {s.songTempo ? <span className="tag" title="tempo taken from the produced song's analysis">song tempo</span> : null}
      <span className="dur" title={`${+(d.end / s.beatsPerBar).toFixed(1)} bars`}>≈ <b>{fmt(d.total)}</b>{d.gaps > 0.5 ? <span className="dim"> ({fmt(d.gaps)} pauses)</span> : null}</span>
      <label className="target dim" title="target length — shows how far off the plan is">target
        <input type="text" placeholder="m:ss" defaultValue={s.target ? fmt(s.target) : ''} key={s.target ?? 'none'} onKeyDown={(e) => e.stopPropagation()}
          onBlur={(e) => { const m = e.target.value.match(/^(\d+):(\d{1,2})$/); editSheet((x) => { x.target = m ? Number(m[1]) * 60 + Number(m[2]) : undefined; }); }} />
      </label>
      {s.target ? <span className={Math.abs(diff) < 5 ? 'ok' : 'off'}>{diff >= 0 ? '+' : '−'}{fmt(Math.abs(diff))}</span> : null}
      {s.target && Math.abs(diff) >= 2 ? <button onClick={() => editSheet((x) => { x.bpm = Math.round(x.bpm * (d.total / s.target!)); x.tempo = x.tempo.map((t) => ({ ...t, bpm: Math.round(t.bpm * (d.total / s.target!)) })); })} title="scale the tempo so the plan hits the target length">fit bpm</button> : null}
      <span className="sep" />
      <button onClick={(e) => templatesMenu(e.clientX, e.clientY)} title="block out a song structure">Templates ▾</button>
      <button className={raw ? 'on' : ''} onClick={() => lx.set({ raw: !raw, editing: null })} title="the whole song as text (R)">Raw</button>
      <button className={showStyle ? 'on' : ''} onClick={() => lx.set({ showStyle: !showStyle })} title="global style prompt">Style</button>
      <button onClick={(e) => tagsMenu(e.clientX, e.clientY)} title="word tags">Tags {s.tags.length ? <span className="n">{s.tags.length}</span> : null}</button>
      <SongMenuButton />
      <span className="sep" />
      <button className={click || playing ? 'on' : ''} onClick={togglePlay} title={hasSong ? 'play the song from the centre line (Space)' : 'read along: click track at the planned tempo (Space)'}>{click || playing ? '❚❚' : '▶'} {hasSong ? 'song' : 'click'}</button>
      <span className="zoom">
        <button onClick={() => zoomBy(1 / 1.4)} title="zoom out (−)">−</button>
        <span className={`lock ${lock > 0.97 ? 'on' : lock > 0.03 ? 'blend' : ''}`} title={lock > 0.97 ? 'locked: lyrics line up with the timeline' : lock > 0.03 ? 'blending' : 'flow: lyrics scroll on their own, centred on the timeline'}>{lock > 0.97 ? 'locked' : lock > 0.03 ? 'blend' : 'flow'}</span>
        <button onClick={() => zoomBy(1.4)} title="zoom in (+)">+</button>
      </span>
      <label className="chk" title="gutter: syllable density, syllables (actual / target), rhyme letters and arcs, findings"><input type="checkbox" checked={meter} onChange={(e) => lx.set({ meter: e.target.checked })} /> meter</label>
      <label className="chk" title="sound view: words tinted by rhyme family — end, internal and slant rhymes (S)"><input type="checkbox" checked={sound} onChange={(e) => lx.set({ sound: e.target.checked })} /> sound</label>
      <button className={panel === 'analysis' ? 'on' : ''} onClick={() => lx.set({ panel: panel === 'analysis' ? null : 'analysis' })} title="findings, song profile, reference shape, targets (F)">
        Analysis{warns ? <span className="n w">{warns}</span> : an.findings.length ? <span className="n">{an.findings.length}</span> : null}
      </button>
      <span className="grow" />
      <button onClick={() => lx.set({ panel: 'library' })} title="saved versions">Library{s.version ? <span className="dim"> · {s.version.name}</span> : null}</button>
      <button className="accent" onClick={() => lx.set({ panel: 'export' })} title="style + lyrics for the song generator (E)">Export</button>
      <button onClick={() => lx.set({ panel: 'keys' })} title="keyboard shortcuts">⌨</button>
      {!chat ? <button onClick={() => lx.set({ chat: true })}>AI ›</button> : null}
    </div>
  );
};

const StyleStrip: React.FC = () => {
  const s = useSheet();
  const show = useLx((x) => x.showStyle);
  if (!show) return null;
  return (
    <div className="lx-style">
      <span className="lbl">Style</span>
      <textarea value={s.style} rows={2} placeholder="genre, voice, instruments, mood, production — e.g. “dark synth-pop, breathy female vocal, 80s drum machine, cold and intimate”"
        onChange={(e) => editSheet((d) => { d.style = e.target.value; }, 'style')} onKeyDown={(e) => e.stopPropagation()} />
      <span className="dim cnt">{s.style.length}</span>
    </div>
  );
};

function zoomBy(f: number) {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, lx.get().zoom * f));
  lx.set({ zoom: z, driver: null });
}

function fitZoom() {
  const s = sheet();
  const end = Math.max(16, sorted(s).reduce((m, b) => Math.max(m, b.at + b.len), 0));
  const vp = document.querySelector('.vt-vp') as HTMLElement | null;
  const h = vp?.clientHeight ?? 600;
  lx.set({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (h - 40) / end)), center: end / 2, driver: null });
}

/** widest the chat can be: what's left after the lyrics pane's minimum and the timeline (its width grows with tracks) */
const LYRICS_MIN = 320, CHAT_MIN = 260, BLOCKS_MIN = 60;
/** the blocks column can grow while the lyrics pane keeps its minimum (the chat gives way first) */
function maxBlocks() {
  const vt = document.querySelector('.lyricsscreen .vt') as HTMLElement | null;
  const col = document.querySelector('.lyricsscreen .vt-col.blocks') as HTMLElement | null;
  return Math.max(BLOCKS_MIN, (col?.offsetWidth ?? 126) + window.innerWidth - LYRICS_MIN - (vt?.offsetWidth ?? 540) - 10 - CHAT_MIN);
}
function maxChat() {
  const vt = document.querySelector('.lyricsscreen .vt') as HTMLElement | null;
  return Math.max(CHAT_MIN, window.innerWidth - LYRICS_MIN - (vt?.offsetWidth ?? 540) - 10);
}

const player = () => (window as any).__player as PlayerRef | undefined;

function togglePlay() {
  const st = lx.get();
  if (st.click) return stopClick();
  if (store.state.project.audio) {
    const p = player();
    if (!p) return;
    if (store.state.playing) p.pause();
    else { store.seek(Math.max(0, clockOf(sheet()).sec(st.center))); p.play(); }
    return;
  }
  startClick(st.center);
}

/** all lines in order (for ↑ ↓ focus) */
const flatLines = (s: LyricSheet) => sorted(s).flatMap((b) => b.lines.map((l, i) => ({ b, l, i })));

function focusTo(block: string, line: string) {
  const s = sheet();
  const b = s.blocks.find((x) => x.id === block);
  if (!b) return;
  const i = b.lines.findIndex((l) => l.id === line);
  const t = lineTimes(b)[i];
  lx.set({ focus: { block, line }, selBlock: block, center: t ? t.at + Math.max(t.len, 0) / 2 : b.at, driver: null });
}

function useLyricsKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (store.state.mode !== 'lyrics') return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const st = lx.get();
      const s = sheet();
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const blockId = st.selBlock ?? st.focus?.block ?? null;
      const handled = () => { e.preventDefault(); e.stopPropagation(); };
      if (ctrl && k === 'z' && !e.shiftKey) { handled(); return store.doUndo(); }
      if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { handled(); return store.doRedo(); }
      if (ctrl && k === 's') { handled(); nextVersionName().then((n) => saveVersion(n)).then((r) => { markSaved(); toast(`saved version “${r.name}”`); }).catch((er) => toast(er.message)); return; }
      if (ctrl && k === 'c' && blockId && !window.getSelection()?.toString()) { handled(); return copyBlock(blockId); }
      if (ctrl && k === 'v') { handled(); return pasteBlock(blockId, e.shiftKey); }
      if (ctrl && k === 'd' && blockId) { handled(); return duplicateBlock(blockId, e.shiftKey); }
      if (e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) { handled(); return cycleAlternative(e.code === 'BracketLeft' ? -1 : 1); }
      if (ctrl) return;
      if (k === ' ') { handled(); return togglePlay(); }
      if (k === 'escape') {
        if (st.panel) return lx.set({ panel: null });
        if (st.wsel) return lx.set({ wsel: null });
        return lx.set({ selBlock: null, selSpan: null, selTempo: null, focus: null });
      }
      if (k === 'delete' || k === 'backspace') {
        handled();
        if (st.selSpan) { const { track, span } = st.selSpan; editSheet((d) => { const t = d.tracks.find((x) => x.id === track); if (t) t.spans = t.spans.filter((x) => x.id !== span); }); return lx.set({ selSpan: null }); }
        if (st.selTempo) { const id = st.selTempo; editSheet((d) => { d.tempo = d.tempo.filter((x) => x.id !== id); }); return lx.set({ selTempo: null }); }
        if (st.selBlock) return deleteBlock(st.selBlock);
        return;
      }
      if (k === 'arrowup' || k === 'arrowdown') {
        handled();
        const dir = k === 'arrowup' ? -1 : 1;
        if (e.altKey && st.focus) {
          let r: ReturnType<typeof moveLine> = null;
          editSheet((d) => { r = moveLine(d as LyricSheet, st.focus!.block, st.focus!.line, dir); });
          const res = r as ReturnType<typeof moveLine>;
          if (res) focusTo(res.block, res.line);
          return;
        }
        const all = flatLines(s);
        if (!all.length) return;
        let i = st.focus ? all.findIndex((x) => x.b.id === st.focus!.block && x.l.id === st.focus!.line) : -1;
        if (i < 0) { const c = st.center; i = Math.max(0, all.findIndex((x) => lineTimes(x.b)[x.i].at >= c) - (dir > 0 ? 1 : 0)); }
        else i = Math.max(0, Math.min(all.length - 1, i + dir));
        return focusTo(all[i].b.id, all[i].l.id);
      }
      if (k === 'enter' && st.focus) {
        handled();
        const b = s.blocks.find((x) => x.id === st.focus!.block);
        if (!b) return;
        const i = b.lines.findIndex((l) => l.id === st.focus!.line);
        const caret = b.lines.slice(0, i + 1).reduce((a, l) => a + l.text.length + 1, 0) - 1;
        return lx.set({ editing: { block: b.id, caret } });
      }
      if (k === 'b' && st.focus) {
        const b = s.blocks.find((x) => x.id === st.focus!.block);
        const i = b?.lines.findIndex((l) => l.id === st.focus!.line) ?? -1;
        if (!b || i <= 0) return toast('focus a line inside a block (not its first) to split there');
        editSheet((d) => { splitBlock(d as LyricSheet, b.id, i); });
        return;
      }
      if (k === 'g' && blockId) { handled(); return gapAfter(blockId, e.shiftKey ? -1 : 1); }
      if (k === '[' || k === ']') {
        const bs = sorted(s);
        const c = st.center;
        const tgt = k === ']' ? bs.find((b) => b.at > c + 0.5) : [...bs].reverse().find((b) => b.at < c - 0.5);
        if (tgt) lx.set({ center: tgt.at + Math.min(tgt.len / 2, 8), selBlock: tgt.id, driver: null });
        return;
      }
      if (k === '+' || k === '=') return zoomBy(1.4);
      if (k === '-' || k === '_') return zoomBy(1 / 1.4);
      if (k === '0') return fitZoom();
      if (k === '/') { handled(); return focusChat(); }
      if (k === 'r') return lx.set({ raw: !st.raw, editing: null });
      if (k === 'e') return lx.set({ panel: st.panel === 'export' ? null : 'export' });
      if (k === 'f') return lx.set({ panel: st.panel === 'analysis' ? null : 'analysis' });
      if (k === 's') return lx.set({ sound: !st.sound });
      if (k === '?') return lx.set({ panel: 'keys' });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/** follow the song while it plays */
function useFollowSong() {
  useEffect(() => {
    let raf = 0;
    const f = () => {
      if (store.state.mode === 'lyrics' && store.state.playing && store.state.project.audio) {
        const b = clockOf(sheet()).beat(store.time);
        if (Math.abs(b - lx.get().center) > 0.01) lx.set({ center: b, driver: 'play' });
      }
    };
    const un = store.subscribeTime(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(f); });
    return () => { un(); cancelAnimationFrame(raf); };
  }, []);
}

export const LyricsScreen: React.FC = () => {
  const chat = useLx((x) => x.chat);
  const panel = useLx((x) => x.panel);
  const toastMsg = useLx((x) => x.toast);
  const s = useStore((x) => x.project.sheet);
  const [blocksW, setBlocksW] = usePersistedSize('lyrics-blocks', () => 126);
  const [chatW, setChatW] = usePersistedSize('lyrics-chat', () => Math.max(320, Math.round(window.innerWidth * 0.26)));
  useLyricsKeys();
  useFollowSong();
  useSemSync();
  useEffect(() => { void loadDict(); }, []);
  useEffect(() => { markSaved(); }, []);
  useEffect(() => () => stopClick(), []);
  // first visit: centre on the first lyric
  useEffect(() => {
    const first = s ? sorted(s).find((b) => b.lines.some((l) => lineKind(l.text) === 'lyric')) : undefined;
    if (first) lx.set({ center: first.at + 4, driver: null });
  }, []);
  return (
    <div className="lyricsscreen" style={{ '--chat-w': `${chat ? chatW : 0}px`, '--blocks-w': `${blocksW}px` } as React.CSSProperties}>
      <Header />
      <StyleStrip />
      <div className={`lx-body ${chat ? 'with-chat' : ''}`}>
        <div className="lx-pane lyrics">
          <div className="lx-pane-h"><span className="dim">lyrics</span><span className="grow" /><span className="dim hintx">click a line to edit · drag across words to tag them</span></div>
          <div className="lx-pane-sub" />
          <SheetView />
        </div>
        <Splitter dir="x" size={blocksW} min={BLOCKS_MIN} max={maxBlocks} sign={-1} onSize={(v) => setBlocksW(v)} />
        <VTimeline />
        {chat ? <Splitter dir="x" size={Math.min(chatW, maxChat())} min={CHAT_MIN} max={maxChat} sign={-1} onSize={setChatW} /> : null}
        {chat ? <Chat /> : null}
      </div>
      {panel === 'library' ? <Library /> : null}
      {panel === 'export' ? <ExportPanel /> : null}
      {panel === 'keys' ? <KeysPanel /> : null}
      {panel === 'analysis' ? <AnalysisPanel /> : null}
      <ProfileCard />
      <TagBar />
      <MenuHost />
      {toastMsg ? <div className="lx-toast">{toastMsg}</div> : null}
    </div>
  );
};

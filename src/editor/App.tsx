import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { MV, type MVProps } from '../comp/MV';
import { cloneLayer } from '../core/project';
import { Tempo } from '../core/tempo';
import { Inspector } from './Inspector';
import { Splitter, usePersistedSize } from './Resizer';
import { withStreamed } from '../core/storyboard';
import { checkNewFootage } from './storyActions';
import { FindScreen, closeFind, openFind } from './FindScreen';
import { RenderScreen, RenderStatus, closeRender, openRender } from './RenderScreen';
import { FootageMenu } from './FootageMenu';
import { HoverPeek, PeekOverlay } from './Peek';
import { groupLayers, groupOf, pruneGroups, selectedLayerIds, ungroup } from './groups';
import { copyKeys, deleteKeys, hasClipKeys, pasteKeys } from './dopesheet';
import { StoryOverlay } from './StoryOverlay';
import { StoryPanel } from './StoryPanel';
import { fmtTime, store, useStore, useTempo, useTime } from './store';
import { Timeline } from './Timeline';
import { useZoomPan } from './useZoomPan';
import { LyricsScreen } from './lyrics/LyricsScreen';

const Preview: React.FC = () => {
  const project = useStore((s) => s.project);
  const media = useStore((s) => s.media);
  const useProxies = useStore((s) => s.useProxies);
  const previewScale = useStore((s) => s.previewScale);
  const inP = useStore((s) => s.inPoint);
  const outP = useStore((s) => s.outPoint);
  const loop = useStore((s) => s.loop);
  const mode = useStore((s) => s.mode);
  const sbOverlay = useStore((s) => s.sbOverlay);
  const hasShots = useStore((s) => !!s.project.storyboard?.shots.length);
  const ref = useRef<PlayerRef>(null);
  const fps = project.fps;
  const total = Math.max(1, Math.ceil(project.duration * fps));

  // picks that aren't downloaded yet stream from the CDN (low res) until the local file lands
  const sbData = project.storyboard;
  const allMedia = useMemo(() => withStreamed(sbData, media), [sbData, media]);
  const inputProps = useMemo<MVProps>(
    () => ({ project, media: allMedia, assetBase: '/', useProxies, renderScale: previewScale, maskScale: 0.35 }),
    [project, allMedia, useProxies, previewScale],
  );
  const peek = useStore((s) => s.peek);
  const zp = useZoomPan();

  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => store.setTime(e.detail.frame / fps);
    const onPlay = () => store.set({ playing: true });
    const onPause = () => store.set({ playing: false });
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('seeked', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    store.seekHandler = (t) => p.seekTo(Math.round(t * fps));
    (window as any).__player = p;
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('seeked', onFrame);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
    };
  }, [fps]);

  // A/B range: either point alone means "from A to the end" / "from the start to B"
  const ranged = inP !== null || outP !== null;
  const inFrame = ranged ? Math.round((inP ?? 0) * fps) : undefined;
  const outFrame = ranged ? Math.min(total - 1, Math.round((outP ?? project.duration) * fps)) : undefined;

  return (
    <div className="preview">
      <div className="pv-view" ref={zp.viewRef}>
      <div className="pv-zoom" ref={zp.zoomRef}>
      <Player
        ref={ref}
        component={MV}
        inputProps={inputProps}
        durationInFrames={total}
        fps={fps}
        compositionWidth={project.width}
        compositionHeight={project.height}
        style={{ width: '100%', height: '100%' }}
        loop={loop}
        inFrame={inFrame !== undefined && outFrame !== undefined && inFrame < outFrame ? inFrame : undefined}
        outFrame={inFrame !== undefined && outFrame !== undefined && inFrame < outFrame ? outFrame : undefined}
        clickToPlay={false}
        doubleClickToFullscreen
        spaceKeyToPlayOrPause={false}
        bufferStateDelayInMilliseconds={300}
        acknowledgeRemotionLicense
      />
      {mode === 'story' && sbOverlay && hasShots ? <StoryOverlay /> : null}
      </div>
      </div>
      {mode === 'edit' ? (
        <button className="fs-btn" title="full screen (Esc to exit)" onClick={() => ref.current?.requestFullscreen()}>⛶</button>
      ) : null}
      {zp.zoom > 1 ? (
        <button className="zoom-btn" title={`zoomed to ${Math.round(zp.zoom * 100)}% — back to fit (pinch / ctrl+wheel zooms, drag or two-finger scroll pans)`} onClick={zp.reset}>
          100%
        </button>
      ) : null}
      {peek && mode !== 'find' ? <PeekOverlay r={peek} /> : null}
    </div>
  );
};

const BeatLamp: React.FC = () => {
  const t = useTime();
  const tempo = useTempo();
  const b = tempo.at(t);
  const bpb = b.section?.beatsPerBar ?? 4;
  const flash = Math.exp(-b.sinceBeat / 0.12);
  return (
    <div className="beatlamp" title="beat grid indicator — check it pulses on the kick">
      {Array.from({ length: bpb }, (_, i) => (
        <span key={i} className={i === b.beatInBar ? (i === 0 ? 'bar' : 'on') : ''} style={{ opacity: i === b.beatInBar ? 0.4 + 0.6 * flash : 0.25 }} />
      ))}
      <span className="bpm">{b.bpm.toFixed(1)}</span>
      <span className="secname">{b.section?.label ?? ''}</span>
    </div>
  );
};

/** Loop toggle + A/B points. Click A/B = set at playhead · Shift+click = clear · Ctrl+click = jump there. */
const LoopControls: React.FC<{ t: number }> = ({ t }) => {
  const loop = useStore((s) => s.loop);
  const inP = useStore((s) => s.inPoint);
  const outP = useStore((s) => s.outPoint);
  const dur = useStore((s) => s.project.duration);
  const ranged = inP !== null || outP !== null;
  const a = inP ?? 0, b = outP ?? dur;
  const point = (which: 'inPoint' | 'outPoint', v: number | null) => (e: React.MouseEvent) => {
    if (e.shiftKey) return store.set({ [which]: null } as any);
    if (e.ctrlKey || e.metaKey) return v !== null && store.seek(v);
    store.set({ [which]: +t.toFixed(3) } as any);
  };
  return (
    <div className={`loopctl ${loop ? 'on' : ''}`}>
      <button className={`loopbtn ${loop ? 'on' : ''}`} onClick={() => store.set({ loop: !loop })} title={`loop ${ranged ? 'A→B' : 'the whole song'} (L)`}>⟳</button>
      <button className={`ab ${inP !== null ? 'set' : ''}`} onClick={point('inPoint', inP)} title="A: set at playhead (I) · Shift+click clears · Ctrl+click jumps there">A <span>{inP !== null ? fmtTime(inP) : '—'}</span></button>
      <button className={`ab ${outP !== null ? 'set' : ''}`} onClick={point('outPoint', outP)} title="B: set at playhead (O) · Shift+click clears · Ctrl+click jumps there">B <span>{outP !== null ? fmtTime(outP) : '—'}</span></button>
      {ranged ? <span className="dim len" title="loop length">{(b - a).toFixed(2)}s</span> : null}
      {ranged ? <button className="ab clr" onClick={() => store.clearLoopRange()} title="clear A/B (Shift+I, Shift+O)">✕</button> : null}
    </div>
  );
};

const Transport: React.FC = () => {
  const t = useTime();
  const playing = useStore((s) => s.playing);
  const project = useStore((s) => s.project);
  const loop = useStore((s) => s.loop);
  const autoKey = useStore((s) => s.autoKey);
  const inP = useStore((s) => s.inPoint);
  const outP = useStore((s) => s.outPoint);
  const mode = useStore((s) => s.mode);
  const sbOverlay = useStore((s) => s.sbOverlay);
  const sbMotion = useStore((s) => s.sbMotion);
  const p = () => (window as any).__player as PlayerRef | undefined;
  return (
    <div className="transport">
      <button onClick={() => store.seek(0)}>⏮</button>
      <button className="play" onClick={() => p()?.toggle()}>{playing ? '❚❚' : '▶'}</button>
      <span className="tc">{fmtTime(t)} <span className="dim">/ {fmtTime(project.duration)} · f{Math.round(t * project.fps)}</span></span>
      <BeatLamp />
      <span className="grow" />
      {mode === 'story' ? (
        <>
          <label className="chk" title="show storyboard thumbs over the render"><input type="checkbox" checked={sbOverlay} onChange={(e) => store.set({ sbOverlay: e.target.checked })} /> thumbs</label>
          <label className="chk" title="play the candidates' preview clips (streams from the stock CDN)"><input type="checkbox" checked={sbMotion} onChange={(e) => store.set({ sbMotion: e.target.checked })} /> motion</label>
        </>
      ) : null}
      <LoopControls t={t} />
      <label className="chk" title="when on, changing an un-animated param creates a keyframe"><input type="checkbox" checked={autoKey} onChange={(e) => store.set({ autoKey: e.target.checked })} /> auto-key</label>
    </div>
  );
};

const TopBar: React.FC = () => {
  const name = useStore((s) => s.project.name);
  const saveState = useStore((s) => s.saveState);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const useProxies = useStore((s) => s.useProxies);
  const previewScale = useStore((s) => s.previewScale);
  const mode = useStore((s) => s.mode);
  return (
    <div className="topbar">
      <span className="logo">phantasma</span>
      <span className="pname" onClick={() => store.set({ sel: {} })} title="project settings">{name}</span>
      <span className={`save ${saveState}`}>{saveState}</span>
      <button disabled={!canUndo} onClick={() => store.doUndo()} title="Ctrl+Z">↶</button>
      <button disabled={!canRedo} onClick={() => store.doRedo()} title="Ctrl+Y">↷</button>
      <div className="modes" title="Tab switches stage">
        <button className={mode === 'lyrics' ? 'on' : ''} onClick={() => store.set({ mode: 'lyrics' })} title="write the lyrics: structure, layers, AI, versions">Lyrics</button>
        <button className={mode === 'story' ? 'on' : ''} onClick={() => store.set({ mode: 'story' })}>Storyboard</button>
        <button className={mode === 'edit' ? 'on' : ''} onClick={() => store.set({ mode: 'edit' })}>Edit</button>
        <button className={mode === 'find' ? 'on' : ''} onClick={() => openFind()} title="full-screen footage search (F)">Find footage</button>
        <button className={mode === 'render' ? 'on' : ''} onClick={() => openRender()} title="render settings, progress and outputs">Render</button>
      </div>
      <span className="grow" />
      <label className="chk"><input type="checkbox" checked={useProxies} onChange={(e) => store.set({ useProxies: e.target.checked })} /> proxies</label>
      <select value={previewScale} onChange={(e) => store.set({ previewScale: Number(e.target.value) })} title="generator resolution in preview">
        <option value={0.25}>¼ res</option>
        <option value={0.5}>½ res</option>
        <option value={1}>full res</option>
      </select>
      <RenderStatus />
    </div>
  );
};

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      const s = store.state;
      if (s.mode === 'lyrics') return; // the lyrics stage owns its keys
      const fps = s.project.fps;
      const player = (window as any).__player as PlayerRef | undefined;
      const tempo = new Tempo(s.project.tempo, s.audio?.meta.beats ?? [], s.project.duration);
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (k === ' ') { e.preventDefault(); player?.toggle(); return; }
      if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); store.doUndo(); return; }
      if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); store.doRedo(); return; }
      if (ctrl && k === 's') { e.preventDefault(); store.save(); return; }
      // keyframes: copy the dopesheet selection, paste at the playhead (onto the selected layer)
      if (ctrl && k === 'c' && !e.shiftKey && s.keySel.length && !window.getSelection()?.toString()) { e.preventDefault(); copyKeys(s.keySel); return; }
      if (ctrl && k === 'v' && !e.shiftKey && hasClipKeys()) { e.preventDefault(); pasteKeys(store.time); return; }
      const lw = s.sel.lyric;
      if (lw && lw.word !== undefined && e.altKey && (k === 'arrowleft' || k === 'arrowright')) {
        // nudge the selected word 10 ms (Shift: 50 ms), kept between its neighbours
        e.preventDefault();
        const step = (k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 0.05 : 0.01);
        store.edit((p) => {
          const flat = p.lyrics?.lines.flatMap((l) => l.words.map((w) => ({ l, w }))) ?? [];
          const line = p.lyrics?.lines.find((x) => x.id === lw.line);
          const w = line?.words[lw.word!];
          if (!w) return;
          const k2 = flat.findIndex((f) => f.w === w);
          const lo = k2 > 0 ? flat[k2 - 1].w.e : 0, hi = k2 < flat.length - 1 ? flat[k2 + 1].w.t : p.duration;
          const d = Math.max(lo - w.t, Math.min(hi - w.e, step));
          w.t = +(w.t + d).toFixed(3); w.e = +(w.e + d).toFixed(3); w.src = 'manual';
          store.seek(w.t);
        }, `nudge-${lw.line}-${lw.word}`);
        return;
      }
      if (lw && (k === 'delete' || k === 'backspace')) {
        store.edit((p) => {
          const line = p.lyrics?.lines.find((x) => x.id === lw.line);
          if (!line || !p.lyrics) return;
          if (lw.word !== undefined) line.words.splice(lw.word, 1);
          if (lw.word === undefined || !line.words.length) p.lyrics.lines = p.lyrics.lines.filter((x) => x.id !== line.id);
        });
        store.set({ sel: {} });
        return;
      }
      if (k === 'c' && !ctrl) { import('./lyricsActions').then(({ addCue }) => addCue(store.time)); return; }
      if (k === 'arrowleft' || k === 'arrowright') {
        e.preventDefault();
        const dir = k === 'arrowleft' ? -1 : 1;
        if (e.shiftKey) {
          const b = tempo.at(store.time + dir * 1e-3);
          const spb = 60 / b.bpm;
          const target = dir > 0 ? store.time + (1 - b.phase) * spb : store.time - (b.phase < 0.02 ? spb : b.phase * spb);
          store.seek(target + 1e-4);
        } else store.seek(store.time + dir / fps);
        return;
      }
      if (k === 'home') { store.seek(0); return; }
      if (k === 'end') { store.seek(s.project.duration); return; }
      if (k === '[' || k === ']') {
        const bounds = [0, ...s.project.tempo.map((x) => x.start), ...s.project.markers.map((m) => m.t), ...(s.project.cues ?? []).map((c) => c.t)].sort((a, b) => a - b);
        const tgt = k === ']' ? bounds.find((b) => b > store.time + 0.01) : [...bounds].reverse().find((b) => b < store.time - 0.01);
        if (tgt !== undefined) store.seek(tgt);
        return;
      }
      if (k === 'tab' && !ctrl) { e.preventDefault(); if (s.mode === 'find') closeFind(); else if (s.mode === 'render') closeRender(); else store.set({ mode: s.mode === 'story' ? 'edit' : 'story' }); return; }
      if (k === 'f' && !ctrl && (s.mode === 'edit' || s.mode === 'story')) { openFind(); return; }
      if (s.mode === 'find' && k === 'escape' && s.peek) { store.set({ peek: null }); return; }
      if (s.mode === 'find' || s.mode === 'render') return; // those screens own the remaining keys (Esc closes it)
      if (s.sel.shotId && (k === 'delete' || k === 'backspace')) {
        // remove the shot; its time goes to the previous shot (or the next one for the first)
        const id = s.sel.shotId;
        store.editSB((d) => {
          const sh = [...d.shots].sort((a, b) => a.start - b.start);
          const i = sh.findIndex((x) => x.id === id);
          if (i < 0) return;
          if (sh[i - 1] && Math.abs(sh[i - 1].end - sh[i].start) < 1e-3) sh[i - 1].end = sh[i].end;
          else if (sh[i + 1] && Math.abs(sh[i + 1].start - sh[i].end) < 1e-3) sh[i + 1].start = sh[i].start;
          d.shots = d.shots.filter((x) => x.id !== id);
        });
        store.set({ sel: {} });
        return;
      }
      if (s.sel.shotId && k === 's' && !ctrl) {
        const t = +store.time.toFixed(3);
        store.editSB((d) => {
          const i = d.shots.findIndex((x) => x.id === s.sel.shotId);
          const sh = d.shots[i];
          if (!sh || t <= sh.start + 0.2 || t >= sh.end - 0.2) return;
          const c = { ...JSON.parse(JSON.stringify(sh)), id: `sh${Math.random().toString(36).slice(2, 8)}`, start: t, transition: 'cut', fade: 0 };
          sh.end = t;
          d.shots.splice(i + 1, 0, c);
        });
        return;
      }
      if (ctrl && k === 'g') {
        e.preventDefault();
        if (e.shiftKey) {
          const g = s.sel.groupId ?? (s.sel.layerId ? groupOf(s.project, s.sel.layerId)?.id : undefined);
          if (g) ungroup(g);
        } else groupLayers(selectedLayerIds());
        return;
      }
      if ((k === 'delete' || k === 'backspace') && s.keySel.length) {
        // dopesheet keys win over the layer
        deleteKeys(s.keySel);
        return;
      }
      if (k === 'delete' || k === 'backspace') {
        const ids = new Set(selectedLayerIds());
        if (ids.size) { store.edit((p) => { p.layers = p.layers.filter((l) => !ids.has(l.id)); pruneGroups(p); }); store.set({ sel: {} }); }
        return;
      }
      if (ctrl && k === 'd') {
        e.preventDefault();
        const l = s.project.layers.find((x) => x.id === s.sel.layerId);
        if (l) {
          const c = cloneLayer(l);
          store.edit((p) => { p.layers.splice(p.layers.findIndex((x) => x.id === l.id) + 1, 0, c); });
          store.set({ sel: { layerId: c.id } });
        }
        return;
      }
      if (k === 's' && !ctrl) {
        // split selected layer at playhead
        const l = s.project.layers.find((x) => x.id === s.sel.layerId);
        const t = store.time;
        if (l && t > l.start + 0.02 && t < l.end - 0.02) {
          const c = cloneLayer(l);
          c.name = l.name;
          c.start = t;
          // keep the footage continuous across the cut
          if (l.kind === 'video') {
            const off = typeof l.params.offset === 'number' ? l.params.offset : 0;
            const sp = typeof l.params.speed === 'number' ? l.params.speed : 1;
            c.params = { ...c.params, offset: off + (t - l.start) * sp };
          }
          store.edit((p) => {
            const i = p.layers.findIndex((x) => x.id === l.id);
            p.layers[i].end = t;
            p.layers[i].fadeOut = 0;
            c.fadeIn = 0;
            p.layers.splice(i + 1, 0, c);
          });
          store.set({ sel: { layerId: c.id } });
        }
        return;
      }
      if (k === 'm') { store.edit((p) => { p.markers.push({ t: +store.time.toFixed(3), label: `M${p.markers.length + 1}` }); p.markers.sort((a, b) => a.t - b.t); }); return; }
      if (k === 'i') { store.set({ inPoint: e.shiftKey ? null : store.time }); return; }
      if (k === 'o') { store.set({ outPoint: e.shiftKey ? null : store.time }); return; }
      if (k === 'l') { store.set({ loop: !s.loop }); return; }
      if (k === 'a') { store.set({ autoKey: !s.autoKey }); return; }
      if (k === 't') {
        const taps = [...s.taps.filter((x) => store.time - x < 20), store.time];
        const si = s.project.tempo.findIndex((x) => store.time >= x.start && store.time < x.end);
        store.set({ taps, sel: si >= 0 ? { section: si } : s.sel });
        return;
      }
      if (k === 'escape') {
        if (s.peek) { store.set({ peek: null }); return; }
        // first Esc clears the selection, the next one leaves a focused group
        if (s.keySel.length) { store.set({ keySel: [] }); return; }
        if (!Object.keys(s.sel).length && s.focusGroup) { store.set({ focusGroup: null }); return; }
        store.set({ sel: {} });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// pane sizes persist per browser; the side pane remembers a width per stage
const PANE_DEFAULTS = { tl: () => Math.round(window.innerHeight * 0.38), edit: () => 360, story: () => Math.max(420, Math.round(window.innerWidth * 0.34)) };

export const App: React.FC = () => {
  useShortcuts();
  // clips dropped into the project folder while the editor was in the background
  useEffect(() => {
    const f = () => { if (document.visibilityState === 'visible') checkNewFootage(); };
    window.addEventListener('focus', f);
    document.addEventListener('visibilitychange', f);
    return () => { window.removeEventListener('focus', f); document.removeEventListener('visibilitychange', f); };
  }, []);
  const mode = useStore((s) => s.mode);
  const [tlH, setTlH] = usePersistedSize('tl', PANE_DEFAULTS.tl);
  const [sideEdit, setSideEdit] = usePersistedSize('edit', PANE_DEFAULTS.edit);
  const [sideStory, setSideStory] = usePersistedSize('story', PANE_DEFAULTS.story);
  const side = mode === 'story' ? sideStory : sideEdit;
  const setSide = mode === 'story' ? setSideStory : setSideEdit;
  return (
    <div className={`app mode-${mode}`} style={{ '--tl-h': `${tlH}px`, '--side-w': `${side}px` } as React.CSSProperties}>
      <TopBar />
      <div className="mid">
        <div className="stage">
          <Preview />
          <Transport />
        </div>
        <Splitter dir="x" size={side} min={260} max={() => window.innerWidth - 360} sign={-1} onSize={setSide} />
        <div className={`side ${mode === 'story' ? 'wide' : ''}`}>{mode === 'story' ? <StoryPanel /> : <Inspector />}</div>
      </div>
      <Splitter dir="y" size={tlH} min={120} max={() => window.innerHeight - 38 - 200} sign={-1} onSize={setTlH} />
      <Timeline />
      {mode === 'find' ? <FindScreen /> : null}
      {mode === 'render' ? <RenderScreen /> : null}
      {mode === 'lyrics' ? <LyricsScreen /> : null}
      <HoverPeek />
      <FootageMenu />
    </div>
  );
};

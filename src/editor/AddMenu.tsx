import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { newGenLayer, newMediaLayer } from '../core/project';
import { mediaRef } from '../core/storyboard';
import type { Layer, MediaItem } from '../core/types';
import { getGen, GENERATORS } from '../gen/registry';
import { loadScene, SCENE_PREFIX } from '../gen/scene';
import { fmtTime, store, useStore } from './store';

/** Default span for a new layer: the tempo section under the playhead (MV-friendly), else 8 s. */
function defaultSpan(): [number, number] {
  const p = store.state.project;
  const t = store.time;
  const s = p.tempo.find((x) => t >= x.start && t < x.end);
  return s ? [s.start, s.end] : [t, Math.min(p.duration, t + 8)];
}

/** Footage goes in at the playhead: a video at its own length (no stretching/looping), an image to the end of the song section (else 8 s). */
function spanFor(m: MediaItem): [number, number] {
  const p = store.state.project, t = store.time;
  if (m.kind === 'video' && m.duration > 0) return [t, Math.min(p.duration, t + m.duration)];
  const sec = p.tempo.find((x) => t >= x.start && t < x.end);
  return [t, Math.min(p.duration, sec && sec.end - t >= 0.5 ? sec.end : t + 8)];
}

function insert(l: Layer) {
  const selId = store.state.sel.layerId;
  store.edit((p) => {
    const i = selId ? p.layers.findIndex((x) => x.id === selId) : -1;
    if (i >= 0) p.layers.splice(i + 1, 0, l);
    else p.layers.push(l);
  });
  store.set({ sel: { layerId: l.id } });
}

function useClickOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  return ref;
}

/** Scene files in <project>/scenes — listed when the generator menu opens. */
const ScenesList: React.FC<{ onPick: (file: string) => void }> = ({ onPick }) => {
  const [files, setFiles] = useState<string[] | null>(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const refresh = () => fetch('/api/scenes').then((r) => r.json()).then((j) => setFiles(j.files ?? []));
  useEffect(() => { refresh(); }, []);
  const create = async () => {
    setErr('');
    const r = await fetch('/api/scenes', { method: 'POST', body: JSON.stringify({ name }) });
    const j = await r.json();
    if (!r.ok) return setErr(j.error ?? 'failed');
    setName('');
    onPick(j.file);
  };
  return (
    <div>
      <div className="cat" title="GLSL scene files in the project's scenes/ folder — edit them in your code editor, they reload on save">Scenes</div>
      {files === null ? <div className="hint">…</div> : files.map((f) => (
        <button key={f} onClick={() => onPick(f)} title={f}>{f.replace(/^scenes\//, '')}</button>
      ))}
      <div className="new-scene">
        <input placeholder="new scene name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name && create()} />
        <button disabled={!name} onClick={create}>＋</button>
      </div>
      {err ? <div className="hint err">{err}</div> : null}
    </div>
  );
};

const CATS: [string, string][] = [['visualizer', 'Visualizers'], ['shader', 'Shaders'], ['particles', 'Particles'], ['text', 'Text'], ['shape', 'Shapes'], ['fill', 'Fills']];

export const AddMenu: React.FC = () => {
  const [open, setOpen] = useState<'media' | 'gen' | null>(null);
  const media = useStore((s) => s.media);
  const layers = useStore((s) => s.project.layers);
  // how many timeline layers already use each clip
  const uses = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of layers) if (l.media) m.set(l.media, (m.get(l.media) ?? 0) + 1);
    return m;
  }, [layers]);
  const ref = useClickOutside(!!open, () => setOpen(null));
  const [a, b] = open ? defaultSpan() : [0, 0];
  // keep the popover inside the window: cap its height to the room above and shift it left if it would overflow right
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pop = popRef.current, host = ref.current;
    if (!pop || !host) return;
    pop.style.left = '0px';
    pop.style.maxHeight = `${Math.max(120, host.getBoundingClientRect().bottom - 30 - 8)}px`;
    const r = pop.getBoundingClientRect();
    const shift = Math.min(0, window.innerWidth - 8 - r.right);
    pop.style.left = `${Math.max(shift, 8 - host.getBoundingClientRect().left)}px`;
  }, [open, media.length]);
  return (
    <div className="addmenu" ref={ref}>
      <button onClick={() => setOpen(open === 'media' ? null : 'media')}>＋ Footage</button>
      <button onClick={() => setOpen(open === 'gen' ? null : 'gen')}>＋ Generator</button>
      {open === 'media' ? <span className="dim span">→ at playhead {fmtTime(store.time)}</span> : open ? <span className="dim span">→ {fmtTime(a)}–{fmtTime(b)}</span> : null}
      {open === 'media' ? (
        <div className="popover media-grid" ref={popRef}>
          {media.map((m) => (
            <div key={m.id} className="thumb" onClick={() => { insert(newMediaLayer(m, ...spanFor(m))); setOpen(null); }} title={`${m.src} · ${uses.get(m.id) ?? 0}× on the timeline · right-click: add to the idea board`}
              onContextMenu={(e) => { e.preventDefault(); store.set({ footMenu: { x: e.clientX, y: e.clientY, ref: mediaRef(m) } }); }}>
              {m.thumb ? <img src={'/' + m.thumb.split('/').map(encodeURIComponent).join('/')} /> : <div className="noimg" />}
              {m.kind === 'video' && m.proxy ? (
                <video
                  muted
                  loop
                  preload="none"
                  src={'/' + m.proxy.split('/').map(encodeURIComponent).join('/')}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.play(); }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '0'; e.currentTarget.pause(); }}
                />
              ) : null}
              <span>{m.width}×{m.height} · {m.duration.toFixed(1)}s</span>
              {uses.get(m.id) ? <b className="used">{uses.get(m.id)}</b> : null}
            </div>
          ))}
          {!media.length ? <div className="hint">No footage found. Drop files in the project folder and run <code>npm run media</code>.</div> : null}
        </div>
      ) : null}
      {open === 'gen' ? (
        <div className="popover gen-list">
          <ScenesList onPick={async (file) => {
            await loadScene(file); // so the layer gets the scene's name + param defaults
            const id = SCENE_PREFIX + file;
            insert(newGenLayer(id, a, b, getGen(id)?.name));
            setOpen(null);
          }} />
          {CATS.map(([cat, title]) => (
            <div key={cat}>
              <div className="cat">{title}</div>
              {GENERATORS.filter((g) => g.category === cat).flatMap((g) => [
                <button key={g.id} onClick={() => { insert(newGenLayer(g.id, a, b)); setOpen(null); }}>{g.name}</button>,
                // generators with presets list them right here (e.g. Particles · Rain)
                ...Object.keys(g.presets ?? {}).map((name) => (
                  <button key={`${g.id}:${name}`} className="preset" onClick={() => {
                    const l = newGenLayer(g.id, a, b, `${g.name} · ${name}`);
                    l.params = { ...l.params, ...(g.presets![name] as any) };
                    insert(l);
                    setOpen(null);
                  }}>· {name}</button>
                )),
              ])}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

import React, { useMemo, useState, useSyncExternalStore } from 'react';
import type { Draft } from 'immer';
import { COMMON_PARAMS, TRAIL_PARAMS, VIDEO_PARAMS, MEDIA_PARAMS } from '../comp/common';
import { defaults, type ParamDef } from '../core/params';
import { newMask } from '../core/project';
import { BLEND_MODES, type Layer, type Mask, type ParamValue, type Project } from '../core/types';
import { assetsVersion, onAssets } from '../gen/assets';
import { getGen, GENERATORS } from '../gen/registry';
import { isSceneId, loadScene, sceneError, sceneFile } from '../gen/scene';
import { ParamField } from './ParamField';
import { fmtTime, store, useStore, useTime } from './store';
import { TempoPanel } from './TempoPanel';
import { editGroup, groupSpan, setMembersEnabled, ungroup } from './groups';

function groupBy(defs: ParamDef[]) {
  const g = new Map<string, ParamDef[]>();
  for (const d of defs) {
    const k = d.group ?? 'Params';
    if (!g.has(k)) g.set(k, []);
    g.get(k)!.push(d);
  }
  return [...g.entries()];
}

const Section: React.FC<{ title: string; children: React.ReactNode; defaultOpen?: boolean; right?: React.ReactNode }> = ({ title, children, defaultOpen = true, right }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`isec ${open ? 'open' : ''}`}>
      <div className="isec-h" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'} {title}</span>
        <span onClick={(e) => e.stopPropagation()}>{right}</span>
      </div>
      {open ? <div className="isec-b">{children}</div> : null}
    </div>
  );
};

export const Inspector: React.FC = () => {
  const sel = useStore((s) => s.sel);
  const layer = useStore((s) => s.project.layers.find((l) => l.id === s.sel.layerId));
  if (sel.section !== undefined) return <TempoPanel index={sel.section} />;
  if (sel.groupId) return <GroupPanel id={sel.groupId} />;
  if (!layer) return <ProjectPanel />;
  return <LayerInspector layer={layer} />;
};

function editLayer(id: string, fn: (l: Draft<Layer>) => void, merge?: string) {
  store.edit((p) => {
    const l = p.layers.find((x) => x.id === id);
    if (l) fn(l);
  }, merge);
}

const LayerInspector: React.FC<{ layer: Layer }> = ({ layer }) => {
  const media = useStore((s) => s.media);
  // scenes load / hot-reload asynchronously and can change their params
  const assetVer = useSyncExternalStore(onAssets, assetsVersion);
  const gen = getGen(layer.gen);
  const typeDefs: ParamDef[] = layer.kind === 'gen' ? [...(gen?.params ?? []), ...TRAIL_PARAMS] : layer.kind === 'video' ? VIDEO_PARAMS : MEDIA_PARAMS;
  const groups = useMemo(() => groupBy([...typeDefs, ...COMMON_PARAMS]), [layer.kind, layer.gen, gen]);
  const sceneErr = isSceneId(layer.gen) ? sceneError(layer.gen) : undefined;
  const setParam = (key: string) => (v: ParamValue | undefined, merge?: string) =>
    editLayer(layer.id, (l) => {
      if (v === undefined) delete l.params[key];
      else l.params[key] = v as any;
    }, merge);

  const num = (key: 'start' | 'end' | 'fadeIn' | 'fadeOut', step = 0.01) => (
    <input type="number" step={step} value={+layer[key].toFixed(3)} onChange={(e) => editLayer(layer.id, (l) => { l[key] = Math.max(0, Number(e.target.value)); }, `${layer.id}.${key}`)} />
  );

  return (
    <div className="inspector">
      <div className="ih">
        <input className="name" value={layer.name} onChange={(e) => editLayer(layer.id, (l) => { l.name = e.target.value; }, `${layer.id}.name`)} />
        <span className="tag">{layer.kind === 'gen' ? gen?.name : layer.kind}</span>
      </div>
      {isSceneId(layer.gen) ? (
        <Section title="Scene" key={assetVer}>
          <div className="grid2">
            <label>File</label>
            <span className="scene-file" title="edit the file in your editor — it reloads on save">{sceneFile(layer.gen)}</span>
            <label />
            <button onClick={() => loadScene(sceneFile(layer.gen!), true)}>↻ Reload</button>
          </div>
          {sceneErr ? <pre className="scene-error">{sceneErr}</pre> : <div className="hint">Edit the .frag file, save, and the layer recompiles. Header lines <code>// @param</code> and <code>// @tex</code> define the controls below.</div>}
        </Section>
      ) : null}
      {gen?.presets ? (
        <Section title="Preset">
          <div className="grid2">
            <label>Load preset</label>
            <select value="" onChange={(e) => {
              const pr = gen.presets![e.target.value];
              if (!pr) return;
              // generator params back to defaults + the preset; transform/look params are kept
              editLayer(layer.id, (l) => {
                for (const d of gen.params) delete l.params[d.key];
                Object.assign(l.params, defaults(gen.params), pr);
              });
            }}>
              <option value="">choose…</option>
              {Object.keys(gen.presets).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
        </Section>
      ) : null}
      <Section title="Timing & blend">
        <div className="grid2">
          <label>Start</label>{num('start')}
          <label>End</label>{num('end')}
          <label>Fade in</label>{num('fadeIn')}
          <label>Fade out</label>{num('fadeOut')}
          <label>Blend</label>
          <select value={layer.blend} onChange={(e) => editLayer(layer.id, (l) => { l.blend = e.target.value as any; })}>
            {BLEND_MODES.map((b) => <option key={b}>{b}</option>)}
          </select>
          <label title="only show where the layer directly below has pixels (Photoshop clipping mask)">Clip to below</label>
          <input type="checkbox" checked={!!layer.clipBelow} onChange={(e) => editLayer(layer.id, (l) => { l.clipBelow = e.target.checked; })} />
          {layer.kind !== 'gen' ? (
            <>
              <label>Media</label>
              <select value={layer.media} onChange={(e) => editLayer(layer.id, (l) => { l.media = e.target.value; })}>
                {media.filter((m) => m.kind === layer.kind).map((m) => <option key={m.id} value={m.id}>{m.id} ({m.duration.toFixed(1)}s)</option>)}
              </select>
            </>
          ) : null}
        </div>
      </Section>
      {groups.map(([g, defs]) => (
        <Section key={g} title={g} defaultOpen={g !== 'Look'}>
          {defs.map((d) => (
            <ParamField key={d.key} def={d} raw={layer.params[d.key]} onChange={setParam(d.key)} mergeKey={`${layer.id}.${d.key}`} layerStart={layer.start} layerEnd={layer.end} />
          ))}
        </Section>
      ))}
      <MasksPanel layer={layer} />
    </div>
  );
};

const MASK_GENS = GENERATORS.filter((g) => g.id !== 'solid');

const MasksPanel: React.FC<{ layer: Layer }> = ({ layer }) => {
  const [adding, setAdding] = useState(false);
  return (
    <Section
      title={`Masks (${layer.masks.length})`}
      right={
        <span className="addmask">
          {adding ? (
            <select autoFocus onBlur={() => setAdding(false)} defaultValue="" onChange={(e) => {
              const m = newMask(e.target.value);
              editLayer(layer.id, (l) => { l.masks.push(m); });
              store.set({ sel: { layerId: layer.id, maskId: m.id } });
              setAdding(false);
            }}>
              <option value="" disabled>mask from…</option>
              {MASK_GENS.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          ) : <button onClick={() => setAdding(true)}>+ mask</button>}
        </span>
      }
    >
      {layer.masks.length === 0 ? <div className="hint">Masks use any generator (shape, text, gradient, even a visualizer) as alpha or luminance. Combine with add / subtract / intersect.</div> : null}
      {layer.masks.map((m, i) => <MaskEditor key={m.id} layer={layer} mask={m} index={i} />)}
    </Section>
  );
};

const MaskEditor: React.FC<{ layer: Layer; mask: Mask; index: number }> = ({ layer, mask, index }) => {
  const gen = getGen(mask.gen);
  const open = useStore((s) => s.sel.maskId === mask.id);
  const em = (fn: (m: Draft<Mask>) => void, merge?: string) =>
    editLayer(layer.id, (l) => { const m = l.masks.find((x) => x.id === mask.id); if (m) fn(m); }, merge);
  return (
    <div className={`mask ${open ? 'open' : ''}`}>
      <div className="mask-h">
        <input type="checkbox" checked={mask.enabled} onChange={(e) => em((m) => { m.enabled = e.target.checked; })} title="enabled" />
        <span className="mname" onClick={() => store.set({ sel: { layerId: layer.id, maskId: open ? undefined : mask.id } })}>
          {open ? '▾' : '▸'} {index + 1}. {gen?.name ?? mask.gen}
        </span>
        <select value={mask.op} onChange={(e) => em((m) => { m.op = e.target.value as any; })} title="combine">
          <option value="add">add</option><option value="subtract">subtract</option><option value="intersect">intersect</option>
        </select>
        <button title="move up" disabled={index === 0} onClick={() => editLayer(layer.id, (l) => { const [x] = l.masks.splice(index, 1); l.masks.splice(index - 1, 0, x); })}>↑</button>
        <button title="delete" onClick={() => editLayer(layer.id, (l) => { l.masks.splice(index, 1); })}>✕</button>
      </div>
      {open ? (
        <div className="mask-b">
          <div className="grid2">
            <label>Mode</label>
            <select value={mask.mode} onChange={(e) => em((m) => { m.mode = e.target.value as any; })}>
              <option value="alpha">alpha</option><option value="luminance">luminance</option>
            </select>
            <label>Invert</label>
            <input type="checkbox" checked={mask.invert} onChange={(e) => em((m) => { m.invert = e.target.checked; })} />
            <label>Feather</label>
            <input type="number" min={0} step={1} value={mask.feather} onChange={(e) => em((m) => { m.feather = Math.max(0, Number(e.target.value)); }, `${mask.id}.feather`)} />
            <label>Source</label>
            <select value={mask.gen} onChange={(e) => em((m) => { m.gen = e.target.value; m.params = defaults(getGen(e.target.value)!.params); })}>
              {MASK_GENS.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          {gen?.params.map((d) => (
            <ParamField
              key={d.key}
              def={d}
              raw={mask.params[d.key]}
              mergeKey={`${mask.id}.${d.key}`}
              layerStart={layer.start}
              layerEnd={layer.end}
              onChange={(v, merge) => em((m) => { if (v === undefined) delete m.params[d.key]; else m.params[d.key] = v as any; }, merge)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const ProjectPanel: React.FC = () => {
  const p = useStore((s) => s.project);
  const t = useTime();
  const ep = (fn: (d: Draft<Project>) => void, merge?: string) => store.edit(fn, merge);
  return (
    <div className="inspector">
      <div className="ih"><input className="name" value={p.name} onChange={(e) => ep((d) => { d.name = e.target.value; }, 'name')} /><span className="tag">project</span></div>
      <Section title="Output">
        <div className="grid2">
          <label>Size</label>
          <select value={`${p.width}x${p.height}`} onChange={(e) => { const [w, h] = e.target.value.split('x').map(Number); ep((d) => { d.width = w; d.height = h; }); }}>
            {['1920x1080', '3840x2160', '1080x1920', '1080x1080', '1280x720'].map((s) => <option key={s}>{s}</option>)}
          </select>
          <label>FPS</label>
          <select value={p.fps} onChange={(e) => ep((d) => { d.fps = Number(e.target.value); })}>
            {[24, 25, 30, 50, 60].map((f) => <option key={f}>{f}</option>)}
          </select>
          <label>Duration</label>
          <input type="number" step={0.01} value={p.duration} onChange={(e) => ep((d) => { d.duration = Number(e.target.value); }, 'dur')} />
          <label>Background</label>
          <input type="color" value={p.background.slice(0, 7)} onChange={(e) => ep((d) => { d.background = e.target.value; }, 'bg')} />
          <label>Audio</label>
          <span className="mono">{p.audio}</span>
        </div>
      </Section>
      <Section title={`Markers (${p.markers.length})`}>
        <button onClick={() => ep((d) => { d.markers.push({ t, label: `M${d.markers.length + 1}` }); d.markers.sort((a, b) => a.t - b.t); })}>+ marker at {fmtTime(t)} (M)</button>
        {p.markers.map((m, i) => (
          <div className="marker-row" key={i}>
            <button onClick={() => store.seek(m.t)}>{fmtTime(m.t)}</button>
            <input value={m.label} onChange={(e) => ep((d) => { d.markers[i].label = e.target.value; }, `mk${i}`)} />
            <button onClick={() => ep((d) => { d.markers.splice(i, 1); })}>✕</button>
          </div>
        ))}
      </Section>
      <div className="hint pad">
        Select a layer in the timeline to edit it, or click a tempo section (coloured strip) to fix BPM / downbeat.
        <br />
        <b>Keys:</b> Space play · ←/→ frame · Shift+←/→ beat · [ ] section · Ctrl+Z/Y · Del · Ctrl+D duplicate · S split · M marker · I/O range · L loop · T tap tempo · A auto-key
      </div>
    </div>
  );
};

const GroupPanel: React.FC<{ id: string }> = ({ id }) => {
  const g = useStore((s) => s.project.groups?.find((x) => x.id === id));
  const project = useStore((s) => s.project);
  const focused = useStore((s) => s.focusGroup === id);
  if (!g) return <ProjectPanel />;
  const sp = groupSpan(project, g);
  const members = project.layers.filter((l) => g.layerIds.includes(l.id)).reverse();
  return (
    <div className="inspector">
      <div className="ih">
        <input className="name" value={g.name} onChange={(e) => editGroup(id, (x) => { x.name = e.target.value; }, `${id}.name`)} />
        <input type="color" value={g.color ?? '#e0a040'} onChange={(e) => editGroup(id, (x) => { x.color = e.target.value; }, `${id}.color`)} />
        <span className="tag">group</span>
      </div>
      <Section title="Group">
        <div className="grid2">
          <label>Span</label><span>{sp ? `${fmtTime(sp.a)} → ${fmtTime(sp.b)} (${(sp.b - sp.a).toFixed(2)}s)` : '—'}</span>
          <label>Row</label>
          <input type="number" min={1} step={1} value={(g.row ?? 0) + 1} onChange={(e) => editGroup(id, (x) => { x.row = Math.max(0, Math.round(Number(e.target.value)) - 1); })} />
        </div>
        <div className="btns" style={{ marginTop: 8 }}>
          <button className={focused ? 'accent' : ''} onClick={() => store.set({ focusGroup: focused ? null : id })}>{focused ? '◀ Leave focus' : '◎ Focus'}</button>
          <button onClick={() => editGroup(id, (x) => { x.collapsed = !x.collapsed; })}>{g.collapsed ? '▸ Expand' : '▾ Collapse'}</button>
          {sp ? <button onClick={() => store.loopRange(sp.a, sp.b)}>⟳ Loop</button> : null}
          <button onClick={() => setMembersEnabled(id, !members.some((l) => l.enabled))}>{members.some((l) => l.enabled) ? 'Hide all' : 'Show all'}</button>
          <button onClick={() => ungroup(id)}>Ungroup</button>
        </div>
        <div className="hint">Focus filters the timeline to these layers; playback, audio, lyrics and the storyboard are unchanged and other groups keep playing. Drag the group bar to move all members; drag it up/down to change row.</div>
      </Section>
      <Section title={`Layers (${members.length})`}>
        {members.map((l) => (
          <div key={l.id} className="memrow" onClick={() => store.set({ sel: { layerId: l.id } })}>
            <span className={l.enabled ? '' : 'dim'}>{l.enabled ? '●' : '○'}</span>
            <span className="grow">{l.name}</span>
            <span className="dim">{fmtTime(l.start)}–{fmtTime(l.end)}</span>
          </div>
        ))}
      </Section>
    </div>
  );
};

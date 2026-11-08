import React, { useState } from 'react';
import {
  baseAt, EASINGS, evalParam, isAnimated, keyAt, removeKey, setKey, setMods, setValue, sortedKeys, type ParamDef,
} from '../core/params';
import type { Easing, Modulation, ModSource, ParamValue, Prim } from '../core/types';
import { store, useStore, useTempo, useTime } from './store';

const MOD_SOURCES: ModSource[] = ['bass', 'rms', 'mid', 'high', 'onset', 'centroid', 'beat', 'bar', 'lfo', 'sectionProgress', 'layerProgress'];

const MOD_HINT: Record<string, string> = {
  beat: 'release = pulse decay (s)',
  bar: 'release = pulse decay (s)',
  lfo: 'release = period in beats',
  sectionProgress: '0→1 across the tempo section',
  layerProgress: '0→1 across the layer',
};

function toHex(c: string): string {
  if (c.startsWith('#')) return c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c.slice(0, 7);
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return '#ffffff';
  const [r, g, b] = m[1].split(',').map((x) => parseInt(x));
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function alphaOf(c: string): number {
  if (c.startsWith('#') && c.length === 9) return parseInt(c.slice(7), 16) / 255;
  const m = c.match(/rgba\(([^)]+)\)/);
  return m ? parseFloat(m[1].split(',')[3]) : 1;
}
function withA(hex: string, a: number) {
  return a >= 0.999 ? hex : hex + Math.round(a * 255).toString(16).padStart(2, '0');
}

export function fmtNum(v: number, step = 0.01) {
  const d = step >= 1 ? 0 : Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))));
  return v.toFixed(d);
}

interface Props {
  def: ParamDef;
  raw: ParamValue | undefined;
  onChange: (v: ParamValue | undefined, merge?: string) => void;
  mergeKey: string;
  layerStart: number;
  layerEnd: number;
}

export const ParamField: React.FC<Props> = ({ def, raw, onChange, mergeKey, layerStart, layerEnd }) => {
  const t = useTime();
  const autoKey = useStore((s) => s.autoKey);
  const audio = useStore((s) => s.audio);
  const media = useStore((s) => s.media);
  const tempo = useTempo();
  const [modOpen, setModOpen] = useState(false);
  const animated = isAnimated(raw) && !!raw.$k?.length;
  const mods = isAnimated(raw) ? raw.$mod ?? [] : [];
  const k = keyAt(raw, t);
  const base = baseAt(raw, t, def.default);
  const live = mods.length ? evalParam(raw, def, { t, audio, tempo, layerStart, layerEnd }) : null;
  const label = def.label ?? def.key;

  const set = (v: Prim, final = false) => onChange(setValue(raw, t, v, autoKey && !def.static), final ? undefined : mergeKey);

  let control: React.ReactNode;
  switch (def.type) {
    case 'number': {
      const v = Number(base);
      const step = def.step ?? 0.01;
      control = (
        <div className="num">
          <input type="range" min={def.min} max={def.max} step={step} value={v} onChange={(e) => set(Number(e.target.value))} />
          <input
            type="number"
            step={step}
            value={fmtNum(v, step)}
            onChange={(e) => e.target.value !== '' && set(Number(e.target.value))}
            onWheel={(e) => (e.target as HTMLInputElement).blur()}
          />
        </div>
      );
      break;
    }
    case 'color': {
      const c = String(base);
      control = (
        <div className="color">
          <input type="color" value={toHex(c)} onChange={(e) => set(withA(e.target.value, alphaOf(c)))} />
          <input type="range" min={0} max={1} step={0.01} value={alphaOf(c)} title="alpha" onChange={(e) => set(withA(toHex(c), Number(e.target.value)))} />
        </div>
      );
      break;
    }
    case 'bool':
      control = <input type="checkbox" checked={!!base} onChange={(e) => set(e.target.checked, true)} />;
      break;
    case 'select':
      control = (
        <select value={String(base)} onChange={(e) => set(e.target.value, true)}>
          {def.options!.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      break;
    case 'text':
      if (def.media) {
        const v = String(base);
        const opts = media.filter((m) => def.media === 'any' || m.kind === def.media).map((m) => m.id);
        if (v && !opts.includes(v)) opts.unshift(v);
        control = (
          <select value={v} onChange={(e) => set(e.target.value, true)}>
            <option value="">— none —</option>
            {opts.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        );
        break;
      }
      control = <textarea rows={String(base).length > 30 ? 3 : 1} value={String(base)} onChange={(e) => set(e.target.value)} />;
      break;
  }

  const keys = isAnimated(raw) ? sortedKeys(raw) : [];
  const prevKey = [...keys].reverse().find((x) => x.t < t - 1e-3);
  const nextKey = keys.find((x) => x.t > t + 1e-3);

  return (
    <div className={`field ${animated ? 'animated' : ''}`}>
      <label title={def.hint ?? def.key}>{label}</label>
      <div className="control">
        {control}
        {live !== null && typeof live === 'number' && def.min !== undefined && def.max !== undefined ? (
          <div className="live" title={`modulated: ${fmtNum(live, def.step)}`}>
            <div style={{ width: `${Math.max(0, Math.min(1, (live - def.min) / (def.max - def.min))) * 100}%` }} />
          </div>
        ) : null}
      </div>
      {!def.static ? (
        <div className="kf">
          <button className="nav" disabled={!prevKey} onClick={() => prevKey && store.seek(prevKey.t)} title="previous key">‹</button>
          <button
            className={`diamond ${k ? 'on' : animated ? 'anim' : ''}`}
            title={k ? 'remove keyframe' : 'add keyframe at playhead'}
            onClick={() => onChange(k ? removeKey(raw, t) : setKey(raw, t, base))}
          >
            ◆
          </button>
          <button className="nav" disabled={!nextKey} onClick={() => nextKey && store.seek(nextKey.t)} title="next key">›</button>
          {def.type === 'number' ? (
            <button className={`mod ${mods.length ? 'on' : ''}`} title="audio / beat modulation" onClick={() => setModOpen(!modOpen)}>∿</button>
          ) : <span className="mod-spacer" />}
          {k ? (
            // tiny button; the (invisible) native select over it opens the easing list
            <label className={`ease-btn ${(k.e ?? 'easeInOut') !== 'easeInOut' ? 'set' : ''}`} title={`ease → next key: ${k.e ?? 'easeInOut'}`}>
              ⋯
              <select value={k.e ?? 'easeInOut'} onChange={(e) => onChange(setKey(raw, t, k.v, e.target.value as Easing))}>
                {EASINGS.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
          ) : <span className="ease-spacer" />}
        </div>
      ) : <div className="kf" />}
      {modOpen ? <ModEditor def={def} mods={mods} onChange={(m) => onChange(setMods(raw, m, base))} /> : null}
    </div>
  );
};

const ModEditor: React.FC<{ def: ParamDef; mods: Modulation[]; onChange: (m: Modulation[]) => void }> = ({ def, mods, onChange }) => {
  const span = def.max !== undefined && def.min !== undefined ? def.max - def.min : 1;
  const upd = (i: number, patch: Partial<Modulation>) => onChange(mods.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <div className="mods">
      {mods.map((m, i) => (
        <div className="mod-row" key={i}>
          <select value={m.src} onChange={(e) => upd(i, { src: e.target.value as ModSource })}>
            {MOD_SOURCES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <span title="amount added at full source level">amt</span>
          <input type="number" step={span / 100} value={+m.amount.toFixed(4)} onChange={(e) => upd(i, { amount: Number(e.target.value) })} />
          <span title={MOD_HINT[m.src] ?? 'peak-hold release (s)'}>rel</span>
          <input type="number" step={0.01} value={m.release ?? ''} placeholder="auto" onChange={(e) => upd(i, { release: e.target.value === '' ? undefined : Number(e.target.value) })} />
          <span title="exponent: >1 = punchier, <1 = softer">crv</span>
          <input type="number" step={0.1} value={m.curve ?? 1} onChange={(e) => upd(i, { curve: Number(e.target.value) })} />
          <span title="ignore source below this level">gate</span>
          <input type="number" step={0.05} min={0} max={0.95} value={m.gate ?? 0} onChange={(e) => upd(i, { gate: Number(e.target.value) })} />
          <button onClick={() => onChange(mods.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="add" onClick={() => onChange([...mods, { src: 'bass', amount: +(span * 0.25).toPrecision(3) }])}>+ modulation</button>
    </div>
  );
};

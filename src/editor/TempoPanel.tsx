import React from 'react';
import type { Draft } from 'immer';
import type { TempoSection } from '../core/types';
import { fmtTime, store, useStore, useTime } from './store';

/** Least-squares fit of tap times → (bpm, phase anchor). */
export function fitTaps(taps: number[]): { bpm: number; offset: number } | null {
  if (taps.length < 4) return null;
  const n = taps.length;
  // assume roughly regular taps; index each tap by rounding to the median interval (tolerates a skipped tap)
  const iv = taps.slice(1).map((t, i) => t - taps[i]).sort((a, b) => a - b)[Math.floor((n - 1) / 2)];
  const idx = taps.map((t) => Math.round((t - taps[0]) / iv));
  const mx = idx.reduce((a, b) => a + b, 0) / n;
  const my = taps.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (idx[i] - mx) * (taps[i] - my);
    sxx += (idx[i] - mx) ** 2;
  }
  const spb = sxy / sxx;
  return { bpm: 60 / spb, offset: my - spb * mx };
}

function editSection(i: number, fn: (s: Draft<TempoSection>) => void, merge?: string) {
  store.edit((p) => fn(p.tempo[i]), merge);
}

export const TempoPanel: React.FC<{ index: number }> = ({ index }) => {
  const s = useStore((st) => st.project.tempo[index]);
  const count = useStore((st) => st.project.tempo.length);
  const audio = useStore((st) => st.audio);
  const taps = useStore((st) => st.taps);
  const t = useTime();
  if (!s) return null;
  const spb = 60 / s.bpm;
  const fit = fitTaps(taps);
  const detected = audio?.meta.sections.find((a) => a.start < s.end && a.end > s.start && Math.abs(a.start - s.start) < 1);
  const setBpm = (bpm: number) => editSection(index, (x) => { x.bpm = +bpm.toFixed(3); });

  return (
    <div className="inspector">
      <div className="ih">
        <input className="name" value={s.label} onChange={(e) => editSection(index, (x) => { x.label = e.target.value; }, `sec${index}.label`)} />
        <span className="tag">tempo section {index + 1}/{count}</span>
      </div>
      <div className="isec open"><div className="isec-b">
        <div className="grid2">
          <label>Start</label>
          <input type="number" step={0.01} value={+s.start.toFixed(3)} disabled={index === 0} onChange={(e) => store.edit((p) => {
            const v = Number(e.target.value);
            p.tempo[index].start = v;
            if (index > 0) p.tempo[index - 1].end = v;
          }, `sec${index}.start`)} />
          <label>End</label>
          <input type="number" step={0.01} value={+s.end.toFixed(3)} disabled={index === count - 1} onChange={(e) => store.edit((p) => {
            const v = Number(e.target.value);
            p.tempo[index].end = v;
            if (index < p.tempo.length - 1) p.tempo[index + 1].start = v;
          }, `sec${index}.end`)} />
          <label>BPM</label>
          <input type="number" step={0.01} value={s.bpm} onChange={(e) => editSection(index, (x) => { x.bpm = Math.max(1, Number(e.target.value)); }, `sec${index}.bpm`)} />
          <label />
          <div className="btns">
            <button onClick={() => setBpm(s.bpm * 2)}>×2</button>
            <button onClick={() => setBpm(s.bpm / 2)}>÷2</button>
            <button onClick={() => setBpm((s.bpm * 2) / 3)}>×⅔</button>
            <button onClick={() => setBpm((s.bpm * 3) / 2)}>×1.5</button>
          </div>
          {detected?.alt?.length ? (
            <>
              <label title="other periodicities the analysis found in this section">Detected</label>
              <div className="btns">
                <button onClick={() => setBpm(detected.bpm)}>{detected.bpm}</button>
                {detected.alt.map((a) => <button key={a} onClick={() => setBpm(a)}>{a}</button>)}
              </div>
            </>
          ) : null}
          <label title="time of a downbeat — the bar grid is anchored here">Downbeat at</label>
          <input type="number" step={0.001} value={+s.beatOffset.toFixed(4)} onChange={(e) => editSection(index, (x) => { x.beatOffset = Number(e.target.value); }, `sec${index}.off`)} />
          <label />
          <div className="btns">
            <button title="the playhead is on a downbeat" onClick={() => editSection(index, (x) => { x.beatOffset = +t.toFixed(4); })}>= playhead</button>
            <button onClick={() => editSection(index, (x) => { x.beatOffset -= spb; })}>−1 beat</button>
            <button onClick={() => editSection(index, (x) => { x.beatOffset += spb; })}>+1 beat</button>
            <button onClick={() => editSection(index, (x) => { x.beatOffset -= 0.01; }, `sec${index}.nudge`)}>−10ms</button>
            <button onClick={() => editSection(index, (x) => { x.beatOffset += 0.01; }, `sec${index}.nudge`)}>+10ms</button>
          </div>
          <label>Beats / bar</label>
          <input type="number" min={1} max={16} value={s.beatsPerBar} onChange={(e) => editSection(index, (x) => { x.beatsPerBar = Math.max(1, Math.round(Number(e.target.value))); })} />
          <label>Color</label>
          <input type="color" value={s.color ?? '#5b8cff'} onChange={(e) => editSection(index, (x) => { x.color = e.target.value; }, `sec${index}.color`)} />
        </div>
      </div></div>

      <div className="isec open"><div className="isec-h"><span>Tap tempo</span></div><div className="isec-b">
        <div className="hint">Play, then press <b>T</b> on every beat (first tap on a downbeat). {taps.length} taps.</div>
        {fit ? (
          <div className="tapfit">
            <span>{fit.bpm.toFixed(2)} bpm · downbeat {fmtTime(fit.offset)}</span>
            <button onClick={() => { editSection(index, (x) => { x.bpm = +fit.bpm.toFixed(3); x.beatOffset = +fit.offset.toFixed(4); }); store.set({ taps: [] }); }}>Apply to section</button>
          </div>
        ) : null}
        <button onClick={() => store.set({ taps: [] })}>Clear taps</button>
      </div></div>

      <div className="isec open"><div className="isec-h"><span>Structure</span></div><div className="isec-b btns">
        <button onClick={() => store.seek(s.start)}>Go to start</button>
        <button disabled={t <= s.start + 0.05 || t >= s.end - 0.05} onClick={() => store.edit((p) => {
          const cur = p.tempo[index];
          const nu = { ...cur, start: +t.toFixed(3), label: `${cur.label}b` };
          cur.end = +t.toFixed(3);
          p.tempo.splice(index + 1, 0, nu);
        })}>Split at playhead</button>
        <button disabled={index >= count - 1} onClick={() => store.edit((p) => {
          p.tempo[index].end = p.tempo[index + 1].end;
          p.tempo.splice(index + 1, 1);
        })}>Merge with next</button>
        <button disabled={count <= 1} onClick={() => {
          store.edit((p) => {
            if (index > 0) p.tempo[index - 1].end = p.tempo[index].end;
            else p.tempo[1].start = p.tempo[0].start;
            p.tempo.splice(index, 1);
          });
          store.set({ sel: {} });
        }}>Delete (merge into neighbour)</button>
      </div></div>
    </div>
  );
};

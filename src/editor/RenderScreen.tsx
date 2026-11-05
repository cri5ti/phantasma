// Render stage: presets (preview / draft / final / still), range, threads, CPU priority, live progress with ETA, outputs.
import React, { useEffect, useState } from 'react';
import { downloadPicks, streamedInTimeline } from './storyActions';
import { usePersist } from './StoryPanel';
import { fmtTime, store, useStore } from './store';

// ---- shared job state (topbar status + this screen) --------------------------------------------------
interface Job {
  running: boolean;
  progress?: number;
  phase?: string;
  done?: number;
  total?: number;
  startedAt?: number;
  renderStartedAt?: number;
  finishedAt?: number;
  out?: string;
  error?: string;
  summary?: string;
  log?: string[];
  opts?: Record<string, any>;
}
let job: Job = { running: false };
const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function poll() {
  try { job = await (await fetch('/api/render')).json(); } catch { /* server restarting */ }
  subs.forEach((f) => f());
}
function loop() {
  if (timer || !subs.size) return;
  timer = setTimeout(async () => { timer = null; await poll(); loop(); }, job.running ? 1000 : 8000);
}
export function useRenderJob(): Job {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    poll().then(loop);
    return () => { subs.delete(f); };
  }, []);
  return job;
}

export const fmtDur = (s: number) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};

/** seconds remaining while rendering (null until there is a rate to extrapolate from) */
export function etaSeconds(j: Job): number | null {
  if (!j.running || j.phase !== 'rendering' || !j.done || !j.total || !j.renderStartedAt) return null;
  const el = (Date.now() - j.renderStartedAt) / 1000;
  if (el < 2) return null;
  return ((j.total - j.done) / (j.done / el)) + 4; // + joining the chunks
}

// ---- starting a render ---------------------------------------------------------------------------------
export async function startRender(opts: Record<string, unknown>) {
  const streamed = streamedInTimeline();
  if (streamed.length) {
    // renders read local files only - streamed stand-ins would be missing from the output
    const ok = confirm(`${streamed.length} timeline clip(s) still stream from the stock CDN and would be missing from the render.\n\nOK = download them first, then render\nCancel = render without them`);
    if (ok) {
      await downloadPicks(streamed);
      if (streamedInTimeline().length) return; // download failed - the busy bar has the error
    }
  }
  await store.save();
  const r = await fetch('/api/render', { method: 'POST', body: JSON.stringify(opts) });
  if (!r.ok) alert((await r.json()).error);
  await poll();
  loop();
}
export const cancelRender = () => fetch('/api/render', { method: 'DELETE' }).then(poll);

let returnMode: 'edit' | 'story' = 'edit';
export function openRender() {
  const m = store.state.mode;
  if (m === 'edit' || m === 'story') returnMode = m;
  store.set({ mode: 'render' });
}
export const closeRender = () => store.set({ mode: returnMode });

// ---- topbar status ----------------------------------------------------------------------------------------
export const RenderStatus: React.FC = () => {
  const j = useRenderJob();
  const eta = etaSeconds(j);
  if (!j.running) return null;
  const label = j.phase === 'rendering' ? `${Math.round((j.progress ?? 0) * 100)}%${eta !== null ? ` · ETA ${fmtDur(eta)}` : ''}` : j.phase === 'still' ? 'still…' : `${j.phase ?? 'starting'}…`;
  return (
    <button className="renderstat" onClick={openRender} title="rendering - click for details">
      <span className="prog"><span style={{ width: `${(j.progress ?? 0) * 100}%` }} /></span> {label}
    </button>
  );
};

// ---- screen ------------------------------------------------------------------------------------------------
type Preset = 'preview' | 'draft' | 'final';
type RangeMode = 'all' | 'ab' | 'custom' | 'playhead';

const PRESETS: { id: Preset; name: string; desc: string }[] = [
  { id: 'preview', name: 'Preview', desc: 'quarter-res generators, 960×540 output, proxies - to check timing and look fast' },
  { id: 'draft', name: 'Draft', desc: 'half-res generators, full-size output, proxies' },
  { id: 'final', name: 'Final', desc: 'full quality, original footage' },
];
const PRIORITIES = [
  { id: 'idle', name: 'Low (idle)', desc: 'only uses CPU nobody else wants' },
  { id: 'belownormal', name: 'Below normal', desc: 'the machine stays responsive' },
  { id: 'normal', name: 'Normal', desc: '' },
  { id: 'abovenormal', name: 'Above normal', desc: 'wins against other programs' },
];

function parseTime(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  const p = s.split(':').map(Number);
  if (p.some((x) => Number.isNaN(x))) return null;
  return p.reduce((acc, x) => acc * 60 + x, 0);
}

const Stat: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => <div className="rstat"><span className="dim">{k}</span><b>{v}</b></div>;

export const RenderScreen: React.FC = () => {
  const j = useRenderJob();
  const [, tick] = useState(0);
  const project = useStore((s) => s.project);
  const inP = useStore((s) => s.inPoint);
  const outP = useStore((s) => s.outPoint);
  const [preset, setPreset] = usePersist<Preset>('mv.render.preset', 'draft');
  const [rangeMode, setRangeMode] = usePersist<RangeMode>('mv.render.range', 'all');
  const [threads, setThreads] = usePersist<number>('mv.render.threads', 4);
  const [priority, setPriority] = usePersist<string>('mv.render.priority', 'belownormal');
  const [crf, setCrf] = usePersist<string>('mv.render.crf', '');
  const [from, setFrom] = useState('0:00');
  const [to, setTo] = useState(fmtTime(project.duration));
  const [pLen, setPLen] = usePersist<number>('mv.render.plen', 10);
  const [files, setFiles] = useState<{ dir: string; files: { name: string; path: string; size: number; mtime: number }[] }>({ dir: '', files: [] });
  const cores = navigator.hardwareConcurrency || 8;

  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && (e.target as HTMLElement).tagName !== 'INPUT' && (e.target as HTMLElement).tagName !== 'SELECT') closeRender(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const running = j.running;
  useEffect(() => { fetch('/api/render/files').then((r) => r.json()).then(setFiles).catch(() => {}); }, [running, j.out]);

  // the range this render will cover
  const dur = project.duration;
  let range: { from?: number; to?: number } = {};
  let rangeNote = '';
  if (rangeMode === 'ab') {
    if (inP === null && outP === null) rangeNote = 'No A/B points set - set them in the timeline (I / O keys).';
    else range = { from: inP ?? 0, to: outP ?? dur };
  } else if (rangeMode === 'custom') {
    const a = parseTime(from), b = parseTime(to);
    if (a === null || b === null || b <= a) rangeNote = 'Enter a valid from/to (seconds or m:ss).';
    else range = { from: a, to: Math.min(dur, b) };
  } else if (rangeMode === 'playhead') {
    range = { from: store.time, to: Math.min(dur, store.time + pLen) };
  }
  const a0 = range.from ?? 0, b0 = range.to ?? dur;
  const frames = Math.max(0, Math.round((b0 - a0) * project.fps));
  const invalid = !!rangeNote;

  const go = () => {
    const opts: Record<string, unknown> = { procs: threads, priority, ...range };
    if (preset === 'preview') opts.preview = true;
    if (preset === 'draft') opts.draft = true;
    if (crf.trim() && Number(crf) > 0) opts.crf = Number(crf);
    startRender(opts);
  };

  const eta = etaSeconds(j);
  const elapsed = j.startedAt ? ((j.running ? Date.now() : j.finishedAt ?? Date.now()) - j.startedAt) / 1000 : 0;
  const fps = j.done && j.renderStartedAt ? j.done / (((j.running ? Date.now() : j.finishedAt ?? Date.now()) - j.renderStartedAt) / 1000) : 0;
  const phaseLabel: Record<string, string> = { bundling: 'Bundling the project…', rendering: 'Rendering frames', joining: 'Joining chunks + audio…', still: 'Rendering still…', done: 'Finished', failed: 'Failed', cancelled: 'Cancelled' };

  return (
    <div className="renderscreen">
      <div className="find-head">
        <button onClick={closeRender} title="back (Esc)">← Back</button>
        <b>Render</b>
        <span className="dim">{project.name} · {project.width}×{project.height} @ {project.fps} fps · {fmtTime(dur)}</span>
      </div>

      <div className="render-body">
        <div className="render-col">
          <div className="isec-h static">Quality</div>
          <div className="presets">
            {PRESETS.map((p) => (
              <button key={p.id} className={`preset ${preset === p.id ? 'on' : ''}`} disabled={running} onClick={() => setPreset(p.id)}>
                <b>{p.name}</b><span>{p.desc}</span>
              </button>
            ))}
          </div>
          <div className="row">
            <label className="wide">CRF override</label>
            <input style={{ width: 60 }} value={crf} disabled={running} placeholder={preset === 'preview' ? '30' : preset === 'draft' ? '26' : '16'} onChange={(e) => setCrf(e.target.value.replace(/[^\d]/g, ''))} title="x264 quality: lower = bigger and better. Blank = the preset's value" />
            <span className="dim">blank = preset default</span>
          </div>

          <div className="isec-h static">Range</div>
          <div className="seg">
            {([['all', 'Whole song'], ['ab', 'A → B'], ['custom', 'Custom'], ['playhead', 'From playhead']] as [RangeMode, string][]).map(([id, name]) => (
              <button key={id} className={rangeMode === id ? 'on' : ''} disabled={running} onClick={() => setRangeMode(id)}>{name}</button>
            ))}
          </div>
          {rangeMode === 'custom' ? (
            <div className="row">
              <label>from</label><input style={{ width: 70 }} value={from} disabled={running} onChange={(e) => setFrom(e.target.value)} />
              <label>to</label><input style={{ width: 70 }} value={to} disabled={running} onChange={(e) => setTo(e.target.value)} />
            </div>
          ) : null}
          {rangeMode === 'playhead' ? (
            <div className="row">
              <span className="dim">{fmtTime(store.time)} for</span>
              <input type="number" min={1} style={{ width: 60 }} value={pLen} disabled={running} onChange={(e) => setPLen(Math.max(1, Number(e.target.value) || 10))} /> <span className="dim">seconds</span>
            </div>
          ) : null}
          <div className="hint">{rangeNote || `${fmtTime(a0)} → ${fmtTime(b0)} · ${(b0 - a0).toFixed(1)} s · ${frames} frames`}</div>

          <div className="isec-h static">Resources</div>
          <div className="row">
            <label className="wide">Threads</label>
            <select value={threads} disabled={running} onChange={(e) => setThreads(Number(e.target.value))}>
              {Array.from({ length: Math.max(8, cores) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}{n === 4 ? ' (default)' : ''}</option>)}
            </select>
            <span className="dim">this machine: {cores} logical cores</span>
          </div>
          <div className="hint">Each thread renders one contiguous slice of the song in its own browser, then the slices are joined. More threads = faster but heavier; short ranges use fewer.</div>
          <div className="row">
            <label className="wide">CPU priority</label>
            <select value={priority} disabled={running} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span className="dim">{PRIORITIES.find((p) => p.id === priority)?.desc}</span>
          </div>
          <div className="hint">Applies to the whole render (browsers, encoder). Set at start; it can't be changed on a running render.</div>

          <div className="render-go">
            {running
              ? <button className="accent" onClick={cancelRender}>✕ Cancel render</button>
              : <button className="accent" disabled={invalid || !frames} onClick={go}>▶ Render {preset}{rangeMode === 'all' ? '' : ' (range)'}</button>}
            <button disabled={running} onClick={() => startRender({ still: true, at: store.time, priority })} title="PNG of the frame under the playhead">Still at playhead</button>
          </div>
        </div>

        <div className="render-col">
          <div className="isec-h static">Progress</div>
          <div className={`rjob ${j.phase ?? 'idle'}`}>
            <div className="rphase">{j.phase ? phaseLabel[j.phase] ?? j.phase : 'Idle - nothing rendered yet this session'}</div>
            {j.running || j.phase === 'done' ? (
              <div className="rbar"><span style={{ width: `${(j.phase === 'done' ? 1 : j.progress ?? 0) * 100}%` }} /></div>
            ) : null}
            {j.running || j.phase === 'done' || j.phase === 'failed' || j.phase === 'cancelled' ? (
              <div className="rstats">
                {j.total ? <Stat k="frames" v={`${j.done ?? 0} / ${j.total}`} /> : null}
                {j.running && j.phase === 'rendering' ? <Stat k="ETA" v={eta !== null ? `${fmtDur(eta)} (≈ ${new Date(Date.now() + eta * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : 'estimating…'} /> : null}
                <Stat k="elapsed" v={fmtDur(elapsed)} />
                {fps ? <Stat k="speed" v={`${fps.toFixed(1)} fps`} /> : null}
                {j.opts ? <Stat k="threads / priority" v={`${j.opts.procs ?? 'auto'} / ${j.opts.priority ?? 'normal'}`} /> : null}
              </div>
            ) : null}
            {j.phase === 'done' && j.summary ? <div className="hint">{j.summary}</div> : null}
            {j.error ? <div className="err">{j.error}</div> : null}
            {j.out && !j.running ? <div className="hint">→ <code>{j.out}</code></div> : null}
          </div>

          <div className="isec-h static">Outputs <span className="dim">{files.dir}</span></div>
          <div className="rfiles">
            {files.files.map((f) => (
              <div className="rfile" key={f.name}>
                <a href={`/out/${encodeURIComponent(f.name)}`} target="_blank" rel="noreferrer" title="open in a new tab">{f.name}</a>
                <span className="dim">{(f.size / 1048576).toFixed(1)} MB · {new Date(f.mtime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <button onClick={() => navigator.clipboard?.writeText(f.path)} title="copy full path">⧉</button>
              </div>
            ))}
            {!files.files.length ? <div className="hint">No renders in out/ yet.</div> : null}
          </div>

          {j.log?.length ? (
            <details className="rlog">
              <summary>Log</summary>
              <pre>{j.log.filter((l) => !/^Rendered \d+\/\d+$/.test(l)).slice(-60).join('\n')}</pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
};

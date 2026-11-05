// AI log: every LLM request this song folder has made (_mvgen/ai-log/), with live progress for running ones.
import React, { useEffect, useState } from 'react';
import { store, useStore } from './store';

export interface RunSummary {
  id: string; kind: string; provider: string; model: string; servedBy?: string;
  status: 'running' | 'done' | 'error'; startedAt: number; endedAt?: number;
  stopReason?: string; error?: string; inputTokens?: number; outputTokens?: number; lastEvent?: string;
}
interface Run extends RunSummary {
  system: string; user: string; thinking: string; text: string;
  usage?: Record<string, unknown>; events: { t: number; msg: string }[];
}

export const fetchRuns = async (): Promise<RunSummary[]> => (await (await fetch('/api/ai/runs')).json()).runs ?? [];

/** Poll fn every `ms` while mounted (and immediately). */
function usePoll(fn: () => void, ms: number, deps: unknown[]) {
  useEffect(() => {
    fn();
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, deps);
}

const dur = (r: RunSummary) => (((r.endedAt ?? Date.now()) - r.startedAt) / 1000).toFixed(1) + ' s';
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

const Block: React.FC<{ title: string; text: string; open?: boolean; mono?: boolean }> = ({ title, text, open, mono = true }) => (
  <details className="ai-block" open={open}>
    <summary>
      {title} <span className="dim">{text.length.toLocaleString()} chars</span>
      <button onClick={(e) => { e.preventDefault(); navigator.clipboard?.writeText(text).catch(() => {}); }} title="copy">⧉</button>
    </summary>
    <pre className={mono ? 'mono' : ''}>{text || '—'}</pre>
  </details>
);

export const AiLogTab: React.FC = () => {
  const sel = useStore((s) => s.aiRun);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const anyRunning = runs.some((r) => r.status === 'running');
  const id = sel ?? runs[0]?.id ?? null;

  usePoll(() => { fetchRuns().then(setRuns).catch(() => {}); }, anyRunning ? 1000 : 4000, [anyRunning]);
  const live = run?.id === id && run?.status === 'running';
  usePoll(() => {
    if (!id) return setRun(null);
    fetch(`/api/ai/runs/${id}`).then((r) => (r.ok ? r.json() : null)).then((r) => r && setRun(r)).catch(() => {});
  }, live || !run || run.id !== id ? 1000 : 60_000, [id, live]);

  return (
    <div className="ailog">
      <div className="ai-list">
        {runs.map((r) => (
          <div key={r.id} className={`ai-row ${r.id === id ? 'sel' : ''} ${r.status}`} onClick={() => store.set({ aiRun: r.id })}>
            <span className="st">{r.status === 'running' ? <span className="spin" /> : r.status === 'error' ? '✖' : '✔'}</span>
            <span className="kind">{r.kind}</span>
            <span className="dim">{new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <span className="grow" />
            <span className="dim">{dur(r)}</span>
          </div>
        ))}
        {!runs.length ? <div className="hint pad">No AI runs yet. Every request (Suggest ideas, Plan storyboard, re-plans) shows up here with its prompt, the model's thinking summary and the raw response. Files: <code>_mvgen/ai-log/</code>.</div> : null}
      </div>
      {run && run.id === id ? (
        <div className="ai-detail">
          <div className="ai-head">
            <b>{run.kind}</b> <span className={`tag ${run.status}`}>{run.status}</span>
            <span className="dim">{run.provider} · {run.model}{run.servedBy && run.servedBy !== run.model ? ` → served by ${run.servedBy}` : ''}</span>
            <span className="grow" />
            <span className="dim">{dur(run)}{run.inputTokens || (run.usage as any)?.input_tokens ? ` · ${(run.usage as any)?.input_tokens ?? run.inputTokens} in / ${(run.usage as any)?.output_tokens ?? run.outputTokens} out` : ''}</span>
          </div>
          {run.error ? <div className="err ai-err">{run.error}</div> : null}
          <details className="ai-block" open>
            <summary>Events <span className="dim">{run.events.length}</span></summary>
            <div className="ai-events">
              {run.events.map((e, i) => (
                <div key={i}><span className="dim">{clock(e.t)}</span> {e.msg}</div>
              ))}
            </div>
          </details>
          {run.thinking ? <Block title="Thinking (summary)" text={run.thinking} open={run.status === 'running'} mono={false} /> : null}
          <Block title="Response" text={pretty(run.text)} />
          <Block title="Prompt — system" text={run.system} />
          <Block title="Prompt — user" text={run.user} />
          <div className="hint">Saved as <code>_mvgen/ai-log/{run.id}.json</code></div>
        </div>
      ) : null}
    </div>
  );
};

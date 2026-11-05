// Every AI request is a "run": the exact prompts, live progress events, streamed thinking summary + response,
// usage and timing. Running runs live in memory; finished ones are written to <project>/_mvgen/ai-log/<id>.json.
import fs from 'node:fs';
import path from 'node:path';

export interface AiEvent { t: number; msg: string }

export interface AiRun {
  id: string;
  kind: string;
  provider: string;
  model: string;
  /** model that actually answered (differs when a fallback served the request) */
  servedBy?: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt?: number;
  system: string;
  user: string;
  thinking: string;
  text: string;
  usage?: Record<string, unknown>;
  stopReason?: string;
  error?: string;
  events: AiEvent[];
}

export type RunSummary = Pick<AiRun, 'id' | 'kind' | 'provider' | 'model' | 'servedBy' | 'status' | 'startedAt' | 'endedAt' | 'stopReason' | 'error'> & {
  inputTokens?: number;
  outputTokens?: number;
  lastEvent?: string;
};

export class AiLog {
  private live = new Map<string, AiRun>();
  private dir: string;

  constructor(projectDir: string) {
    this.dir = path.join(projectDir, '_mvgen', 'ai-log');
  }

  start(kind: string, provider: string, model: string, system: string, user: string): AiRun {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${kind}-${Math.random().toString(36).slice(2, 5)}`;
    const run: AiRun = { id, kind, provider, model, status: 'running', startedAt: Date.now(), system, user, thinking: '', text: '', events: [] };
    this.live.set(id, run);
    this.event(run, `${kind} → ${provider} ${model} · prompt ${user.length + system.length} chars`);
    return run;
  }

  event(run: AiRun, msg: string) {
    run.events.push({ t: Date.now(), msg });
    console.log(`[ai ${run.id.slice(11, 19)}] ${msg}`);
  }

  finish(run: AiRun, error?: unknown) {
    run.endedAt = Date.now();
    if (error) {
      run.status = 'error';
      run.error = String((error as any)?.message ?? error);
      this.event(run, `✖ ${run.error}`);
    } else {
      run.status = 'done';
      this.event(run, `✔ done in ${((run.endedAt - run.startedAt) / 1000).toFixed(1)} s`);
    }
    this.persist(run);
    // keep it in memory a little so the UI can still append client-side notes
    setTimeout(() => this.live.delete(run.id), 5 * 60_000);
  }

  /** client-side follow-up (e.g. how the shot list was post-processed) */
  note(id: string, msg: string) {
    const run = this.get(id);
    if (!run) return false;
    this.event(run, `· ${msg}`);
    this.persist(run);
    return true;
  }

  get(id: string): AiRun | null {
    const r = this.live.get(id);
    if (r) return r;
    const f = path.join(this.dir, `${path.basename(id)}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }

  list(limit = 200): RunSummary[] {
    const ids = new Set(this.live.keys());
    if (fs.existsSync(this.dir)) for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.json')) ids.add(f.slice(0, -5));
    return [...ids].sort().reverse().slice(0, limit).flatMap((id) => {
      const r = this.get(id);
      if (!r) return [];
      const { system, user, thinking, text, events, usage, ...rest } = r;
      return [{ ...rest, inputTokens: num(usage?.input_tokens ?? usage?.prompt_tokens), outputTokens: num(usage?.output_tokens ?? usage?.completion_tokens), lastEvent: events.at(-1)?.msg }];
    });
  }

  private persist(run: AiRun) {
    if (run.status === 'running') return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${run.id}.json`), JSON.stringify(run, null, 1));
  }
}

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

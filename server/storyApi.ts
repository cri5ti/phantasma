// /api/story/* and /api/stock/* — storyboard stage endpoints, mounted by vite.config.ts.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateShots, llmStatus, suggestIdeas, transformCards, type LLMProvider } from './ai';
import { AiLog } from './aiLog';
import { loadEnv } from './env';
import { lyricsApi } from './lyrics';
import { Downloader, initSearchCache, providerStatus, RateLimitError, search } from './stock';
import type { StockProvider } from '../src/core/types';

type Send = (res: any, code: number, body: unknown) => void;

export function storyApi(root: string, project: string) {
  loadEnv(root, project);
  const scan = () =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(root, 'scripts', 'media.mjs'), project], { cwd: root, stdio: 'inherit' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`media scan exited ${code}`))));
    });
  const dl = new Downloader(project, scan);

  // footage dropped into the project folder by hand: list media files on disk vs. what media.json knows about
  const MEDIA_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
  const onDisk = (rel = ''): string[] =>
    fs.readdirSync(path.join(project, rel), { withFileTypes: true }).flatMap((e) => {
      if (e.name.startsWith('.') || e.name === '_mvgen' || e.name === 'node_modules' || e.name === 'out') return [];
      const r = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? onDisk(r) : MEDIA_EXT.has(path.extname(e.name).toLowerCase()) ? [r] : [];
    });
  const known = (): Set<string> => {
    try { return new Set(JSON.parse(fs.readFileSync(path.join(project, '_mvgen', 'media.json'), 'utf8')).media.map((m: any) => m.src)); } catch { return new Set(); }
  };
  let scanning: Promise<void> | null = null;
  const ai = new AiLog(project);
  initSearchCache(path.join(project, '_mvgen', 'stock-cache.json'));
  const lyrics = lyricsApi(root, project, ai);

  return async (req: any, res: any, url: URL, body: () => Promise<any>, send: Send): Promise<boolean> => {
    const p = url.pathname;
    if (p.startsWith('/api/lyrics/')) return lyrics(req, res, url, body, send);
    if (p === '/api/media/stale') {
      const have = known();
      const files = onDisk();
      send(res, 200, { fresh: files.filter((f) => !have.has(f)).length, total: files.length });
      return true;
    }
    if (p === '/api/media/scan' && req.method === 'POST') {
      // one scan at a time (a stock download may be scanning too); concurrent callers share it
      scanning ??= scan().finally(() => { scanning = null; });
      await scanning;
      send(res, 200, { ok: true });
      return true;
    }
    if (p === '/api/story/status') {
      send(res, 200, { llm: llmStatus(), stock: providerStatus() });
      return true;
    }
    if (p === '/api/story/shots' && req.method === 'POST') {
      const { provider = 'claude', model, context } = await body();
      const r = await generateShots(ai, provider as LLMProvider, model, context);
      send(res, 200, r);
      return true;
    }
    if (p === '/api/story/ideas' && req.method === 'POST') {
      const { provider = 'claude', model, context, count } = await body();
      const r = await suggestIdeas(ai, provider as LLMProvider, model, context, count);
      send(res, 200, r);
      return true;
    }
    if (p === '/api/story/cards' && req.method === 'POST') {
      const { provider = 'claude', model, context, cards, task, mode = 'custom' } = await body();
      const r = await transformCards(ai, provider as LLMProvider, model, context, cards ?? [], String(task ?? ''), String(mode));
      send(res, 200, r);
      return true;
    }
    // AI run log: list, one run, client-side notes
    if (p === '/api/ai/runs') {
      send(res, 200, { runs: ai.list() });
      return true;
    }
    const m = p.match(/^\/api\/ai\/runs\/([\w-]+)(\/note)?$/);
    if (m && m[2] && req.method === 'POST') {
      const { msg } = await body();
      send(res, ai.note(m[1], String(msg ?? '')) ? 200 : 404, { ok: true });
      return true;
    }
    if (m) {
      const r = ai.get(m[1]);
      send(res, r ? 200 : 404, r ?? { error: 'no such run' });
      return true;
    }
    if (p === '/api/stock/usage') {
      send(res, 200, providerStatus());
      return true;
    }
    if (p === '/api/stock/search') {
      const q = url.searchParams;
      const r = await search((q.get('provider') ?? 'pexels') as StockProvider, {
        q: q.get('q') ?? '',
        kind: (q.get('kind') as any) ?? 'video',
        page: Number(q.get('page') ?? 1),
        perPage: Number(q.get('perPage') ?? 15),
        orientation: (q.get('orientation') as any) || undefined,
      }).catch((e) => { if (e instanceof RateLimitError) { send(res, 429, { error: e.message, rateLimited: true }); return null; } throw e; });
      if (r) send(res, 200, r);
      return true;
    }
    if (p === '/api/stock/download' && req.method === 'POST') {
      const { refs } = await body();
      dl.enqueue(refs ?? []);
      send(res, 200, dl.status());
      return true;
    }
    if (p === '/api/stock/jobs') {
      send(res, 200, dl.status());
      return true;
    }
    return false;
  };
}

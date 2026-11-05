// Stock footage providers, normalised to StockRef. Keys come from the environment (.env):
//   PEXELS_API_KEY, PIXABAY_API_KEY
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StockProvider, StockRef } from '../src/core/types';

export interface SearchOpts {
  q: string;
  kind: 'video' | 'image';
  page?: number;
  perPage?: number;
  orientation?: 'landscape' | 'portrait' | 'square';
}

export interface SearchResult {
  items: StockRef[];
  total: number;
}

interface Provider {
  available(): boolean;
  why?: string;
  search(o: SearchOpts): Promise<SearchResult>;
  /** best file to download for the project (≈1080p for video) */
  resolve(ref: StockRef): Promise<{ url: string; ext: string }>;
}

// ---- rate limiting ------------------------------------------------------------------------------
// Only API calls count (searches + one lookup per download); thumbnails / preview mp4s are CDN files.
// Defaults (free keys):  Pexels 200/hour + 20,000/month   ·   Pixabay 100 per 60 s.
// We stay under a safety share of each window, track the providers' own counters from response headers,
// and never retry blindly: a short wait is queued, a long one fails fast with "resets in …".
interface Window { n: number; ms: number }
const LIMITS: Record<'pexels' | 'pixabay', Window[]> = {
  pexels: [{ n: Number(process.env.MV_PEXELS_PER_HOUR ?? 200), ms: 3600_000 }],
  pixabay: [{ n: Number(process.env.MV_PIXABAY_PER_MIN ?? 100), ms: 60_000 }],
};
const SAFETY = 0.85;      // use at most 85% of a window
const MAX_WAIT = 15_000;  // queue a call for at most this long, otherwise fail with a clear message

export class RateLimitError extends Error {}

class Limiter {
  private stamps: number[] = [];
  /** provider-reported counter (Pexels: monthly; Pixabay: per window) */
  remaining?: number;
  limit?: number;
  resetAt?: number;
  blockedUntil = 0;
  calls = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly name: string, readonly windows: Window[]) {}

  private waitMs(now: number): number {
    let w = Math.max(0, this.blockedUntil - now);
    for (const win of this.windows) {
      const inWin = this.stamps.filter((t) => now - t < win.ms);
      const allowed = Math.max(1, Math.floor(win.n * SAFETY));
      if (inWin.length >= allowed) w = Math.max(w, inWin[inWin.length - allowed] + win.ms - now);
    }
    // the provider says we're (nearly) out: hold until its reset
    if (this.remaining !== undefined && this.remaining <= 2 && this.resetAt && this.resetAt > now) w = Math.max(w, this.resetAt - now);
    return w;
  }

  /** resolves when a call may go out; calls are serialised so bursts can't overshoot */
  take(): Promise<void> {
    const next = this.chain.then(async () => {
      const now = Date.now();
      const w = this.waitMs(now);
      if (w > MAX_WAIT) throw new RateLimitError(`${this.name}: rate limit reached — resets in ${fmt(w)} (cached searches still work)`);
      if (w > 0) await new Promise((r) => setTimeout(r, w));
      const t = Date.now();
      this.stamps.push(t);
      const longest = Math.max(...this.windows.map((x) => x.ms));
      this.stamps = this.stamps.filter((x) => t - x < longest);
      this.calls++;
    });
    this.chain = next.catch(() => {});
    return next;
  }

  update(h: Headers) {
    const lim = Number(h.get('x-ratelimit-limit'));
    const rem = h.get('x-ratelimit-remaining');
    const reset = Number(h.get('x-ratelimit-reset'));
    if (lim) this.limit = lim;
    if (rem !== null && rem !== '') this.remaining = Number(rem);
    // Pexels sends a UNIX timestamp, Pixabay seconds-until-reset
    if (reset) this.resetAt = reset > 1e9 ? reset * 1000 : Date.now() + reset * 1000;
  }

  on429(h: Headers) {
    const ra = Number(h.get('retry-after'));
    this.update(h);
    this.blockedUntil = Date.now() + (ra ? ra * 1000 : this.resetAt && this.resetAt > Date.now() ? this.resetAt - Date.now() : this.windows[0].ms);
  }

  status() {
    const now = Date.now();
    return {
      windows: this.windows.map((w) => ({ per: w.ms >= 3600_000 ? 'hour' : `${w.ms / 1000}s`, limit: w.n, budget: Math.floor(w.n * SAFETY), used: this.stamps.filter((t) => now - t < w.ms).length })),
      providerRemaining: this.remaining,
      providerLimit: this.limit,
      resetsIn: this.resetAt && this.resetAt > now ? this.resetAt - now : undefined,
      blockedFor: this.blockedUntil > now ? this.blockedUntil - now : undefined,
      callsThisSession: this.calls,
    };
  }
}

const fmt = (ms: number) => (ms < 90_000 ? `${Math.ceil(ms / 1000)} s` : ms < 2 * 3600_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.round(ms / 3600_000)} h`);

export const limiters = { pexels: new Limiter('pexels', LIMITS.pexels), pixabay: new Limiter('pixabay', LIMITS.pixabay) };

async function getJson(provider: keyof typeof limiters, url: string, headers: Record<string, string> = {}) {
  const lim = limiters[provider];
  await lim.take();
  const r = await fetch(url, { headers });
  if (r.status === 429) {
    lim.on429(r.headers);
    throw new RateLimitError(`${provider}: rate limit hit (429) — paused for ${fmt(lim.blockedUntil - Date.now())}`);
  }
  lim.update(r.headers);
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<any>;
}

/** Prefer the file closest to 1920 wide (long edge), never upscale-sized junk. */
function bestFile<T extends { width: number; height: number }>(files: T[], target = 1920): T | undefined {
  const long = (f: T) => Math.max(f.width || 0, f.height || 0);
  const ok = files.filter((f) => long(f) > 0);
  const atLeast = ok.filter((f) => long(f) >= target).sort((a, b) => long(a) - long(b));
  return atLeast[0] ?? ok.sort((a, b) => long(b) - long(a))[0];
}

// ---- Pexels --------------------------------------------------------------------------
const pexels: Provider = {
  available: () => !!process.env.PEXELS_API_KEY,
  why: 'set PEXELS_API_KEY (free key: https://www.pexels.com/api/)',
  async search(o) {
    const h = { Authorization: process.env.PEXELS_API_KEY! };
    const qs = new URLSearchParams({ query: o.q, per_page: String(Math.min(80, o.perPage ?? 15)), page: String(o.page ?? 1) });
    if (o.orientation) qs.set('orientation', o.orientation);
    if (o.kind === 'video') {
      const j = await getJson('pexels', `https://api.pexels.com/videos/search?${qs}`, h);
      return {
        total: j.total_results ?? 0,
        items: (j.videos ?? []).map((v: any): StockRef => {
          const files = (v.video_files ?? []).filter((f: any) => f.file_type === 'video/mp4');
          const bySize = files.filter((f: any) => f.width).sort((a: any, b: any) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
          const small = bySize.find((f: any) => Math.max(f.width, f.height) >= 480) ?? bySize.at(-1);
          const hd = bySize.find((f: any) => Math.max(f.width, f.height) >= 1200) ?? bySize.at(-1);
          return {
            provider: 'pexels', id: String(v.id), kind: 'video',
            thumb: v.image, preview: small?.link, previewHd: hd?.link, page: v.url,
            author: v.user?.name, authorUrl: v.user?.url,
            width: v.width, height: v.height, duration: v.duration,
          };
        }),
      };
    }
    const j = await getJson('pexels', `https://api.pexels.com/v1/search?${qs}`, h);
    return {
      total: j.total_results ?? 0,
      items: (j.photos ?? []).map((p: any): StockRef => ({
        provider: 'pexels', id: String(p.id), kind: 'image',
        thumb: p.src?.medium ?? p.src?.small, page: p.url,
        author: p.photographer, authorUrl: p.photographer_url,
        width: p.width, height: p.height, tags: p.alt ? [p.alt] : undefined,
      })),
    };
  },
  async resolve(ref) {
    const h = { Authorization: process.env.PEXELS_API_KEY! };
    if (ref.kind === 'video') {
      const v = await getJson('pexels', `https://api.pexels.com/videos/videos/${ref.id}`, h);
      const f = bestFile((v.video_files ?? []).filter((x: any) => x.file_type === 'video/mp4') as any[]);
      if (!f) throw new Error(`pexels ${ref.id}: no mp4 file`);
      return { url: f.link, ext: '.mp4' };
    }
    const p = await getJson('pexels', `https://api.pexels.com/v1/photos/${ref.id}`, h);
    return { url: p.src?.large2x ?? p.src?.original, ext: '.jpg' };
  },
};

// ---- Pixabay -------------------------------------------------------------------------
const pixabay: Provider = {
  available: () => !!process.env.PIXABAY_API_KEY,
  why: 'set PIXABAY_API_KEY (free key: https://pixabay.com/api/docs/)',
  async search(o) {
    const qs = new URLSearchParams({ key: process.env.PIXABAY_API_KEY!, q: o.q.slice(0, 100), per_page: String(Math.min(200, Math.max(3, o.perPage ?? 15))), page: String(o.page ?? 1), safesearch: 'true' });
    if (o.kind === 'video') {
      const j = await getJson('pixabay', `https://pixabay.com/api/videos/?${qs}`);
      return {
        total: j.totalHits ?? 0,
        items: (j.hits ?? []).map((v: any): StockRef => {
          const best = v.videos?.large?.width ? v.videos.large : v.videos?.medium;
          return {
            provider: 'pixabay', id: String(v.id), kind: 'video',
            thumb: v.videos?.medium?.thumbnail || v.videos?.small?.thumbnail || '',
            preview: v.videos?.tiny?.url || v.videos?.small?.url,
            previewHd: v.videos?.small?.url || v.videos?.medium?.url || v.videos?.tiny?.url, page: v.pageURL,
            author: v.user, authorUrl: `https://pixabay.com/users/${v.user}-${v.user_id}/`,
            width: best?.width ?? 0, height: best?.height ?? 0, duration: v.duration,
            tags: String(v.tags ?? '').split(',').map((s: string) => s.trim()).filter(Boolean),
          };
        }),
      };
    }
    qs.set('image_type', 'photo');
    if (o.orientation === 'landscape') qs.set('orientation', 'horizontal');
    if (o.orientation === 'portrait') qs.set('orientation', 'vertical');
    const j = await getJson('pixabay', `https://pixabay.com/api/?${qs}`);
    return {
      total: j.totalHits ?? 0,
      items: (j.hits ?? []).map((p: any): StockRef => ({
        provider: 'pixabay', id: String(p.id), kind: 'image',
        thumb: p.webformatURL, page: p.pageURL,
        author: p.user, authorUrl: `https://pixabay.com/users/${p.user}-${p.user_id}/`,
        width: p.imageWidth, height: p.imageHeight,
        tags: String(p.tags ?? '').split(',').map((s: string) => s.trim()).filter(Boolean),
      })),
    };
  },
  async resolve(ref) {
    const qs = new URLSearchParams({ key: process.env.PIXABAY_API_KEY!, id: ref.id });
    if (ref.kind === 'video') {
      const j = await getJson('pixabay', `https://pixabay.com/api/videos/?${qs}`);
      const v = j.hits?.[0];
      const f = bestFile(Object.values(v?.videos ?? {}) as any[]);
      if (!f) throw new Error(`pixabay ${ref.id}: no file`);
      return { url: (f as any).url, ext: '.mp4' };
    }
    const j = await getJson('pixabay', `https://pixabay.com/api/?${qs}`);
    return { url: j.hits?.[0]?.largeImageURL, ext: '.jpg' };
  },
};

// ---- Mixkit --------------------------------------------------------------------------
// Mixkit has no public API. Kept as a registered provider so the UI lists it; wire a scraper or
// a licensed feed here if you want it.
const mixkit: Provider = {
  available: () => false,
  why: 'Mixkit has no public API — not wired yet',
  async search() { throw new Error(mixkit.why); },
  async resolve() { throw new Error(mixkit.why); },
};

export const PROVIDERS: Record<StockProvider, Provider> = { pexels, pixabay, mixkit };

export function providerStatus() {
  return Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, {
    available: p.available(),
    why: p.available() ? undefined : p.why,
    usage: k in limiters ? limiters[k as keyof typeof limiters].status() : undefined,
  }]));
}

// Search results are cached for 24 h and persisted (Pixabay's API terms ask for 24 h caching; it also keeps us far
// below the per-key rate limits — only searches and download lookups hit the APIs, thumbnails/previews are CDN files).
const CACHE_TTL = 24 * 3600_000;
let cache = new Map<string, { at: number; r: SearchResult }>();
let cacheFile: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function initSearchCache(file: string) {
  cacheFile = file;
  try {
    const now = Date.now();
    const raw: [string, { at: number; r: SearchResult }][] = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = new Map(raw.filter(([, v]) => now - v.at < CACHE_TTL));
  } catch { /* no cache yet */ }
}

function saveCache() {
  if (!cacheFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at >= CACHE_TTL) cache.delete(k);
    fs.mkdirSync(path.dirname(cacheFile!), { recursive: true });
    fs.writeFileSync(cacheFile!, JSON.stringify([...cache]));
  }, 2000);
}

export async function search(provider: StockProvider, o: SearchOpts): Promise<SearchResult & { cached?: boolean }> {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider ${provider}`);
  if (!p.available()) throw new Error(`${provider}: ${p.why}`);
  const key = JSON.stringify([provider, o.q.trim().toLowerCase(), o.kind, o.page ?? 1, o.perPage ?? 15, o.orientation ?? '']);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.r, cached: true };
  const flying = inflight.get(key);
  if (flying) return { ...(await flying), cached: true };
  const req = p.search(o);
  inflight.set(key, req);
  try {
    const r = await req;
    cache.set(key, { at: Date.now(), r });
    saveCache();
    return r;
  } finally {
    inflight.delete(key);
  }
}
const inflight = new Map<string, Promise<SearchResult>>();

/** File name a downloaded ref lands at (media id = slug of it, see scripts/lib.mjs). */
export const stockFileBase = (ref: StockRef) => `${ref.provider}-${ref.id}`;

// ---- downloads (background queue) -------------------------------------------------------
export interface DownloadJob {
  ref: StockRef;
  state: 'queued' | 'downloading' | 'done' | 'error';
  bytes: number;
  total: number;
  file?: string;
  error?: string;
}

export class Downloader {
  jobs: DownloadJob[] = [];
  scanning = false;
  private running = 0;
  private needScan = false;

  constructor(private projectDir: string, private scan: () => Promise<void>) {}

  enqueue(refs: StockRef[]) {
    for (const ref of refs) {
      const k = stockFileBase(ref);
      if (this.jobs.some((j) => stockFileBase(j.ref) === k && j.state !== 'error')) continue;
      this.jobs = this.jobs.filter((j) => stockFileBase(j.ref) !== k);
      this.jobs.push({ ref, state: 'queued', bytes: 0, total: 0 });
    }
    this.pump();
  }

  status() {
    const busy = this.running > 0 || this.scanning || this.jobs.some((j) => j.state === 'queued');
    return { busy, scanning: this.scanning, jobs: this.jobs.map(({ ref, ...j }) => ({ key: stockFileBase(ref), ...j })) };
  }

  private pump() {
    while (this.running < 3) {
      const j = this.jobs.find((x) => x.state === 'queued');
      if (!j) break;
      this.running++;
      this.run(j).finally(() => {
        this.running--;
        this.needScan = this.needScan || j.state === 'done';
        this.pump();
        this.maybeScan();
      });
    }
  }

  private async maybeScan() {
    if (this.running || this.scanning || !this.needScan || this.jobs.some((j) => j.state === 'queued')) return;
    this.needScan = false;
    this.scanning = true;
    try { await this.scan(); } catch (e) { console.error('[stock] media scan failed', e); }
    this.scanning = false;
    this.maybeScan();
  }

  private async run(j: DownloadJob) {
    const p = j.ref.provider === 'local' ? undefined : PROVIDERS[j.ref.provider];
    try {
      j.state = 'downloading';
      if (!p) throw new Error('local media needs no download');
      const { url, ext } = await p.resolve(j.ref);
      const dir = path.join(this.projectDir, 'stock');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, stockFileBase(j.ref) + ext);
      j.file = path.relative(this.projectDir, file).replace(/\\/g, '/');
      if (!fs.existsSync(file)) {
        const r = await fetch(url);
        if (!r.ok || !r.body) throw new Error(`download ${r.status}`);
        j.total = Number(r.headers.get('content-length') ?? 0);
        const body = Readable.fromWeb(r.body as any);
        body.on('data', (c: Buffer) => (j.bytes += c.length));
        await pipeline(body, fs.createWriteStream(file + '.part'));
        fs.renameSync(file + '.part', file);
      }
      this.credit(j.ref, j.file);
      j.state = 'done';
    } catch (e: any) {
      j.state = 'error';
      j.error = String(e?.message ?? e);
    }
  }

  /** stock/credits.json — attribution log (Pexels/Pixabay ask for credit where possible). */
  private credit(ref: StockRef, file: string) {
    const f = path.join(this.projectDir, 'stock', 'credits.json');
    const all: any[] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
    if (all.some((c) => c.file === file)) return;
    all.push({ file, provider: ref.provider, id: ref.id, page: ref.page, author: ref.author, authorUrl: ref.authorUrl, at: new Date().toISOString() });
    fs.writeFileSync(f, JSON.stringify(all, null, 2));
  }
}

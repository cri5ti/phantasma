import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { storyApi } from './server/storyApi';

const ROOT = __dirname;
const PROJECT = path.resolve(process.env.MV_PROJECT ?? process.cwd());
const WORK = path.join(PROJECT, '_mvgen');
const PROJECT_FILE = path.join(PROJECT, 'mv.project.json');
const AUDIO_EXT = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg'];

interface RenderJob {
  proc: ChildProcess | null;
  running: boolean;
  progress: number;
  log: string[];
  out?: string;
  error?: string;
  startedAt: number;
  /** bundling | rendering | joining | still | done | cancelled */
  phase?: string;
  /** frames rendered / to render, and when the first frame landed (for the ETA) */
  done?: number;
  total?: number;
  renderStartedAt?: number;
  finishedAt?: number;
  summary?: string;
  opts?: Record<string, unknown>;
  cancelled?: boolean;
}
let job: RenderJob | null = null;

function api(): Plugin {
  const readBody = (req: any) =>
    new Promise<string>((res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c));
      req.on('end', () => res(b));
    });
  const send = (res: any, code: number, body: unknown) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const story = storyApi(ROOT, PROJECT);
  return {
    name: 'mvgen-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/')) return next();
        try {
          const u = new URL(url, 'http://x');
          const json = async () => JSON.parse((await readBody(req)) || '{}');
          if (await story(req, res, u, json, send)) return;
          if (url === '/api/info') {
            const audio = fs.readdirSync(PROJECT).filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()));
            return send(res, 200, { dir: PROJECT, name: path.basename(PROJECT), audio, hasProject: fs.existsSync(PROJECT_FILE) });
          }
          if (url === '/api/project' && req.method === 'GET') {
            if (!fs.existsSync(PROJECT_FILE)) return send(res, 404, { error: 'no project' });
            res.setHeader('content-type', 'application/json');
            return res.end(fs.readFileSync(PROJECT_FILE));
          }
          if (url === '/api/project' && req.method === 'PUT') {
            const body = await readBody(req);
            JSON.parse(body); // validate
            if (fs.existsSync(PROJECT_FILE)) {
              // rolling backups, at most one per minute, keep 40
              const bdir = path.join(WORK, 'backups');
              fs.mkdirSync(bdir, { recursive: true });
              const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
              const bfile = path.join(bdir, `project-${stamp}.json`);
              if (!fs.existsSync(bfile)) fs.copyFileSync(PROJECT_FILE, bfile);
              const all = fs.readdirSync(bdir).sort();
              all.slice(0, Math.max(0, all.length - 40)).forEach((f) => fs.unlinkSync(path.join(bdir, f)));
            }
            fs.writeFileSync(PROJECT_FILE + '.tmp', body);
            fs.renameSync(PROJECT_FILE + '.tmp', PROJECT_FILE);
            return send(res, 200, { ok: true });
          }
          if (url === '/api/media') {
            const f = path.join(WORK, 'media.json');
            return send(res, 200, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { media: [] });
          }
          if (url === '/api/render' && req.method === 'GET') {
            if (!job) return send(res, 200, { running: false });
            const { proc, ...rest } = job;
            return send(res, 200, { ...rest, log: rest.log.slice(-200) });
          }
          if (url === '/api/render/files' && req.method === 'GET') {
            const dir = path.join(PROJECT, 'out');
            const files = fs.existsSync(dir)
              ? fs.readdirSync(dir).filter((f) => /\.(mp4|png)$/i.test(f)).map((f) => {
                  const st = fs.statSync(path.join(dir, f));
                  return { name: f, path: path.join(dir, f), size: st.size, mtime: st.mtimeMs };
                }).sort((a, b) => b.mtime - a.mtime).slice(0, 30)
              : [];
            return send(res, 200, { dir, files });
          }
          if (url === '/api/render' && req.method === 'POST') {
            if (job?.running) return send(res, 409, { error: 'render already running' });
            const opts = JSON.parse((await readBody(req)) || '{}');
            const args = [path.join(ROOT, 'scripts', 'render.mjs'), PROJECT];
            if (opts.draft) args.push('--draft');
            if (opts.preview) args.push('--preview');
            if (opts.procs) args.push('--procs', String(opts.procs));
            if (opts.priority) args.push('--priority', String(opts.priority));
            if (opts.crf) args.push('--crf', String(opts.crf));
            if (opts.from != null) args.push('--from', String(opts.from));
            if (opts.to != null) args.push('--to', String(opts.to));
            if (opts.still) args.push('--still', '--at', String(opts.at ?? 0));
            const proc = spawn(process.execPath, args, { cwd: ROOT });
            const j: RenderJob = { proc, running: true, progress: 0, log: [], startedAt: Date.now(), opts, phase: opts.still ? 'still' : 'bundling' };
            job = j;
            const onData = (d: Buffer) => {
              for (const line of d.toString().split(/\r?\n/)) {
                const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
                if (!clean) continue;
                const m = clean.match(/Rendered (\d+)\/(\d+)/) || clean.match(/Encoded (\d+)\/(\d+)/);
                if (m) {
                  j.progress = Number(m[1]) / Number(m[2]);
                  j.done = Number(m[1]);
                  j.total = Number(m[2]);
                  if (j.done > 0 && !j.renderStartedAt) j.renderStartedAt = Date.now();
                }
                const ph = clean.match(/^phase: (\w+)$/);
                if (ph) j.phase = ph[1];
                const sm = clean.match(/^\d+ frames in \d+s .*/);
                if (sm) j.summary = sm[0];
                const w = clean.match(/^wrote (.+)$/);
                if (w) j.out = w[1];
                j.log.push(clean);
                if (j.log.length > 400) j.log.splice(0, 200);
              }
            };
            proc.stdout.on('data', onData);
            proc.stderr.on('data', onData);
            proc.on('exit', (code) => {
              j.running = false;
              j.proc = null;
              j.finishedAt = Date.now();
              if (code !== 0 && !j.cancelled) j.error = `render exited with code ${code}`;
              j.phase = j.cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed';
            });
            return send(res, 200, { ok: true });
          }
          if (url === '/api/render' && req.method === 'DELETE') {
            const pid = job?.proc?.pid;
            if (job) job.cancelled = true;
            // the render spawns headless browsers + ffmpeg: take the whole tree down, not just node
            if (pid && process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
            else job?.proc?.kill();
            return send(res, 200, { ok: true });
          }
          send(res, 404, { error: 'unknown endpoint' });
        } catch (e: any) {
          send(res, 500, { error: String(e?.message ?? e), runId: e?.runId });
        }
      });
    },
  };
}

export default defineConfig({
  root: path.join(ROOT, 'src', 'editor'),
  publicDir: PROJECT,
  plugins: [react(), api()],
  server: { port: Number(process.env.MV_PORT ?? 5190), strictPort: false },
  optimizeDeps: { include: ['react', 'react-dom', 'remotion', '@remotion/player', 'immer'] },
});

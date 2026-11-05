// Render a project with Remotion.
// usage:
//   npm run render -- <projectDir> [--out out/video.mp4] [--from 30 --to 45] [--draft | --preview] [--scale 0.5]
//                      [--procs auto|N] [--concurrency 1] [--crf 18]
//   npm run still  -- <projectDir> --at 62.5 [--out out/still.png]
//
// Video renders are split into contiguous frame chunks, one render process (headless browser) per chunk, then
// joined with ffmpeg. Remotion's own parallelism hands frames to its tabs out of order, which makes feedback-trail
// layers re-simulate their warm-up history for every frame; contiguous chunks keep them at one draw per frame.
//   --procs        parallel chunks (default auto = logical cores - 1, max 8)
//   --concurrency  tabs per chunk (default 1 - more only helps projects without feedback layers)
//   --priority     idle | belownormal | normal | abovenormal - CPU priority of the whole render (default normal)
//   --preview      quarter-res generators, half-size output, proxies: for checking timing/looks fast
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { projectDir, flag, run, ROOT, WORK, PROJECT_FILE } from './lib.mjs';

const dir = projectDir();
const projectPath = path.join(dir, PROJECT_FILE);
if (!fs.existsSync(projectPath)) throw new Error(`No ${PROJECT_FILE} in ${dir} — open the editor first (npm run edit -- "${dir}")`);
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
const media = JSON.parse(fs.readFileSync(path.join(dir, WORK, 'media.json'), 'utf8')).media;
{
  const have = new Set(media.map((m) => m.id));
  const missing = project.layers.filter((l) => l.enabled && l.media && !have.has(l.media));
  if (missing.length) console.warn(`warning: ${missing.length} layer(s) use media that isn't downloaded and will be blank: ${[...new Set(missing.map((l) => l.media))].join(', ')}`);
}

const preview = !!flag('preview');
const draft = !!flag('draft') || preview;
const still = !!flag('still');
const props = {
  project, media, assetBase: null, useProxies: draft,
  renderScale: preview ? 0.25 : draft ? 0.5 : 1,
  maskScale: preview ? 0.25 : draft ? 0.35 : 0.5,
};
const propsPath = path.join(dir, WORK, 'render-props.json');
fs.writeFileSync(propsPath, JSON.stringify(props));

// ---- CPU priority ----------------------------------------------------------------------------------
// Children inherit the priority class on Windows, but Chromium re-assigns its own processes, so besides setting ours
// we sweep our whole process tree every few seconds (browsers, compositor, ffmpeg).
const PRI = {
  idle: os.constants.priority.PRIORITY_LOW,
  belownormal: os.constants.priority.PRIORITY_BELOW_NORMAL,
  normal: os.constants.priority.PRIORITY_NORMAL,
  abovenormal: os.constants.priority.PRIORITY_ABOVE_NORMAL,
};
const priName = String(flag('priority') ?? 'normal').toLowerCase().replace(/[^a-z]/g, '');
if (!(priName in PRI)) throw new Error(`--priority must be one of ${Object.keys(PRI).join(', ')}`);
const setPri = (pid) => { try { os.setPriority(pid, PRI[priName]); } catch { /* process already gone / protected */ } };
if (priName !== 'normal') {
  setPri(process.pid);
  console.log(`CPU priority: ${priName}`);
  let sweeping = false;
  const sweep = () => {
    if (sweeping) return;
    sweeping = true;
    const done = () => { sweeping = false; };
    if (process.platform === 'win32') {
      execFile('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }'], { windowsHide: true }, (err, stdout) => {
        if (!err) applyTree(stdout.split(/\r?\n/).map((l) => l.split(',').map(Number)).filter((p) => p.length === 2 && !p.some(Number.isNaN)));
        done();
      });
    } else {
      execFile('ps', ['-A', '-o', 'pid=,ppid='], (err, stdout) => {
        if (!err) applyTree(stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((p) => p.length === 2 && !p.some(Number.isNaN)));
        done();
      });
    }
  };
  const applyTree = (pairs) => {
    const kids = new Map();
    for (const [pid, ppid] of pairs) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(pid);
    const stack = [process.pid];
    while (stack.length) for (const k of kids.get(stack.pop()) ?? []) { setPri(k); stack.push(k); }
  };
  setInterval(sweep, 4000).unref();
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const base = (project.name || 'mv').replace(/[^\w-]+/g, '_');
const suffix = preview ? '-preview' : draft ? '-draft' : '';
const out = path.resolve(dir, flag('out') || (still ? `out/${base}-still.png` : `out/${base}${suffix}-${stamp}.mp4`));
fs.mkdirSync(path.dirname(out), { recursive: true });
const fps = project.fps;

if (still) {
  const args = ['remotion', 'still', 'src/remotion/index.ts', 'MV', out, `--props=${propsPath}`, `--public-dir=${dir}`, `--frame=${Math.round(Number(flag('at') ?? 0) * fps)}`];
  if (flag('scale')) args.push(`--scale=${flag('scale')}`);
  console.log(`> npx ${args.join(' ')}`);
  await run('npx', args.map((a) => (/\s/.test(a) ? `"${a}"` : a)), { cwd: ROOT });
  console.log(`\nwrote ${out}`);
  process.exit(0);
}

// ---- video: parallel contiguous chunks ---------------------------------------------------------------
const total = Math.ceil(project.duration * fps);
const from = flag('from'), to = flag('to');
const a = from !== undefined ? Math.max(0, Math.round(Number(from) * fps)) : 0;
const b = to !== undefined ? Math.min(total - 1, Math.round(Number(to) * fps) - 1) : total - 1;
if (!(b >= a)) throw new Error(`empty frame range ${a}-${b}`);
const n = b - a + 1;

const auto = Math.min(8, Math.max(1, os.cpus().length - 1));
const wanted = flag('procs') && flag('procs') !== 'auto' ? Math.max(1, Math.round(Number(flag('procs')))) : auto;
const procs = Math.max(1, Math.min(wanted, Math.floor(n / 60) || 1)); // not worth a browser for < 2 s of frames
const size = Math.ceil(n / procs);
const chunks = Array.from({ length: procs }, (_, i) => [a + i * size, Math.min(b, a + (i + 1) * size - 1)]).filter(([s, e]) => e >= s);
const crf = Number(flag('crf') ?? (preview ? 30 : draft ? 26 : 16));
const scale = flag('scale') ? Number(flag('scale')) : preview ? 0.5 : 1;
const tabs = Math.max(1, Math.round(Number(flag('concurrency') ?? 1)));

// leftovers of a cancelled render
for (const d of fs.readdirSync(path.join(dir, WORK))) if (d.startsWith('render-chunks-')) fs.rmSync(path.join(dir, WORK, d), { recursive: true, force: true });

console.log('phase: bundling');
const { bundle } = await import('@remotion/bundler');
const { renderMedia, selectComposition, makeCancelSignal } = await import('@remotion/renderer');

console.log(`${n} frames (${a}-${b}) in ${chunks.length} chunk(s) × ${tabs} tab(s), ${preview ? 'preview' : draft ? 'draft' : 'final'}, crf ${crf}${scale !== 1 ? `, scale ${scale}` : ''}`);
const t0 = Date.now();
let lastPct = -1;
const serveUrl = await bundle({
  entryPoint: path.join(ROOT, 'src/remotion/index.ts'),
  publicDir: dir,
  onProgress: (p) => { if (p % 25 === 0 && p !== lastPct) { lastPct = p; console.log(`Bundling ${p}%`); } },
});
const chromiumOptions = { gl: 'angle' };
const composition = await selectComposition({ serveUrl, id: 'MV', inputProps: props, chromiumOptions });

const tmp = path.join(dir, WORK, `render-chunks-${stamp}`);
fs.mkdirSync(tmp, { recursive: true });
const files = chunks.map((_, i) => path.join(tmp, `chunk-${String(i).padStart(2, '0')}.mp4`));
const done = chunks.map(() => 0);
const { cancel, cancelSignal } = makeCancelSignal();
console.log('phase: rendering');
const tick = setInterval(() => console.log(`Rendered ${Math.min(n, done.reduce((x, y) => x + y, 0))}/${n}`), 1000);

try {
  await Promise.all(chunks.map(([s, e], i) =>
    renderMedia({
      composition, serveUrl, inputProps: props, chromiumOptions, cancelSignal,
      codec: 'h264', crf, muted: true, scale, overwrite: true,
      imageFormat: 'jpeg', jpegQuality: 92,
      frameRange: [s, e], concurrency: tabs,
      outputLocation: files[i],
      onProgress: ({ renderedFrames }) => { done[i] = renderedFrames; },
    }).catch((err) => { cancel(); throw err; }),
  ));
} finally {
  clearInterval(tick);
}
console.log(`Rendered ${n}/${n}`);

// ---- join the chunks + the audio slice ------------------------------------------------------------
const list = path.join(tmp, 'list.txt');
fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
const audioFile = project.audio ? path.resolve(dir, project.audio) : null;
const hasAudio = !!audioFile && fs.existsSync(audioFile);
const ff = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list];
if (hasAudio) ff.push('-ss', String(a / fps), '-t', String(n / fps), '-i', audioFile, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '320k', '-shortest');
ff.push('-c:v', 'copy', '-movflags', '+faststart', out);
console.log('phase: joining');
console.log('Joining chunks…');
await new Promise((res, rej) => spawn('ffmpeg', ff, { stdio: 'inherit' }).on('exit', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
fs.rmSync(tmp, { recursive: true, force: true });

const secs = (Date.now() - t0) / 1000;
console.log(`${n} frames in ${secs.toFixed(0)}s (${(n / secs).toFixed(1)} fps, ${chunks.length} chunks)`);
console.log(`\nwrote ${out}`);
process.exit(0);

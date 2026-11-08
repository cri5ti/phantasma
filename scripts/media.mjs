// Scan a project folder for footage/images, write _phantasma/media.json and build preview proxies.
// usage: npm run media -- <projectDir> [--no-proxies] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { projectDir, flag, walk, probe, slug, VIDEO_EXT, IMAGE_EXT, WORK } from './lib.mjs';

const dir = projectDir();
const work = path.join(dir, WORK);
fs.mkdirSync(path.join(work, 'proxies'), { recursive: true });

const files = walk(dir).filter((f) => [...VIDEO_EXT, ...IMAGE_EXT].includes(path.extname(f).toLowerCase()));
const media = [];
const used = new Set();
for (const f of files) {
  const kind = VIDEO_EXT.includes(path.extname(f).toLowerCase()) ? 'video' : 'image';
  let id = slug(path.basename(f));
  while (used.has(id)) id += '-x';
  used.add(id);
  const info = probe(path.join(dir, f));
  const item = { id, kind, src: f, ...info };
  if (kind === 'video') item.proxy = `${WORK}/proxies/${id}.mp4`;
  media.push(item);
  console.log(`${kind.padEnd(5)} ${info.width}x${info.height} ${info.duration.toFixed(2)}s  ${f}`);
}
fs.writeFileSync(path.join(work, 'media.json'), JSON.stringify({ media }, null, 2));
console.log(`wrote ${WORK}/media.json (${media.length} items)`);

// Thumbnails for the editor's media picker
fs.mkdirSync(path.join(work, 'thumbs'), { recursive: true });
for (const m of media) {
  const out = path.join(work, 'thumbs', `${m.id}.jpg`);
  m.thumb = `${WORK}/thumbs/${m.id}.jpg`;
  if (fs.existsSync(out) && !flag('force')) continue;
  const at = m.kind === 'video' ? ['-ss', String(Math.min(1, m.duration / 2))] : [];
  await new Promise((res) => spawn('ffmpeg', ['-y', '-v', 'error', ...at, '-i', path.join(dir, m.src), '-frames:v', '1', '-vf', 'scale=320:-2', out]).on('exit', res));
}
fs.writeFileSync(path.join(work, 'media.json'), JSON.stringify({ media }, null, 2));

if (flag('no-proxies')) process.exit(0);

// Proxies: small, all-keyframe-ish H.264 so the editor scrubs instantly. Renders use the originals.
const force = !!flag('force');
const jobs = media.filter((m) => m.kind === 'video' && (force || !fs.existsSync(path.join(dir, m.proxy))));
const conc = 3;
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const m = jobs[next++];
    const out = path.join(dir, m.proxy);
    const scale = m.width >= m.height ? 'scale=960:-2' : 'scale=-2:960';
    await new Promise((res) => {
      const p = spawn('ffmpeg', ['-y', '-v', 'error', '-i', path.join(dir, m.src), '-vf', `${scale},fps=30`, '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '6', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out + '.tmp.mp4']);
      p.stderr.on('data', (d) => process.stderr.write(d));
      p.on('exit', (code) => {
        if (code === 0) fs.renameSync(out + '.tmp.mp4', out);
        console.log(`${code === 0 ? 'proxy ok ' : 'proxy FAIL'} ${m.id}`);
        res();
      });
    });
  }
}
await Promise.all(Array.from({ length: conc }, worker));

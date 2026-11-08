import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AUDIO_EXT = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg'];
export const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'];
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export const WORK = '_phantasma';
export const PROJECT_FILE = 'mv.project.json';

/** Project dir = first non-flag CLI arg, else $MV_PROJECT, else cwd. */
export function projectDir(argv = process.argv.slice(2)) {
  const arg = argv.find((a) => !a.startsWith('--'));
  const dir = path.resolve(arg ?? process.env.MV_PROJECT ?? process.cwd());
  if (!fs.existsSync(dir)) throw new Error(`Project dir not found: ${dir}`);
  return dir;
}

export function flag(name, argv = process.argv.slice(2)) {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = argv[i];
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

export function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === WORK || e.name === 'node_modules' || e.name === 'out') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}

export function findAudio(dir) {
  return walk(dir).find((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()));
}

export function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const [n, d] = (v?.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    duration: Number(j.format.duration ?? 0),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: d ? n / d : 0,
    hasAudio: j.streams.some((s) => s.codec_type === 'audio'),
  };
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    // Without a shell, args are passed verbatim; on Windows (shell) they must be quoted.
    const argv = win ? args.map((a) => `"${a}"`) : args;
    const p = spawn(cmd, argv, { stdio: 'inherit', shell: win, ...opts });
    const desc = `${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
    p.on('error', (err) =>
      reject(new Error(err.code === 'ENOENT'
        ? `Could not start "${cmd}": not found on PATH. Is it installed / is the right environment active?`
        : `Could not start "${cmd}": ${err.message}`)));
    p.on('exit', (code, signal) => {
      if (code === 0) return resolve();
      const why = signal ? `was killed by ${signal}` : `failed with exit code ${code}`;
      reject(new Error(`Command ${why}:\n  ${desc}\n(see output above for details)`));
    });
  });
}

export function slug(s) {
  return s.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).toLowerCase();
}

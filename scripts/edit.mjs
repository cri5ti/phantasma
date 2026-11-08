// Open the editor for a project folder. Runs analysis / media scan first when missing.
// usage: npm run edit -- <projectDir> [--port 5190] [--reanalyze]
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { projectDir, flag, findAudio, run, ROOT, WORK } from './lib.mjs';

const dir = projectDir();
const work = path.join(dir, WORK);

if (flag('reanalyze') || !fs.existsSync(path.join(work, 'analysis.json'))) {
  const audio = findAudio(dir);
  if (!audio) throw new Error(`No audio file found in ${dir}`);
  console.log(`Analysing ${audio} …`);
  await run('python', [path.join(ROOT, 'analyze', 'analyze.py'), path.join(dir, audio), work]);
}
if (!fs.existsSync(path.join(work, 'media.json'))) {
  console.log('Scanning media and building proxies …');
  await run('node', [path.join(ROOT, 'scripts', 'media.mjs'), dir]);
}

process.env.MV_PROJECT = dir;
if (flag('port')) process.env.MV_PORT = String(flag('port'));
const server = await createServer({ configFile: path.join(ROOT, 'vite.config.ts') });
await server.listen();
server.printUrls();
console.log(`\nProject: ${dir}`);

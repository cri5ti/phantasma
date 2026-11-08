// Re-run audio analysis for a project folder.
// usage: npm run analyze -- <projectDir> [--audio file.wav]
import path from 'node:path';
import { projectDir, flag, findAudio, run, ROOT, WORK } from './lib.mjs';

const dir = projectDir();
const audio = flag('audio') || findAudio(dir);
if (!audio) throw new Error(`No audio file found in ${dir}`);
await run('python', [path.join(ROOT, 'analyze', 'analyze.py'), path.resolve(dir, audio), path.join(dir, WORK)]);

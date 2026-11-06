// Lyrics timing jobs. Each one is logged as a run in the AI log (_phantasma/ai-log) so progress is visible live.
//   transcribe  OpenAI whisper-1, per-word timestamps (MV_TRANSCRIBE_MODEL to override)
//   separate    local Demucs vocal stem → _phantasma/lyrics/vocals.wav (better transcripts + alignment)
//   refine      local forced alignment of the lyric words (torchaudio MMS_FA) → precise word boundaries
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import OpenAI from 'openai';
import type { AiLog, AiRun } from './aiLog';

const AUDIO_EXT = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg'];

export function lyricsApi(root: string, project: string, ai: AiLog) {
  const dir = path.join(project, '_phantasma', 'lyrics');
  const f = (n: string) => path.join(dir, n);
  const songFile = () => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(project, 'mv.project.json'), 'utf8'));
      if (p.audio && fs.existsSync(path.join(project, p.audio))) return path.join(project, p.audio);
    } catch { /* fall through */ }
    const a = fs.readdirSync(project).find((x) => AUDIO_EXT.includes(path.extname(x).toLowerCase()));
    if (!a) throw new Error('no audio file in the project folder');
    return path.join(project, a);
  };
  let busy: string | null = null;

  const tools = () => {
    // no shell: on Windows cmd.exe would mangle the inline script's quotes
    const r = spawnSync('python', ['-c', 'import importlib.util as u;print(",".join(m for m in ["demucs","torchaudio"] if u.find_spec(m)))'], { encoding: 'utf8' });
    const have = new Set((r.stdout ?? '').trim().split(',').filter(Boolean));
    return {
      openai: !!process.env.OPENAI_API_KEY,
      transcribeModel: process.env.MV_TRANSCRIBE_MODEL || 'whisper-1',
      python: r.status === 0,
      demucs: have.has('demucs'),
      torchaudio: have.has('torchaudio'),
      install: 'pip install torchaudio==2.8.0 demucs --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple',
      vocals: fs.existsSync(f('vocals.wav')),
      transcript: fs.existsSync(f('transcript.json')),
      busy,
    };
  };

  /** spawn a long local job; stdout/stderr lines become (throttled) run events */
  const runPy = (run: AiRun, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn('python', args, { cwd: root });
      let last = 0;
      const onLine = (d: Buffer) => {
        for (const raw of d.toString().split(/\r|\n/)) {
          const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (!line) continue;
          const now = Date.now();
          const pct = line.match(/(\d{1,3})%\|/);
          if (pct && now - last < 2000) continue; // tqdm bars: keep a readable rate
          last = now;
          ai.event(run, pct ? `progress ${pct[1]}%` : line.slice(0, 300));
        }
      };
      p.stdout.on('data', onLine);
      p.stderr.on('data', onLine);
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`python exited with code ${code}`))));
    });

  /** run a job in the background; the client follows its run in the AI log */
  const background = (kind: string, model: string, describe: string, job: (run: AiRun) => Promise<unknown>, provider = 'local') => {
    if (busy) throw new Error(`another lyrics job is running (${busy})`);
    fs.mkdirSync(dir, { recursive: true });
    const run = ai.start(kind, provider, model, '', describe);
    busy = kind;
    job(run)
      .then((r) => { run.text = JSON.stringify(r ?? {}, null, 1).slice(0, 200_000); ai.finish(run); })
      .catch((e) => ai.finish(run, e))
      .finally(() => { busy = null; });
    return run.id;
  };

  const transcribe = async (run: AiRun, o: { useVocals?: boolean; prompt?: string; language?: string }) => {
    const model = process.env.MV_TRANSCRIBE_MODEL || 'whisper-1';
    const src = o.useVocals && fs.existsSync(f('vocals.wav')) ? f('vocals.wav') : songFile();
    const mp3 = f('asr-input.mp3');
    ai.event(run, `encoding ${path.basename(src)} → mono 16 kHz mp3 (API upload limit is 25 MB)`);
    await new Promise<void>((res, rej) => {
      const p = spawn('ffmpeg', ['-y', '-v', 'error', '-i', src, '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3]);
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
    });
    ai.event(run, `uploading ${(fs.statSync(mp3).size / 1e6).toFixed(1)} MB to ${model} (word + segment timestamps)`);
    const client = new OpenAI();
    const r: any = await client.audio.transcriptions.create({
      file: fs.createReadStream(mp3),
      model,
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
      // the lyrics as a spelling hint (whisper reads ~224 tokens of prompt)
      ...(o.prompt ? { prompt: o.prompt.slice(0, 800) } : {}),
      ...(o.language ? { language: o.language } : {}),
    });
    const out = {
      model, at: new Date().toISOString(), source: path.basename(src), language: r.language, duration: r.duration, text: r.text,
      words: (r.words ?? []).map((w: any) => ({ word: w.word, start: w.start, end: w.end })),
      segments: (r.segments ?? []).map((s: any) => ({ start: s.start, end: s.end, text: s.text })),
    };
    fs.writeFileSync(f('transcript.json'), JSON.stringify(out, null, 1));
    ai.event(run, `transcript: ${out.words.length} words, ${out.segments.length} segments, language ${out.language ?? '?'}`);
    run.servedBy = model;
    return out;
  };

  return async (req: any, res: any, url: URL, body: () => Promise<any>, send: (res: any, code: number, b: unknown) => void): Promise<boolean> => {
    const p = url.pathname;
    if (p === '/api/lyrics/tools') { send(res, 200, tools()); return true; }
    if (p === '/api/lyrics/transcript') {
      if (!fs.existsSync(f('transcript.json'))) { send(res, 404, { error: 'no transcript yet' }); return true; }
      res.setHeader('content-type', 'application/json');
      res.end(fs.readFileSync(f('transcript.json')));
      return true;
    }
    if (p === '/api/lyrics/transcribe' && req.method === 'POST') {
      const o = await body();
      if (!process.env.OPENAI_API_KEY) throw new Error('set OPENAI_API_KEY in phantasma/.env (transcription uses OpenAI whisper-1)');
      const id = background('transcribe', process.env.MV_TRANSCRIBE_MODEL || 'whisper-1', `transcribe${o.useVocals ? ' (vocal stem)' : ''}${o.prompt ? `

lyrics hint:
${o.prompt.slice(0, 800)}` : ''}`, (run) => transcribe(run, o), 'openai');
      send(res, 200, { runId: id });
      return true;
    }
    if (p === '/api/lyrics/separate' && req.method === 'POST') {
      if (!tools().demucs) throw new Error(`demucs is not installed — ${tools().install}`);
      const song = songFile();
      const id = background('separate-vocals', 'demucs htdemucs', `vocal stem of ${path.basename(song)}`, async (run) => {
        const out = f('demucs');
        ai.event(run, 'separating vocals on the CPU (first run downloads the htdemucs model, ~80 MB; a 4-5 min song takes a few minutes)');
        await runPy(run, ['-m', 'demucs', '--two-stems', 'vocals', '-n', 'htdemucs', '-o', out, song]);
        const stem = path.join(out, 'htdemucs', path.parse(song).name, 'vocals.wav');
        if (!fs.existsSync(stem)) throw new Error(`demucs finished but ${stem} is missing`);
        fs.copyFileSync(stem, f('vocals.wav'));
        return { vocals: '_phantasma/lyrics/vocals.wav' };
      });
      send(res, 200, { runId: id });
      return true;
    }
    if (p === '/api/lyrics/refine' && req.method === 'POST') {
      const { lines } = await body(); // [{ words: string[], t0, t1 }]
      if (!tools().torchaudio) throw new Error(`torchaudio is not installed — ${tools().install}`);
      const audio = fs.existsSync(f('vocals.wav')) ? f('vocals.wav') : songFile();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f('refine-in.json'), JSON.stringify({ audio, lines }));
      const id = background('refine-words', 'torchaudio MMS_FA', `forced alignment of ${lines.length} line(s) on ${path.basename(audio)}`, async (run) => {
        ai.event(run, fs.existsSync(f('vocals.wav')) ? 'using the vocal stem' : 'no vocal stem — aligning on the full mix (run “Isolate vocals” first for tighter timing)');
        await runPy(run, [path.join(root, 'analyze', 'align.py'), f('refine-in.json'), f('refine-out.json')]);
        return JSON.parse(fs.readFileSync(f('refine-out.json'), 'utf8'));
      });
      send(res, 200, { runId: id });
      return true;
    }
    if (p === '/api/lyrics/refined') {
      if (!fs.existsSync(f('refine-out.json'))) { send(res, 404, { error: 'no refined timings yet' }); return true; }
      res.setHeader('content-type', 'application/json');
      res.end(fs.readFileSync(f('refine-out.json')));
      return true;
    }
    return false;
  };
}

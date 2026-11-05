// Brief tab block: get word-timed lyrics (transcribe → align to the text above → optional local refine).
import React, { useEffect, useState } from 'react';
import { alignStored, lyricsToBrief, lyricsTools, refineTiming, separateVocals, transcribe, type LyricsTools } from './lyricsActions';
import { store, useStore } from './store';

export const LyricsSync: React.FC = () => {
  const lyrics = useStore((s) => s.project.lyrics);
  const busy = useStore((s) => s.busy);
  const [tools, setTools] = useState<LyricsTools | null>(null);
  const [useVocals, setUseVocals] = useState(true);
  const [lang, setLang] = useState('');
  const running = !!busy && !busy.startsWith('⚠');
  useEffect(() => { lyricsTools().then(setTools).catch(() => {}); }, [busy]);

  const words = lyrics?.lines.reduce((n, l) => n + l.words.length, 0) ?? 0;
  const count = (src: string) => lyrics?.lines.reduce((n, l) => n + l.words.filter((w) => (w.src ?? 'asr') === src).length, 0) ?? 0;
  const loadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => store.editSB((d) => { d.brief.lyrics = t; }));
    e.target.value = '';
  };

  return (
    <div className="lyrsync">
      <div className="row">
        <b>Word timing</b>
        <span className="grow" />
        <label className="btnlike" title="load lyrics from a .txt or .lrc file into the box above">Load .txt/.lrc…<input type="file" accept=".txt,.lrc,text/plain" onChange={loadFile} hidden /></label>
      </div>
      <div className="btns">
        <button className="accent" disabled={running || !tools?.openai} onClick={() => transcribe({ useVocals, language: lang || undefined })}
          title={`${tools?.transcribeModel ?? 'whisper-1'} transcribes the ${useVocals && tools?.vocals ? 'vocal stem' : 'song'} with per-word timestamps, then your lyrics above are aligned to it (your words and line breaks win; the transcript only gives timing)`}>
          🎤 Transcribe + align
        </button>
        <button disabled={running || !tools?.transcript} onClick={() => alignStored()} title="re-align the saved transcript to the lyrics above — no API call; use after fixing the lyrics text">⇄ Re-align</button>
        <button disabled={running || !tools?.demucs} onClick={() => separateVocals()} title={tools?.demucs ? 'local Demucs vocal stem (a few minutes on CPU) — cleaner transcripts and much tighter alignment' : `needs demucs: ${tools?.install}`}>
          Isolate vocals{tools?.vocals ? ' ✓' : ''}
        </button>
        <button disabled={running || !tools?.torchaudio || !words} onClick={() => refineTiming()} title={tools?.torchaudio ? 'local forced alignment of every word (torchaudio MMS_FA) inside its line — precise word boundaries; hand-edited words are kept' : `needs torchaudio: ${tools?.install}`}>
          ⌖ Refine timing
        </button>
        <button disabled={!words} onClick={lyricsToBrief} title="write the timed lines into the lyrics box as LRC, so the storyboard AI plans against real timings">→ LRC</button>
      </div>
      <div className="row">
        <label className="chk" title="transcribe the isolated vocal stem when one exists"><input type="checkbox" checked={useVocals} onChange={(e) => setUseVocals(e.target.checked)} /> use vocal stem</label>
        <input value={lang} onChange={(e) => setLang(e.target.value)} placeholder="lang (en)" style={{ width: 70 }} title="ISO language code — optional, helps Whisper" />
      </div>
      {lyrics?.lines.length ? (
        <div className="dim">
          {lyrics.lines.length} lines · {words} words —{' '}
          <span className="lw asr">{count('asr')} transcript</span> · <span className="lw interp">{count('interp')} guessed</span> · <span className="lw aligned">{count('aligned')} refined</span> · <span className="lw manual">{count('manual')} hand-set</span>
          {lyrics.source?.model ? <> · {lyrics.source.model}</> : null}
        </div>
      ) : (
        <div className="hint">Paste or load the lyrics above, then Transcribe + align. The Lyrics lane appears on the timeline: lines, ▸ expands to words. Drag words to move, edges to trim, dbl-click to fix text, Alt+←/→ nudges.</div>
      )}
      {tools && (!tools.demucs || !tools.torchaudio) ? (
        <details className="hint">
          <summary>Precise local timing (optional)</summary>
          Vocal isolation and forced alignment run locally and need two Python packages ({[!tools.demucs && 'demucs', !tools.torchaudio && 'torchaudio'].filter(Boolean).join(', ')} missing):
          <pre className="mono">{tools.install}</pre>
        </details>
      ) : null}
    </div>
  );
};

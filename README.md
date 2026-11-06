# phantasma — music video generator

Audio-reactive visualizers + stock footage, composited with blend modes and masks, edited in a timeline UI, and
rendered with [Remotion](https://www.remotion.dev/). An optional AI storyboard stage (Claude or OpenAI) turns a song,
its lyrics and a brief into a shot list, finds matching stock footage, and builds the timeline for you.

## Features

- **Timeline editor** in the browser: layers, keyframes, audio-driven modulation, blend modes, masks, clipping.
- **Audio analysis** (librosa): bands, onsets, beats, sections, tempo candidates, with an editable tempo map.
- **Generators**: visualizers, GLSL shaders, shapes, particles, word-timed lyrics, trails/feedback.
- **AI storyboard** (optional): idea board, shot planning, Pexels / Pixabay stock search and download.
- **Word-timed lyrics** via Whisper transcription + alignment (optional local Demucs/MMS_FA refinement).
- **Deterministic rendering**: everything is a pure function of time, so scrubbing and parallel renders match exactly.

## Requirements

- Node.js 22+
- Python 3 with `librosa` (`pip install librosa`)
- `ffmpeg` on your PATH
- Optional API keys (see below) for the storyboard, lyric transcription and stock footage

## Install

```
git clone https://github.com/cri5ti/phantasma.git
cd phantasma
npm install
cp .env.example .env      # then add whichever keys you want
```

API keys go in `phantasma/.env` or in a song folder's own `.env`; shell variables take precedence.
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` power the storyboard AI, `OPENAI_API_KEY` also powers lyric transcription,
and `PEXELS_API_KEY` / `PIXABAY_API_KEY` enable stock search. All are optional: the editor and renderer work without them.
Keys are only read locally and sent to the respective provider; never commit your `.env`.

## Per-video workflow

A *project* is just a folder with a song and footage (any sub-folders):

```
my-video/
  song.wav
  stock/*.mp4
  mv.project.json      ← the script (created/edited by the editor)
  _phantasma/              ← analysis, proxies, thumbs, backups (generated)
  out/                 ← renders
```

From the `phantasma/` folder (on Windows use **PowerShell**; Remotion's compositor can fail to spawn from Git Bash):

```powershell
npm run edit   -- "..\my-video"                 # analyses audio + builds proxies on first run, opens http://localhost:5190
npm run render -- "..\my-video"                 # final render (originals, full-res)
npm run render -- "..\my-video" --draft         # fast: proxies + half-res generators
npm run render -- "..\my-video" --from 60 --to 75
npm run still  -- "..\my-video" --at 62.5
npm run media  -- "..\my-video"                 # re-scan after adding footage (--force rebuilds proxies)
npm run analyze -- "..\my-video"                # re-run audio analysis
```

## Storyboard stage

Toggle **Storyboard / Edit** in the top bar (or **Tab**). Everything is saved in `mv.project.json` under `storyboard`
(undoable, per song folder). Put API keys in `phantasma/.env` or the song folder's `.env` (see `.env.example`).

1. **Brief & AI** — director prompt, look & style, lyrics (plain or LRC `[mm:ss.xx]`). Pick Claude or OpenAI.
   - **✦ Suggest ideas** → AI idea cards on the board (tagged, with model/time provenance).
   - **▦ Plan storyboard** → a shot list over the whole song, built from the tempo sections (energy, bar length),
     lyrics, pinned board ideas, local footage and the generator list; cuts snap to bar lines.
     **↻ Re-plan In→Out** (I/O keys) or **↻ AI** on a shot redoes just that window.
   - **⬚ Fetch thumbnails** searches each shot's query (Pexels / Pixabay; Mixkit has no public API — stub) and picks
     a distinct first hit. **⬇ Download picks** saves them to `stock/<provider>-<id>.mp4`, logs attribution in
     `stock/credits.json`, then rescans media + builds proxies. **Build timeline →** replaces the storyboard-built
     layers (`layer.shot`) with fresh ones — crossfades overlap, dips fade through black, short clips are slowed to fit,
     generator shots become generator layers. Your other layers are left alone.
2. **Storyboard lane** in the timeline: picked thumbs as a filmstrip. Drag edges (shared boundaries move together),
   double-click or **S** to split, **Delete** to merge into the neighbour, drop a board card / stock thumb on a shot.
3. **Preview**: the player shows the picked thumbs with the planned transitions + caption/lyric over the render
   (transport: `thumbs`, `motion` = stream the preview clips).
4. **Shot** tab: edit description/query/lyric/tags/transition, browse + search candidates, pin to board.
5. **Idea board**: free canvas (drag to pan, wheel to zoom), notes, lyric-line cards, stock and local footage cards,
   tag chips to filter, 🔍 on an idea searches stock around it, ⠿ handle drags a card onto a timeline shot.

## Lyrics timing & cues

- **Word-timed lyrics** (Brief & AI tab → Word timing): paste or *Load .txt/.lrc*, then **🎤 Transcribe + align** —
  OpenAI `whisper-1` (per-word timestamps; `MV_TRANSCRIBE_MODEL` to override) transcribes the song, then your text is
  aligned to it word by word: your words and line breaks win, the transcript supplies timing, missed words are
  interpolated (shown hatched). **⇄ Re-align** reuses the saved transcript (`_phantasma/lyrics/transcript.json`) after you
  fix the text — no API call. **→ LRC** writes the timed lines back into the brief for the storyboard AI.
- **Precise timing (local, optional):** *Isolate vocals* (Demucs) and *⌖ Refine timing* (torchaudio MMS_FA forced
  alignment per line, `analyze/align.py`) — needs
  `pip install torchaudio==2.8.0 demucs --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple`.
- **Lyrics lane** on the timeline: lines; ▸ expands to words. Drag a word to move it, its edges to trim, dbl-click to
  retype (several words split the slot), Alt+←/→ nudges 10 ms (Shift 50 ms), Delete removes. Drag a line to move all of
  it. Lyrics edits are precise by default — hold Shift to snap to beats/cues.
- **Cues:** right-click anywhere on the timeline → add a cue at that exact time (or on the nearest beat / at the
  playhead); right-click near a cue to rename, move to playhead or remove. **C** adds one at the playhead, drag cue
  flags in the ruler (Shift snaps), `[` / `]` jump between cues, sections and markers. Cues are snap targets.
- Every transcription / separation / alignment run is in the **AI log** with its events.

## Concepts

- **Tempo map** (`project.tempo`): sections with bpm + downbeat anchor. Seeded from analysis, fix it in the editor
  (click the coloured strip; tap tempo with **T**; ×2 / ÷2 / ×⅔ buttons; detected alternates). Beat/bar modulation,
  snapping and the beat lamp all follow it.
- **Layers** (bottom → top): `video`, `image`, or `gen` (any generator). Each has start/end, fades, blend mode,
  transform/filter params, masks, and optional **clip to below** (Photoshop clipping mask).
- **Params** are constants or animated: `{ "$k": [{t, v, e}], "$mod": [{src, amount, release, curve, gate}] }`.
  Keyframes use absolute song time. Modulation sources: `rms bass mid high onset centroid beat bar lfo sectionProgress layerProgress`.
- **Masks** reuse generators (shape, text, gradient, even visualizers) as alpha or luminance, combined add/subtract/intersect, with feather + invert.

## Generators: trails, lyrics, particles

- **Trails** (any generator, *Trails* group): `echo` re-draws the generator N times per frame; `feedback` keeps a
  low-res history buffer and each frame transforms it (FB zoom / rotate / drift / blur / hue), fades it (FB keep) and
  lays the new frame on top — one draw per frame. Out-of-order frames (scrubbing, Remotion's parallel tabs) catch up
  from the stored state or warm up over the last *FB warm-up* frames, so renders stay consistent. Measured on a 90-frame
  nebula shader render: ~3 s faster than 12 echoes (both serial and parallel); for very cheap generators the two are close.
- **Lyrics** (Text): renders the word-timed lyrics — `line`, `word`, `build` (line builds word by word), `focus`
  (karaoke: sung word highlighted). Per-part in/out effects (fade, blur, rise, drop, zoom, pop, slide, typewriter),
  continuous motion (float, wave, shake, beat pulse, sway), stroke / glow / shadow / subtitle box, *Only section* filter.
  Presets: Karaoke, Subtitles, Word punch, Build-up, Dreamy, Typewriter.
- **Particles**: deterministic (closed-form per particle, scrub-exact). Emitters (area, edges, point, ring), rate +
  bursts on beats/bars, gravity / wind / drag / turbulence / sway / spin, 10 shapes, colour over life, twinkle, blend.
  Presets: Rain, Snow, Dust, Stars, Smoke, Leaves, Embers, Bokeh, Confetti, Fireflies, Beat burst — in *＋ Generator*
  and the Inspector's *Preset* menu (keeps the layer's transform/look).

## Adding a visualizer

Write a `GenDef` (`src/gen/types.ts`): `params` (schema → inspector UI) and `draw(ctx, p, f)` drawing in stage units
(`f.W × f.H`) using `f.audio` (`bands`, `bars`, `scalar`, `wave`, `integral`) and `f.beat`. Register it in
`src/gen/registry.ts`. For GLSL, use `shaderGen()` in `src/gen/shaders.ts` — number/color params become `u_<key>` uniforms.
Keep `draw` a pure function of time so scrubbing and parallel rendering stay exact.

## Layout

```
analyze/analyze.py   audio features (60 Hz bands/scalars/waveform), beats, sections, tempo candidates
src/core             schema, keyframes/modulation, audio data, tempo grid, project factories
src/gen              generators: visualizers, shaders, shapes/text/fills
src/comp             Remotion composition: layers, blending, masks, clipping
src/remotion         Remotion entry
src/editor           React editor (Vite) — player, timeline, inspector, storyboard panel/board/overlay
server               editor API add-ons: LLM (Claude / OpenAI), stock providers + download queue
scripts              edit / render / media / analyze CLIs
```

## Credits & licensing of footage

Downloaded stock clips keep their provider's license (Pexels / Pixabay); attribution is logged in `stock/credits.json`
in your project. Check the provider terms before publishing a video.

## License

[MIT](LICENSE)

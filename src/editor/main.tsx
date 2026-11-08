import React from 'react';
import { createRoot } from 'react-dom/client';
import { loadAnalysis } from '../core/audio';
import { emptyProject, newGenLayer, tempoFromAnalysis } from '../core/project';
import type { MediaItem, Project } from '../core/types';
import { App } from './App';
import { linkDownloaded } from './storyActions';
import { initStore } from './store';
import { applyView, loadView, startViewSync } from './viewState';
import './styles.css';

const enc = (p: string) => '/' + p.split('/').map(encodeURIComponent).join('/');

// ctrl/cmd+wheel (and trackpad pinch) belongs to the timeline/board zoom, never the browser's page zoom.
window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });

async function boot() {
  const root = createRoot(document.getElementById('root')!);
  root.render(<div className="boot">loading…</div>);
  const info = await (await fetch('/api/info')).json();
  const media: MediaItem[] = (await (await fetch('/api/media')).json()).media;
  const audio = await loadAnalysis((f) => enc(`_phantasma/${f}`)).catch((e) => {
    console.error(e);
    return null;
  });

  let project: Project;
  let fresh = false;
  const r = await fetch('/api/project');
  if (r.ok) {
    project = await r.json();
    // the song arrived after a lyrics-first start: attach it (analysis ran on startup)
    if (!project.audio && info.audio[0] && audio) {
      project.audio = info.audio[0];
      project.duration = Math.floor(audio.duration * 100) / 100;
      project.tempo = tempoFromAnalysis(audio.meta);
      fresh = true;
    }
  } else {
    fresh = true;
    const dur = audio ? Math.floor(audio.duration * 100) / 100 : 60;
    project = emptyProject(info.name, info.audio[0] ?? '', dur);
    if (audio) project.tempo = tempoFromAnalysis(audio.meta);
    project.layers.push(newGenLayer('nebula', 0, dur, 'Background'), newGenLayer('spectrum', 0, dur, 'Spectrum'));
  }
  const store = initStore(project);
  store.set({ media, audio, zoom: Math.max(2, (window.innerWidth - 260) / project.duration) });
  linkDownloaded(media);
  if (fresh) store.save();
  document.title = `${project.name} — phantasma`;
  // last view of this project folder (URL fragment wins over localStorage)
  const view = loadView(info.dir, info.name);
  applyView(view);
  root.render(<App />);
  startViewSync();
}

boot().catch((e) => {
  document.getElementById('root')!.innerHTML = `<pre style="color:#f66;padding:20px">${String(e?.stack ?? e)}</pre>`;
});

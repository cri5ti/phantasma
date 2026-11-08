#!/usr/bin/env node
// Fetch the CMU Pronouncing Dictionary and write a compact JSON table for the lyric metrics.
//   node scripts/cmudict.mjs            → data/cmudict.json  ({ word: "HH AH0 L OW1" }, first pronunciation only)
// Source: https://github.com/cmusphinx/cmudict (cmudict.dict, ~3.6 MB, BSD-style licence — see the repo's LICENSE).
// Without it the editor falls back to a built-in word list + letter-to-sound rules (counts marked as estimated).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict';
const OUT = path.join(ROOT, 'data', 'cmudict.json');

const res = await fetch(URL_);
if (!res.ok) { console.error(`download failed: ${res.status} ${res.statusText}`); process.exit(1); }
const text = await res.text();
const dict = {};
let n = 0;
for (const line of text.split('\n')) {
  const t = line.replace(/#.*$/, '').trim();
  if (!t) continue;
  const sp = t.indexOf(' ');
  const word = t.slice(0, sp);
  if (/\(\d+\)$/.test(word)) continue; // alternative pronunciations: keep the first
  // same normalisation as phonetics.ts normWord: lowercase, letters and digits only
  const key = word.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]/g, '');
  if (!key || dict[key]) continue;
  dict[key] = t.slice(sp + 1).trim();
  n++;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(dict));
console.log(`wrote ${n} words → ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);

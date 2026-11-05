import { SHADERS } from './shaders';
import { SHAPES } from './shapes';
import type { GenDef } from './types';
import { VISUALIZERS } from './visualizers';
import { lyricsGen } from './lyricsText';
import { particles } from './particles';

// To add a visualizer: write a GenDef (params + draw) and append it here. The editor picks it up automatically.
export const GENERATORS: GenDef[] = [...VISUALIZERS, ...SHADERS, ...SHAPES, lyricsGen, particles];

const byId = new Map(GENERATORS.map((g) => [g.id, g]));

export function getGen(id: string | undefined): GenDef | undefined {
  return id ? byId.get(id) : undefined;
}

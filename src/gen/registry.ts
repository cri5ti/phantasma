import { SHADERS } from './shaders';
import { SHAPES } from './shapes';
import type { GenDef } from './types';
import { VISUALIZERS } from './visualizers';
import { lyricsGen } from './lyricsText';
import { particles } from './particles';
import { imageGen } from './image';
import { isSceneId, sceneGen } from './scene';

// To add a visualizer: write a GenDef (params + draw) and append it here. The editor picks it up automatically.
// Scene layers ("scene:<file>") are GLSL files in the project folder, resolved on demand (see scene.ts).
export const GENERATORS: GenDef[] = [...VISUALIZERS, ...SHADERS, ...SHAPES, imageGen, lyricsGen, particles];

const byId = new Map(GENERATORS.map((g) => [g.id, g]));

export function getGen(id: string | undefined): GenDef | undefined {
  if (isSceneId(id)) return sceneGen(id);
  return id ? byId.get(id) : undefined;
}

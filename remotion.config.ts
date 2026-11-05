import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(92);
// WebGL generators need a GPU-ish backend in headless Chrome
Config.setChromiumOpenGlRenderer('angle');
Config.setOverwriteOutput(true);

import React from 'react';
import { Composition } from 'remotion';
import { MV, type MVProps } from '../comp/MV';
import { emptyProject } from '../core/project';

export const Root: React.FC = () => (
  <Composition
    id="MV"
    component={MV}
    defaultProps={{ project: emptyProject('untitled', ''), media: [], assetBase: null } as MVProps}
    calculateMetadata={({ props }) => ({
      fps: props.project.fps,
      width: props.project.width,
      height: props.project.height,
      durationInFrames: Math.max(1, Math.ceil(props.project.duration * props.project.fps)),
    })}
    durationInFrames={1}
    fps={30}
    width={1920}
    height={1080}
  />
);

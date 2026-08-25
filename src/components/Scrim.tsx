import React from 'react';
import {StyleSheet, useWindowDimensions} from 'react-native';
import {Canvas, LinearGradient, Rect, vec} from '@shopify/react-native-skia';

// Bottom-weighted scrim over the blurred album art.
//
// The first attempt at this was two flat Views — a light one over the whole
// frame and a heavier one over the bottom 62% — on the assumption that at this
// blur radius the boundary would not read. On the TV it read as a hard
// horizontal line straight across the picture, because the seam is a step in
// ALPHA and blurring the art underneath does nothing to soften it.
//
// So draw an actual gradient. Skia is already a dependency, so this costs
// nothing: no react-native-linear-gradient, no new native module. Four stops
// rather than two, because a straight linear ramp from clear to dark dims the
// middle of the cover more than it needs to — the art should stay bright until
// it reaches the metadata.
export default function Scrim() {
  const {height} = useWindowDimensions();

  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      <Rect x={0} y={0} width={10000} height={height}>
        <LinearGradient
          start={vec(0, 0)}
          end={vec(0, height)}
          colors={[
            'rgba(0,0,0,0.30)',
            'rgba(0,0,0,0.26)',
            'rgba(0,0,0,0.55)',
            'rgba(0,0,0,0.78)',
          ]}
          positions={[0, 0.42, 0.74, 1]}
        />
      </Rect>
    </Canvas>
  );
}

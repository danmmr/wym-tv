import React, {useEffect, useState, useMemo} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  NativeModules,
} from 'react-native';
import {
  BlurMask,
  Canvas,
  Circle,
  Fill,
  Group,
  Image as SkiaImage,
  Paint,
  Path,
  Shader,
  Skia,
} from '@shopify/react-native-skia';
import type {SkImage} from '@shopify/react-native-skia';
import ReAnimated, {
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';
import {usePlayerStore} from '../store/playerStore';

const {width, height} = Dimensions.get('window');

// The full-screen SkSL shaders are GPU fill-rate bound on the Fire Stick's Mali
// GPU - at native 1080p (~2.07M px) the spiral tunnel runs ~35fps and reads as
// jerky. We render the background visualizer into a smaller canvas and let the
// GPU upscale it at composite time (a cheap bilinear blit, NOT a re-raster), so
// the shader only runs over ~0.92M px. Measured: locked 60fps. The continuous
// sin/cos fields are indistinguishable upscaled. Album art + clock are separate
// full-res canvases, so they stay crisp. uv is normalized by resolution.y, so
// the look is identical at any DOWNSCALE.
const DOWNSCALE = 1.5; // 1920x1080 -> 1280x720 backing
const LOW_W = Math.round(width / DOWNSCALE);
const LOW_H = Math.round(height / DOWNSCALE);

const PLASMA_SRC = `
uniform float2 resolution;
uniform float  time;
uniform float  colorShift;
uniform float  density;
uniform float  pulse;

half4 main(float2 fragCoord) {
  float aspect = resolution.x / resolution.y;
  float x = (fragCoord.x / resolution.x - 0.5) * aspect * 8.0;
  float y = (fragCoord.y / resolution.y - 0.5) * 8.0;

  float d = density + pulse * 0.35;

  float v  = sin(x * d          + time * 1.10);
  v       += sin(y * d * 0.80   + time * 0.85);
  v       += sin((x * 0.55 + y * 0.83) * d + time * 0.70);
  v       += sin(sqrt(x * x + y * y + 0.001) * d * 1.05 - time * 0.50);
  float n  = v * 0.25 + 0.5;

  float hue = fract(n * 1.5 + colorShift);
  // Blue/purple/magenta palette - green channel capped low so no yellow or green appear
  float r = 0.20 + 0.22 * cos(6.2832 * (hue + 0.00));
  float g = 0.08 + 0.08 * cos(6.2832 * (hue + 0.30));
  float b = 0.30 + 0.28 * cos(6.2832 * (hue + 0.60));

  float bright = 0.85 + pulse * 0.15;
  return half4(r * bright, g * bright, b * bright, 1.0);
}
`;

const PLASMA_EFFECT = Skia.RuntimeEffect.Make(PLASMA_SRC);

// Flow: domain-warped gradient. Smoothest visualizer - all motion is soft sine
// warping with no hard edges or tight rings, so it never shimmers or snaps.
const FLOW_SRC = `
uniform float2 resolution;
uniform float  time;
uniform float  colorShift;
uniform float  density;
uniform float  pulse;

half4 main(float2 fragCoord) {
  float2 uv = fragCoord / resolution;
  float aspect = resolution.x / resolution.y;
  float2 p = (uv - 0.5) * float2(aspect, 1.0) * 3.0;

  float t = time * 0.25;
  float amp = 0.55 + (density - 0.7) * 0.25;

  // Two layers of domain warp - each coordinate is bent by the previous layer
  float2 q = p;
  q.x += amp * sin(p.y * 1.3 + t);
  q.y += amp * sin(p.x * 1.1 - t * 0.9);
  float2 r = q;
  r.x += (amp * 0.7) * sin(q.y * 1.7 - t * 1.1);
  r.y += (amp * 0.7) * sin(q.x * 1.5 + t * 0.8);

  float field = 0.5 + 0.5 * sin(r.x + r.y + t * 0.5);
  field = mix(field, 0.5 + 0.5 * sin(length(r) * 1.1 + t), 0.35);

  float hue = fract(field * 0.6 + colorShift);
  // Same blue/purple/magenta palette as plasma - green capped low
  float cr = 0.20 + 0.22 * cos(6.2832 * (hue + 0.00));
  float cg = 0.08 + 0.08 * cos(6.2832 * (hue + 0.30));
  float cb = 0.30 + 0.28 * cos(6.2832 * (hue + 0.60));

  float bright = 0.85 + pulse * 0.15;
  return half4(cr * bright, cg * bright, cb * bright, 1.0);
}
`;

const FLOW_EFFECT = Skia.RuntimeEffect.Make(FLOW_SRC);

// Starfield / warp tunnel: polar coords with stars rushing inward toward the
// center. depth = time + 1/r so cells compress and accelerate near the middle.
// Each star fades in/out smoothly within its depth band (no popping), center
// speed is clamped (no strobing), and three layers break up the banding.
// Spiral tunnel: pure-sin spiral arms + rings scrolling inward, with sin-product
// "glints" that read as sparkles - NO per-pixel loop, so it runs at ~full fps
// (the 36-star loop version measured 12fps; this is plasma-class cost). Dark
// vanishing-point center hides the fast 1/r region.
const STARFIELD_SRC = `
uniform float2 resolution;
uniform float  time;
uniform float  colorShift;
uniform float  density;
uniform float  pulse;

half4 main(float2 fragCoord) {
  float2 uv = (fragCoord - 0.5 * resolution) / resolution.y;
  float pr = max(length(uv), 0.0001);
  float pa = atan(uv.y, uv.x);
  float t  = time * 1.5;

  // depth = 0.45/r + t : walls scroll inward (forward motion). 1/r blows up at
  // the center but the fade keeps that fast region dark = the vanishing point.
  float depth = 0.45 / pr + t;

  // Spiral arms + counter-arms + rings, all pure sin of continuous depth -> no
  // cells, no popping, smooth at any speed. NO per-pixel loop, so it stays cheap.
  float arms   = 0.5 + 0.5 * sin(pa * 5.0 + depth * 3.0);
  float detail = 0.5 + 0.5 * sin(pa * 9.0 - depth * 2.0);
  float rings  = 0.5 + 0.5 * sin(depth * 6.2832);

  // Glints: bright points where a spiral arm and a fast ring coincide - these
  // scroll down the tube and read as sparkles/stars, with no loop.
  float glint = pow(max(0.0, sin(pa * 5.0 + depth * 3.0) * sin(depth * 9.0)), 8.0);

  float fade = smoothstep(0.04, 0.45, pr);                  // dark center, lit rim
  float hue  = fract(colorShift + depth * 0.04);
  float3 wall = float3(
    0.20 + 0.24 * cos(6.2832 * (hue + 0.00)),
    0.08 + 0.09 * cos(6.2832 * (hue + 0.30)),
    0.32 + 0.30 * cos(6.2832 * (hue + 0.60)));

  float3 col = float3(0.02, 0.01, 0.05);
  col += wall * (0.25 + 0.5 * arms * detail + 0.3 * arms * rings) * fade;
  col += float3(0.80, 0.90, 1.0) * glint * fade;            // sparkles
  col += wall * 0.35 * smoothstep(0.5, 0.9, pr);            // rim brightening
  return half4(min(col, float3(1.0)), 1.0);
}
`;

const STARFIELD_EFFECT = Skia.RuntimeEffect.Make(STARFIELD_SRC);

// Metaball / lava lamp: sum of inverse-distance blobs drifting slowly (mostly
// vertical), thresholded into a smooth gooey surface.
const METABALL_SRC = `
uniform float2 resolution;
uniform float  time;
uniform float  colorShift;
uniform float  density;
uniform float  pulse;

half4 main(float2 fragCoord) {
  float2 uv = fragCoord / resolution;
  float aspect = resolution.x / resolution.y;
  float2 p = float2(uv.x * aspect, uv.y);
  float t = time * 0.2;

  float field = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float2 c = float2(
      0.5 * aspect + 0.35 * aspect * sin(t * 0.6 + fi * 1.7),
      0.5 + 0.42 * sin(t * 0.4 + fi * 2.3) * cos(t * 0.15 + fi)
    );
    float rad = 0.10 + 0.05 * sin(t + fi);
    float2 d = p - c;
    field += (rad * rad) / (dot(d, d) + 0.0008);
  }

  float thr = 1.0 + (density - 0.7) * 0.3;
  float m = smoothstep(thr - 0.4, thr + 0.6, field);

  float hue = fract(field * 0.15 + colorShift);
  float cr = 0.20 + 0.22 * cos(6.2832 * (hue + 0.00));
  float cg = 0.08 + 0.08 * cos(6.2832 * (hue + 0.30));
  float cb = 0.30 + 0.28 * cos(6.2832 * (hue + 0.60));
  float3 lava = float3(cr, cg, cb) * (0.9 + pulse * 0.2);
  float3 bg = float3(0.04, 0.02, 0.08);
  return half4(mix(bg, lava, m), 1.0);
}
`;

const METABALL_EFFECT = Skia.RuntimeEffect.Make(METABALL_SRC);

// Selectable background visualizers. Mapped to D-pad directions on the remote:
// LEFT=plasma, RIGHT=flow, UP=starfield, DOWN=metaball (see NowPlayingScreen).
export const VISUALIZERS = ['plasma', 'flow', 'starfield', 'metaball'] as const;
export type Visualizer = (typeof VISUALIZERS)[number];

const EFFECT_BY_VISUALIZER: Record<Visualizer, ReturnType<typeof Skia.RuntimeEffect.Make>> = {
  plasma: PLASMA_EFFECT,
  flow: FLOW_EFFECT,
  starfield: STARFIELD_EFFECT,
  metaball: METABALL_EFFECT,
};

const ART_SIZE = 180;
const ART_RADIUS = ART_SIZE / 2;
const PROGRESS_RING_R = ART_RADIUS + 14; // radius of the song-progress ring track

function makeCirclePath() {
  const path = Skia.Path.Make();
  path.addCircle(ART_RADIUS, ART_RADIUS, ART_RADIUS);
  return path;
}

// Screensaver frame cap. Everything animated here is slow and ambient (13-40s
// field drift, 17s/13s art orbit, beat-period ring decay) - 30fps is visually
// identical from the couch, and halving every canvas's redraw rate halves the
// screensaver's continuous CPU/GPU load and heat (the multi-hour
// throttle/lockup driver on the 1.7GB Fire Stick).
const SAVER_FPS = 30;

// Drop-in replacement for skia's useClock (shared value, ms) that only writes
// when the quantized frame advances. Derived values reading it - and the
// canvases they drive - therefore redraw at `fps` instead of every vsync.
// (Quantizing t inside a consumer worklet wouldn't help: a fresh derived value
// every frame still invalidates its canvas.) EVERY clock consumer in this file
// must use this, not useClock - one ungated 60fps canvas keeps the whole
// window presenting at 60.
function useCappedClock(fps: number) {
  const t = useSharedValue(0);
  const stepMs = 1000 / fps;
  useFrameCallback(info => {
    const q = Math.floor(info.timestamp / stepMs) * stepMs;
    if (q !== t.value) {
      t.value = q;
    }
  });
  return t;
}

function AlbumArt({uri, bpm, pulseEnabled, trackProgress, accent}: {uri: string; bpm: number; pulseEnabled: boolean; trackProgress: number; accent: string}) {
  const [img, setImg] = useState<SkImage | null>(null);
  const clock = useCappedClock(SAVER_FPS);
  const clipPath = useMemo(makeCirclePath, []);

  useEffect(() => {
    let cancelled = false;
    fetch(uri)
      .then(r => r.arrayBuffer())
      .then(buf => {
        if (cancelled) return;
        const data = Skia.Data.fromBytes(new Uint8Array(buf));
        setImg(Skia.Image.MakeImageFromEncoded(data));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [uri]);

  // Deterministically free each SkImage's native memory when it is replaced by
  // the next track's art (or on unmount). Skia images hold native/GPU memory
  // that JS GC only reclaims lazily; on the memory-constrained Fire Stick that
  // lag accumulates over hours of track changes until the device wedges. This
  // cleanup runs AFTER React has committed the new image to the canvas, so the
  // outgoing image is no longer drawn and is safe to dispose. See
  // [[project-wiimtv]] Skia notes.
  useEffect(() => {
    return () => {
      img?.dispose();
    };
  }, [img]);

  // Animated values run on the UI thread every frame via the reanimated clock.
  // Reading clock.value inside useDerivedValue is what makes the ring actually
  // pulse - computing it in the JS render body froze it at a single sample.
  const orbitX = useDerivedValue(() => {
    const t = clock.value / 1000;
    return ((Math.sin((2 * Math.PI * t) / 17) + 1) / 2) * (width - ART_SIZE - 120) + 60;
  }, [clock]);
  const orbitY = useDerivedValue(() => {
    const t = clock.value / 1000;
    return ((Math.cos((2 * Math.PI * t) / 13) + 1) / 2) * (height - ART_SIZE - 120) + 60;
  }, [clock]);
  const beat = useDerivedValue(() => {
    const t = clock.value / 1000;
    const beatPeriod = 60 / bpm;
    return Math.pow(1 - ((t % beatPeriod) / beatPeriod), 2);
  }, [clock, bpm]);

  const artTransform = useDerivedValue(() => [
    {translateX: orbitX.value},
    {translateY: orbitY.value},
  ]);
  const ringCx = useDerivedValue(() => orbitX.value + ART_RADIUS);
  const ringCy = useDerivedValue(() => orbitY.value + ART_RADIUS);
  const pm = pulseEnabled ? 1 : 0;
  const ringR = useDerivedValue(() => ART_RADIUS + 6 + beat.value * 10 * pm, [clock, bpm, pm]);
  const ringBlur = useDerivedValue(() => 18 + beat.value * 14 * pm, [clock, bpm, pm]);
  const ringOpacity = useDerivedValue(() => 0.25 + beat.value * 0.5 * pm, [clock, bpm, pm]);

  // Progress arc as an SVG path string — guarantees a bare arc with no
  // connecting lines to the center (addArc draws a pie sector on this Skia build).
  const progressArcPath = useMemo((): string => {
    const r = PROGRESS_RING_R;
    const cx = ART_RADIUS;
    const cy = ART_RADIUS;
    if (trackProgress >= 1) {
      // Full circle: two semicircles avoids the degenerate coincident-endpoint case
      return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r}`;
    }
    const sweep = trackProgress * 360;
    const startRad = -Math.PI / 2;          // 12 o'clock
    const endRad = startRad + (sweep * Math.PI) / 180;
    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy + r * Math.sin(endRad);
    const largeArc = sweep > 180 ? 1 : 0;
    // M = move to start (no drawn line); A = arc to end; no Z = open path
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
  }, [trackProgress]);

  if (!img) return null;

  return (
    <Canvas style={styles.canvas}>
      <Group>
        {pulseEnabled ? (
          /* Mode 1: beat-synced glow ring */
          <Circle cx={ringCx} cy={ringCy} r={ringR}>
            <Paint
              color={accent}
              style={(Skia as any).PaintStyle?.Stroke ?? 1}
              strokeWidth={22}
              opacity={ringOpacity}>
              <BlurMask style="normal" blur={ringBlur} respectCTM={true} />
            </Paint>
          </Circle>
        ) : (
          /* Mode 2: song-progress ring — fills clockwise, completes when song ends */
          <Group transform={artTransform}>
            {trackProgress > 0 && (
              <Path
                path={progressArcPath}
                color="rgba(255,255,255,0.45)"
                style={(Skia as any).PaintStyle?.Stroke ?? 1}
                strokeWidth={0.5}
              />
            )}
          </Group>
        )}
        <Group transform={artTransform} clip={clipPath}>
          <SkiaImage
            image={img}
            x={0}
            y={0}
            width={ART_SIZE}
            height={ART_SIZE}
            fit="cover"
          />
        </Group>
      </Group>
    </Canvas>
  );
}

function titleToBpm(title: string): number {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash + title.charCodeAt(i)) & 0xffffffff;
  }
  return 60 + (Math.abs(hash) % 80);
}

interface VisualProps {
  volume: number;
  trackProgress: number;
  bpm: number;
  visualizer: Visualizer;
}

function VisualizerCanvas({volume, trackProgress, bpm, visualizer}: VisualProps) {
  const clock = useCappedClock(SAVER_FPS);

  // Uniforms recompute on the UI thread each gated tick so the field keeps moving.
  const uniforms = useDerivedValue(() => {
    const t = clock.value / 1000;
    // Plasma and flow get layered incommensurate frequencies so speed feels
    // randomly variable - sometimes surging, sometimes dragging - with no
    // discernible period. Four terms at 26s/14.6s/62s/9.4s cycles whose
    // derivative magnitudes sum to 0.91 so the field never actually reverses.
    // Starfield and metaball keep the original 40s sinusoidal breath.
    let warpTime: number;
    if (visualizer === 'plasma' || visualizer === 'flow') {
      warpTime = t
        - (4.0 / Math.PI) * Math.cos((t * Math.PI) / 13.0)
        + (3.0 / Math.PI) * Math.sin((t * Math.PI) / 19.0)
        - (2.0 / Math.PI) * Math.cos((t * Math.PI) / 37.0)
        + (1.5 / Math.PI) * Math.sin((t * Math.PI) / 53.0);
    } else {
      warpTime = t - (8 / Math.PI) * Math.cos((t * Math.PI) / 20);
    }
    const beatPeriod = 60 / bpm;
    const beatPulse = Math.pow(1 - ((t % beatPeriod) / beatPeriod), 2);
    const density = 0.7 + (volume / 100) * 0.6 + beatPulse * 0.2;
    const colorShift = (trackProgress * 0.8 + t * 0.018) % 1;
    return {
      resolution: [LOW_W, LOW_H],
      time: warpTime,
      colorShift,
      density,
      pulse: beatPulse,
    };
  }, [bpm, volume, trackProgress, visualizer]);

  const effect = EFFECT_BY_VISUALIZER[visualizer] ?? PLASMA_EFFECT;
  if (!effect) {
    return null;
  }

  // Canvas backs at LOW_W x LOW_H; the scale transform blows it up to fill the
  // screen. translate re-centers it: a scale about the view center leaves the
  // center fixed, so we shift the (LOW_W x LOW_H) box so its scaled bounds land
  // exactly on (0,0)..(width,height).
  return (
    <Canvas style={styles.canvasLow}>
      <Fill>
        <Shader source={effect} uniforms={uniforms} />
      </Fill>
    </Canvas>
  );
}

function clockNow(): string {
  return new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

export interface ScreensaverProps {
  onExit: () => void;
  visualizer?: Visualizer;
  pulseEnabled?: boolean;
}

class ScreensaverErrorBoundary extends React.Component<
  {children: React.ReactNode},
  {error: Error | null}
> {
  state = {error: null as Error | null};

  static getDerivedStateFromError(error: Error) {
    return {error};
  }

  componentDidCatch(error: Error, info: any) {
    console.error('SCREENSAVER_CRASH:', error?.message, error?.stack, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      const e = this.state.error;
      return (
        <View style={styles.errBox}>
          <Text style={styles.errTitle}>Screensaver crashed</Text>
          <Text style={styles.errMsg}>{e.message}</Text>
          <Text style={styles.errStack} numberOfLines={20}>
            {e.stack}
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function ScreensaverWrapped(props: ScreensaverProps) {
  return (
    <ScreensaverErrorBoundary>
      <Screensaver {...props} />
    </ScreensaverErrorBoundary>
  );
}

function Screensaver({onExit, visualizer = 'plasma', pulseEnabled = true}: ScreensaverProps) {
  const {title, artist, albumArt, volume, currentPos, duration, accent} = usePlayerStore();
  const ringColor = accent || '#78a0ff';

  const clock = useCappedClock(SAVER_FPS);
  const [clockStr, setClockStr] = useState(clockNow);

  const trackProgress = duration > 0 ? Math.min(1, currentPos / duration) : 0;
  const bpm = titleToBpm(title || 'default');

  useEffect(() => {
    NativeModules.WakeControl?.keepAwake(true);
    return () => {
      NativeModules.WakeControl?.keepAwake(false);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setClockStr(clockNow()), 1000);
    return () => clearInterval(id);
  }, []);

  // Text drift off the capped clock, not RN Animated.loop - the native-driver
  // loop animated the transform every vsync, which alone kept the whole window
  // compositing at 60fps even with the canvases gated to SAVER_FPS. Same path
  // as before: 26s sine ping-pong along the diagonal (13s each way, in-out).
  const floatStyle = useAnimatedStyle(() => {
    const t = clock.value / 1000;
    const phase = (1 - Math.cos((2 * Math.PI * t) / 26)) / 2;
    return {
      transform: [
        {translateX: 40 + phase * (Math.max(40, width - 580) - 40)},
        {translateY: 60 + phase * (Math.max(100, height - 180) - 60)},
      ],
    };
  });

  return (
    <View style={styles.container}>
      <VisualizerCanvas
        volume={volume}
        trackProgress={trackProgress}
        bpm={bpm}
        visualizer={visualizer}
      />

      {!!albumArt && <AlbumArt uri={albumArt} bpm={bpm} pulseEnabled={pulseEnabled} trackProgress={trackProgress} accent={ringColor} />}

      {title ? (
        <ReAnimated.View style={[styles.floatBlock, floatStyle]}>
          <Text style={styles.trackTitle} numberOfLines={2}>
            {title}
          </Text>
          {!!artist && <Text style={styles.trackArtist}>{artist}</Text>}
        </ReAnimated.View>
      ) : (
        <View style={styles.clockContainer}>
          <Text style={styles.clockText}>{clockStr}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#050505', overflow: 'hidden'},
  canvas: {position: 'absolute', width, height},
  canvasLow: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: LOW_W,
    height: LOW_H,
    transform: [
      {translateX: (width - LOW_W) / 2},
      {translateY: (height - LOW_H) / 2},
      {scale: DOWNSCALE},
    ],
  },
  floatBlock: {position: 'absolute', top: 0, left: 0, maxWidth: 520},
  trackTitle: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: 'bold',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: {width: 0, height: 2},
    textShadowRadius: 8,
  },
  trackArtist: {
    color: '#cceeff',
    fontSize: 20,
    marginTop: 6,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 6,
  },
  clockContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  clockText: {
    color: 'rgba(255,255,255,0.80)',
    fontSize: 120,
    fontWeight: '100',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: {width: 0, height: 4},
    textShadowRadius: 24,
    letterSpacing: 8,
  },
  errBox: {
    flex: 1,
    backgroundColor: '#1a0000',
    padding: 40,
    justifyContent: 'center',
  },
  errTitle: {color: '#ff5555', fontSize: 32, fontWeight: 'bold', marginBottom: 16},
  errMsg: {color: '#ffaa55', fontSize: 22, marginBottom: 20},
  errStack: {color: '#cccccc', fontSize: 14, fontFamily: 'monospace'},
});

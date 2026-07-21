import React, {useEffect, useState, useMemo} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  NativeModules,
} from 'react-native';
import {
  Canvas,
  Fill,
  Group,
  Image as SkiaImage,
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

// The full-screen SkSL shaders run on the Fire Stick's Mali GPU. We render the
// background visualizer into a smaller canvas and let the GPU upscale it at
// composite time (a cheap bilinear blit, NOT a re-raster). Album art + clock are
// separate full-res canvases, so they stay crisp. uv is normalized by
// resolution.y, so the look is identical at any DOWNSCALE.
//
// 720p because native 1080p looks no different on this panel from across a
// room, and costs 2.25x the fill for it. Native IS affordable now (measured 6ms
// GPU against a 16.7ms budget at 60fps) — an earlier note here claimed it was
// not viable, based on a reading of 13 missed vsyncs and a 4950ms 90th
// percentile that turned out to be a one-off stall, not a fill-rate limit. So
// this is a "no benefit" call, not a "can't afford it" one.
//
// Note `width`/`height` are DP: the window is 960x540 dp on the 1080p panel
// (density 320, PixelRatio 2). So DOWNSCALE 1.5 gives a 640x360 dp canvas,
// which backs at 1280x720 physical pixels.
const DOWNSCALE = 1.5; // 640x360 dp canvas -> 1280x720 physical
const LOW_W = Math.round(width / DOWNSCALE);
const LOW_H = Math.round(height / DOWNSCALE);

// All four visualizers share one palette: a ramp between two endpoint colours,
// swept by whatever scalar field that visualizer computes. The endpoints arrive
// as uniforms so the ramp can follow the album art (see paletteFor).
const PALETTE_UNIFORMS = `
uniform float3 palLo;
uniform float3 palHi;
`;
const PALETTE_FN = `
float3 palette(float hue) {
  float t = 0.5 + 0.5 * cos(6.2832 * hue);
  return mix(palLo, palHi, t);
}

// Interleaved gradient noise — a hash with no sin/cos, so it costs almost
// nothing per pixel. Returns 0..1.
float ign(float2 p) {
  return fract(52.9829189 * fract(dot(p, float2(0.06711056, 0.00583715))));
}

// Per-pixel dither, added to the final colour, to soften gradient contouring.
//
// It does NOT remove the fine diagonal weave in the field. That weave was
// measured on a build from before the palette change and is present there too
// (in fact with a worse flat-run score), so it long predates album-accent
// theming. It is also invariant to DOWNSCALE — it looks the same at 1.0, 1.5
// and 2.0 — so it is not the upscale resample beat either. What the single-hue
// palette changed is only how VISIBLE it is: the old blue-to-red sweep had
// enough chroma contrast to pull the eye off it. Don't spend time re-testing
// resolutions or dither amplitudes on it; that ground is covered.
//
// Static (no time term) on purpose: a temporally varying dither shimmers, which
// would read as noise crawling over the field.
float3 dither(float2 fragCoord) {
  return float3((ign(fragCoord) - 0.5) * ${(3.0 / 255).toFixed(6)});
}
`;

// The screensaver palette is a ramp between two endpoints, swept by the field
// value. Both endpoints are built around the album accent's hue, so the field
// stays inside that album's colour family.
//
// Anchored on the ORIGINAL tuned look: hue ~273 (deep blue/purple) ramping to a
// brighter magenta. An earlier attempt rotated the old cosine palette in RGB,
// which held "one channel stays low" but not WHICH channel — a blue accent
// suppressed red and let green rise, so the field went blue/green. Building the
// endpoints in HSV keeps the ramp inside a narrow hue window instead.
const PAL_DEFAULT_HUE = 273;
const PAL_DEFAULT_SAT = 0.75;
const PAL_LO_HUE_OFFSET = -12; // deep end, slightly cooler than the accent
const PAL_HI_HUE_OFFSET = 20; // bright end, slightly warmer
const PAL_LO_VALUE = 0.14;
const PAL_HI_VALUE = 0.62;

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) { r = c; g = x; }
  else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; }
  else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; }
  else { r = c; b = x; }
  return [r + m, g + m, b + m];
}

// Hue and saturation of a #rrggbb string, or null if unparseable / grey.
function hsOf(hex: string): {h: number; s: number} | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.02) return null; // grey - no meaningful hue
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return {h, s: max > 0 ? d / max : 0};
}

// Palette endpoints for an accent colour. Falls back to the tuned original when
// there is no accent (nothing playing, or art that yielded no vibrant swatch).
function paletteFor(accent: string): {
  palLo: [number, number, number];
  palHi: [number, number, number];
} {
  const hs = hsOf(accent);
  const h = hs ? hs.h : PAL_DEFAULT_HUE;
  // Clamp saturation: a washed-out accent would give a grey field, a fully
  // saturated one would band on the TV's gradient handling.
  const s = hs ? Math.min(0.95, Math.max(0.55, hs.s)) : PAL_DEFAULT_SAT;
  return {
    palLo: hsvToRgb(h + PAL_LO_HUE_OFFSET, Math.min(1, s * 1.05), PAL_LO_VALUE),
    palHi: hsvToRgb(h + PAL_HI_HUE_OFFSET, s * 0.85, PAL_HI_VALUE),
  };
}

const PLASMA_SRC = `
uniform float2 resolution;
uniform float  time;
uniform float  colorShift;
uniform float  density;
uniform float  pulse;
${PALETTE_UNIFORMS}
${PALETTE_FN}
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
  float3 col = palette(hue);

  float bright = 0.85 + pulse * 0.15;
  return half4(half3(col * bright + dither(fragCoord)), 1.0);
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
${PALETTE_UNIFORMS}
${PALETTE_FN}
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
  float3 col = palette(hue);

  float bright = 0.85 + pulse * 0.15;
  return half4(half3(col * bright + dither(fragCoord)), 1.0);
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
${PALETTE_UNIFORMS}
${PALETTE_FN}
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
  // A very slow angular drift on the arms (constant rate, not a speed change) so
  // the tunnel's spiral never lines back up with where it was — same reason as
  // the metaball frequencies above.
  float arms   = 0.5 + 0.5 * sin(pa * 5.0 + depth * 3.0 + t * 0.0371);
  float detail = 0.5 + 0.5 * sin(pa * 9.0 - depth * 2.0 - t * 0.0237);
  float rings  = 0.5 + 0.5 * sin(depth * 6.2832);

  // Glints: bright points where a spiral arm and a fast ring coincide - these
  // scroll down the tube and read as sparkles/stars, with no loop.
  float glint = pow(max(0.0, sin(pa * 5.0 + depth * 3.0) * sin(depth * 9.0)), 8.0);

  float fade = smoothstep(0.04, 0.45, pr);                  // dark center, lit rim
  float hue  = fract(colorShift + depth * 0.04);
  float3 wall = palette(hue);

  float3 col = float3(0.02, 0.01, 0.05);
  col += wall * (0.25 + 0.5 * arms * detail + 0.3 * arms * rings) * fade;
  col += float3(0.80, 0.90, 1.0) * glint * fade;            // sparkles
  col += wall * 0.35 * smoothstep(0.5, 0.9, pr);            // rim brightening
  return half4(min(col + dither(fragCoord), float3(1.0)), 1.0);
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
${PALETTE_UNIFORMS}
${PALETTE_FN}
half4 main(float2 fragCoord) {
  float2 uv = fragCoord / resolution;
  float aspect = resolution.x / resolution.y;
  float2 p = float2(uv.x * aspect, uv.y);
  // 0.45, up from 0.20. The blobs were slow enough to look stalled once the
  // variable-speed breathing was removed and could no longer carry them.
  float t = time * 0.45;

  float field = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    // Incommensurate frequencies (irrational ratios), so the blobs never all
    // return to their starting arrangement at once. With the round numbers this
    // used to use (0.6 / 0.4 / 0.15 / 1.0) the whole configuration recurred on a
    // fixed cycle and visibly "started over" — the variable-speed breathing that
    // was removed had been smearing that boundary and hiding it.
    float2 c = float2(
      0.5 * aspect + 0.35 * aspect * sin(t * 0.6131 + fi * 1.7),
      0.5 + 0.42 * sin(t * 0.4373 + fi * 2.3) * cos(t * 0.1597 + fi)
    );
    float rad = 0.10 + 0.05 * sin(t * 0.9283 + fi);
    float2 d = p - c;
    field += (rad * rad) / (dot(d, d) + 0.0008);
  }

  float thr = 1.0 + (density - 0.7) * 0.3;
  float m = smoothstep(thr - 0.4, thr + 0.6, field);

  float hue = fract(field * 0.15 + colorShift);
  float3 lava = palette(hue) * (0.9 + pulse * 0.2);
  float3 bg = float3(0.04, 0.02, 0.08);
  return half4(mix(bg, lava, m) + dither(fragCoord), 1.0);
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
// 60. Measured with a single canvas at 720p: 156 frames/5s (an exact, evenly
// paced 30) with 0 missed vsyncs and a GPU time of 4ms against a 33ms budget —
// so at 30 the hardware was idle 88% of the time and the warp tunnel STILL read
// as sluggish. Nothing was struggling; 30 is simply too low a sample rate for
// fast motion. Going to 60 takes the GPU duty cycle from ~12% to ~24%, which is
// nowhere near the load that caused the original lockups (58% CPU sustained,
// before both the half-res canvas and the cap existed).
const SAVER_FPS = 60;

// Drop-in replacement for skia's useClock (shared value, ms) that only writes
// when the quantized frame advances. Derived values reading it - and the
// canvases they drive - therefore redraw at `fps` instead of every vsync.
// (Quantizing t inside a consumer worklet wouldn't help: a fresh derived value
// every frame still invalidates its canvas.) EVERY clock consumer in this file
// must use this, not useClock - one ungated 60fps canvas keeps the whole
// window presenting at 60.
function useCappedClock(fps: number) {
  const t = useSharedValue(0); // published, ms — what consumers read
  const acc = useSharedValue(0); // accumulator, advanced every frame
  const n = useSharedValue(0);
  const every = Math.max(1, Math.round(60 / fps));
  useFrameCallback(info => {
    // ACCUMULATE elapsed time rather than reading a clock off `info`. Both
    // obvious choices are wrong here:
    //
    //   info.timestamp           — absolute, so it never restarts, but it is
    //                              milliseconds since a far-off origin. /1000
    //                              lands where float32 (the `time` uniform in
    //                              SkSL) has ~7 significant digits, so motion
    //                              quantises into visible steps and sin() of a
    //                              large argument degrades badly. This is what
    //                              made the whole screensaver look sluggish and
    //                              put a fixed weave over the field.
    //
    //   info.timeSinceFirstFrame — small, but measured from THIS frame
    //                              callback's registration. If the callback is
    //                              ever re-created it restarts at zero, and
    //                              every animation on this clock snaps back to
    //                              its start at the same instant.
    //
    // Summing per-frame deltas into a shared value gives both properties: the
    // accumulator persists across re-renders and re-registration, and it starts
    // at zero so it stays precise in float32 for hours.
    const dt = info.timeSincePreviousFrame ?? 0;
    // A re-registered callback reports a null or very large first delta; skip
    // it rather than jumping the clock forward.
    acc.value = acc.value + (dt > 0 && dt < 100 ? dt : 0);

    // Gate on vsync COUNT, not a millisecond grid: flooring onto a 33.3ms grid
    // while vsync ticks every ~16.67ms advanced the clock 2 vsyncs apart, then
    // 3, then 2 — an exact average with uneven spacing, which reads as stutter.
    n.value = n.value + 1;
    if (n.value >= every) {
      n.value = 0;
      t.value = acc.value;
    }
  });
  return t;
}

function AlbumArt({uri, showProgressRing, trackProgress, accent}: {uri: string; showProgressRing: boolean; trackProgress: number; accent: string}) {
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
  // Wandering orbit. The periods are deliberately NOT round numbers: 17s and
  // 13s are both integers, so that Lissajous closed every 221s and the art
  // snapped back to exactly where it started — visible as the drift "getting
  // pulled back" when the loop ended. Incommensurate periods never close, so it
  // keeps exploring. Each axis also carries a small faster term, which fills the
  // interior of the box instead of tracing the same thin figure repeatedly.
  const orbitX = useDerivedValue(() => {
    const t = clock.value / 1000;
    const u =
      (Math.sin((2 * Math.PI * t) / 17.0) +
        0.22 * Math.sin((2 * Math.PI * t) / 6.7331)) /
      1.22;
    return ((u + 1) / 2) * (width - ART_SIZE - 120) + 60;
  }, [clock]);
  const orbitY = useDerivedValue(() => {
    const t = clock.value / 1000;
    const u =
      (Math.cos((2 * Math.PI * t) / 12.7913) +
        0.22 * Math.cos((2 * Math.PI * t) / 5.3187)) /
      1.22;
    return ((u + 1) / 2) * (height - ART_SIZE - 120) + 60;
  }, [clock]);
  const artTransform = useDerivedValue(() => [
    {translateX: orbitX.value},
    {translateY: orbitY.value},
  ]);
  const ringCx = useDerivedValue(() => orbitX.value + ART_RADIUS);
  const ringCy = useDerivedValue(() => orbitY.value + ART_RADIUS);

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
        {/* The art carries NO ring by default. There used to be a beat-synced
            glow here, but a ring throbbing to a BPM guessed from the track
            title is noise, not information. The progress ring below is the only
            ring, and it is opt-in — see showProgressRing. */}
        {showProgressRing && (
          /* Song-progress ring — fills clockwise, completes when the song ends */
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
  accent: string;
}

function VisualizerCanvas({
  volume,
  trackProgress,
  bpm,
  visualizer,
  accent,
}: VisualProps) {
  const clock = useCappedClock(SAVER_FPS);

  // Derived once per accent change, NOT per frame — this is plain JS trig and
  // the uniforms worklet runs 30x a second.
  const {palLo, palHi} = useMemo(() => paletteFor(accent), [accent]);

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
      // Starfield (warp) and metaball breathe, but gently. warpTime =
      // t - (A/P_pi) * cos(t*pi/P) has speed 1 + (A/P)*sin(...), so the old
      // A=8, P=20 swung the rate +/-40% — enough that a tunnel rushing at you
      // read as stuttering rather than as organic variation. A=3 is +/-15%:
      // present, but not something you catch yourself watching.
      warpTime = t - (3.0 / Math.PI) * Math.cos((t * Math.PI) / 20);
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
      palLo,
      palHi,
    };
  }, [bpm, volume, trackProgress, visualizer, palLo, palHi]);

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
  showProgressRing?: boolean;
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

function Screensaver({onExit, visualizer = 'plasma', showProgressRing = false}: ScreensaverProps) {
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
    // Independent, incommensurate axes rather than one shared phase. A single
    // 26s ping-pong walked the same diagonal line out and back forever; giving
    // x and y their own non-closing periods makes the text wander the screen.
    const px = (Math.sin((2 * Math.PI * t) / 23.0) + 1) / 2;
    const py = (Math.cos((2 * Math.PI * t) / 17.4291) + 1) / 2;
    return {
      transform: [
        {translateX: 40 + px * (Math.max(40, width - 580) - 40)},
        {translateY: 60 + py * (Math.max(100, height - 180) - 60)},
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
        accent={ringColor}
      />

      {!!albumArt && <AlbumArt uri={albumArt} showProgressRing={showProgressRing} trackProgress={trackProgress} accent={ringColor} />}

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

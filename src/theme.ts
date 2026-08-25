// Design tokens for the player UI. Follows the house style of config/display.ts:
// plain exported consts, each with the reason it is the value it is.
//
// These are DESCRIPTIVE, not aspirational — every colour and size here was
// lifted from a value already in use across the six screens, so adopting the
// module is a no-op visually and the diffs stay reviewable. The point is that
// `#3b9eff` / `#0a0a0a` / `#333` were retyped in six places, which is why the
// art-derived accent from useAccentColor.ts was only ever half-threaded: the
// literals could not follow the music.
//
// NOTE the same Metro trap documented in config/display.ts applies: do not add
// a `theme.json` beside this file. sourceExts resolves json BEFORE ts, so it
// would shadow this module in a release build while jest kept passing.

import {DEFAULT_ACCENT} from './hooks/useAccentColor';

export const color = {
  // Near-black rather than #000: the Fire Stick's panel shows banding on true
  // black behind the blurred-art background.
  bg: '#0a0a0a',
  // Focused-control fill, from the old volumeButtonFocused/footerBtnFocused.
  surface: '#16315a',
  // Unfilled track behind progress and volume bars.
  track: '#333',
  textPrimary: '#ffffff',
  // Album line and other supporting copy — deliberately brighter than textDim,
  // which vanished over pale album art.
  textSecondary: '#d2d2d2',
  // The format line specifically; a notch above textSecondary for the same reason.
  textDetail: '#e2e2e2',
  // Timestamps and other chrome that should recede.
  textDim: '#888',
  // Amber for the reconnecting banner. Not red — a reconnect is not an error,
  // it is the poll loop backing off, and it usually resolves itself.
  warn: '#ffb84d',
  // The currently-playing row in Queue. Green rather than the accent, because
  // the accent is derived from the cover of the track that IS playing — tinting
  // "this one is playing" with it would make the marker vanish into everything
  // else on screen that already follows the same colour.
  nowPlaying: '#46c08d',

  // Feeling Lucky's violet, the one element deliberately NOT accent-tinted:
  // it is a shuffle, not a property of the current album.
  lucky: '#5b2bd9',
  luckyFocused: '#7a4dff',

  // Quality-tier pills. Gold reads as the premium tier at 10 feet without
  // needing a label change; blue matches the accent family; grey recedes
  // because lossy is information, not a warning.
  tier: {
    hiResBg: '#c9a13b',
    hiResFg: '#0a0a0a',
    losslessBg: '#2f6fb0',
    losslessFg: '#ffffff',
    lossyBg: '#3a3a3a',
    lossyFg: '#d0d0d0',
  },

  // Fallback when the cover yields no vibrant colour. Re-exported rather than
  // duplicated so there is exactly one definition of the default blue.
  accentFallback: DEFAULT_ACCENT,
} as const;

// Text over blurred album art needs a shadow or it disappears against a pale
// cover. This is the triple already repeated on title/artist/album/format,
// spread as one object instead of retyped.
export const onArt = {
  textShadowColor: 'rgba(0,0,0,0.85)',
  textShadowOffset: {width: 0, height: 1},
  textShadowRadius: 4,
} as const;

// Type scale in dp. The window is 960x540 dp (1080p at density 320), so every
// number here is drawn at 2x — the 22dp title is 44 physical px. Sizes are
// bounded by VERTICAL space, not legibility: at a 10-foot viewing distance
// these are comfortably large, and going bigger costs the hero its room.
export const type = {
  hero: {fontSize: 30, fontWeight: 'bold'},
  title: {fontSize: 22, fontWeight: 'bold'},
  body: {fontSize: 17, fontWeight: '600'},
  label: {fontSize: 14, fontWeight: '600'},
  caption: {fontSize: 12, fontWeight: '400'},
  // Letterspaced because the tier pills are all-caps single words, where
  // tracking is what makes them read as a badge rather than as shouting.
  badge: {fontSize: 11, fontWeight: '800', letterSpacing: 1.5},
} as const;

// 4dp base scale.
export const space = {xs: 4, sm: 8, md: 16, lg: 24, xl: 40} as const;

export const radius = {sm: 5, md: 8, pill: 999} as const;

// Motion. Fire Stick GPU budget allows transform and opacity only, driven by
// Reanimated shared values on the UI thread — no RN shadow* (not
// GPU-composited on Android) and no runtime blur.
export const motion = {
  // Slightly overdamped: focus should feel immediate on a remote, so this
  // settles without the overshoot that would read as lag between keypresses.
  focusSpring: {damping: 18, stiffness: 260, mass: 0.7},
  // Art cross-fade on track change.
  crossFade: 320,
  // How long the transient volume overlay stays up after the last press.
  volumeOverlay: 2000,
} as const;

// Focus states. Scale plus brightness carries focus; the old idiom was an
// instant 3dp white border, which is what made every control read as a form
// field. The thin accent ring stays as a secondary cue only.
export const focus = {
  scale: 1.12,
  // Unfocused siblings settle here so the focused control reads without chrome.
  restOpacity: 0.55,
  ringWidth: 2,
} as const;

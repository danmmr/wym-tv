import {useEffect} from 'react';
import ImageColors from 'react-native-image-colors';
import {usePlayerStore} from '../store/playerStore';

// Adaptive theming: derive a single vibrant accent color from the current cover
// art and write it to the player store so every screen (Now Playing controls,
// screensaver glow ring, art frame) can tint to match the music. Uses Android's
// Palette API under the hood via react-native-image-colors, which is far more
// reliable on the Fire Stick than hand-rolling pixel reads through Skia.
//
// The chosen color is normalized so it always reads well as an accent on the
// app's near-black background: we push a too-dark or too-desaturated pick toward
// a bright, saturated tone. On any failure the store's accent is left undefined
// and the UI falls back to its default blue.

const DEFAULT_ACCENT = '#3b9eff';

// Plex LAN cover art is served over https with a *.plex.direct certificate that
// fails hostname verification against the bare LAN IP. The app's RN networking
// uses a trust-all client (MainApplication.kt) so <Image>/Skia load it fine, but
// react-native-image-colors uses its OWN http client that does normal cert
// checks and rejects it ("Hostname X not verified"). Plex also serves the same
// bytes over plain http on the LAN (cleartext is allowed), so downgrade a
// private-IP https URL to http for the color fetch only. Public https art
// (e.g. the MusicBrainz Cover Art Archive fallback) is left untouched.
function isPrivateIp(ip: string): boolean {
  const p = ip.split('.').map(n => parseInt(n, 10));
  if (p.length !== 4) {
    return false;
  }
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
  );
}

function toFetchableUrl(url: string): string {
  const m = /^https:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\//.exec(url);
  if (m && isPrivateIp(m[1])) {
    return 'http://' + url.slice('https://'.length);
  }
  return url;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    return null;
  }
  const int = parseInt(m[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) {
      h += 360;
    }
  }
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    [r, g, b] = [c, x, 0];
  } else if (h < 120) {
    [r, g, b] = [x, c, 0];
  } else if (h < 180) {
    [r, g, b] = [0, c, x];
  } else if (h < 240) {
    [r, g, b] = [0, x, c];
  } else if (h < 300) {
    [r, g, b] = [x, 0, c];
  } else {
    [r, g, b] = [c, 0, x];
  }
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

// Normalize a raw palette pick into a UI-friendly accent: keep its hue, but force
// enough saturation and a mid-high lightness so it pops on the dark background.
function normalizeAccent(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return DEFAULT_ACCENT;
  }
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  // A near-grey pick (no real hue) is not worth theming with — fall back.
  if (s < 0.12) {
    return DEFAULT_ACCENT;
  }
  return hslToHex(h, clamp(s, 0.55, 0.95), clamp(l, 0.55, 0.66));
}

// A text-safe variant of an accent, for type drawn OVER the blurred cover.
//
// The accent itself is normalized to L 0.55-0.66, which pops nicely against the
// near-black background — but the Now Playing hero does not draw text on
// near-black, it draws it on a blurred, scrimmed copy of the cover the accent
// came FROM. When a sleeve is dominated by one saturated colour, those two are
// the same hue at nearly the same lightness and the text disappears into it.
// Coil's "The Sound of Musick" is the case that exposed this: blue on blue,
// unreadable across the room, while Max Richter and Public Enemy were fine
// because their accents contrasted with their own backgrounds.
//
// So lift the lightness well clear of anything the scrim leaves behind, and cap
// saturation so the result reads as tinted white rather than as a second
// colour. The hue survives, which is the part that carries "this is the music".
//
// Fills, rings, the progress bar and icon tints keep the RAW accent — contrast
// is not their problem and they lose their punch if paled.
export function textAccent(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return '#ffffff';
  }
  const [h, s] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  return hslToHex(h, clamp(s, 0.3, 0.55), 0.8);
}

// Accent for one image URL, or undefined if it can't be derived. Exported so
// callers that theme off something OTHER than the currently playing track (the
// art-frame slideshow) can reuse the same picking and normalization without
// writing to the player store.
export async function accentFor(url: string): Promise<string | undefined> {
  if (!url) {
    return undefined;
  }
  try {
    const res = await ImageColors.getColors(toFetchableUrl(url), {
      cache: true,
      key: url,
      quality: 'low',
    });
    // Android returns vibrant/dominant/average/muted/etc. Prefer a vibrant
    // pick, then dominant, then average, so we always land on something.
    const pick =
      (res.platform === 'android' &&
        (res.vibrant || res.dominant || res.average)) ||
      (res.platform === 'ios' && (res.primary || res.secondary)) ||
      undefined;
    return pick ? normalizeAccent(pick) : undefined;
  } catch {
    return undefined;
  }
}

export function useAccentColor() {
  const albumArt = usePlayerStore(s => s.albumArt);

  useEffect(() => {
    let cancelled = false;
    if (!albumArt) {
      usePlayerStore.getState().setPlayerState({accent: undefined});
      return;
    }
    accentFor(albumArt).then(accent => {
      if (!cancelled) {
        usePlayerStore.getState().setPlayerState({accent});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [albumArt]);
}

export {DEFAULT_ACCENT};

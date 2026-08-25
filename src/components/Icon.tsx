import React, {useMemo} from 'react';
import {Canvas, Group, Path, Skia} from '@shopify/react-native-skia';
import {color as themeColor} from '../theme';

// Monochrome vector icons, drawn with Skia.
//
// These replace the emoji the player used as iconography (🔉 🔊 🎲 📻 ☰ ⏮ ⏸ ▶
// ⏭ rendered as <Text>). Fire OS draws those with Noto Color Emoji, so they
// came out as multicolour stickers sitting inside monochrome buttons — the
// loudest amateur tell in the app, and the one thing that could never be
// restyled, because the glyph's colour belongs to the font.
//
// Skia is ALREADY a dependency (Screensaver.tsx), so this costs no new native
// module: no react-native-svg (absent), no bundled icon font, no APK growth,
// and no third-party licence to declare in a public repo. That is why the
// icons are hand-authored path data rather than an icon library — do not
// "simplify" this by adding one.
//
// Every path is authored on a 24x24 viewBox and scaled by a Group transform,
// so one `size` prop covers every call site.
const VIEWBOX = 24;

const PATHS = {
  // Transport. Triangles + bars, the universal set; drawn solid because
  // outlined transport icons lose their silhouette at 10 feet.
  prev: 'M7 6h2.5v5.2L18 6v12l-8.5-5.2V18H7z',
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M8 5.5h3.2v13H8zm4.8 0H16v13h-3.2z',
  next: 'M17 6h-2.5v5.2L6 6v12l8.5-5.2V18H17z',

  // Volume. A speaker cone, plus arcs for up and a slash for down, so the two
  // differ in silhouette and not only in the number of arcs — at this size a
  // one-arc/two-arc distinction is unreadable across the room.
  volumeDown:
    'M4 9.5h3.2L11.5 6v12L7.2 14.5H4zm10.2-.6a4.2 4.2 0 010 6.2l-1.3-1.4a2.3 2.3 0 000-3.4z',
  volumeUp:
    'M4 9.5h3.2L11.5 6v12L7.2 14.5H4zm10.2-.6a4.2 4.2 0 010 6.2l-1.3-1.4a2.3 2.3 0 000-3.4zm2.4-2.6a7.7 7.7 0 010 11.4l-1.3-1.4a5.8 5.8 0 000-8.6z',

  // Secondary actions, all living in the ⋮ overlay.
  queue: 'M3 6h13v2H3zm0 4.5h13v2H3zm0 4.5h9v2H3zm12 .5l6-3.5-6-3.5z',
  radio:
    'M12 8.2a3.8 3.8 0 100 7.6 3.8 3.8 0 000-7.6zm0 2a1.8 1.8 0 110 3.6 1.8 1.8 0 010-3.6zM6.3 4.9L7.7 6.3a8 8 0 000 11.4l-1.4 1.4a10 10 0 010-14.2zm11.4 0a10 10 0 010 14.2l-1.4-1.4a8 8 0 000-11.4z',
  // Feeling Lucky: a die showing five pips.
  dice: 'M5 5h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1zm3 2.8a1.3 1.3 0 100 2.6 1.3 1.3 0 000-2.6zm8 0a1.3 1.3 0 100 2.6 1.3 1.3 0 000-2.6zm-4 3.9a1.3 1.3 0 100 2.6 1.3 1.3 0 000-2.6zm-4 3.9a1.3 1.3 0 100 2.6 1.3 1.3 0 000-2.6zm8 0a1.3 1.3 0 100 2.6 1.3 1.3 0 000-2.6z',
  // Deep Cuts gets its own glyph. It shared the radio icon at first, which made
  // the two station entries indistinguishable in the menu — the labels were
  // doing all the work and the icons none.
  deepcuts:
    'M3 14.5c1.6 0 1.6-2 3.2-2s1.6 2 3.2 2 1.6-2 3.2-2 1.6 2 3.2 2 1.6-2 3.2-2 1.6 2 3.2 2v2c-1.6 0-1.6-2-3.2-2s-1.6 2-3.2 2-1.6-2-3.2-2-1.6 2-3.2 2-1.6-2-3.2-2-1.6 2-3.2 2zM7 4h1.8v6.6H7zm4.1 2h1.8v4.6h-1.8zm4.1-3H17v7.6h-1.8z',
  album:
    'M12 3a9 9 0 100 18 9 9 0 000-18zm0 2a7 7 0 110 14 7 7 0 010-14zm0 5.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z',
  browse: 'M4 5h7v6H4zm9 0h7v6h-7zM4 13h7v6H4zm9 0h7v6h-7z',
  recent:
    'M12 3a9 9 0 109 9h-2a7 7 0 11-7-7v3.2l4.4-4.1L12 0v3zm.9 4.6v4.9l4 2.4.9-1.5-3.2-1.9V7.6z',
  settings:
    'M12 8.4a3.6 3.6 0 100 7.2 3.6 3.6 0 000-7.2zm0 2a1.6 1.6 0 110 3.2 1.6 1.6 0 010-3.2zM10.6 2h2.8l.4 2.6a8 8 0 011.8 1l2.4-1 1.4 2.4-2 1.7a8 8 0 010 2.6l2 1.7-1.4 2.4-2.4-1a8 8 0 01-1.8 1L13.4 22h-2.8l-.4-2.6a8 8 0 01-1.8-1l-2.4 1L4.6 17l2-1.7a8 8 0 010-2.6l-2-1.7L6 8.6l2.4 1a8 8 0 011.8-1z',
  // The ⋮ affordance that opens the overlay.
  more: 'M12 5.4a1.9 1.9 0 110 3.8 1.9 1.9 0 010-3.8zm0 4.7a1.9 1.9 0 110 3.8 1.9 1.9 0 010-3.8zm0 4.7a1.9 1.9 0 110 3.8 1.9 1.9 0 010-3.8z',
  screensaver:
    'M3 5h18a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1zm2 2v8h14V7zm3 12h8v2H8z',
} as const;

export type IconName = keyof typeof PATHS;

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  /** Multiplies the glyph inside its box; use to visually balance a set. */
  inset?: number;
};

export default function Icon({
  name,
  size = 24,
  color = themeColor.textPrimary,
  inset = 0,
}: Props) {
  // Skia parses the path data once per glyph. Memoized on `name` alone because
  // the parsed path is scale-independent — the Group transform does the sizing,
  // so changing `size` must not re-parse.
  const path = useMemo(() => Skia.Path.MakeFromSVGString(PATHS[name]), [name]);

  if (!path) {
    // MakeFromSVGString returns null on malformed data rather than throwing.
    // Render nothing rather than crashing the player over a typo'd glyph.
    return null;
  }

  const box = size - inset * 2;
  const scale = box / VIEWBOX;

  return (
    <Canvas style={{width: size, height: size}}>
      <Group transform={[{translateX: inset}, {translateY: inset}, {scale}]}>
        <Path path={path} color={color} />
      </Group>
    </Canvas>
  );
}

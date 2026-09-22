// A stable colour per style name.
//
// The picker is a grid of 52 near-identical dark tiles, which scans as a wall
// of text: nothing distinguishes one row from the next, so the eye has no
// landmarks and every visit starts by reading from the top. Giving each style
// its own hue turns it into a map — "Drone is the teal one, second column" —
// and it is the same trick Plexamp uses on its own station list.
//
// The hue is DERIVED, never stored. A tag id would tie the colour to Plex's
// internal numbering (which changes if the library is rebuilt), and a lookup
// table would need an entry every time the retag project coins a style. Hashing
// the name means a style is the same colour on every device, every launch, with
// nothing to keep in sync.

// FNV-1a, 32-bit. Chosen over summing char codes because anagrams and
// transpositions must not collide: this library is full of near-identical style
// names ("Post Rock" / "Prog Rock", "Breakbeat" / "Breaks"), and adjacent tiles
// sharing a hue is exactly the confusion the colour is meant to remove.
//
// The >>> 0 keeps it unsigned: JS bitwise ops yield a SIGNED 32-bit int, so
// without it the multiply overflows negative and the modulo below can return a
// negative hue, which React Native renders as a transparent colour.
export function styleHash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    // The FNV prime, 16777619, written as shifts: Math.imul is the only way to
    // multiply 32-bit in JS without losing the low bits to float precision.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Hue in degrees. The full circle is used: at the low saturation these tiles
// carry, even neighbouring hues stay distinguishable, and reserving a band
// would only make collisions likelier.
export function styleHue(name: string): number {
  return styleHash(name) % 360;
}

// The tile's icon chip. Dim and desaturated when idle so 24 of them on screen
// read as one family rather than as confetti; bright and saturated when
// focused, which is what makes the focused tile obvious across a room in a grid
// where every tile is otherwise the same size and shape.
export function styleChip(name: string, focused: boolean): string {
  const h = styleHue(name);
  return focused ? `hsl(${h}, 62%, 42%)` : `hsl(${h}, 45%, 27%)`;
}

// The glyph inside the chip. White when focused — at 62% saturation the chip
// behind it is strong enough that a tinted glyph would lose contrast.
export function styleGlyph(name: string, focused: boolean): string {
  return focused ? '#ffffff' : `hsl(${styleHue(name)}, 55%, 68%)`;
}

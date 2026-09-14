// The "why this?" line under the album title — the context a blind shuffle
// lands without: when it came out, on what label, and how much more of this
// artist the library holds. Each part is dropped rather than shown empty, so
// a track Plex knows nothing about produces no line at all (and no gap).
// Pure and in its own module so the test does not have to import the screen
// (which pulls in reanimated and Skia).
export function whyThisLine(
  c: {year: string; label: string; artistAlbums?: number} | undefined,
): string {
  if (!c) {
    return '';
  }
  const parts: string[] = [];
  if (c.year) {
    parts.push(c.year);
  }
  if (c.label) {
    parts.push(c.label);
  }
  if (c.artistAlbums === 1) {
    parts.push('only album in library');
  } else if (c.artistAlbums && c.artistAlbums > 1) {
    parts.push(`${c.artistAlbums} albums in library`);
  }
  return parts.join('  ·  ');
}

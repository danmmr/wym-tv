// The "why this?" line under the album title — the context a blind shuffle
// lands without: when it came out, on what label, what kind of record it is,
// and how much more of this artist the library holds. Each part is dropped
// rather than shown empty, so a track Plex knows nothing about produces no
// line at all (and no gap).
// Pure and in its own module so the test does not have to import the screen
// (which pulls in reanimated and Skia).

// How many of the album's styles the line shows. Plex can tag an album with
// six or more; the first two (Plex's order) say what it is without pushing
// the line to a second row on a 1080p stick.
export const STYLES_SHOWN = 2;

export function whyThisLine(
  c:
    | {year: string; label: string; artistAlbums?: number; styles?: string[]}
    | undefined,
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
  const styles = (c.styles || [])
    .map(x => (x || '').trim())
    .filter(Boolean)
    .slice(0, STYLES_SHOWN);
  if (styles.length) {
    parts.push(styles.join(', '));
  }
  if (c.artistAlbums === 1) {
    parts.push('only album in library');
  } else if (c.artistAlbums && c.artistAlbums > 1) {
    parts.push(`${c.artistAlbums} albums in library`);
  }
  return parts.join('  ·  ');
}

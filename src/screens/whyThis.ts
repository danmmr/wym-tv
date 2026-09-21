// The "why this?" block under the album title — the context a blind shuffle
// lands without, as up to three short rows:
//   1987  ·  Factory
//   Post-Punk, Synth Pop
//   4 albums in library
// Each row is dropped rather than shown empty, so a track Plex knows nothing
// about produces no rows at all (and no gap).
// Pure and in its own module so the test does not have to import the screen
// (which pulls in reanimated and Skia).

// How many of the album's styles the styles row shows. Plex can tag an album
// with six or more; the first two (Plex's order) say what it is.
export const STYLES_SHOWN = 2;

export function whyThisLines(
  c:
    | {year: string; label: string; artistAlbums?: number; styles?: string[]}
    | undefined,
): string[] {
  if (!c) {
    return [];
  }
  const rows: string[] = [];
  const first = [c.year, c.label].filter(Boolean).join('  ·  ');
  if (first) {
    rows.push(first);
  }
  const styles = (c.styles || [])
    .map(x => (x || '').trim())
    .filter(Boolean)
    .slice(0, STYLES_SHOWN);
  if (styles.length) {
    rows.push(styles.join(', '));
  }
  if (c.artistAlbums === 1) {
    rows.push('only album in library');
  } else if (c.artistAlbums && c.artistAlbums > 1) {
    rows.push(`${c.artistAlbums} albums in library`);
  }
  return rows;
}

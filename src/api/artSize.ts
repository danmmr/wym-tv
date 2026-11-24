// Rewrites a Plex transcode URL to ask for a smaller square. The WiiM always
// hands out width=1000&height=1000, which decodes to 4 MB however small it is
// drawn. Never enlarges, and leaves any other URL (the MusicBrainz fallback)
// alone. The nested `url=` is percent-encoded, so its own query cannot match.
export function sizedArt(uri: string, px: number): string {
  if (!uri.includes('/photo/:/transcode?')) {
    return uri;
  }
  return uri.replace(
    /([?&](?:width|height)=)(\d+)/g,
    (_m, key: string, n: string) => `${key}${Math.min(Number(n), px)}`,
  );
}

// Which cover to show for a newly changed track. Separate from the hook so the
// order of these steps can be tested without a device.
//
// The store holds the PREVIOUS track's cover until something replaces it. So
// "found nothing" has to clear it, or an album with no art shows the last album's
// cover. It clears only once the device has answered: clearing on every track
// change would flash the placeholder between two tracks that both have covers.
//
// The clear also comes BEFORE the online lookup, not after. That lookup can take
// several seconds, and the old cover would be wrong for all of them.
export async function resolveTrackArt(
  deviceArt: () => Promise<string | undefined>,
  lookupArt: () => Promise<string | null>,
  apply: (url: string | undefined) => void,
  isCancelled: () => boolean,
): Promise<void> {
  let fromDevice: string | undefined;
  try {
    fromDevice = await deviceArt();
  } catch (e) {
    // Treated as no art from the device: the online lookup can still find one.
  }
  if (isCancelled()) {
    return;
  }
  apply(fromDevice);
  if (fromDevice) {
    return;
  }
  try {
    const found = await lookupArt();
    if (found && !isCancelled()) {
      apply(found);
    }
  } catch (e) {
    // Already cleared, so the placeholder stays.
  }
}

// The address the device gave for a track's cover, if it is one worth loading. For
// a track with no art a WiiM may answer 'unknow', or, when Plex started the track,
// a real-looking transcode address for `url=(null)`, which Plex answers with a 400.
export function usableArtUri(uri: unknown): string | undefined {
  return typeof uri === 'string' &&
    uri.startsWith('http') &&
    !/[?&]url=(\(null\)|%28null%29)?(&|$)/i.test(uri)
    ? uri
    : undefined;
}

// What to draw in the cover's two layers. The old cover stays under the new one
// only so that the new one can fade in over it. The placeholder is nearly
// transparent, so anything left under it shows through as if it were this track's
// cover. A cover that fails to load gets the same treatment.
export function coverLayers(
  prev: string | undefined,
  next: string | undefined,
  failed: string | undefined,
): {under?: string; top?: string} {
  return next && next !== failed ? {under: prev, top: next} : {};
}

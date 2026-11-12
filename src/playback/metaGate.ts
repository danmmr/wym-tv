// Decides when Now Playing's poll needs to ask the WiiM for getMetaInfo.
//
// The poll used to make two HTTPS requests every 1.5s: getPlayerStatus, and
// getMetaInfo for the track id, sample rate, bit depth and bitrate. Those four
// belong to the TRACK, so for the length of a track the second request brought
// back the same answer every time. This keeps the last answer and says when it
// is worth asking again:
//
//   - nothing is held yet, or the last ask came back with no metadata (the
//     device answers a bare "Failed" when idle) — keep asking, as before;
//   - the status describes a different track than the one the answer was
//     fetched under;
//   - for a couple of polls after such a change. getMetaInfo can trail
//     getPlayerStatus by a moment, so the first answer after a change may still
//     be the previous track's; asking again is what corrects it;
//   - every REFRESH_EVERY polls regardless, as a backstop for a change the
//     status fields cannot show (two same-named tracks of the same length).
//
// Pure bookkeeping, no network, so the rules can be tested without a device.

// Polls to keep asking after the status changes track.
export const SETTLE_POLLS = 2;
// Ask at least this often even when nothing appears to have changed.
export const REFRESH_EVERY = 10;

// The fields of getPlayerStatus that change when the track does. curpos, vol
// and mute are deliberately absent: they change constantly and say nothing
// about which track is playing.
export function statusSignature(status: any): string {
  return [
    status?.Title,
    status?.Artist,
    status?.Album,
    status?.totlen,
    status?.plicurr,
    status?.status,
  ]
    .map(v => String(v ?? ''))
    .join('|');
}

export class MetaGate {
  private signature: string | null = null;
  private settle = 0;
  private sinceFetch = 0;
  private held: any;

  // The metadata from the last successful ask, or undefined.
  get metaData(): any {
    return this.held;
  }

  // Call once per poll with that poll's status. True means: fetch getMetaInfo
  // now and hand the result to store().
  shouldFetch(signature: string): boolean {
    if (signature !== this.signature) {
      this.signature = signature;
      this.settle = SETTLE_POLLS;
      return true;
    }
    if (!this.held) {
      return true;
    }
    if (this.settle > 0) {
      this.settle -= 1;
      return true;
    }
    this.sinceFetch += 1;
    return this.sinceFetch >= REFRESH_EVERY;
  }

  // Record what an ask returned. undefined (the device had none, or the
  // request failed) drops the held copy rather than keeping a stale one.
  store(metaData: any): void {
    this.held = metaData || undefined;
    this.sinceFetch = 0;
  }
}

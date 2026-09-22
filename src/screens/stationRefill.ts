// When a station should append its next batch.
//
// Split out of NowPlayingScreen because the bug this encodes is invisible in
// the component: it needs a device whose queue has already been edited once,
// which is several minutes of skipping on a real WiiM to reproduce by hand.

export interface QueuePos {
  index: number; // 1-based position of the playing track
  total: number; // tracks in the queue
}

// Cheap gate, from getPlayerStatus. Its plicurr/plicount are free (the poll
// already has them) but they go STALE the moment the queue is edited, so they
// may not decide anything — they only say whether the honest source is worth a
// SOAP round trip.
//
// Staleness cannot cause a MISS here. A stale plicount is the older, smaller
// number, so `plicount - plicurr` reads lower than the truth and this errs
// towards asking. It can only cause a needless check.
export function mayBeNearEnd(
  plicount: number,
  plicurr: number,
  threshold: number,
): boolean {
  if (plicount <= 0) {
    return false;
  }
  return plicount - plicurr <= threshold;
}

// The real decision, from GetQueueIndex.
//
// `refillAt` is the queue length the last append was made at. Comparing against
// it is what stops the 1.5s poll appending over and over while the device
// catches up — but it MUST be compared against the honest total. Against
// getPlayerStatus's plicount, which does not grow when the queue is appended
// to, it matches forever after the first append and the station quietly runs
// dry. Measured: append 50 to a 50-track station and the device still reports
// plicount=50 while GetQueueIndex reports TrackNums=100.
export function shouldAppend(
  pos: QueuePos,
  refillAt: number,
  threshold: number,
): boolean {
  if (pos.total <= 0) {
    return false;
  }
  if (pos.total - pos.index > threshold) {
    return false;
  }
  return pos.total !== refillAt;
}

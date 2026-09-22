// The station refill decision.
//
// The bug this exists for: getPlayerStatus's plicount does NOT grow when the
// queue is appended to. Measured on a WiiM Mini — after a station appended 50
// tracks to its 50-track queue, plicount still read 50 while GetQueueIndex
// reported TrackNums=100. The old code compared the "already appended at this
// length" marker against plicount, so after the first append it matched on
// every poll forever and the station ran dry at 100 tracks instead of playing
// on. Library Radio and Deep Cuts had it too; it was not specific to styles.

import {mayBeNearEnd, shouldAppend} from '../src/screens/stationRefill';

const T = 10; // REFILL_THRESHOLD

describe('mayBeNearEnd', () => {
  it('is false comfortably mid-queue', () => {
    expect(mayBeNearEnd(50, 1, T)).toBe(false);
    expect(mayBeNearEnd(50, 39, T)).toBe(false);
  });

  it('is true once the tail is in sight', () => {
    expect(mayBeNearEnd(50, 40, T)).toBe(true);
    expect(mayBeNearEnd(50, 50, T)).toBe(true);
  });

  it('is false when the device reports no queue', () => {
    // A zero here means "nothing loaded", not "queue exhausted". Treating it as
    // near-the-end would have the app append to a queue that is not playing.
    expect(mayBeNearEnd(0, 0, T)).toBe(false);
  });

  it('errs towards asking when the count is stale', () => {
    // The whole point of the cheap gate: a stale plicount is the older, SMALLER
    // number, so it can only make this read as nearer the end than it is. It
    // must never be the thing that suppresses a check.
    expect(mayBeNearEnd(50, 42, T)).toBe(true); // stale 50, truly 100
  });
});

describe('shouldAppend', () => {
  it('appends when the real queue is near its end', () => {
    expect(shouldAppend({index: 42, total: 50}, 0, T)).toBe(true);
  });

  it('does not append mid-queue', () => {
    expect(shouldAppend({index: 42, total: 100}, 50, T)).toBe(false);
  });

  it('does not append twice at the same queue length', () => {
    // The poll runs every 1.5s and the device takes a moment to reflect an
    // append; without this the station would append repeatedly in that window.
    expect(shouldAppend({index: 42, total: 50}, 50, T)).toBe(false);
  });

  it('APPENDS AGAIN once the queue has actually grown', () => {
    // The regression. After the first append the queue is 100 long and the
    // marker says 50; when playback nears 100 a second append must fire.
    // Judged on plicount (stuck at 50) this returned false forever.
    expect(shouldAppend({index: 92, total: 100}, 50, T)).toBe(true);
    // ...and a third, after that one lands.
    expect(shouldAppend({index: 142, total: 150}, 100, T)).toBe(true);
  });

  it('ignores an empty queue', () => {
    // refillAt is deliberately NOT 0 here. With a 0 marker the zero-total case
    // returns false through the "same length" comparison anyway, so the test
    // would pass with the guard deleted — it has to be a case only the guard
    // can catch. A device reporting no queue must never be appended to.
    expect(shouldAppend({index: 0, total: 0}, 50, T)).toBe(false);
    expect(shouldAppend({index: 0, total: 0}, 0, T)).toBe(false);
  });
});

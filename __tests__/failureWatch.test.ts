// The sample sequences here are the ones measured on real devices with broken
// files, thinned to what a 1.5s poll would see. See failureWatch.ts.

import {FailureWatch, PlaybackSample} from '../src/playback/failureWatch';

const ID = '/library/metadata/';

let clock = 0;
const sample = (
  n: string | number,
  status: string,
  posMs = 0,
  durMs = 0,
  over: Partial<PlaybackSample> = {},
): PlaybackSample => {
  clock += 1500;
  return {
    trackId: typeof n === 'number' ? `${ID}${n}` : n,
    title: `T${n}`,
    artist: 'A',
    album: 'B',
    status,
    posMs,
    durMs,
    shuffled: false,
    now: clock,
    ...over,
  };
};

// Feeds a run of samples and returns what was reported, as [track, kind].
const run = (w: FailureWatch, samples: PlaybackSample[]) =>
  samples
    .map(s => w.observe(s))
    .filter(Boolean)
    .map(f => [f!.trackId.replace(ID, ''), f!.kind]);

beforeEach(() => {
  clock = 100000;
});

describe('FailureWatch: real failures', () => {
  it('reports a corrupt file that moves on to the next track', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'load', 33441),
        sample(2, 'load', 33441),
        sample(2, 'play', 574, 93493),
      ]),
    ).toEqual([['1', 'load']]);
  });

  it('reports a corrupt file with nothing after it, once', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'load', 11541),
        sample(1, 'stop', 11541),
        sample(1, 'stop', 11541),
        sample(1, 'stop', 11541),
      ]),
    ).toEqual([['1', 'load']]);
  });

  it('reports a truncated file that advances by itself', () => {
    const w = new FailureWatch();
    const out = [
      sample(1, 'load'),
      sample(1, 'play', 643, 93493),
      sample(1, 'play', 3000, 93493),
      sample(1, 'play', 4800, 93493),
      sample(2, 'play', 346, 93493),
    ].map(s => w.observe(s));
    expect(out.filter(Boolean)).toEqual([
      expect.objectContaining({
        kind: 'early',
        posMs: 4800,
        durMs: 93493,
        title: 'T1',
      }),
    ]);
  });

  it('reports a truncated last track that stops, keeping its id', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'play', 3000, 93493),
        sample(1, 'stop', 5000, 93493),
      ]),
    ).toEqual([['1', 'early']]);
  });

  it('still catches a broken track the app itself skipped to', () => {
    const w = new FailureWatch();
    run(w, [sample(1, 'play', 5000, 200000)]);
    w.noteCommand(clock);
    expect(
      run(w, [
        sample(2, 'load'), // the track left by the command: forgiven
        sample(3, 'load'), // the broken one moving on by itself: reported
        sample(3, 'play', 500, 200000),
      ]),
    ).toEqual([['2', 'load']]);
  });

  it('catches a broken first track when nothing was loaded before', () => {
    // Found on a real device: playing an album with no track loaded left the
    // command pending, and it then excused the album's broken first track.
    const w = new FailureWatch();
    w.noteCommand(clock);
    expect(run(w, [sample(1, 'load'), sample(2, 'play', 500, 93493)])).toEqual([
      ['1', 'load'],
    ]);
  });

  it('catches it after an app stop too', () => {
    const w = new FailureWatch();
    run(w, [sample(9, 'play', 6000, 148280)]);
    w.noteCommand(clock);
    run(w, [sample('0', 'stop', 6000, 148280)]);
    w.noteCommand(clock);
    expect(run(w, [sample(1, 'load'), sample(2, 'play', 500, 93493)])).toEqual([
      ['1', 'load'],
    ]);
  });

  it('still judges a track that read stop before it started', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'stop'),
        sample(1, 'stop'),
        sample(1, 'load'),
        sample(1, 'play', 3000, 93493),
        sample(1, 'stop', 5000, 93493),
      ]),
    ).toEqual([['1', 'early']]);
  });

  it('counts a track that read play but never got a length', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'play', 12989, 0),
        sample(2, 'play', 500, 93493),
      ]),
    ).toEqual([['1', 'load']]);
  });

  it('does not take the previous track position for this one', () => {
    // During 'load' the device still reports the last track's position.
    const w = new FailureWatch();
    const out = [
      sample(1, 'load', 88000, 90000),
      sample(2, 'play', 500, 90000),
    ].map(s => w.observe(s));
    expect(out[1]).toEqual(expect.objectContaining({kind: 'load', posMs: 0}));
  });
});

describe('FailureWatch: not failures', () => {
  it('ignores a track that plays to its end', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'play', 80000, 93493),
        sample(1, 'play', 92000, 93493),
        sample(2, 'load', 92000),
        sample(2, 'play', 500, 90000),
      ]),
    ).toEqual([]);
  });

  it('ignores the last track of a queue ending naturally', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'play', 92000, 93493),
        sample(1, 'stop', 93363, 93493),
      ]),
    ).toEqual([]);
  });

  it('allows a long track its 10% and a short one its 10s', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'play', 545000, 600000), // 55s short, past 90%
        sample(2, 'play', 21000, 30000), // 9s short, only 70% through
        sample(3, 'play', 1000, 200000),
        sample(3, 'stop', 195000, 200000),
      ]),
    ).toEqual([]);
  });

  it('ignores a stop from any app, which clears the id', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'play', 6000, 148280),
        sample('0', 'stop', 6844, 148280),
      ]),
    ).toEqual([]);
    expect(
      run(new FailureWatch(), [sample(1, 'load'), sample('0', 'stop', 6844)]),
    ).toEqual([]);
  });

  it('forgives the track an app skip left', () => {
    const w = new FailureWatch();
    run(w, [sample(1, 'play', 6000, 148280)]);
    w.noteCommand(clock);
    expect(run(w, [sample(2, 'play', 500, 93493)])).toEqual([]);
  });

  it('forgives each of two quick skips', () => {
    const w = new FailureWatch();
    run(w, [sample(1, 'play', 6000, 148280)]);
    w.noteCommand(clock);
    w.noteCommand(clock);
    expect(run(w, [sample(2, 'load'), sample(3, 'play', 500, 93493)])).toEqual(
      [],
    );
  });

  it('forgives an app stop that keeps the id', () => {
    const w = new FailureWatch();
    run(w, [sample(1, 'play', 6000, 148280)]);
    w.noteCommand(clock);
    expect(run(w, [sample(1, 'stop', 6000, 148280)])).toEqual([]);
  });

  it('no longer forgives once the command is old', () => {
    const w = new FailureWatch();
    run(w, [sample(1, 'play', 6000, 148280)]);
    w.noteCommand(clock - 60000);
    expect(run(w, [sample(2, 'play', 500, 93493)])).toEqual([['1', 'early']]);
  });

  it('ignores a pause', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'play', 6000, 148280),
        sample(1, 'pause', 6000, 148280),
        sample(1, 'play', 6000, 148280),
      ]),
    ).toEqual([]);
  });

  it('does not judge from a position that is out of date', () => {
    const w = new FailureWatch();
    run(w, [sample(1, 'play', 6000, 148280)]);
    clock += 60000;
    expect(run(w, [sample(2, 'play', 500, 93493)])).toEqual([]);
  });

  // Measured on a WiiM Mini switching albums: the new queue's first track read
  // 'stop' before 'load'. Two polls in that moment reported a track that then
  // played perfectly.
  it('ignores a new queue whose first track reads stop before loading', () => {
    const w = new FailureWatch();
    run(w, [sample(1, 'play', 6000, 148280)]);
    w.noteCommand(clock);
    expect(
      run(w, [
        sample(2, 'stop', 0, 148280),
        sample(2, 'stop', 0, 148280),
        sample(2, 'load'),
        sample(2, 'play', 500, 78546),
        sample(2, 'play', 2000, 78546),
      ]),
    ).toEqual([]);
  });

  it('ignores a queue that was already finished when the app opened', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'stop', 93363, 93493),
        sample(1, 'stop', 93363, 93493),
        sample(2, 'play', 500, 93493),
      ]),
    ).toEqual([]);
  });

  it('ignores anything that is not a library track', () => {
    expect(
      run(new FailureWatch(), [
        sample('http://radio', 'load'),
        sample('spotify:1', 'stop'),
      ]),
    ).toEqual([]);
  });

  it('does not count a track that reads play before it has a length', () => {
    expect(
      run(new FailureWatch(), [
        sample(1, 'play', 12989, 0),
        sample(1, 'play', 413, 93493),
        sample(1, 'play', 90000, 93493),
        sample(2, 'play', 500, 93493),
      ]),
    ).toEqual([]);
  });
});

describe('FailureWatch: tracks that fell between polls', () => {
  it('asks once per settled track, and not while it loads', () => {
    const w = new FailureWatch();
    const loading = sample(1, 'load');
    w.observe(loading);
    expect(w.wantsIndex(loading)).toBe(false);
    const playing = sample(1, 'play', 500, 90000);
    w.observe(playing);
    expect(w.wantsIndex(playing)).toBe(true);
    w.reportIndex(1);
    expect(w.wantsIndex(sample(1, 'play', 2000, 90000))).toBe(false);
  });

  it('never asks when shuffled', () => {
    const w = new FailureWatch();
    const s = sample(1, 'play', 500, 90000, {shuffled: true});
    w.observe(s);
    expect(w.wantsIndex(s)).toBe(false);
  });

  it('reports positions passed over', () => {
    const w = new FailureWatch();
    expect(w.reportIndex(3)).toEqual([]);
    expect(w.reportIndex(4)).toEqual([]);
    expect(w.reportIndex(7)).toEqual([5, 6]);
  });

  it('reports a first track that failed between polls', () => {
    // Found on a real device: a queue started by the app, whose bad first track
    // was never seen.
    const w = new FailureWatch();
    w.noteCommand(clock, 1);
    expect(w.reportIndex(2)).toEqual([1]);
  });

  it('reports nothing when a queue starts where it was asked to', () => {
    const w = new FailureWatch();
    w.noteCommand(clock, 5);
    expect(w.reportIndex(5)).toEqual([]);
    expect(w.reportIndex(6)).toEqual([]);
  });

  it('does not ask about the old queue once a command is sent', () => {
    const w = new FailureWatch();
    const s = sample(1, 'play', 500, 90000);
    w.observe(s);
    w.noteCommand(clock, 1);
    expect(w.wantsIndex(s)).toBe(false);
  });

  it('treats position 0 as not knowing', () => {
    const w = new FailureWatch();
    w.reportIndex(0);
    expect(w.reportIndex(3)).toEqual([]);
  });

  it('takes a long jump for a jump, not a run of bad files', () => {
    // Found on a real device: a queue moved from track 1 to 21 by another app
    // listed all 19 tracks between as failed.
    const w = new FailureWatch();
    w.reportIndex(1);
    expect(w.reportIndex(21)).toEqual([]);
    expect(w.reportIndex(23)).toEqual([22]);
  });

  it('still believes the most that can fail between polls', () => {
    const w = new FailureWatch();
    w.reportIndex(1);
    expect(w.reportIndex(5)).toEqual([2, 3, 4]);
  });

  it('ignores a wrap back to the start', () => {
    const w = new FailureWatch();
    w.reportIndex(20);
    expect(w.reportIndex(1)).toEqual([]);
  });

  it('does not treat an app jump as skipped tracks', () => {
    const w = new FailureWatch();
    w.reportIndex(3);
    w.noteCommand(clock);
    expect(w.reportIndex(15)).toEqual([]);
    expect(w.reportIndex(17)).toEqual([16]);
  });
});

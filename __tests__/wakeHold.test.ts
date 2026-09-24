// The screen is held awake whenever the WiiM is playing, on every screen.
// Before this, only the app's own screensaver held it, and a state where that
// saver never came up let Fire OS's ambient screensaver take over after 5
// minutes — backgrounding the app, which then exits. It looked like a crash.

import {startWakeHold} from '../src/wakeHold';

function harness(initial: string) {
  let listener: ((s: string) => void) | null = null;
  const calls: boolean[] = [];
  const stop = startWakeHold(
    l => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    initial,
    on => calls.push(on),
  );
  return {
    calls,
    stop,
    emit: (s: string) => listener?.(s),
    live: () => !!listener,
  };
}

describe('startWakeHold', () => {
  it('holds from the start when already playing', () => {
    const h = harness('play');
    expect(h.calls).toEqual([true]);
  });

  it('does not hold when paused at start', () => {
    const h = harness('pause');
    expect(h.calls).toEqual([false]);
  });

  it('follows play and pause', () => {
    const h = harness('pause');
    h.emit('play');
    h.emit('pause');
    h.emit('play');
    expect(h.calls).toEqual([false, true, false, true]);
  });

  it('treats anything other than play as not playing', () => {
    // The WiiM also reports states outside the typed union (e.g. load). None of
    // them is music the viewer is hearing.
    const h = harness('play');
    h.emit('stop');
    h.emit('play');
    h.emit('load');
    expect(h.calls).toEqual([true, false, true, false]);
  });

  it('only calls native on a change, not on every poll', () => {
    const h = harness('play');
    for (let i = 0; i < 20; i++) {
      h.emit('play');
    }
    expect(h.calls).toEqual([true]);
  });

  it('releases and unsubscribes when stopped', () => {
    const h = harness('play');
    h.stop();
    expect(h.calls).toEqual([true, false]);
    expect(h.live()).toBe(false);
  });
});

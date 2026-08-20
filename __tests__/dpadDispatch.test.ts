// The D-pad is the ONLY input this app has, so a press that goes nowhere is
// indistinguishable from a frozen app. Two gaps used to swallow presses, and
// both are the kind that leave no trace to debug from:
//
//   * on a cold start MainActivity.captureDpad was false until a screen reached
//     its focus effect, so early presses fell through to native TV focus, which
//     draws no highlight on Fire OS. Fixed natively (the flag starts true);
//     what is testable here is the JS half.
//   * each screen added its own emitter listener on focus and removed it on
//     blur, so during a screen transition the native side emitted to nobody.
//
// The routing below is what replaced them. The stack ordering matters because
// react-navigation does not guarantee whether the incoming screen's focus
// effect runs before or after the outgoing screen's cleanup — route to the
// wrong end and one of those two orders leaves the visible screen deaf.

import {DeviceEventEmitter} from 'react-native';
import {
  __reset,
  __setClock,
  dispatchNavKey,
  subscribeNav,
} from '../src/nav/dpad';

beforeEach(() => __reset());

describe('D-pad routing', () => {
  it('delivers native WiiMNavKey events to the subscriber', () => {
    const seen: string[] = [];
    subscribeNav(k => seen.push(k));

    // The real path: emitted by MainActivity, not called directly.
    DeviceEventEmitter.emit('WiiMNavKey', 'down');
    expect(seen).toEqual(['down']);
  });

  it('routes to the most recent subscriber, not the first', () => {
    const older: string[] = [];
    const newer: string[] = [];
    subscribeNav(k => older.push(k));
    subscribeNav(k => newer.push(k));

    dispatchNavKey('select');
    expect(newer).toEqual(['select']);
    expect(older).toEqual([]);
  });

  it('falls back to the screen underneath when the top unsubscribes', () => {
    const older: string[] = [];
    subscribeNav(k => older.push(k));
    const off = subscribeNav(() => {});

    off();
    dispatchNavKey('up');
    expect(older).toEqual(['up']);
  });

  it('survives the outgoing screen cleaning up AFTER the incoming subscribes', () => {
    // react-navigation does this ordering on some transitions. Removing by
    // identity rather than popping the stack is what keeps it correct.
    const outgoing: string[] = [];
    const incoming: string[] = [];
    const offOutgoing = subscribeNav(k => outgoing.push(k));
    subscribeNav(k => incoming.push(k));

    offOutgoing(); // late cleanup, while the new screen is already on top
    dispatchNavKey('right');

    expect(incoming).toEqual(['right']);
    expect(outgoing).toEqual([]);
  });
});

describe('presses made during a screen transition', () => {
  it('hands a held direction to the next screen that subscribes', () => {
    dispatchNavKey('down'); // nobody listening yet
    const seen: string[] = [];
    subscribeNav(k => seen.push(k));

    expect(seen).toEqual(['down']);
  });

  it('never replays select or menu into a screen the user has not seen', () => {
    // Replaying an activation would start playback or navigate somewhere the
    // user never chose, on a screen that was not on the TV when they pressed.
    for (const key of ['select', 'menu']) {
      __reset();
      dispatchNavKey(key);
      const seen: string[] = [];
      subscribeNav(k => seen.push(k));
      expect(seen).toEqual([]);
    }
  });

  it('drops a stale press rather than acting on it later', () => {
    let clock = 1000;
    __setClock(() => clock);

    dispatchNavKey('left');
    clock += 501; // past the buffer window

    const seen: string[] = [];
    subscribeNav(k => seen.push(k));
    expect(seen).toEqual([]);
  });

  it('holds only the most recent press, not a backlog', () => {
    dispatchNavKey('up');
    dispatchNavKey('down');
    dispatchNavKey('left');

    const seen: string[] = [];
    subscribeNav(k => seen.push(k));
    expect(seen).toEqual(['left']);
  });

  it('does not re-deliver the held press to a second subscriber', () => {
    dispatchNavKey('down');
    const first: string[] = [];
    const second: string[] = [];
    subscribeNav(k => first.push(k));
    subscribeNav(k => second.push(k));

    expect(first).toEqual(['down']);
    expect(second).toEqual([]);
  });

  it('leaves nothing stale behind after normal use', () => {
    // A buffered press, then a live one, then the screen goes away: the next
    // screen must start clean rather than inheriting an old press.
    dispatchNavKey('up'); // buffered
    const seen: string[] = [];
    const off = subscribeNav(k => seen.push(k));
    dispatchNavKey('down'); // live
    off();

    const next: string[] = [];
    subscribeNav(k => next.push(k));
    expect(seen).toEqual(['up', 'down']);
    expect(next).toEqual([]);
  });
});

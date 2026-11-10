import {usePlayerStore} from '../src/store/playerStore';

// The poll loop writes the same values every 1.5s while paused. Those writes
// must not notify subscribers, or every bare subscriber re-renders per poll.
describe('setPlayerState no-op guard', () => {
  it('notifies only when a field actually changes', () => {
    const set = usePlayerStore.getState().setPlayerState;
    set({title: 'A', currentPos: 1});
    let calls = 0;
    const unsub = usePlayerStore.subscribe(() => {
      calls++;
    });
    set({title: 'A', currentPos: 1});
    expect(calls).toBe(0);
    set({title: 'A', currentPos: 2});
    expect(calls).toBe(1);
    expect(usePlayerStore.getState().currentPos).toBe(2);
    unsub();
  });
});

import {WiiMClient, QueueTrack} from '../src/api/wiim';

// queueNext edits the queue that is ALREADY playing rather than replacing it.
// That is not a style choice: CreateQueue mid-playback stops the device (seen
// on a WiiM Ultra — status went to 'stop' and stayed), so a "rebuild the queue
// with the current track prepended" version cannot work at all. What is left is
// a sequence of index-range edits, and the order of those edits is the whole
// correctness story — hence these tests assert on the CALLS, not on a return
// value. A result-only assertion cannot tell a correct trim from one that
// removed the song the user is listening to.
const track = (title: string): QueueTrack => ({
  url: `http://plex/${title}`,
  trackId: `/library/metadata/${title}`,
  albumId: '/library/metadata/1/children',
  title,
  artist: 'A',
  album: 'B',
  durationMs: '1000',
  bitrate: '900',
  artUrl: 'http://plex/art',
});

// Stand in for the two transports the client talks over, recording what it
// asks for. `soap` returns whatever the queued script says next.
function harness(opts: {
  status?: 'play' | 'pause' | 'stop';
  listName?: string;
  index?: number;
  total?: number;
}) {
  const {status = 'play', listName = 'WiiMTV', index = 3, total = 6} = opts;
  const c = new WiiMClient('10.0.0.1');
  const calls: Array<{action: string; inner: string}> = [];
  (c as any).command = async () => ({status});
  (c as any).playQueueSoap = async (action: string, inner: string) => {
    calls.push({action, inner});
    if (action === 'BrowseQueue') {
      return listName
        ? `<QueueContext>&lt;ListName&gt;${listName}&lt;/ListName&gt;</QueueContext>`
        : '<no/>';
    }
    if (action === 'GetQueueIndex') {
      return `<CurrentIndex>${index}</CurrentIndex><TrackNums>${total}</TrackNums>`;
    }
    return '<ok/>';
  };
  return {c, calls};
}

const removals = (calls: Array<{action: string; inner: string}>) =>
  calls
    .filter(x => x.action === 'RemoveTracksInQueue')
    .map(x => {
      const s = /<RangStart>(\d+)<\/RangStart>/.exec(x.inner);
      const e = /<RangEnd>(\d+)<\/RangEnd>/.exec(x.inner);
      return [Number(s?.[1]), Number(e?.[1])];
    });

describe('queueNext', () => {
  it('clears the tail BEFORE the head, and never the playing track', async () => {
    const {c, calls} = harness({index: 3, total: 6});
    expect(await c.queueNext([track('x')])).toBe(true);
    // Tail first: removing 1..2 first would renumber the playing track from 3
    // to 1, and the tail range 4..6 would then delete the album we just queued
    // — or, one press later, the song being listened to.
    expect(removals(calls)).toEqual([
      [4, 6],
      [1, 2],
    ]);
    expect(calls[calls.length - 1].action).toBe('AppendTracksInQueue');
  });

  it('removes nothing when the playing track is the whole queue', async () => {
    const {c, calls} = harness({index: 1, total: 1});
    expect(await c.queueNext([track('x')])).toBe(true);
    expect(removals(calls)).toEqual([]);
  });

  it('removes only the tail when playing the first of many', async () => {
    const {c, calls} = harness({index: 1, total: 4});
    await c.queueNext([track('x')]);
    expect(removals(calls)).toEqual([[2, 4]]);
  });

  it('removes only the head when playing the last of many', async () => {
    const {c, calls} = harness({index: 4, total: 4});
    await c.queueNext([track('x')]);
    expect(removals(calls)).toEqual([[1, 3]]);
  });

  it('appends into the queue that is loaded, not always ours', async () => {
    // The WiiM Home app and Plex push queues under their own ListName, and
    // AppendTracksInQueue merges by name — ours would land nowhere.
    const {c, calls} = harness({listName: 'Feral Grace'});
    await c.queueNext([track('x')]);
    const append = calls.find(x => x.action === 'AppendTracksInQueue')!;
    expect(append.inner).toContain('Feral Grace');
    expect(append.inner).not.toContain('WiiMTV');
  });

  it('declines, touching nothing, when the device is stopped', async () => {
    // There is no "current song" to queue behind; the caller plays outright.
    const {c, calls} = harness({status: 'stop'});
    expect(await c.queueNext([track('x')])).toBe(false);
    expect(calls).toEqual([]);
  });

  it('declines when there is no queue loaded', async () => {
    const {c, calls} = harness({listName: ''});
    expect(await c.queueNext([track('x')])).toBe(false);
    expect(removals(calls)).toEqual([]);
    expect(calls.some(x => x.action === 'AppendTracksInQueue')).toBe(false);
  });

  it('declines when the device reports no position in the queue', async () => {
    const {c, calls} = harness({index: 0, total: 0});
    expect(await c.queueNext([track('x')])).toBe(false);
    expect(removals(calls)).toEqual([]);
  });

  it('does nothing at all with an empty track list', async () => {
    const {c, calls} = harness({});
    expect(await c.queueNext([])).toBe(false);
    expect(calls).toEqual([]);
  });
});

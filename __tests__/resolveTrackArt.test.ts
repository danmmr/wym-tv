// A track with no cover must not keep showing the previous track's cover, and a
// track WITH one must not flash the placeholder on the way there.
//
// toStrictEqual throughout: toEqual passes [undefined] against [], which is the
// difference between clearing the cover and never touching it.

import {
  coverLayers,
  resolveTrackArt,
  usableArtUri,
} from '../src/hooks/resolveTrackArt';

const run = async (
  device: () => Promise<string | undefined>,
  lookup: () => Promise<string | null>,
  isCancelled = () => false,
) => {
  const applied: (string | undefined)[] = [];
  await resolveTrackArt(device, lookup, u => applied.push(u), isCancelled);
  return applied;
};

describe('resolveTrackArt', () => {
  it('replaces the cover directly when the device has one', async () => {
    const lookup = jest.fn(async () => 'http://online');
    const applied = await run(async () => 'http://device', lookup);
    expect(applied).toStrictEqual(['http://device']);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('clears the old cover when nothing has art', async () => {
    const applied = await run(
      async () => undefined,
      async () => null,
    );
    expect(applied).toStrictEqual([undefined]);
  });

  it('clears before the online lookup, then uses what it finds', async () => {
    const seenAtLookup: (string | undefined)[][] = [];
    const applied: (string | undefined)[] = [];
    await resolveTrackArt(
      async () => undefined,
      async () => {
        seenAtLookup.push([...applied]);
        return 'http://online';
      },
      u => applied.push(u),
      () => false,
    );
    expect(seenAtLookup).toStrictEqual([[undefined]]);
    expect(applied).toStrictEqual([undefined, 'http://online']);
  });

  it('clears when the device request fails', async () => {
    const applied = await run(
      async () => {
        throw new Error('offline');
      },
      async () => null,
    );
    expect(applied).toStrictEqual([undefined]);
  });

  it('stays cleared when the online lookup fails', async () => {
    const applied = await run(
      async () => undefined,
      async () => {
        throw new Error('offline');
      },
    );
    expect(applied).toStrictEqual([undefined]);
  });

  it('applies nothing once the track has changed again', async () => {
    const applied = await run(
      async () => 'http://device',
      async () => null,
      () => true,
    );
    expect(applied).toStrictEqual([]);
  });

  it('drops a late online result for a track that has moved on', async () => {
    let cancelled = false;
    const applied = await run(
      async () => undefined,
      async () => {
        cancelled = true;
        return 'http://online';
      },
      () => cancelled,
    );
    expect(applied).toStrictEqual([undefined]);
  });
});

describe('usableArtUri', () => {
  const plex = 'http://plex:32400/photo/:/transcode?width=1000&height=1000';

  it('keeps a real cover', () => {
    const uri = `${plex}&url=%2Flibrary%2Fmetadata%2F1%2Fthumb%2F2&format=jpeg`;
    expect(usableArtUri(uri)).toBe(uri);
  });

  it.each([
    ['the literal a WiiM reported', `${plex}&url=(null)&format=jpeg&X=1`],
    ['the same, encoded', `${plex}&url=%28null%29&format=jpeg`],
    ['an empty url at the end', `${plex}&url=`],
    ['no art at all', 'unknow'],
    ['nothing', undefined],
  ])('rejects %s', (_label, uri) => {
    expect(usableArtUri(uri)).toBeUndefined();
  });
});

describe('coverLayers', () => {
  it('fades a new cover in over the old one', () => {
    expect(coverLayers('old', 'new', undefined)).toStrictEqual({
      under: 'old',
      top: 'new',
    });
  });

  it('leaves nothing to show through the placeholder', () => {
    expect(coverLayers('old', undefined, undefined)).toStrictEqual({});
  });

  it('treats a cover that failed to load as no cover', () => {
    expect(coverLayers('old', 'bad', 'bad')).toStrictEqual({});
  });

  it('is not put off by an older failure', () => {
    expect(coverLayers('old', 'new', 'bad')).toStrictEqual({
      under: 'old',
      top: 'new',
    });
  });
});

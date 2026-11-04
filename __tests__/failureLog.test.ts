jest.mock('../src/config/plex', () => ({
  PLEX: {baseUrl: 'http://plex.test:32400', musicSection: 4},
}));
jest.mock('axios', () => ({get: jest.fn()}));

import axios from 'axios';
import type {PlaybackFailure} from '../src/playback/failureWatch';

const mockGet = axios.get as jest.Mock;

const failure = (id: number, over = {}): PlaybackFailure => ({
  trackId: `/library/metadata/${id}`,
  title: `T${id}`,
  artist: 'A',
  album: 'B',
  kind: 'load',
  posMs: 0,
  durMs: 0,
  ...over,
});

const KEY = 'wym.playbackFailures.v1';
const storage = () => {
  const m = require('@react-native-async-storage/async-storage');
  return m.default || m;
};

// A new module AND new storage, holding what the last run saved, which is what an
// app restart is. Resetting modules alone also empties the fake storage, and
// loading nothing would pass any "survives a restart" test.
const restart = async () => {
  const saved = await storage().getItem(KEY);
  const log = fresh();
  if (saved !== null) {
    await storage().setItem(KEY, saved);
  }
  return log;
};

const flush = () => new Promise(r => setTimeout(r, 0));

// Fresh module state each time, to start with nothing in memory.
const fresh = () => {
  jest.resetModules();
  return require('../src/playback/failureLog');
};

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  mockGet.mockReset();
  mockGet.mockResolvedValue({data: {MediaContainer: {Metadata: []}}});
  await fresh().clearFailures();
});

describe('failure log', () => {
  it('keeps one row per track, newest first, and counts repeats', async () => {
    const log = fresh();
    await log.recordFailure(failure(1));
    await log.recordFailure(failure(2));
    await log.recordFailure(failure(1));
    const list = await log.getFailures();
    expect(list.map((e: any) => [e.title, e.count])).toEqual([
      ['T1', 2],
      ['T2', 1],
    ]);
  });

  it('survives an app restart', async () => {
    await fresh().recordFailure(failure(1));
    const log = await restart();
    const list = await log.getFailures();
    expect(list.map((e: any) => e.title)).toEqual(['T1']);
  });

  it('caps the list, dropping the oldest', async () => {
    const log = fresh();
    for (let i = 0; i < 205; i++) {
      await log.recordFailure(failure(i));
    }
    const list = await log.getFailures();
    expect(list.length).toBe(200);
    expect(list[0].title).toBe('T204');
    expect(list.some((e: any) => e.title === 'T4')).toBe(false);
  });

  it('clears for good', async () => {
    const log = fresh();
    await log.recordFailure(failure(1));
    await log.clearFailures();
    expect(await log.getFailures()).toEqual([]);
    expect(await (await restart()).getFailures()).toEqual([]);
  });

  it('adds the file path when Plex has it', async () => {
    const log = fresh();
    require('axios').get.mockResolvedValue({
      data: {
        MediaContainer: {Metadata: [{Media: [{Part: [{file: '/m/a.flac'}]}]}]},
      },
    });
    await log.recordFailure(failure(1));
    await flush();
    expect((await log.getFailures())[0].file).toBe('/m/a.flac');
  });

  it('keeps the failure when the path lookup fails', async () => {
    const log = fresh();
    require('axios').get.mockRejectedValue(new Error('plex down'));
    await log.recordFailure(failure(1));
    await flush();
    const list = await log.getFailures();
    expect(list.map((e: any) => [e.title, e.file])).toEqual([['T1', '']]);
  });

  it('survives a damaged saved list', async () => {
    const log = fresh();
    await storage().setItem(KEY, '{not json');
    expect(await log.getFailures()).toEqual([]);
  });

  it('labels what was seen', () => {
    const log = fresh();
    expect(log.describeKind(failure(1))).toBe("Wouldn't load");
    expect(
      log.describeKind(failure(1, {kind: 'early', posMs: 5000, durMs: 93493})),
    ).toBe('Stopped at 0:05 of 1:33');
  });
});

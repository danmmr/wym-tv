// RANDOM_ORDER (src/config/display.ts) governs the order of the two Browse
// listings: the Albums grid and the Artists roster. Both settings are exercised
// here, and both of the album grid's paths — the one-request server sample and
// the in-memory branch taken when the full catalog is already loaded.
//
// The config is read at call time, not at import time, but each case loads a
// fresh copy of src/api/plex anyway so its session caches (sampleCache,
// albumCache, shuffledArtistsCache) start empty.

jest.mock('../src/config/plex', () => ({
  PLEX: {baseUrl: 'http://plex.test:32400', musicSection: 4},
}));

// 60 albums whose titles and artists are both deliberately out of alphabetical
// order, so "sorted" is a real assertion rather than the input order restated.
const N = 60;
const letter = (i: number) => String.fromCharCode(65 + ((i * 7) % 26));
const FIXTURE = Array.from({length: N}, (_, i) => ({
  ratingKey: String(1000 + i),
  title: `${letter(i)}lbum ${i}`,
  parentTitle: `${letter(N - i)}rtist ${i}`,
  parentRatingKey: String(2000 + i),
  thumb: `/library/metadata/${1000 + i}/thumb/1`,
  year: '2020',
}));

type Plex = typeof import('../src/api/plex');

// Load src/api/plex with RANDOM_ORDER pinned to `random`, against a stubbed
// axios that answers every Plex query with the fixture catalog.
function load(random: 0 | 1): {plex: Plex; get: jest.Mock} {
  let plex: Plex;
  let get: jest.Mock;
  jest.isolateModules(() => {
    jest.doMock('../src/config/display', () => ({
      RANDOM_ORDER: random,
      randomOrderEnabled: () => random === 1,
    }));
    get = jest.fn(async () => ({
      data: {MediaContainer: {size: N, totalSize: N, Metadata: FIXTURE}},
    }));
    jest.doMock('axios', () => ({__esModule: true, default: {get}}));
    plex = require('../src/api/plex');
  });
  return {plex: plex!, get: get!};
}

const isSorted = (names: string[]) =>
  names.every(
    (n, i) =>
      i === 0 ||
      names[i - 1].localeCompare(n, undefined, {sensitivity: 'base'}) <= 0,
  );

describe('Albums grid — the single-request path', () => {
  it('asks Plex for sort=random when RANDOM_ORDER = 1', async () => {
    const {plex, get} = load(1);
    await plex.getAlbumSample(10);
    expect(get.mock.calls[0][0]).toContain('sort=random');
  });

  it('asks Plex for sort=titleSort when RANDOM_ORDER = 0', async () => {
    const {plex, get} = load(0);
    await plex.getAlbumSample(10);
    const url: string = get.mock.calls[0][0];
    expect(url).toContain('sort=titleSort');
    expect(url).not.toContain('sort=random');
  });

  it('requests exactly the sample size, either way', async () => {
    for (const r of [0, 1] as const) {
      const {plex, get} = load(r);
      await plex.getAlbumSample(25);
      expect(get.mock.calls[0][0]).toContain('X-Plex-Container-Size=25');
    }
  });
});

describe('Albums grid — the in-memory path (catalog already loaded)', () => {
  it('is alphabetical by title when RANDOM_ORDER = 0', async () => {
    const {plex} = load(0);
    await plex.loadAllAlbums(); // seeds albumCache, so no second round trip
    const sample = await plex.getAlbumSample(20);
    expect(sample).toHaveLength(20);
    expect(isSorted(sample.map(a => a.title))).toBe(true);
  });

  it('is not alphabetical when RANDOM_ORDER = 1', async () => {
    const {plex} = load(1);
    await plex.loadAllAlbums();
    const sample = await plex.getAlbumSample(20);
    expect(sample).toHaveLength(20);
    expect(isSorted(sample.map(a => a.title))).toBe(false);
  });

  it('does not re-query Plex once the catalog is in memory', async () => {
    const {plex, get} = load(1);
    await plex.loadAllAlbums();
    const before = get.mock.calls.length;
    await plex.getAlbumSample(20);
    expect(get.mock.calls.length).toBe(before);
  });
});

describe('Artists roster', () => {
  it('is alphabetical by name when RANDOM_ORDER = 0', async () => {
    const {plex} = load(0);
    const artists = await plex.getShuffledArtists();
    expect(artists).toHaveLength(N);
    expect(isSorted(artists.map(a => a.name))).toBe(true);
  });

  it('is shuffled — same roster, different order — when RANDOM_ORDER = 1', async () => {
    const {plex} = load(1);
    const artists = await plex.getShuffledArtists();
    // The whole roster is still there; only its order changed.
    expect(artists).toHaveLength(N);
    expect([...artists.map(a => a.name)].sort()).toEqual(
      [...FIXTURE.map(f => f.parentTitle)].sort(),
    );
    expect(isSorted(artists.map(a => a.name))).toBe(false);
  });

  it('holds the order for the session, so the tab does not reorder on re-entry', async () => {
    for (const r of [0, 1] as const) {
      const {plex} = load(r);
      const first = await plex.getShuffledArtists();
      const second = await plex.getShuffledArtists();
      expect(second.map(a => a.name)).toEqual(first.map(a => a.name));
    }
  });

  it('is capped at the sample size, at either setting', async () => {
    for (const r of [0, 1] as const) {
      const {plex} = load(r);
      const artists = await plex.getShuffledArtists(undefined, 12);
      expect(artists).toHaveLength(12);
      // Distinct artists, not the same one repeated by a bad slice.
      expect(new Set(artists.map(a => a.key)).size).toBe(12);
    }
  });

  it('defaults the cap to ARTIST_SAMPLE', async () => {
    const {plex} = load(1);
    expect(plex.ARTIST_SAMPLE).toBe(500);
  });

  it('leaves the alphabetical getArtists() cache untouched at either setting', async () => {
    for (const r of [0, 1] as const) {
      const {plex} = load(r);
      await plex.getShuffledArtists();
      const alpha = await plex.getArtists();
      expect(isSorted(alpha.map(a => a.name))).toBe(true);
    }
  });
});

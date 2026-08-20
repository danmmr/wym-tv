// The album catalog is the single most expensive thing the app fetches — every
// album in the library, paged 800 at a time, megabytes of JSON — and entering
// Browse's Search tab used to sit behind all of it on every cold start. It is now cached to
// AsyncStorage behind a fingerprint. The traps that make this worth asserting:
//
//   * a STALE cache is worse than a slow one. Serving a saved catalog when the
//     library has actually changed hides new albums from Search with no symptom
//     at all, so the fingerprint gate has to be exact, not approximate.
//   * the fingerprint must come from the CHEAP probe. /library/sections answers
//     in ~30 ms; a Container-Size=0 count probe makes Plex tally the section and
//     took ~1.1 s measured against a real server, which would eat most of the win.
//   * excludeFields is a payload cut (measured at roughly half the bytes per
//     page against a real server), and it is one edit away from excluding a field the app then
//     reads as ''. Every mapped field is asserted to survive the round trip.
//   * when Plex is unreachable the fingerprint is unknowable. Browsing a saved
//     catalog still works, so an offline server must fall back to the cache
//     rather than failing the tab.

jest.mock('../src/config/plex', () => ({
  PLEX: {baseUrl: 'http://plex.test:32400', musicSection: 4},
}));

type PlexApi = typeof import('../src/api/plex');

// The section listing the fingerprint is derived from. Shaped from the real
// server: `key` is a STRING, and the music section is not the only one.
const sections = (contentChangedAt = 4127249) => ({
  MediaContainer: {
    Directory: [
      {
        key: '1',
        title: 'Movies',
        contentChangedAt: 99,
        scannedAt: 1,
        updatedAt: 1,
      },
      {
        key: '4',
        title: 'Music',
        contentChangedAt,
        scannedAt: 1787221804,
        updatedAt: 1783927740,
      },
    ],
  },
});

// One album as Plex sends it, including the fields excludeFields is meant to
// strip — a server that ignores the parameter must still map correctly.
const album = (i: number) => ({
  ratingKey: 1000 + i,
  title: `Album ${i}`,
  parentTitle: `Artist ${i}`,
  parentRatingKey: 2000 + i,
  thumb: `/library/metadata/${1000 + i}/thumb/1`,
  year: 1990 + i,
  guid: 'plex://album/deadbeef',
  UltraBlurColors: {topLeft: '000000'},
});

const TOTAL = 5;

// Load src/api/plex fresh (albumCache is module state) with a stubbed axios and
// a real in-memory AsyncStorage that persists across reloads within a test.
function loadPlex(responder: (url: string) => any) {
  let plex!: PlexApi;
  let get!: jest.Mock;
  jest.isolateModules(() => {
    get = jest.fn(async (url: string) => ({data: responder(url)}));
    jest.doMock('axios', () => ({__esModule: true, default: {get}}));
    plex = require('../src/api/plex');
  });
  return {plex, get};
}

// Serves the section listing plus a paged album catalog. `fail` makes the
// section probe throw, standing in for an unreachable server.
function server(opts: {contentChangedAt?: number; fail?: boolean} = {}) {
  return (url: string) => {
    if (
      url.includes('/library/sections?') ||
      url.endsWith('/library/sections')
    ) {
      if (opts.fail) {
        throw new Error('ECONNREFUSED');
      }
      return sections(opts.contentChangedAt);
    }
    const start = Number(/X-Plex-Container-Start=(\d+)/.exec(url)?.[1] ?? 0);
    const size = Number(/X-Plex-Container-Size=(\d+)/.exec(url)?.[1] ?? 0);
    const items = [];
    for (let i = start; i < Math.min(start + size, TOTAL); i++) {
      items.push(album(i));
    }
    return {
      MediaContainer: {totalSize: TOTAL, size: items.length, Metadata: items},
    };
  };
}

const AsyncStorage = require('@react-native-async-storage/async-storage');

beforeEach(async () => {
  await AsyncStorage.clear();
});

const albumUrls = (get: jest.Mock) =>
  get.mock.calls.map(c => c[0] as string).filter(u => u.includes('/all?'));

describe('album catalog disk cache', () => {
  it('maps every field the app reads and excludes the ones it does not', async () => {
    const {plex, get} = loadPlex(server());
    const all = await plex.loadAllAlbums();

    expect(all).toHaveLength(TOTAL);
    expect(all[0]).toEqual({
      ratingKey: '1000',
      title: 'Album 0',
      artist: 'Artist 0',
      artistKey: '2000',
      thumb: '/library/metadata/1000/thumb/1',
      year: '1990',
    });

    // Each mapped field must be absent from the exclusion list, or the server
    // would omit it and every album would carry '' in that slot.
    for (const field of [
      'ratingKey',
      'title',
      'parentTitle',
      'parentRatingKey',
      'thumb',
      'year',
    ]) {
      expect(plex.ALBUM_QUERY).not.toMatch(new RegExp(`[,=]${field}(,|$)`));
    }
    expect(plex.ALBUM_QUERY).toContain('excludeFields=');
    expect(albumUrls(get).every(u => u.includes('excludeFields='))).toBe(true);
  });

  it('reuses the saved catalog on a cold start, without paging', async () => {
    const first = loadPlex(server());
    await first.plex.loadAllAlbums();
    expect(albumUrls(first.get).length).toBeGreaterThan(0);

    // Fresh module registry = a fresh process, but the same AsyncStorage.
    const second = loadPlex(server());
    const all = await second.plex.loadAllAlbums();

    expect(all).toHaveLength(TOTAL);
    expect(albumUrls(second.get)).toEqual([]); // no /all request at all
    expect(second.get).toHaveBeenCalledTimes(1); // just the fingerprint probe
    expect(second.get.mock.calls[0][0]).toContain('/library/sections');
  });

  it('re-pages when the library has changed', async () => {
    const first = loadPlex(server());
    await first.plex.loadAllAlbums();

    // contentChangedAt is the field Plex bumps on an add or a delete.
    const second = loadPlex(server({contentChangedAt: 4127250}));
    const all = await second.plex.loadAllAlbums();

    expect(all).toHaveLength(TOTAL);
    expect(albumUrls(second.get).length).toBeGreaterThan(0);
  });

  it('serves the saved catalog when the server is unreachable', async () => {
    const first = loadPlex(server());
    await first.plex.loadAllAlbums();

    const offline = loadPlex(server({fail: true}));
    const all = await offline.plex.loadAllAlbums();

    expect(all).toHaveLength(TOTAL);
    expect(albumUrls(offline.get)).toEqual([]);
  });

  it('never writes a catalog it could not fingerprint', async () => {
    const {plex} = loadPlex(server({fail: true}));
    await plex.loadAllAlbums(); // pages, because there is nothing on disk
    await new Promise(r => setImmediate(r)); // let a fire-and-forget write land

    expect(await AsyncStorage.getItem('plex.catalog.v1')).toBeNull();
  });

  it('reports progress up to the real total', async () => {
    const {plex} = loadPlex(server());
    const seen: Array<[number, number]> = [];
    const all = await plex.loadAllAlbums((loaded, total) =>
      seen.push([loaded, total]),
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual([TOTAL, TOTAL]);
    // A warm start still reports, so the spinner cannot stick at 0.
    const warm = loadPlex(server());
    const warmSeen: Array<[number, number]> = [];
    await warm.plex.loadAllAlbums((l, t) => warmSeen.push([l, t]));
    expect(warmSeen).toEqual([[all.length, all.length]]);
  });

  it('clearCatalogCache drops the saved copy', async () => {
    const {plex} = loadPlex(server());
    await plex.loadAllAlbums();
    await new Promise(r => setImmediate(r));
    expect(await AsyncStorage.getItem('plex.catalog.v1')).not.toBeNull();

    await plex.clearCatalogCache();
    expect(await AsyncStorage.getItem('plex.catalog.v1')).toBeNull();
  });
});

export {};

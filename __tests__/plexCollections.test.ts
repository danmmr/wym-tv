// The Collections tab (Browse) reads two Plex endpoints, and both have a trap
// the type signatures don't show:
//
//   * /collections sends `smart` as the STRING "1", not a JSON boolean, so
//     Boolean(p.smart) would be true for every collection — including "0".
//   * the cover mosaic arrives as `thumb`. /playlists calls the same idea
//     `composite`, and reading THAT here silently left every collection card on
//     its letter placeholder — shipped once, on 2026-08-15.
//   * a collection's children come back one container at a time, and the real
//     ones here run past a thousand albums, so the paging loop has to keep
//     asking rather than trusting the first page.
//
// All three are asserted here because on-device the only symptom would be a
// wrong gear icon, missing art, or a collection that silently stops at 800
// albums. The fixtures below are shaped from a real /collections response —
// the first version of this file invented a `composite` field the server never
// sends, so it confirmed the bug instead of catching it.

jest.mock('../src/config/plex', () => ({
  PLEX: {baseUrl: 'http://plex.test:32400', musicSection: 4},
}));

// A test file with no import/export is a global SCRIPT to tsc, so `Plex` and
// `load` here would collide with the same names in browseOrder.test.ts. The
// trailing `export {}` makes this a module; the names are still distinct for
// readability when both files are open.
type PlexApi = typeof import('../src/api/plex');

// Load src/api/plex fresh (its collection cache is module state) against a
// stubbed axios whose responder the test supplies.
function loadPlex(responder: (url: string) => any): {
  plex: PlexApi;
  get: jest.Mock;
} {
  let plex: PlexApi;
  let get: jest.Mock;
  jest.isolateModules(() => {
    get = jest.fn(async (url: string) => ({data: responder(url)}));
    jest.doMock('axios', () => ({__esModule: true, default: {get}}));
    plex = require('../src/api/plex');
  });
  return {plex: plex!, get: get!};
}

const COLLECTIONS = [
  {
    ratingKey: '80158',
    title: 'Zebra sessions',
    subtype: 'album',
    childCount: 170,
    // Note the field name and the query string Plex bakes into the path.
    thumb: '/library/collections/80158/composite/1?width=400&height=400',
    smart: '1',
  },
  {
    ratingKey: '74606',
    title: 'Bandcamp Friday',
    subtype: 'album',
    childCount: 19,
    thumb: '/library/collections/74606/composite/2?width=400&height=400',
    // no `smart` key at all — Plex omits it for a hand-built collection
  },
  {
    ratingKey: '99999',
    title: 'Explicitly not smart',
    subtype: 'album',
    childCount: 3,
    thumb: '',
    smart: '0',
  },
  // An ARTIST collection: its children are artists, not albums, so the album
  // grid must never be handed one.
  {
    ratingKey: '55555',
    title: 'Favourite artists',
    subtype: 'artist',
    childCount: 12,
    thumb: '/library/collections/55555/composite/3',
  },
];

describe('getCollections', () => {
  it('reads Plex\'s string "1"/"0" as the smart flag', async () => {
    const {plex} = loadPlex(() => ({MediaContainer: {Metadata: COLLECTIONS}}));
    const out = await plex.getCollections();
    const byTitle = Object.fromEntries(out.map(c => [c.title, c.smart]));
    expect(byTitle['Zebra sessions']).toBe(true);
    expect(byTitle['Bandcamp Friday']).toBe(false); // key absent
    expect(byTitle['Explicitly not smart']).toBe(false); // the "0" trap
  });

  it('takes the cover mosaic from `thumb`, the field Plex actually sends', async () => {
    const {plex} = loadPlex(() => ({MediaContainer: {Metadata: COLLECTIONS}}));
    const out = await plex.getCollections();
    const zebra = out.find(c => c.title === 'Zebra sessions')!;
    expect(zebra.thumb).toBe(
      '/library/collections/80158/composite/1?width=400&height=400',
    );
    // An empty collection has no mosaic; the card falls back to its letter.
    expect(out.find(c => c.title === 'Explicitly not smart')!.thumb).toBe('');
  });

  it('still finds the mosaic if a server sends the playlist-style `composite`', async () => {
    const {plex} = loadPlex(() => ({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '1',
            title: 'Composite only',
            subtype: 'album',
            childCount: 2,
            composite: '/library/collections/1/composite/9',
          },
        ],
      },
    }));
    const [only] = await plex.getCollections();
    expect(only.thumb).toBe('/library/collections/1/composite/9');
  });

  it('keeps only album collections', async () => {
    const {plex} = loadPlex(() => ({MediaContainer: {Metadata: COLLECTIONS}}));
    const out = await plex.getCollections();
    expect(out.map(c => c.title)).not.toContain('Favourite artists');
    expect(out).toHaveLength(3);
  });

  it('returns them alphabetically, with childCount as the album count', async () => {
    const {plex} = loadPlex(() => ({MediaContainer: {Metadata: COLLECTIONS}}));
    const out = await plex.getCollections();
    expect(out.map(c => c.title)).toEqual([
      'Bandcamp Friday',
      'Explicitly not smart',
      'Zebra sessions',
    ]);
    expect(out[2].count).toBe(170);
    expect(out[2].ratingKey).toBe('80158');
  });

  it('survives a section with no collections at all', async () => {
    const {plex} = loadPlex(() => ({MediaContainer: {}}));
    await expect(plex.getCollections()).resolves.toEqual([]);
  });
});

// A 1000-album collection: two full pages of 800 + 200, which is the real
// shape of the biggest collections on this server.
const TOTAL = 1000;
const CHILD = (i: number) => ({
  ratingKey: String(9000 + i),
  title: `Album ${i}`,
  parentTitle: `Artist ${i}`,
  parentRatingKey: String(3000 + i),
  thumb: `/library/metadata/${9000 + i}/thumb/1`,
  year: '2021',
});

function pagedResponder(url: string) {
  const start = Number(/X-Plex-Container-Start=(\d+)/.exec(url)?.[1] ?? 0);
  const size = Number(/X-Plex-Container-Size=(\d+)/.exec(url)?.[1] ?? 0);
  const slice = Array.from(
    {length: Math.max(0, Math.min(size, TOTAL - start))},
    (_, i) => CHILD(start + i),
  );
  return {
    MediaContainer: {size: slice.length, totalSize: TOTAL, Metadata: slice},
  };
}

describe('getCollectionAlbums', () => {
  it('pages until it has every album, not just the first container', async () => {
    const {plex, get} = loadPlex(pagedResponder);
    const out = await plex.getCollectionAlbums('59646');
    expect(out).toHaveLength(TOTAL);
    expect(get).toHaveBeenCalledTimes(2);
    expect(out[0].title).toBe('Album 0');
    expect(out[TOTAL - 1].title).toBe('Album 999');
  });

  it('maps children into the album shape the grid plays', async () => {
    const {plex} = loadPlex(pagedResponder);
    const [first] = await plex.getCollectionAlbums('59646');
    expect(first).toEqual({
      ratingKey: '9000',
      title: 'Album 0',
      artist: 'Artist 0', // Plex parentTitle
      artistKey: '3000',
      thumb: '/library/metadata/9000/thumb/1',
      year: '2021',
    });
  });

  it('caches per collection — re-entering one costs no requests', async () => {
    const {plex, get} = loadPlex(pagedResponder);
    await plex.getCollectionAlbums('59646');
    const calls = get.mock.calls.length;
    await plex.getCollectionAlbums('59646');
    expect(get).toHaveBeenCalledTimes(calls);
    // A DIFFERENT collection is still fetched.
    await plex.getCollectionAlbums('74606');
    expect(get.mock.calls.length).toBeGreaterThan(calls);
  });

  it('stops instead of looping when a page comes back empty', async () => {
    // totalSize claims more than the server will actually hand over — without
    // the empty-page guard this paging loop would never terminate.
    const {plex, get} = loadPlex(() => ({
      MediaContainer: {size: 0, totalSize: 500, Metadata: []},
    }));
    await expect(plex.getCollectionAlbums('bogus')).resolves.toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

export {};

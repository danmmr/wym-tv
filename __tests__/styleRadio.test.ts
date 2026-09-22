// Style Radio: a station built from one of the library's Style tags.
//
// Three things here are easy to get wrong and silent when wrong:
//
//   * STYLE IS AN ALBUM TAG. `type=10&style=<id>` does not error — it returns
//     an empty container, so a station built on it would simply play nothing
//     and look like an empty library. The track query has to reach through the
//     album with `album.style`. Measured against the real server: `style=`
//     returned 0 tracks where `album.style=` returned 5,974 for the same tag,
//     and a bogus tag id returned 0 through both (the negative control that
//     separates a working filter from an ignored one).
//   * THE COUNTS COST A REQUEST EACH. Plex's style listing carries key and
//     title only — no album count, and includeMeta adds none — so the list is
//     a fan-out that must be cached against the library fingerprint like the
//     album catalog, or it runs on every launch.
//   * THE TAG ID ROUND-TRIPS THROUGH stationKind. Auto-refill rebuilds the
//     station from that string alone, so a style station that loses its id
//     refills as something else entirely.

jest.mock('../src/config/plex', () => ({
  PLEX: {baseUrl: 'http://plex.test:32400', musicSection: 4},
}));

type PlexApi = typeof import('../src/api/plex');

const sections = (contentChangedAt = 100) => ({
  MediaContainer: {
    Directory: [
      {
        key: '4',
        title: 'Music',
        contentChangedAt,
        scannedAt: 1,
        updatedAt: 1,
      },
    ],
  },
});

// Plex's "By Style" listing, shaped as the real server sends it: a `Directory`
// array of key/title/fastKey, with NO count anywhere.
const STYLES = [
  {key: '259016', title: 'Abstract', albums: 597},
  {key: '259135', title: 'Chiptune', albums: 1},
  {key: '259055', title: 'Ethereal', albums: 12},
  {key: '650', title: 'Drone', albums: 614},
];

const track = (i: number) => ({
  ratingKey: 500 + i,
  title: `Track ${i}`,
  parentTitle: 'An Album',
  parentRatingKey: 90,
  parentThumb: '/library/metadata/90/thumb/1',
  duration: 200000,
  Media: [{bitrate: 900, Part: [{key: `/library/parts/${i}/1/f.flac`}]}],
});

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

// A server that knows its styles. Counting probes (Container-Size=0) answer
// with totalSize and no Metadata, exactly as Plex does.
function server(opts: {contentChangedAt?: number} = {}) {
  return (url: string) => {
    if (
      url.includes('/library/sections?') ||
      url.endsWith('/library/sections')
    ) {
      return sections(opts.contentChangedAt);
    }
    if (url.includes('/style?type=9')) {
      return {
        MediaContainer: {
          size: STYLES.length,
          Directory: STYLES.map(s => ({
            key: s.key,
            title: s.title,
            fastKey: `/library/sections/4/all?style=${s.key}`,
          })),
        },
      };
    }
    // An album count probe: type=9 with a style filter and no page size.
    const counted = /[?&]style=(\d+)/.exec(url);
    if (url.includes('type=9') && counted) {
      const hit = STYLES.find(s => s.key === counted[1]);
      return {MediaContainer: {totalSize: hit ? hit.albums : 0, size: 0}};
    }
    // A track query. ONLY album.style matches; a bare style= yields nothing,
    // which is what the real server does.
    if (url.includes('type=10')) {
      if (url.includes('album.style=')) {
        return {
          MediaContainer: {size: 3, Metadata: [track(1), track(2), track(3)]},
        };
      }
      if (url.includes('style=')) {
        return {MediaContainer: {size: 0}};
      }
      return {MediaContainer: {size: 2, Metadata: [track(1), track(2)]}};
    }
    return {MediaContainer: {size: 0}};
  };
}

const AsyncStorage = require('@react-native-async-storage/async-storage');

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('station kind round trip', () => {
  it('carries the tag id in the string and reads it back', () => {
    const {plex} = loadPlex(server());
    const kind = plex.styleStation('259016');
    expect(kind).toBe('style:259016');
    expect(plex.stationStyleKey(kind)).toBe('259016');
  });

  it('reports no style for the two fixed stations', () => {
    const {plex} = loadPlex(server());
    expect(plex.stationStyleKey('library')).toBe('');
    expect(plex.stationStyleKey('deepcuts')).toBe('');
  });
});

describe('buildStationQueue', () => {
  it('filters a style station through album.style, never a bare style', async () => {
    const {plex, get} = loadPlex(server());
    const q = await plex.buildStationQueue(plex.styleStation('259016'), 50);
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain('album.style=259016');
    // The bare form is the bug: it returns an empty container rather than an
    // error, so the station would be silently empty.
    expect(url).not.toMatch(/[?&]style=/);
    expect(url).toContain('sort=random');
    expect(q).toHaveLength(3);
  });

  it('leaves the fixed stations exactly as they were', async () => {
    const {plex, get} = loadPlex(server());
    await plex.buildStationQueue('library', 50);
    expect(get.mock.calls[0][0]).not.toContain('style');
    expect(get.mock.calls[0][0]).not.toContain('viewCount');

    const {plex: p2, get: g2} = loadPlex(server());
    await p2.buildStationQueue('deepcuts', 50);
    expect(g2.mock.calls[0][0]).toContain('viewCount=0');
    expect(g2.mock.calls[0][0]).not.toContain('style');
  });

  it('honours the requested size', async () => {
    const {plex, get} = loadPlex(server());
    await plex.buildStationQueue(plex.styleStation('650'), 25);
    expect(get.mock.calls[0][0]).toContain('X-Plex-Container-Size=25');
  });
});

describe('getStyles', () => {
  it('returns every style with its album count, alphabetical', async () => {
    const {plex} = loadPlex(server());
    const styles = await plex.getStyles();
    expect(styles.map(s => s.title)).toEqual([
      'Abstract',
      'Chiptune',
      'Drone',
      'Ethereal',
    ]);
    expect(styles.find(s => s.title === 'Drone')?.albums).toBe(614);
    expect(styles.find(s => s.title === 'Chiptune')?.albums).toBe(1);
  });

  it('caches to disk so a relaunch makes no count probes', async () => {
    const {plex} = loadPlex(server());
    await plex.getStyles();

    // Fresh module, same AsyncStorage and an unchanged library.
    const {plex: p2, get: g2} = loadPlex(server());
    const styles = await p2.getStyles();
    expect(styles).toHaveLength(STYLES.length);
    const probes = g2.mock.calls
      .map(c => c[0] as string)
      .filter(u => u.includes('X-Plex-Container-Size=0'));
    expect(probes).toHaveLength(0);
  });

  it('re-counts when the library has changed', async () => {
    const {plex} = loadPlex(server({contentChangedAt: 1}));
    await plex.getStyles();

    const {plex: p2, get: g2} = loadPlex(server({contentChangedAt: 2}));
    await p2.getStyles();
    const probes = g2.mock.calls
      .map(c => c[0] as string)
      .filter(u => u.includes('X-Plex-Container-Size=0'));
    expect(probes).toHaveLength(STYLES.length);
  });

  it('serves the cache when the server is unreachable', async () => {
    const {plex} = loadPlex(server());
    await plex.getStyles();

    const {plex: p2} = loadPlex((url: string) => {
      if (url.includes('/library/sections')) {
        throw new Error('ECONNREFUSED');
      }
      throw new Error('should not be asked');
    });
    await expect(p2.getStyles()).resolves.toHaveLength(STYLES.length);
  });

  it('does not cache a failure as an empty list', async () => {
    let boom = true;
    const {plex} = loadPlex((url: string) => {
      if (boom) {
        throw new Error('ECONNREFUSED');
      }
      return server()(url);
    });
    await expect(plex.getStyles()).rejects.toThrow();
    boom = false;
    // A retry within the same session must re-fetch rather than serve the
    // rejected promise back.
    await expect(plex.getStyles()).resolves.toHaveLength(STYLES.length);
  });
});

describe('stationStyles', () => {
  const all = [
    {key: 'a', title: 'Big', albums: 600},
    {key: 'b', title: 'Middling', albums: 40},
    {key: 'c', title: 'Tiny', albums: 1},
  ];

  it('keeps only styles with enough albums behind them', () => {
    const {plex} = loadPlex(server());
    expect(plex.stationStyles(all, 40).map(s => s.title)).toEqual([
      'Big',
      'Middling',
    ]);
  });

  it('falls back to the whole list rather than an empty menu', () => {
    const {plex} = loadPlex(server());
    expect(plex.stationStyles(all, 10000)).toHaveLength(3);
  });
});

// This file is a module, not a global script: two suites declaring the same
// top-level const would otherwise collide under tsc (jest never sees it).
export {};

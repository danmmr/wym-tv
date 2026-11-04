// What Now Playing's Artist button resolves to. The catalog and the track rows
// are passed in, so this needs no device and no Plex.

// See the note in plexUrls.test.ts: the real config is gitignored, so mock it.
jest.mock('../src/config/plex', () => ({
  PLEX: {baseUrl: 'http://plex.test:32400', musicSection: 4},
}));

import {
  appearancesFromTracks,
  findOwnReleases,
  mergeReleases,
} from '../src/api/plex';
import type {PlexAlbum} from '../src/api/plex';

const album = (
  ratingKey: string,
  artist: string,
  artistKey: string,
  year = '2000',
): PlexAlbum => ({
  ratingKey,
  title: `Album ${ratingKey}`,
  artist,
  artistKey,
  thumb: `/thumb/${ratingKey}`,
  year,
});

const CATALOG = [
  album('1', 'Boards of Canada', '10', '2005'),
  album('2', 'Boards of Canada', '10', '1998'),
  album('3', 'Various Artists', '99'),
  // Two different artists with one name, the smaller listed first.
  album('4', 'Air', '20'),
  album('5', 'Air', '21'),
  album('6', 'Air', '21'),
  album('7', 'Éliane Radigue', '30'),
];

const titles = (found: ReturnType<typeof findOwnReleases>) =>
  found ? found.albums.map(a => a.ratingKey) : null;

describe('findOwnReleases', () => {
  it('goes by id on a normal album, oldest first', () => {
    const found = findOwnReleases(CATALOG, {
      artistKey: '10',
      albumArtist: 'Boards of Canada',
      trackArtist: 'Boards of Canada',
    });
    expect(titles(found)).toEqual(['2', '1']);
    expect(found?.artist.name).toBe('Boards of Canada');
    expect(found?.artist.key).toBe('10');
  });

  it('keeps a namesake apart when the album says which one it is', () => {
    const found = findOwnReleases(CATALOG, {
      artistKey: '20',
      albumArtist: 'Air',
      trackArtist: 'Air',
    });
    expect(titles(found)).toEqual(['4']);
  });

  it('on a compilation, ignores the Various id and uses the credit', () => {
    const found = findOwnReleases(CATALOG, {
      artistKey: '99',
      albumArtist: 'Various Artists',
      trackArtist: 'Boards of Canada',
    });
    expect(titles(found)).toEqual(['2', '1']);
  });

  it('takes the larger namesake when only a credit is known', () => {
    const found = findOwnReleases(CATALOG, {
      artistKey: '99',
      albumArtist: 'Various Artists',
      trackArtist: 'Air',
    });
    expect(titles(found)).toEqual(['5', '6']);
  });

  it('folds case and accents when matching a credit', () => {
    const found = findOwnReleases(CATALOG, {
      artistKey: '',
      albumArtist: '',
      trackArtist: 'ELIANE RADIGUE',
    });
    expect(titles(found)).toEqual(['7']);
    expect(found?.artist.name).toBe('Éliane Radigue');
  });

  it('returns null for a credit with no album of its own', () => {
    expect(
      findOwnReleases(CATALOG, {
        artistKey: '99',
        albumArtist: 'Various Artists',
        trackArtist: 'Bikini Kill',
      }),
    ).toBeNull();
  });

  it('never offers the Various Artists placeholder as an artist', () => {
    expect(
      findOwnReleases(CATALOG, {
        artistKey: '99',
        albumArtist: 'Various Artists',
        trackArtist: 'Various Artists',
      }),
    ).toBeNull();
  });
});

describe('appearancesFromTracks', () => {
  const row = (parentRatingKey: string, originalTitle: string, year = 2011) => ({
    parentRatingKey,
    originalTitle,
    parentTitle: `Comp ${parentRatingKey}`,
    grandparentTitle: 'Various',
    grandparentRatingKey: '99',
    parentYear: year,
  });

  it('drops the loose matches Plex filter lets through', () => {
    const got = appearancesFromTracks(
      [row('1', 'Air'), row('2', 'Air Supply')],
      'Air',
    );
    expect(got.map(a => a.ratingKey)).toEqual(['1']);
  });

  it('lists an album once however many tracks carry the credit', () => {
    const got = appearancesFromTracks(
      [row('1', 'Air'), row('1', 'Air'), row('2', 'Air')],
      'Air',
    );
    expect(got.map(a => a.ratingKey)).toEqual(['1', '2']);
  });

  it('sorts oldest first and maps the album fields', () => {
    const got = appearancesFromTracks(
      [row('1', 'Air', 2011), row('2', 'Air', 1999)],
      'Air',
    );
    expect(got.map(a => a.ratingKey)).toEqual(['2', '1']);
    expect(got[0]).toMatchObject({
      title: 'Comp 2',
      artist: 'Various',
      artistKey: '99',
      year: '1999',
    });
  });
});

describe('mergeReleases', () => {
  const own = findOwnReleases(CATALOG, {
    artistKey: '10',
    albumArtist: 'Boards of Canada',
    trackArtist: 'Boards of Canada',
  });
  // Older than both of the artist's albums, so a merged sort would put it first.
  const comp = album('50', 'Various Artists', '99', '1990');

  it('puts the albums first even when a compilation is older', () => {
    const got = mergeReleases(own, [comp], 'Boards of Canada');
    expect(got?.albums.map(a => a.ratingKey)).toEqual(['2', '1', '50']);
  });

  it('counts both, and keeps the artist identity from the albums', () => {
    const got = mergeReleases(own, [comp], 'boards of canada');
    expect(got?.artist.count).toBe(3);
    expect(got?.artist.name).toBe('Boards of Canada');
    expect(got?.artist.key).toBe('10');
  });

  it('does not list an own album again as an appearance', () => {
    const dupe = album('1', 'Boards of Canada', '10', '2005');
    const got = mergeReleases(own, [dupe], 'Boards of Canada');
    expect(got?.albums.map(a => a.ratingKey)).toEqual(['2', '1']);
  });

  it('shows only the compilations for an artist with no albums', () => {
    const got = mergeReleases(null, [comp], 'Bikini Kill');
    expect(got?.albums.map(a => a.ratingKey)).toEqual(['50']);
    expect(got?.artist.name).toBe('Bikini Kill');
  });

  it('returns null when there is nothing at all', () => {
    expect(mergeReleases(null, [], 'Nobody')).toBeNull();
  });
});

describe('findArtistReleases when the appearances request fails', () => {
  // Isolated so the catalog cache inside plex.ts starts empty for each test.
  const load = (failTracks: boolean) => {
    jest.resetModules();
    jest.doMock('axios', () => ({
      get: jest.fn((url: string) => {
        if (url.includes('type=10')) {
          return failTracks
            ? Promise.reject(new Error('plex down'))
            : Promise.resolve({data: {MediaContainer: {Metadata: []}}});
        }
        if (url.includes('type=9')) {
          return Promise.resolve({
            data: {
              MediaContainer: {
                totalSize: 1,
                Metadata: [
                  {
                    ratingKey: 1,
                    title: 'Bytes',
                    parentTitle: 'The Black Dog',
                    parentRatingKey: 10,
                    year: 1993,
                  },
                ],
              },
            },
          });
        }
        return Promise.resolve({data: {MediaContainer: {Directory: []}}});
      }),
    }));
    return require('../src/api/plex');
  };

  it('still shows the albums', async () => {
    const {findArtistReleases} = load(true);
    const got = await findArtistReleases({
      artistKey: '10',
      albumArtist: 'The Black Dog',
      trackArtist: 'The Black Dog',
    });
    expect(got?.albums.map((a: PlexAlbum) => a.title)).toEqual(['Bytes']);
  });

  it('reports the error rather than claiming there is nothing', async () => {
    const {findArtistReleases} = load(true);
    await expect(
      findArtistReleases({
        artistKey: '99',
        albumArtist: 'Various Artists',
        trackArtist: 'Bikini Kill',
      }),
    ).rejects.toThrow('plex down');
  });

  it('skips the request for the Various Artists placeholder', async () => {
    const {findArtistReleases} = load(true);
    await expect(
      findArtistReleases({
        artistKey: '99',
        albumArtist: 'Various Artists',
        trackArtist: 'Various Artists',
      }),
    ).resolves.toBeNull();
  });
});

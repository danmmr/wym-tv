// The Artists roster is alphabetised by a precomputed fold() key rather than by
// localeCompare(..., {sensitivity: 'base'}) per comparison — the options form of
// localeCompare cost 4,976 ms sorting this library's 2,782 artists on a Fire
// Stick, against 49 ms for a plain comparator over the same data, because
// Hermes ships without Intl.
//
// Speed is not what this file guards; the ORDERING the fast path has to keep is.
// Every fixture name below is chosen so that a naive `<` comparator gets it
// wrong: by code unit the upper-case ASCII names sort before the lower-case one
// and all three accented names sort after every ASCII name, so a regression to
// raw string comparison fails here rather than passing quietly and showing up
// as Ø at the bottom of the roster on the TV.
//
// It also cannot be satisfied by folding with toLowerCase: Hermes' case
// conversion is ASCII-only, so `'Ólafur'.toLowerCase()` is unchanged on device.
// fold() is table-driven in both cases for exactly that reason — see
// searchText.test.ts, which asserts on the table itself.

jest.mock('../src/config/plex', () => ({
  PLEX: {baseUrl: 'http://plex.test:32400', musicSection: 4},
}));

// One album each, fed in an order that is neither the expected output nor
// reverse of it.
const ROSTER_NAMES = [
  'ØXN',
  'orbital',
  'Éliane Radigue',
  'Oval',
  'Ólafur Arnalds',
];

const ROSTER_FIXTURE = ROSTER_NAMES.map((name, i) => ({
  ratingKey: String(1000 + i),
  title: `Album ${i}`,
  parentTitle: name,
  parentRatingKey: String(2000 + i),
  thumb: `/library/metadata/${1000 + i}/thumb/1`,
  year: '2020',
}));

type RosterPlex = typeof import('../src/api/plex');

function loadRoster(): RosterPlex {
  let plex: RosterPlex;
  jest.isolateModules(() => {
    jest.doMock('../src/config/display', () => ({
      RANDOM_ORDER: 0,
      randomOrderEnabled: () => false,
    }));
    jest.doMock('axios', () => ({
      __esModule: true,
      default: {
        get: jest.fn(async () => ({
          data: {
            MediaContainer: {
              size: ROSTER_FIXTURE.length,
              totalSize: ROSTER_FIXTURE.length,
              Metadata: ROSTER_FIXTURE,
            },
          },
        })),
      },
    }));
    plex = require('../src/api/plex');
  });
  return plex!;
}

describe('Artists roster ordering', () => {
  it('folds accents and case, so Ø and Ó sort among the Os', async () => {
    const artists = await loadRoster().getArtists();
    expect(artists.map(a => a.name)).toEqual([
      'Éliane Radigue',
      'Ólafur Arnalds',
      'orbital',
      'Oval',
      'ØXN',
    ]);
  });

  it('is not raw code-unit order', () => {
    // Guards the guard: if the expectation above ever coincided with a plain
    // `<` sort, this test file would stop being able to catch a regression.
    expect(ROSTER_NAMES.slice().sort()).not.toEqual([
      'Éliane Radigue',
      'Ólafur Arnalds',
      'orbital',
      'Oval',
      'ØXN',
    ]);
  });
});

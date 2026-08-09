// See the note in plexUrls.test.ts: the real config is gitignored, so mock it.
jest.mock('../src/config/plex', () => ({
  PLEX: {
    baseUrl: 'http://plex.test:32400',
    token: 'TESTTOKEN',
    musicSection: 4,
  },
}));

import {trackArtist} from '../src/api/plex';

describe('trackArtist', () => {
  it('uses the album artist on a normal album', () => {
    expect(
      trackArtist({grandparentTitle: 'Boards of Canada', originalTitle: null}),
    ).toBe('Boards of Canada');
  });

  it('does NOT let originalTitle override a real album artist', () => {
    // Plex populates originalTitle for feat. credits and variant spellings.
    // On a single-artist album the canonical name is what we want.
    expect(
      trackArtist({
        grandparentTitle: 'Gorillaz',
        originalTitle: 'Gorillaz feat. Snoop Dogg and Hypnotic Brass Ensemble',
      }),
    ).toBe('Gorillaz');
    expect(
      trackArtist({grandparentTitle: 'Czarface', originalTitle: 'CZARFACE'}),
    ).toBe('Czarface');
  });

  it('uses the per-track artist on a compilation', () => {
    expect(
      trackArtist({grandparentTitle: 'Various Artists', originalTitle: 'Sugar'}),
    ).toBe('Sugar');
  });

  it('recognizes the bare "Various" placeholder this library also uses', () => {
    // Both spellings are present in the library (e.g. "20 Years Of Kill Rock
    // Stars" is filed under "Various", not "Various Artists").
    expect(
      trackArtist({grandparentTitle: 'Various', originalTitle: 'Slim Moon'}),
    ).toBe('Slim Moon');
    expect(
      trackArtist({grandparentTitle: 'various artist', originalTitle: 'Gossip'}),
    ).toBe('Gossip');
  });

  it('falls back to the placeholder when a compilation track has no credit', () => {
    expect(trackArtist({grandparentTitle: 'Various Artists'})).toBe(
      'Various Artists',
    );
    expect(
      trackArtist({grandparentTitle: 'Various Artists', originalTitle: ''}),
    ).toBe('Various Artists');
  });

  it('does not match artists whose name merely contains "various"', () => {
    expect(
      trackArtist({
        grandparentTitle: 'Various Production',
        originalTitle: 'Someone Else',
      }),
    ).toBe('Various Production');
  });

  it('returns empty string when nothing is known', () => {
    expect(trackArtist({})).toBe('');
  });
});

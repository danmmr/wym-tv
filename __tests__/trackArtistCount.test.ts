// The count on Now Playing's context line. On a compilation it must describe the
// credited artist, not the "Various" placeholder.

jest.mock('../src/config/plex', () => ({
  PLEX: {baseUrl: 'http://plex.test:32400', musicSection: 4},
}));

const COUNTS: Record<string, number> = {
  '10': 37,
  '20': 1,
  '21': 5,
  '30': 2,
  // Larger than either Air, so it wins if the loose match is not filtered out.
  '31': 50,
};
const ARTISTS: Record<string, {title: string; ratingKey: string}[]> = {
  'The%20Black%20Dog': [
    {title: 'The Black Dog', ratingKey: '10'},
    {title: 'The Black Dog & Plaid', ratingKey: '30'},
  ],
  Air: [
    {title: 'Air', ratingKey: '20'},
    {title: 'Air', ratingKey: '21'},
    {title: 'Air Liquide', ratingKey: '31'},
  ],
};

jest.mock('axios', () => ({get: jest.fn()}));

import axios from 'axios';
import {getTrackArtistAlbumCount} from '../src/api/plex';

const mockGet = axios.get as jest.Mock;

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) => {
    const artistId = /artist\.id=(\w+)/.exec(url);
    if (artistId) {
      return Promise.resolve({
        data: {MediaContainer: {totalSize: COUNTS[artistId[1]] ?? 0}},
      });
    }
    const title = /type=8&title=([^&]+)/.exec(url);
    if (title) {
      return Promise.resolve({
        data: {MediaContainer: {Metadata: ARTISTS[title[1]] || []}},
      });
    }
    return Promise.reject(new Error('unexpected ' + url));
  });
});

const comp = (artist: string) => ({
  artistKey: '99',
  albumArtist: 'Various',
  artist,
});

describe('getTrackArtistAlbumCount', () => {
  it('uses the album artist id on a normal album', async () => {
    expect(
      await getTrackArtistAlbumCount({
        artistKey: '10',
        albumArtist: 'The Black Dog',
        artist: 'The Black Dog',
      }),
    ).toBe(37);
    const urls = mockGet.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('type=8'))).toBe(false);
  });

  it('counts the credited artist on a compilation, not Various', async () => {
    expect(await getTrackArtistAlbumCount(comp('The Black Dog'))).toBe(37);
  });

  it('ignores loose title matches', async () => {
    expect(await getTrackArtistAlbumCount(comp('Air'))).toBe(5);
  });

  it('takes the larger namesake', async () => {
    expect(await getTrackArtistAlbumCount(comp('Air'))).toBe(5);
  });

  it('is 0 for a credit with no album of its own', async () => {
    expect(await getTrackArtistAlbumCount(comp('Bikini Kill'))).toBe(0);
  });

  it('is 0 for a compilation track with no credit', async () => {
    expect(await getTrackArtistAlbumCount(comp('Various'))).toBe(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('asks Plex for one name only once', async () => {
    await getTrackArtistAlbumCount(comp('Cached Name'));
    await getTrackArtistAlbumCount(comp('Cached Name'));
    const lookups = mockGet.mock.calls.filter(c =>
      String(c[0]).includes('type=8'),
    );
    expect(lookups.length).toBe(1);
  });
});
